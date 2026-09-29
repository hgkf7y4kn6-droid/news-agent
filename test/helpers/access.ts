export const TEAM_DOMAIN = "team.cloudflareaccess.com";
export const ISSUER = `https://${TEAM_DOMAIN}`;
export const AUD = "aud-123";
export const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`;
const KID = "test-key-1";

const keyPair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const otherKeyPair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;

const publicJwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: KID };

export const certsResponse = () => Response.json({ keys: [publicJwk] });

const b64url = (data: Uint8Array | string) =>
  btoa(typeof data === "string" ? data : String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export async function signToken(
  overrides: Record<string, unknown> = {},
  { signWithOtherKey = false, kid = KID }: { signWithOtherKey?: boolean; kid?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: ISSUER, aud: [AUD], email: "alice@example.com", iat: now, nbf: now, exp: now + 3600, ...overrides };
  const signingInput = `${b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`;
  const key = signWithOtherKey ? otherKeyPair.privateKey : keyPair.privateKey;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}
