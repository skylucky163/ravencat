import type { DatabaseTransactionExecutor } from '@platform/persistence';
import type { ChatFavorite, ChatFavoriteCategory, ChatFavoriteCursor, ChatFavoritePage, ChatFavoriteSearch } from './ChatFavorite';

export interface ChatFavoriteRepository {
  getBySource(messageId: number): Promise<ChatFavorite | null>;
  getBySourceInTransaction(transaction: DatabaseTransactionExecutor, messageId: number): Promise<ChatFavorite | null>;
  createInTransaction(transaction: DatabaseTransactionExecutor, favorite: ChatFavorite): Promise<void>;
  list(category: ChatFavoriteCategory | null, cursor: ChatFavoriteCursor | null, search: ChatFavoriteSearch | null): Promise<ChatFavoritePage>;
  removeInTransaction(transaction: DatabaseTransactionExecutor, id: string): Promise<string[]>;
}
