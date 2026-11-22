import type { DatabaseTransactionExecutor } from '@platform/persistence';
import type { ChatFavorite, ChatFavoriteCategory, ChatFavoriteCursor, ChatFavoritePage, ChatFavoriteRef, ChatFavoriteSearch } from './ChatFavorite';

export interface ChatFavoriteRepository {
  getBySource(messageId: number): Promise<ChatFavorite | null>;
  getBySourceInTransaction(transaction: DatabaseTransactionExecutor, messageId: number): Promise<ChatFavorite | null>;
  /** 列表页一次性判断多行收藏状态，避免逐行查询。 */
  listRefsBySources(messageIds: readonly number[]): Promise<ChatFavoriteRef[]>;
  createInTransaction(transaction: DatabaseTransactionExecutor, favorite: ChatFavorite): Promise<void>;
  list(category: ChatFavoriteCategory | null, cursor: ChatFavoriteCursor | null, search: ChatFavoriteSearch | null): Promise<ChatFavoritePage>;
  removeInTransaction(transaction: DatabaseTransactionExecutor, id: string): Promise<string[]>;
}
