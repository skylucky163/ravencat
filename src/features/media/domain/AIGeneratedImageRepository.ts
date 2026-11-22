import type { DatabaseTransactionExecutor } from '@platform/persistence';

export interface AIGeneratedImage {
  mediaAssetId: string;
  fileName: string;
  createdAt: string;
}

export type AIGeneratedImageQuery =
  | { mediaAssetId: string }
  | { keyword?: string; limit: number; offset: number };

export interface AIGeneratedImagePage {
  images: AIGeneratedImage[];
  nextOffset: number | null;
}

export interface AIGeneratedImageRepository {
  renameInTransaction(transaction: DatabaseTransactionExecutor, assistantId: string, mediaAssetId: string, fileName: string): Promise<number>;
  deleteInTransaction(transaction: DatabaseTransactionExecutor, assistantId: string, mediaAssetId: string): Promise<number>;
  query(assistantId: string, query: AIGeneratedImageQuery): Promise<AIGeneratedImagePage>;
  addInTransaction(transaction: DatabaseTransactionExecutor, input: { assistantId: string; mediaAssetId: string; fileName: string }): Promise<void>;
}
