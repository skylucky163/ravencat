import type { DatabaseTransactionExecutor } from '@platform/persistence';

export interface AIDownloadedImage {
  mediaAssetId: string;
  fileName: string;
  sourceUrl: string;
  createdAt: string;
}

export type AIDownloadedImageQuery =
  | { mediaAssetId: string }
  | { keyword?: string; limit: number; offset: number };

export interface AIDownloadedImagePage {
  images: AIDownloadedImage[];
  nextOffset: number | null;
}

export interface AIDownloadedImageRepository {
  renameInTransaction(transaction: DatabaseTransactionExecutor, assistantId: string, mediaAssetId: string, fileName: string): Promise<number>;
  deleteInTransaction(transaction: DatabaseTransactionExecutor, assistantId: string, mediaAssetId: string): Promise<number>;
  query(assistantId: string, query: AIDownloadedImageQuery): Promise<AIDownloadedImagePage>;
  addInTransaction(transaction: DatabaseTransactionExecutor, input: {
    assistantId: string; mediaAssetId: string; sourceUrl: string; fileName: string;
  }): Promise<void>;
}
