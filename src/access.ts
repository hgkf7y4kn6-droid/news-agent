/**
 * Verifies the Cloudflare Access JWT that Access attaches to every request it lets through.
 * Checking it in the Worker means chat stays locked even if a request reaches the Worker
 * without passing through Access (e.g. via the *.workers.dev hostname).
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */

export interface AccessEnv {
  /** e.g. "myteam.cloudflareaccess.com" */
  ACCESS_TEAM_DOMAIN?: string;
  /** Application Audience (AUD) tag from the Access application's overview page. */
  ACCESS_AUD?: string;
  /** Optional comma-separated allowlist, checked in addition to the Access policy. */
  CHAT_ALLOWED_EMAILS?: string;
  /** "true" skips the check for local development. Only honoured for requests to localhost. */
  CHAT_AUTH_DISABLED?: string;
}

export interface ChatUser {
  email: string;
}

export class AuthError extends Error {
  constructor(public status: 401 | 403 | 503, message: string) {
    super(message);
  }
}

const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 60;

let jwksCache: { issuer: string; keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;

function isLocalhost(request: Request): boolean {
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function issuerFor(teamDomain: string): string {
  return `https://${teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
}

export async function authorizeChat(request: Request, env: AccessEnv): Promise<ChatUser> {
  if (env.CHAT_AUTH_DISABLED === "true" && isLocalhost(request)) return { email: "local-dev" };
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new AuthError(503, "Chat is locked: Cloudflare Access is not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD)");
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new AuthError(401, "Sign in to use chat");

  const payload = await verifyJwt(token, issuerFor(env.ACCESS_TEAM_DOMAIN), env.ACCESS_AUD);
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (!email) throw new AuthError(403, "Chat requires a signed-in user");

  const allowed = (env.CHAT_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length && !allowed.includes(email)) {
    throw new AuthError(403, `${email} is not allowed to use chat`);
  }
  return { email };
}

async function verifyJwt(token: string, issuer: string, audience: string): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError(401, "Malformed access token");

  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(decodeText(parts[0]));
    payload = JSON.parse(decodeText(parts[1]));
  } catch {
    throw new AuthError(401, "Malformed access token");
  }
  if (header.alg !== "RS256" || !header.kid) throw new AuthError(401, "Unsupported access token");

  const key = await signingKey(issuer, header.kid);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new AuthError(401, "Invalid access token signature");

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== issuer) throw new AuthError(401, "Access token has the wrong issuer");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(audience)) throw new AuthError(403, "Access token is for a different application");
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S < now) throw new AuthError(401, "Access session expired, sign in again");
  if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_S > now) throw new AuthError(401, "Access token not yet valid");
  return payload;
}

async function signingKey(issuer: string, kid: string): Promise<CryptoKey> {
  const fresh = jwksCache && jwksCache.issuer === issuer && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  let key = fresh ? jwksCache!.keys.get(kid) : undefined;
  if (!key) {
    // Unknown kid may mean Access rotated its keys, so refetch before rejecting.
    await loadJwks(issuer);
    key = jwksCache!.keys.get(kid);
  }
  if (!key) throw new AuthError(401, "Access token signed with an unknown key");
  return key;
}

async function loadJwks(issuer: string): Promise<void> {
  const res = await fetch(`${issuer}/cdn-cgi/access/certs`);
  if (!res.ok) throw new AuthError(503, `Could not load Access signing keys (HTTP ${res.status})`);
  const { keys = [] } = await res.json<{ keys?: Array<JsonWebKey & { kid?: string }> }>();
  const imported = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    imported.set(
      jwk.kid,
      await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
    );
  }
  jwksCache = { issuer, keys: imported, fetchedAt: Date.now() };
}

function base64UrlDecode(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function decodeText(input: string): string {
  return new TextDecoder().decode(base64UrlDecode(input));
}

/** Test hook: forget cached signing keys. */
export function resetAccessKeyCache(): void {
  jwksCache = null;
}
