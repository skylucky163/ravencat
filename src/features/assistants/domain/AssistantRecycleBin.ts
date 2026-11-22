/** 回收期限属于助手生命周期；恢复和清理必须在同一事务中竞争这份事实。 */
export const ASSISTANT_RECYCLE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 用户操作的已提交事实；任命关系不随数据恢复而恢复。 */
export type AssistantRecycleLifecycleChange = {
  assistantId: string; assistantDisplayName: string; occurredAt: string; deletedAt: string;
} & ({ change: 'recycled'; wasHost: boolean; wasLedger: boolean } | { change: 'restored' });

export interface RecycledAssistant {
  id: string;
  agentId: string;
  name: string;
  nickname: string | null;
  avatar: string | null;
  avatarMediaAssetId: string | null;
  deletedAt: string;
  expiresAt: string;
}

export interface AssistantRecycleBinRepository {
  list(): Promise<RecycledAssistant[]>;
  recycle<T>(id: string, suspend: (tx: import('@platform/persistence').DatabaseTransactionExecutor, change: AssistantRecycleLifecycleChange) => Promise<T>): Promise<{ wasHost: boolean; afterCommit: T } | null>;
  restore<T>(id: string, now: Date, record: (tx: import('@platform/persistence').DatabaseTransactionExecutor, change: AssistantRecycleLifecycleChange) => Promise<T>): Promise<{ afterCommit: T } | null>;
  getDeletion(id: string): Promise<{ deletedAt: string } | null>;
  listExpired(now: Date): Promise<{ id: string; deletedAt: string }[]>;
  getNextExpiry(): Promise<number | null>;
}
