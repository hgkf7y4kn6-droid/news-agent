import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAccessKeyCache } from "../src/access";
import worker, { type Env } from "../src/index";
import { AUD, CERTS_URL, certsResponse, signToken, TEAM_DOMAIN } from "./helpers/access";

const RSS = `<rss><channel>
  <item><title>Fed holds interest rates steady</title><link>https://news.test/fed</link><description>Central bank pauses.</description><pubDate>Mon, 28 Sep 2026 09:00:00 GMT</pubDate></item>
  <item><title>Local team wins cup</title><link>https://news.test/cup</link><description>Sports.</description><pubDate>Mon, 28 Sep 2026 08:00:00 GMT</pubDate></item>
</channel></rss>`;

function memoryKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string, type?: string) => {
      const v = store.get(k);
      return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
    },
    put: async (k: string, v: string) => void store.set(k, v),
  } as unknown as KVNamespace;
}

function memoryVectorize() {
  const vectors = new Map<string, VectorizeVector>();
  return {
    vectors,
    getByIds: async (ids: string[]) => ids.filter((id) => vectors.has(id)).map((id) => vectors.get(id)!),
    upsert: async (vs: VectorizeVector[]) => {
      vs.forEach((v) => vectors.set(v.id, v));
      return { ids: vs.map((v) => v.id), count: vs.length };
    },
    // Fake similarity: the "fed" article is relevant, everything else isn't.
    query: async () => ({
      count: vectors.size,
      matches: [...vectors.values()].map((v) => ({
        id: v.id,
        score: (v.metadata as Record<string, string>).link.endsWith("/fed") ? 0.9 : 0.1,
        metadata: v.metadata,
      })),
    }),
  };
}

const embedding = Array.from({ length: 768 }, () => 0.01);

let geminiRequests: Array<{ url: string; body: any }> = [];
beforeEach(() => {
  geminiRequests = [];
  resetAccessKeyCache();
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url === CERTS_URL) return certsResponse();
    if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      const body = JSON.parse(String(init!.body));
      geminiRequests.push({ url, body });
      if (url.includes(":batchEmbedContents")) {
        return Response.json({ embeddings: body.requests.map(() => ({ values: embedding })) });
      }
      return Response.json({ candidates: [{ content: { parts: [{ text: "Rates are unchanged [1]." }] } }] });
    }
    return new Response(RSS, { headers: { "Content-Type": "application/rss+xml" } });
  });
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const waits: Promise<unknown>[] = [];
  const env = {
    USER_STATE: memoryKv(),
    VECTORIZE: memoryVectorize() as unknown as VectorizeIndex,
    GEMINI_API_KEY: "test-key",
    CHAT_MODEL: "gemini-test",
    EMBEDDING_MODEL: "embed-test",
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD: AUD,
  } satisfies Env;
  const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  let cookie = "";
  // By default every request carries a valid Access token, as if Access let it through.
  let accessToken: string | null = null;
  const call = async (path: string, init: RequestInit = {}, { signedIn = true, token }: { signedIn?: boolean; token?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("Cookie", cookie);
    if (signedIn) headers.set("Cf-Access-Jwt-Assertion", token ?? (accessToken ??= await signToken()));
    if (init.body) headers.set("Content-Type", "application/json");
    const res = await worker.fetch(new Request(`https://app.test${path}`, { ...init, headers }) as any, env, ctx);
    const setCookie = res.headers.get("Set-Cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const body = res.headers.get("Content-Type")?.includes("json") ? await res.json() : null;
    return { status: res.status, body: body as any, headers: res.headers };
  };
  const embedCalls = () => geminiRequests.filter((r) => r.url.includes(":batchEmbedContents")).length;
  return { env, call, embedCalls, flush: () => Promise.all(waits) };
}

describe("worker", () => {
  it("fetches a feed, applies limits and dislikes, indexes it, and answers chat with citations", async () => {
    const { env, call, embedCalls, flush } = setup();

    const first = await call("/api/feed/1");
    expect(first.status).toBe(200);
    expect(first.body.articles.map((a: any) => a.link)).toEqual(["https://news.test/fed", "https://news.test/cup"]);
    await flush();
    expect((env.VECTORIZE as any).vectors.size).toBe(2);

    await call("/api/articles/dislike", { method: "POST", body: JSON.stringify({ link: "https://news.test/cup", title: "cup" }) });
    await call("/api/preferences/source", { method: "POST", body: JSON.stringify({ sourceId: "1", liked: true, maxArticles: 1 }) });

    const mine = await call("/api/feed");
    expect(mine.body.articles.map((a: any) => a.link)).toEqual(["https://news.test/fed"]);

    // Re-fetching must not re-embed articles that are already indexed.
    await flush();
    const before = embedCalls();
    await call("/api/feed/1");
    await flush();
    expect(embedCalls()).toBe(before);

    const chat = await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "What did the Fed do?" }) });
    expect(chat.status).toBe(200);
    expect(chat.body.reply).toBe("Rates are unchanged [1].");
    expect(chat.body.sources).toEqual([
      { title: "Fed holds interest rates steady", link: "https://news.test/fed", source: "World News (BBC)" },
    ]);

    const generate = geminiRequests.find((r) => r.url.includes(":generateContent"))!;
    expect(generate.url).toContain("models/gemini-test:generateContent");
    expect(generate.body.contents.at(-1).parts[0].text).toContain("[1] Fed holds interest rates steady");

    const session = await call("/api/chat");
    expect(session.body.email).toBe("alice@example.com");
    expect(session.body.history).toEqual([
      { role: "user", text: "What did the Fed do?" },
      { role: "model", text: "Rates are unchanged [1]." },
    ]);

    await call("/api/chat", { method: "DELETE", body: "{}" });
    expect((await call("/api/chat")).body.history).toEqual([]);
  });

  it("keeps chat history to the last 5 exchanges", async () => {
    const { call } = setup();
    for (let i = 0; i < 7; i++) {
      await call("/api/chat", { method: "POST", body: JSON.stringify({ message: `q${i}` }) });
    }
    const history = (await call("/api/chat")).body.history;
    expect(history).toHaveLength(10);
    expect(history[0]).toEqual({ role: "user", text: "q2" });
  });

  it("locks chat, but not the reader, for requests without an Access token", async () => {
    const { call } = setup();
    await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "seed history" }) });

    for (const [path, init] of [
      ["/api/chat", { method: "POST", body: JSON.stringify({ message: "hi" }) }],
      ["/api/chat", {}],
      ["/api/chat", { method: "DELETE", body: "{}" }],
      ["/api/chat/login", {}],
    ] as const) {
      const res = await call(path, init, { signedIn: false });
      expect(res.status, `${init.method ?? "GET"} ${path}`).toBe(401);
    }
    expect(geminiRequests.filter((r) => r.url.includes(":generateContent"))).toHaveLength(1);

    expect((await call("/api/sources", {}, { signedIn: false })).status).toBe(200);
    expect((await call("/api/feed/1", {}, { signedIn: false })).status).toBe(200);
    const prefs = await call("/api/preferences", {}, { signedIn: false });
    expect(prefs.status).toBe(200);
    expect(prefs.body.chatHistory).toBeUndefined();
  });

  it("keeps chat history per signed-in user, even on a shared browser", async () => {
    const { call } = setup();
    await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "alice's question" }) });

    const bob = await signToken({ email: "bob@example.com" });
    const bobSession = await call("/api/chat", {}, { token: bob });
    expect(bobSession.body).toEqual({ email: "bob@example.com", history: [] });

    const aliceSession = await call("/api/chat");
    expect(aliceSession.body.history[0]).toEqual({ role: "user", text: "alice's question" });
  });

  it("redirects back to the app after signing in", async () => {
    const { call } = setup();
    const res = await call("/api/chat/login");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://app.test/");
  });

  it("reports feed errors as 502", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    const { call } = setup();
    const res = await call("/api/feed/1");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/HTTP 500/);
  });
});
