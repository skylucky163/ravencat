/** AI 主理、冷却与拉黑状态的持久化端口。 */

export interface HostCooldownStatus {
  isInCooldown: boolean;
  remainingDays: number;
  revokedAIId: string | null;
  endAt: string | null;
}

export type HostAppointmentAvailability =
  | { status: 'occupied' | 'vacant' }
  | { status: 'cooldown'; endAt: string };

export const HOST_AI_APPOINTMENT_COOLDOWN_MS = 168 * 60 * 60 * 1000;
export const HOST_AI_RELATIONSHIP_STATE_ID = 'default';

export function createHostAIAppointmentCooldown(now: Date): {
  startAt: string;
  endAt: string;
} {
  if (!Number.isFinite(now.getTime())) {
    throw new Error('主理 AI 撤销时间非法');
  }
  return {
    startAt: now.toISOString(),
    endAt: new Date(now.getTime() + HOST_AI_APPOINTMENT_COOLDOWN_MS).toISOString(),
  };
}

export type HostRelationshipErrorCode =
  | 'assistant_not_found'
  | 'assistant_blocked'
  | 'assistant_model_unconfigured'
  | 'host_already_assigned'
  | 'host_appointment_cooldown_active';

export class HostRelationshipError extends Error {
  constructor(
    public readonly code: HostRelationshipErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'HostRelationshipError';
  }
}

export interface BlockAIParams {
  aiId: string;
  /**
   * 系统内部字段：执行拉黑动作的 host AI 的 ai_assistants.id。
   * 注意：这不是给 AI 暴露的 agentId，而是系统关系键。
   */
  blockedByAIId: string;
  blockedUntil: string;
  reason?: string | null;
}

export interface BlockedAIRecord {
  id: string;
  aiId: string;
  /**
   * 系统内部字段：执行拉黑动作的 host AI 的 ai_assistants.id。
   */
  blockedByAIId: string;
  blockedUntil: string;
  reason?: string | null;
  createdAt?: string;
}

export interface IAIHostRepository {
  getCurrentHostAIId(): Promise<string | null>;
  setHostAI(aiId: string): Promise<boolean>;
  revokeHostAI(aiId: string): Promise<boolean>;
  checkHostCooldown(): Promise<HostCooldownStatus>;
  releaseAppointmentCooldown(actorAIId: string): Promise<boolean>;
  blockAI(params: BlockAIParams): Promise<BlockedAIRecord>;
  unblockAI(blacklistId: string): Promise<boolean>;
  isAIBlocked(aiId: string): Promise<{ isBlocked: boolean; blockInfo: BlockedAIRecord | null }>;
  cleanupExpiredBlocks(): Promise<boolean>;
}
