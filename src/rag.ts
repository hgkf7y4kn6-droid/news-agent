import type { Article } from "./feeds";
import { embedTexts, type GeminiEnv } from "./gemini";

export interface RagEnv extends GeminiEnv {
  VECTORIZE?: VectorizeIndex;
}

// gemini-embedding-001 cosine scores for unrelated text sit well above 0, so this is stricter than a naive cutoff.
const MIN_RELEVANCE = 0.55;
const GET_BY_IDS_BATCH = 20;

export function ragEnabled(env: RagEnv): boolean {
  return Boolean(env.GEMINI_API_KEY && env.VECTORIZE);
}

/** Vectorize ids are capped at 64 bytes, so key articles by the SHA-256 of their link. */
export async function articleId(link: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(link));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function documentText(a: Article): string {
  return `${a.title}\n${a.source}\n${a.summary}`;
}

/** Embeds and stores any articles not already in the index. Returns how many were added. */
export async function indexArticles(env: RagEnv, articles: Article[]): Promise<number> {
  if (!ragEnabled(env) || articles.length === 0) return 0;
  const index = env.VECTORIZE!;

  const unique = [...new Map(articles.map((a) => [a.link, a])).values()];
  const ids = await Promise.all(unique.map((a) => articleId(a.link)));

  const existing = new Set<string>();
  for (let i = 0; i < ids.length; i += GET_BY_IDS_BATCH) {
    const found = await index.getByIds(ids.slice(i, i + GET_BY_IDS_BATCH));
    found.forEach((v) => existing.add(v.id));
  }

  const fresh = unique.map((a, i) => ({ article: a, id: ids[i] })).filter(({ id }) => !existing.has(id));
  if (fresh.length === 0) return 0;

  const vectors = await embedTexts(env, fresh.map(({ article }) => documentText(article)), "RETRIEVAL_DOCUMENT");
  await index.upsert(
    fresh.map(({ article, id }, i) => ({
      id,
      values: vectors[i],
      metadata: {
        title: article.title,
        link: article.link,
        summary: article.summary,
        source: article.source,
        sourceId: article.sourceId,
        published: article.published ?? "",
      },
    })),
  );
  return fresh.length;
}

export async function searchArticles(
  env: RagEnv,
  query: string,
  topK: number,
  excludeLinks: Set<string>,
): Promise<Article[]> {
  if (!ragEnabled(env)) return [];
  const [vector] = await embedTexts(env, [query], "RETRIEVAL_QUERY");
  const result = await env.VECTORIZE!.query(vector, { topK: Math.min(topK + excludeLinks.size, 20), returnMetadata: "all" });

  return result.matches
    .filter((m) => m.score >= MIN_RELEVANCE && m.metadata)
    .map((m) => {
      const md = m.metadata as Record<string, string>;
      return {
        title: md.title,
        link: md.link,
        summary: md.summary,
        source: md.source,
        sourceId: md.sourceId,
        published: md.published || null,
      };
    })
    .filter((a) => !excludeLinks.has(a.link))
    .slice(0, topK);
}
