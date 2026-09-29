import type { ChatTurn } from "./gemini";

export interface DislikedArticle {
  link: string;
  title: string;
  source: string;
}

export interface UserState {
  likedSources: string[];
  /** sourceId -> max articles to show for that source. */
  sourceMaxArticles: Record<string, number>;
  dislikedArticles: DislikedArticle[];
}

/** 5 full user/assistant exchanges. */
export const MAX_CHAT_TURNS = 10;
const MAX_DISLIKED = 500;
const STATE_TTL_S = 60 * 60 * 24 * 180;

export const emptyState = (): UserState => ({
  likedSources: [],
  sourceMaxArticles: {},
  dislikedArticles: [],
});

const key = (userId: string) => `user:${userId}`;

export async function loadState(kv: KVNamespace, userId: string): Promise<UserState> {
  const stored = await kv.get<Partial<UserState>>(key(userId), "json");
  const { likedSources, sourceMaxArticles, dislikedArticles } = { ...emptyState(), ...stored };
  return { likedSources, sourceMaxArticles, dislikedArticles };
}

export async function saveState(kv: KVNamespace, userId: string, state: UserState): Promise<void> {
  state.dislikedArticles = state.dislikedArticles.slice(-MAX_DISLIKED);
  await kv.put(key(userId), JSON.stringify(state), { expirationTtl: STATE_TTL_S });
}

/** Chat history belongs to the signed-in Access user, not the browser, so it follows them across devices. */
const chatKey = (email: string) => `chat:${email}`;

export async function loadChatHistory(kv: KVNamespace, email: string): Promise<ChatTurn[]> {
  return (await kv.get<ChatTurn[]>(chatKey(email), "json")) ?? [];
}

export async function saveChatHistory(kv: KVNamespace, email: string, history: ChatTurn[]): Promise<void> {
  await kv.put(chatKey(email), JSON.stringify(history.slice(-MAX_CHAT_TURNS)), { expirationTtl: STATE_TTL_S });
}
