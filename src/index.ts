import { fetchFeed, FeedError, type Article } from "./feeds";
import { GeminiError, generateReply } from "./gemini";
import { indexArticles, ragEnabled, searchArticles, type RagEnv } from "./rag";
import { CATEGORIES, SOURCES, SOURCES_BY_ID } from "./sources";
import { loadState, saveState, type UserState } from "./state";

export interface Env extends RagEnv {
  USER_STATE: KVNamespace;
}

const DEFAULT_ARTICLES_PER_SOURCE = 10;
const MAX_ARTICLES_PER_SOURCE = 50;
const MY_FEED_MAX_ARTICLES = 60;
const RAG_TOP_K = 5;
const MAX_MESSAGE_CHARS = 2000;
const USER_COOKIE = "news_uid";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SYSTEM_PROMPT = `You are a concise, neutral news assistant.
Use the numbered articles provided with each question as your primary source and cite them inline as [1], [2], etc.
If the articles don't cover the question, say so briefly, then answer from general knowledge and note it may be out of date.
Never invent headlines, quotes, figures or links.`;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface RequestContext {
  env: Env;
  ctx: ExecutionContext;
  userId: string;
  request: Request;
  url: URL;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { userId, isNew } = getUserId(request);

    let response: Response;
    try {
      response = await route({ env, ctx, userId, request, url });
    } catch (err) {
      if (err instanceof HttpError) {
        response = json({ error: err.message }, err.status);
      } else if (err instanceof FeedError) {
        response = json({ error: err.message }, 502);
      } else if (err instanceof GeminiError) {
        console.error(err);
        response = json({ error: "The AI service is unavailable right now. Please try again." }, 502);
      } else {
        console.error(err);
        response = json({ error: "Internal server error" }, 500);
      }
    }

    if (isNew) {
      response = new Response(response.body, response);
      response.headers.append(
        "Set-Cookie",
        `${USER_COOKIE}=${userId}; Path=/; Max-Age=${60 * 60 * 24 * 365}; HttpOnly; Secure; SameSite=Lax`,
      );
    }
    return response;
  },
} satisfies ExportedHandler<Env>;

async function route(c: RequestContext): Promise<Response> {
  const { request, url } = c;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (method !== "GET" && method !== "HEAD" && !request.headers.get("Content-Type")?.includes("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }

  if (path === "/api/sources" && method === "GET") return listSources(c);
  if (path === "/api/feed" && method === "GET") return myFeed(c);
  const feedMatch = path.match(/^\/api\/feed\/([^/]+)$/);
  if (feedMatch && method === "GET") return sourceFeed(c, decodeURIComponent(feedMatch[1]));
  if (path === "/api/preferences" && method === "GET") return json(await loadState(c.env.USER_STATE, c.userId));
  if (path === "/api/preferences/source" && method === "POST") return updateSourcePreference(c);
  if (path === "/api/articles/dislike" && method === "POST") return dislikeArticle(c);
  if (path === "/api/articles/dislike" && method === "DELETE") return undislikeArticle(c);
  if (path === "/api/chat" && method === "POST") return chat(c);
  if (path === "/api/chat" && method === "DELETE") return clearChat(c);
  if (path === "/api/health" && method === "GET") return health(c);
  if (path === "/api/health/feeds" && method === "GET") return feedHealth();

  throw new HttpError(404, "Not found");
}

// ---------- Sources & feeds ----------

async function listSources(c: RequestContext): Promise<Response> {
  const state = await loadState(c.env.USER_STATE, c.userId);
  const liked = new Set(state.likedSources);
  return json({
    categories: CATEGORIES.map((name) => ({
      name,
      sources: SOURCES.filter((s) => s.category === name).map((s) => ({
        id: s.id,
        name: s.name,
        liked: liked.has(s.id),
        maxArticles: state.sourceMaxArticles[s.id] ?? null,
      })),
    })),
  });
}

function articleLimit(state: UserState, sourceId: string, url: URL): number {
  const requested = Number(url.searchParams.get("limit"));
  const limit = requested > 0 ? requested : state.sourceMaxArticles[sourceId] ?? DEFAULT_ARTICLES_PER_SOURCE;
  return Math.min(Math.floor(limit), MAX_ARTICLES_PER_SOURCE);
}

function withoutDisliked(articles: Article[], state: UserState): Article[] {
  const disliked = new Set(state.dislikedArticles.map((a) => a.link));
  return articles.filter((a) => !disliked.has(a.link));
}

async function sourceFeed(c: RequestContext, sourceId: string): Promise<Response> {
  const source = SOURCES_BY_ID.get(sourceId);
  if (!source) throw new HttpError(404, `Unknown source "${sourceId}"`);

  const [state, articles] = await Promise.all([loadState(c.env.USER_STATE, c.userId), fetchFeed(source)]);
  c.ctx.waitUntil(indexInBackground(c.env, articles));

  const visible = withoutDisliked(articles, state).slice(0, articleLimit(state, sourceId, c.url));
  return json({ source: { id: source.id, name: source.name, category: source.category }, articles: visible });
}

async function myFeed(c: RequestContext): Promise<Response> {
  const state = await loadState(c.env.USER_STATE, c.userId);
  const liked = state.likedSources.map((id) => SOURCES_BY_ID.get(id)).filter((s) => s !== undefined);

  const results = await Promise.allSettled(liked.map((s) => fetchFeed(s)));
  const articles: Article[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    const source = liked[i];
    if (r.status === "fulfilled") {
      c.ctx.waitUntil(indexInBackground(c.env, r.value));
      articles.push(...withoutDisliked(r.value, state).slice(0, articleLimit(state, source.id, c.url)));
    } else {
      errors.push(r.reason instanceof Error ? r.reason.message : `${source.name} failed`);
    }
  });

  articles.sort((a, b) => (b.published ?? "").localeCompare(a.published ?? ""));
  return json({ articles: articles.slice(0, MY_FEED_MAX_ARTICLES), errors });
}

async function indexInBackground(env: Env, articles: Article[]): Promise<void> {
  try {
    await indexArticles(env, articles);
  } catch (err) {
    console.error("Indexing failed:", err);
  }
}

// ---------- Preferences ----------

async function updateSourcePreference(c: RequestContext): Promise<Response> {
  const body = await readJson<{ sourceId?: string; liked?: boolean; maxArticles?: number | null }>(c.request);
  const sourceId = String(body.sourceId ?? "");
  if (!SOURCES_BY_ID.has(sourceId)) throw new HttpError(400, "Unknown sourceId");

  const state = await loadState(c.env.USER_STATE, c.userId);
  if (typeof body.liked === "boolean") {
    const liked = new Set(state.likedSources);
    body.liked ? liked.add(sourceId) : liked.delete(sourceId);
    state.likedSources = [...liked];
  }
  if (body.maxArticles === null) {
    delete state.sourceMaxArticles[sourceId];
  } else if (body.maxArticles !== undefined) {
    const max = Math.floor(Number(body.maxArticles));
    if (!(max >= 1 && max <= MAX_ARTICLES_PER_SOURCE)) {
      throw new HttpError(400, `maxArticles must be between 1 and ${MAX_ARTICLES_PER_SOURCE}`);
    }
    state.sourceMaxArticles[sourceId] = max;
  }
  await saveState(c.env.USER_STATE, c.userId, state);
  return json(state);
}

async function dislikeArticle(c: RequestContext): Promise<Response> {
  const body = await readJson<{ link?: string; title?: string; source?: string }>(c.request);
  const link = String(body.link ?? "").trim();
  if (!/^https?:\/\//.test(link)) throw new HttpError(400, "A valid article link is required");

  const state = await loadState(c.env.USER_STATE, c.userId);
  if (!state.dislikedArticles.some((a) => a.link === link)) {
    state.dislikedArticles.push({
      link,
      title: String(body.title ?? "").slice(0, 300),
      source: String(body.source ?? "").slice(0, 100),
    });
    await saveState(c.env.USER_STATE, c.userId, state);
  }
  return json({ ok: true });
}

async function undislikeArticle(c: RequestContext): Promise<Response> {
  const { link } = await readJson<{ link?: string }>(c.request);
  const state = await loadState(c.env.USER_STATE, c.userId);
  state.dislikedArticles = state.dislikedArticles.filter((a) => a.link !== link);
  await saveState(c.env.USER_STATE, c.userId, state);
  return json({ ok: true });
}

// ---------- Chat ----------

async function chat(c: RequestContext): Promise<Response> {
  const body = await readJson<{ message?: string }>(c.request);
  const message = String(body.message ?? "").trim();
  if (!message) throw new HttpError(400, "message is required");
  if (message.length > MAX_MESSAGE_CHARS) throw new HttpError(400, `message must be under ${MAX_MESSAGE_CHARS} characters`);
  if (!c.env.GEMINI_API_KEY) throw new HttpError(503, "Chat is not configured: set the GEMINI_API_KEY secret");

  const state = await loadState(c.env.USER_STATE, c.userId);
  const disliked = new Set(state.dislikedArticles.map((a) => a.link));

  let context: Article[] = [];
  try {
    context = await searchArticles(c.env, message, RAG_TOP_K, disliked);
  } catch (err) {
    console.error("Retrieval failed, answering without context:", err);
  }

  const contextBlock = context.length
    ? context
        .map((a, i) => `[${i + 1}] ${a.title}\nSource: ${a.source}${a.published ? ` (${a.published.slice(0, 10)})` : ""}\nLink: ${a.link}\n${a.summary}`)
        .join("\n\n")
    : "No indexed articles matched this question.";

  const reply = await generateReply(c.env, SYSTEM_PROMPT, [
    ...state.chatHistory,
    { role: "user", text: `Relevant articles:\n${contextBlock}\n\nQuestion: ${message}` },
  ]);

  // Store the bare question (not the retrieved context) so history stays small.
  state.chatHistory.push({ role: "user", text: message }, { role: "model", text: reply });
  await saveState(c.env.USER_STATE, c.userId, state);

  return json({
    reply,
    sources: context.map(({ title, link, source }) => ({ title, link, source })),
  });
}

async function clearChat(c: RequestContext): Promise<Response> {
  const state = await loadState(c.env.USER_STATE, c.userId);
  state.chatHistory = [];
  await saveState(c.env.USER_STATE, c.userId, state);
  return json({ ok: true });
}

// ---------- Health ----------

function health(c: RequestContext): Response {
  return json({
    ok: true,
    chat: Boolean(c.env.GEMINI_API_KEY),
    retrieval: ragEnabled(c.env),
    sources: SOURCES.length,
  });
}

/** Fetches every feed and reports which ones are working. Useful after deploying. */
async function feedHealth(): Promise<Response> {
  const results = await Promise.allSettled(SOURCES.map((s) => fetchFeed(s)));
  const report = SOURCES.map((s, i) => {
    const r = results[i];
    return r.status === "fulfilled"
      ? { id: s.id, name: s.name, ok: r.value.length > 0, articles: r.value.length }
      : { id: s.id, name: s.name, ok: false, error: (r.reason as Error).message };
  });
  return json({ working: report.filter((r) => r.ok).length, total: report.length, feeds: report });
}

// ---------- Helpers ----------

function getUserId(request: Request): { userId: string; isNew: boolean } {
  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${USER_COOKIE}=([^;]+)`));
  if (match && UUID_RE.test(match[1])) return { userId: match[1], isNew: false };
  return { userId: crypto.randomUUID(), isNew: true };
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    const body = await request.json();
    if (body && typeof body === "object") return body as T;
  } catch {
    // fall through
  }
  throw new HttpError(400, "Request body must be a JSON object");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
