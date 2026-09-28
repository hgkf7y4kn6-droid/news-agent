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
  chatHistory: ChatTurn[];
}

/** 5 full user/assistant exchanges. */
export const MAX_CHAT_TURNS = 10;
const MAX_DISLIKED = 500;
const STATE_TTL_S = 60 * 60 * 24 * 180;

export const emptyState = (): UserState => ({
  likedSources: [],
  sourceMaxArticles: {},
  dislikedArticles: [],
  chatHistory: [],
});

const key = (userId: string) => `user:${userId}`;

export async function loadState(kv: KVNamespace, userId: string): Promise<UserState> {
  const stored = await kv.get<Partial<UserState>>(key(userId), "json");
  return { ...emptyState(), ...stored };
}

export async function saveState(kv: KVNamespace, userId: string, state: UserState): Promise<void> {
  state.chatHistory = state.chatHistory.slice(-MAX_CHAT_TURNS);
  state.dislikedArticles = state.dislikedArticles.slice(-MAX_DISLIKED);
  await kv.put(key(userId), JSON.stringify(state), { expirationTtl: STATE_TTL_S });
}
