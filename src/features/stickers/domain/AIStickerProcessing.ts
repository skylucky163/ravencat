import type { MediaAsset } from '@features/media';
import type { Sticker, StickerAnnotationMetadata } from './Sticker';
import type { StickerEmbedding } from './StickerEmbedding';
import type { DatabaseTransactionExecutor } from '@platform/persistence';
export type AIStickerCommitGuard = (transaction: DatabaseTransactionExecutor) => Promise<void>;

export type AIStickerOperation = 'recognize' | 'embed';
export interface AIStickerTask {
  operation: AIStickerOperation;
  status: 'processing' | 'succeeded' | 'failed' | 'cancelled';
  error: string | null;
}
export interface AIStickerClaim {
  sticker: Sticker;
  claimId: string;
  operation: AIStickerOperation;
}
export interface AIStickerProcessingRepository {
  create(ownerId: string, asset: MediaAsset, name: string, fileName: string | null, id: string, now: string, guard: AIStickerCommitGuard): Promise<{ sticker: Sticker; reused: boolean }>;
  claim(ownerId: string, stickerId: string, operation: AIStickerOperation, claimId: string, executionId: string, now: string, guard: AIStickerCommitGuard): Promise<AIStickerClaim | null>;
  finish(claim: AIStickerClaim, result: { metadata?: StickerAnnotationMetadata; embedding?: StickerEmbedding; error?: string }, now: string, guard: AIStickerCommitGuard): Promise<boolean>;
  cancel(claim: AIStickerClaim, now: string): Promise<void>;
  getTask(stickerId: string): Promise<AIStickerTask | null>;
  getTasks(stickerIds: readonly string[]): Promise<Map<string, AIStickerTask>>;
}
