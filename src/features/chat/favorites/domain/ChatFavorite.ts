import type { MediaAssetChatAttachment } from '../../messages/domain/ChatAttachment';
import type { ChatVoiceMessageMetadata } from '../../messages/domain/chatMessageMetadata';

export type ChatFavoriteCategory = 'text' | 'audio' | 'image' | 'file';
export interface ChatFavoriteSnapshot {
  sourceAssistantId: string | null;
  sourceGroupId: string | null;
  authorAgentId: string | null;
  sourceName: string;
  authorName: string;
  authorKind: 'user' | 'assistant';
  messageCreatedAt: string;
  text: string;
  /** 仅文字收藏保存同一逻辑消息的思维链；旧收藏没有此快照字段。 */
  reasoningText?: string;
  replyToText: string | null;
  attachments: MediaAssetChatAttachment[];
  voice: ChatVoiceMessageMetadata['voice'] | null;
}
export interface ChatFavorite {
  id: string;
  sourceMessageId: number;
  category: ChatFavoriteCategory;
  savedAt: string;
  snapshot: ChatFavoriteSnapshot;
}
export interface ChatFavoriteCursor { savedAt: string; id: string }
export interface ChatFavoritePage { items: ChatFavorite[]; nextCursor: ChatFavoriteCursor | null }
export interface ChatFavoriteListItem extends ChatFavorite { sourceName: string; authorName: string }
export interface ChatFavoriteSearch {
  text: string;
  sourceAssistantIds: string[];
  sourceGroupIds: string[];
  authorAgentIds: string[];
  includeUserAuthor: boolean;
}

export function getChatFavoriteCategory(snapshot: ChatFavoriteSnapshot): ChatFavoriteCategory {
  return snapshot.voice ? 'audio' : snapshot.attachments.some(item => item.type === 'file') ? 'file' : snapshot.attachments.length ? 'image' : 'text';
}
