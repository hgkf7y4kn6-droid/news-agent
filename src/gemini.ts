const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Must match the dimensions the Vectorize index was created with. */
export const EMBEDDING_DIMENSIONS = 768;
const EMBED_BATCH_SIZE = 100;

export type EmbeddingTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export interface ChatTurn {
  role: "user" | "model";
  text: string;
}

export interface GeminiEnv {
  GEMINI_API_KEY?: string;
  CHAT_MODEL: string;
  EMBEDDING_MODEL: string;
}

export class GeminiError extends Error {}

async function callGemini<T>(env: GeminiEnv, path: string, body: unknown): Promise<T> {
  if (!env.GEMINI_API_KEY) throw new GeminiError("GEMINI_API_KEY is not configured");
  const res = await fetch(`${API_BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GeminiError(`Gemini ${path} failed (HTTP ${res.status}): ${detail.slice(0, 300)}`);
  }
  return res.json<T>();
}

export async function embedTexts(env: GeminiEnv, texts: string[], taskType: EmbeddingTask): Promise<number[][]> {
  const model = `models/${env.EMBEDDING_MODEL}`;
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const data = await callGemini<{ embeddings: Array<{ values: number[] }> }>(env, `${model}:batchEmbedContents`, {
      requests: batch.map((text) => ({
        model,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: EMBEDDING_DIMENSIONS,
      })),
    });
    vectors.push(...data.embeddings.map((e) => e.values));
  }
  return vectors;
}

export async function generateReply(env: GeminiEnv, systemInstruction: string, turns: ChatTurn[]): Promise<string> {
  const data = await callGemini<{
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
  }>(env, `models/${env.CHAT_MODEL}:generateContent`, {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
  });

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim();
  if (text) return text;
  const reason = data.promptFeedback?.blockReason ?? data.candidates?.[0]?.finishReason ?? "empty response";
  throw new GeminiError(`Gemini returned no text (${reason})`);
}
