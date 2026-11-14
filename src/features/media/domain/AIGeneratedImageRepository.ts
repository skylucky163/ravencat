import type { DatabaseTransactionExecutor } from '@platform/persistence';
export interface AIGeneratedImageRepository {
  addInTransaction(transaction: DatabaseTransactionExecutor, input: { assistantId: string; mediaAssetId: string; fileName: string }): Promise<void>;
}
