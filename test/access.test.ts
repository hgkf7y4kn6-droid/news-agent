import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeChat, AuthError, resetAccessKeyCache, type AccessEnv } from "../src/access";
import { AUD, CERTS_URL, certsResponse, signToken, TEAM_DOMAIN } from "./helpers/access";

const env: AccessEnv = { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUD };

const request = (token?: string, host = "news.example.com") =>
  new Request(`https://${host}/api/chat`, { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} });

async function expectAuthError(promise: Promise<unknown>, status: number, message?: RegExp) {
  const err = await promise.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(AuthError);
  expect(err.status).toBe(status);
  if (message) expect(err.message).toMatch(message);
}

let certFetches = 0;
beforeEach(() => {
  resetAccessKeyCache();
  certFetches = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo) => {
    if (String(input) === CERTS_URL) {
      certFetches++;
      return certsResponse();
    }
    return new Response("unexpected", { status: 500 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("authorizeChat", () => {
  it("accepts a valid Access token and returns the email", async () => {
    expect(await authorizeChat(request(await signToken({ email: "Alice@Example.com" })), env)).toEqual({ email: "alice@example.com" });
  });

  it("accepts a team domain given as a URL", async () => {
    const user = await authorizeChat(request(await signToken()), { ...env, ACCESS_TEAM_DOMAIN: `https://${TEAM_DOMAIN}/` });
    expect(user.email).toBe("alice@example.com");
  });

  it("caches signing keys between requests", async () => {
    await authorizeChat(request(await signToken()), env);
    await authorizeChat(request(await signToken()), env);
    expect(certFetches).toBe(1);
  });

  it("rejects requests without a token", async () => {
    await expectAuthError(authorizeChat(request(), env), 401, /Sign in/);
  });

  it("fails closed when Access is not configured", async () => {
    await expectAuthError(authorizeChat(request(await signToken()), {}), 503, /not configured/);
  });

  it("rejects a token signed by a different key", async () => {
    await expectAuthError(authorizeChat(request(await signToken({}, { signWithOtherKey: true })), env), 401, /signature/);
  });

  it("rejects a token with an unknown key id", async () => {
    await expectAuthError(authorizeChat(request(await signToken({}, { kid: "nope" })), env), 401, /unknown key/);
  });

  it("rejects a token for another Access application", async () => {
    await expectAuthError(authorizeChat(request(await signToken({ aud: ["other-app"] })), env), 403, /different application/);
  });

  it("rejects a token from another issuer", async () => {
    await expectAuthError(authorizeChat(request(await signToken({ iss: "https://evil.cloudflareaccess.com" })), env), 401, /issuer/);
  });

  it("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    await expectAuthError(authorizeChat(request(await signToken({ exp: past, nbf: past - 60 })), env), 401, /expired/);
  });

  it("rejects a tampered payload", async () => {
    const [h, , s] = (await signToken()).split(".");
    const forged = btoa(JSON.stringify({ iss: `https://${TEAM_DOMAIN}`, aud: [AUD], email: "mallory@example.com", exp: 9e9 }))
      .replace(/=+$/, "");
    await expectAuthError(authorizeChat(request(`${h}.${forged}.${s}`), env), 401, /signature/);
  });

  it("rejects service tokens with no user email", async () => {
    await expectAuthError(authorizeChat(request(await signToken({ email: undefined })), env), 403);
  });

  it("enforces the optional Worker-side allowlist", async () => {
    const restricted = { ...env, CHAT_ALLOWED_EMAILS: "bob@example.com, Carol@example.com" };
    await expectAuthError(authorizeChat(request(await signToken()), restricted), 403, /not allowed/);
    expect((await authorizeChat(request(await signToken({ email: "carol@example.com" })), restricted)).email).toBe("carol@example.com");
  });

  it("only honours CHAT_AUTH_DISABLED on localhost", async () => {
    const dev = { CHAT_AUTH_DISABLED: "true" };
    expect(await authorizeChat(request(undefined, "localhost:8787"), dev)).toEqual({ email: "local-dev" });
    await expectAuthError(authorizeChat(request(undefined, "news.example.com"), dev), 503);
  });
});
