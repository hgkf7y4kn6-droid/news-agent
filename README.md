# News Agent

A personal news reader with an AI chat assistant, built as a Cloudflare Worker.

- **62 curated sources** across general news, business, tech & security, science & biotech, health & fitness, and sports.
- **My feed**: star sources to build a combined feed, set a max article count per source, and hide articles you don't want to see again.
- **Chat** (approved users only, via Cloudflare Access): ask about the news. Articles you load are embedded with Gemini and stored in Cloudflare Vectorize, and the assistant answers with citations to them (retrieval-augmented generation). Keeps the last 5 exchanges of history.

The news reader is public. Each browser gets its own anonymous profile, identified by a cookie. Preferences and chat history are stored in Workers KV. Chat is locked to the people you list in a Cloudflare Access policy (see [Restricting chat to specific users](#restricting-chat-to-specific-users)).

## Architecture

| Piece | Where |
| --- | --- |
| HTTP API + routing | `src/index.ts` |
| Source catalog (RSS URLs) | `src/sources.ts` |
| RSS / Atom / RDF parsing | `src/feeds.ts` |
| Gemini REST client (chat + embeddings) | `src/gemini.ts` |
| Vector indexing and search | `src/rag.ts` (Cloudflare Vectorize) |
| Per-user preferences & chat history | `src/state.ts` (Workers KV) |
| Cloudflare Access token check for chat | `src/access.ts` |
| Web UI | `public/index.html` (Workers static assets) |

## Deploy to Cloudflare

Prerequisites: Node.js 20+, a Cloudflare account, and a Gemini API key from <https://aistudio.google.com/apikey>.

```bash
npm install
npx wrangler login

# 1. KV namespace for user preferences. Copy the printed id into wrangler.jsonc (replace REPLACE_WITH_KV_NAMESPACE_ID).
npx wrangler kv namespace create USER_STATE

# 2. Vector index for chat retrieval. The dimensions must match EMBEDDING_DIMENSIONS in src/gemini.ts.
npx wrangler vectorize create news-articles --dimensions=768 --metric=cosine

# 3. Gemini API key, stored as a secret.
npx wrangler secret put GEMINI_API_KEY

# 4. Deploy.
npm run deploy
```

Chat stays locked until you complete the Access setup below. The news reader works immediately.

Wrangler prints your `*.workers.dev` URL. To use your own domain, add a route or custom domain in the Cloudflare dashboard (Workers & Pages → news-agent → Settings → Domains & Routes).

After deploying, open `https://<your-worker>/api/health/feeds` to see which feeds are responding. Publishers occasionally move or retire feeds, so fix any failing URL in `src/sources.ts`.

## Restricting chat to specific users

Chat uses your Gemini quota, so it's limited to the people you approve. There are two layers:

1. **A Cloudflare Access application** on the `/api/chat` path. It shows a login page and only lets through the people in its policy. Access is free for up to 50 users.
2. **A check in the Worker** (`src/access.ts`). It verifies the signed token (JWT) that Access adds to each request it lets through: signature, audience, issuer and expiry. Chat fails closed. It stays locked whenever that token is missing or invalid, including when Access isn't configured and when a request reaches the Worker through an unprotected hostname such as `*.workers.dev`.

The rest of the site (sources, feeds, preferences) stays public.

### Setup

1. **Use a custom domain.** Access protects a hostname and path on a domain in your Cloudflare account. In the dashboard, open Workers & Pages → news-agent → Settings → Domains & Routes and add a custom domain, e.g. `news.example.com`.
2. **Create the Access application.** In the [Zero Trust dashboard](https://one.dash.cloudflare.com/), open Access → Applications → Add an application → Self-hosted.
   - Application domain: `news.example.com`, path `api/chat`. The path also covers `/api/chat/login`.
   - Add a policy with action **Allow**, and include **Emails** listing each approved address (or **Emails ending in** `@yourcompany.com`).
   - Login methods: One-time PIN (a code emailed to the user) works with no extra setup. You can add Google, GitHub and others under Settings → Authentication.
3. **Point the Worker at the application.** Set these in `wrangler.jsonc`, then run `npm run deploy`:
   - `ACCESS_TEAM_DOMAIN`: your team domain, e.g. `myteam.cloudflareaccess.com` (Zero Trust → Settings → Custom Pages).
   - `ACCESS_AUD`: the **Application Audience (AUD) Tag** from the application's Overview tab.
4. **Optional:** set `"workers_dev": false` in `wrangler.jsonc` so the site is only served from your custom domain. Chat is locked on `workers.dev` either way.

Chat history is stored per signed-in email, so it follows each person across devices, and people who share a browser don't see each other's conversations.

To add or remove people later, edit the Access policy. You don't need to redeploy. If you also want the Worker to enforce the list itself, set `CHAT_ALLOWED_EMAILS` to a comma-separated list. It's checked in addition to the Access policy.

When a signed-out visitor opens the site, the chat panel shows **Sign in to chat**. That link goes to `/api/chat/login`: Access shows its login page, then the visitor is sent back to the app. **Sign out** uses Access's `/cdn-cgi/access/logout`.

## Local development

```bash
cp .dev.vars.example .dev.vars   # then add your GEMINI_API_KEY
npm run dev                      # http://localhost:8787
```

Access isn't in front of `wrangler dev`, so `.dev.vars.example` sets `CHAT_AUTH_DISABLED=true`. The Worker only honours this for requests to `localhost`, so setting it on a deployed Worker won't unlock chat.

Vectorize can't be emulated locally, so `wrangler dev` connects to the real `news-articles` index (`"remote": true` in `wrangler.jsonc`). You need to be logged in (`npx wrangler login`), and the index must exist. KV is simulated locally.

Checks:

```bash
npm run typecheck
npm test
```

## Configuration

These are set in `wrangler.jsonc` under `vars`:

| Variable | Default | Notes |
| --- | --- | --- |
| `CHAT_MODEL` | `gemini-3.8-flash` | Any Gemini model that supports `generateContent`. Change it here when Google releases or retires models; no code changes needed. |
| `EMBEDDING_MODEL` | `gemini-embedding-001` | If you change it, recreate the Vectorize index. |
| `ACCESS_TEAM_DOMAIN` | empty | Required for chat, e.g. `myteam.cloudflareaccess.com`. |
| `ACCESS_AUD` | empty | Required for chat: the Access application's AUD tag. |
| `CHAT_ALLOWED_EMAILS` | empty | Optional comma-separated allowlist, checked by the Worker. |

If there's no Vectorize binding, chat still works without article context. If `GEMINI_API_KEY` isn't set, or Access isn't configured, the reader works and chat is disabled.

## API

| Method & path | Description |
| --- | --- |
| `GET /api/sources` | Catalog grouped by category, with your liked/limit settings |
| `GET /api/feed/:sourceId[?limit=N]` | Articles from one source |
| `GET /api/feed` | Combined feed from your starred sources |
| `GET /api/preferences` | Your liked sources, limits and hidden articles |
| `POST /api/preferences/source` | `{ sourceId, liked?, maxArticles? }` (`maxArticles: null` resets to the default) |
| `POST /api/articles/dislike` | `{ link, title, source }` hides an article |
| `DELETE /api/articles/dislike` | `{ link }` un-hides it |
| `GET /api/chat` 🔒 | `{ email, history }` for the signed-in user |
| `GET /api/chat/login` 🔒 | Browser sign-in entry point; redirects to `/` |
| `POST /api/chat` 🔒 | `{ message }` returns `{ reply, sources }` |
| `DELETE /api/chat` 🔒 | Clears chat history |
| `GET /api/health` | Configuration status |
| `GET /api/health/feeds` | Live check of every feed |

🔒 means the route requires a valid Cloudflare Access token. Requests that aren't `GET` must send `Content-Type: application/json`.
