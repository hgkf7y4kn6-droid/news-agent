# News Agent

A personal news reader with an AI chat assistant, built as a Cloudflare Worker.

- **62 curated sources** across general news, business, tech & security, science & biotech, health & fitness, and sports.
- **My feed**: star sources to build a combined feed, set a max article count per source, and hide articles you don't want to see again.
- **Chat**: ask about the news. Articles you load are embedded with Gemini and stored in Cloudflare Vectorize, and the assistant answers with citations to them (retrieval-augmented generation). Keeps the last 5 exchanges of history.

Each browser gets its own anonymous profile, identified by a cookie. Preferences and chat history are stored in Workers KV.

## Architecture

| Piece | Where |
| --- | --- |
| HTTP API + routing | `src/index.ts` |
| Source catalog (RSS URLs) | `src/sources.ts` |
| RSS / Atom / RDF parsing | `src/feeds.ts` |
| Gemini REST client (chat + embeddings) | `src/gemini.ts` |
| Vector indexing and search | `src/rag.ts` (Cloudflare Vectorize) |
| Per-user preferences & chat history | `src/state.ts` (Workers KV) |
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

Wrangler prints your `*.workers.dev` URL. To use your own domain, add a route or custom domain in the Cloudflare dashboard (Workers & Pages → news-agent → Settings → Domains & Routes).

After deploying, open `https://<your-worker>/api/health/feeds` to see which feeds are responding. Publishers occasionally move or retire feeds, so fix any failing URL in `src/sources.ts`.

> **Protect your API key.** Anyone who can reach the site can use the chat, which spends your Gemini quota. For a personal deployment, put the Worker behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/). It's free for up to 50 users and needs no code changes.

## Local development

```bash
cp .dev.vars.example .dev.vars   # then add your GEMINI_API_KEY
npm run dev                      # http://localhost:8787
```

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
| `CHAT_MODEL` | `gemini-2.5-flash` | Any Gemini model that supports `generateContent`. |
| `EMBEDDING_MODEL` | `gemini-embedding-001` | If you change it, recreate the Vectorize index. |

If there's no Vectorize binding, chat still works without article context. If `GEMINI_API_KEY` isn't set, the reader works and chat is disabled.

## API

| Method & path | Description |
| --- | --- |
| `GET /api/sources` | Catalog grouped by category, with your liked/limit settings |
| `GET /api/feed/:sourceId[?limit=N]` | Articles from one source |
| `GET /api/feed` | Combined feed from your starred sources |
| `GET /api/preferences` | Your stored state |
| `POST /api/preferences/source` | `{ sourceId, liked?, maxArticles? }` (`maxArticles: null` resets to the default) |
| `POST /api/articles/dislike` | `{ link, title, source }` hides an article |
| `DELETE /api/articles/dislike` | `{ link }` un-hides it |
| `POST /api/chat` | `{ message }` returns `{ reply, sources }` |
| `DELETE /api/chat` | Clears chat history |
| `GET /api/health` | Configuration status |
| `GET /api/health/feeds` | Live check of every feed |

Requests that aren't `GET` must send `Content-Type: application/json`.
