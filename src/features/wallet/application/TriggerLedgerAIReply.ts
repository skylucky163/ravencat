import type { AIProfile, IAIHostRepository } from '@features/assistants';
import type { WalletRecord } from '../domain/WalletRecord';
import { getRecordsSummary } from '../domain/WalletRecord';
import type { ILedgerRepository } from '../domain/LedgerRepository';

export interface TriggerLedgerAIReplyParams {
  aiProfile: AIProfile;
  newRecords: WalletRecord[];
}

export interface TriggerLedgerAIReplyResult {
  success: boolean;
  error: string | null;
}

export interface WalletChatReplyRequest {
  aiProfile: AIProfile;
  triggerData: string;
  newRecords: WalletRecord[];
}

export interface WalletChatReplyResult {
  sessionId: string | null;
  text: string;
  error: string | null;
}

export interface WalletChatReplyGateway {
  generateReply(request: WalletChatReplyRequest): Promise<WalletChatReplyResult>;
}

export interface TriggerLedgerAIReplyDeps {
  hostRepository: Pick<IAIHostRepository, 'cleanupExpiredBlocks' | 'isAIBlocked'>;
  ledgerRepository: ILedgerRepository;
  chatReplyGateway: WalletChatReplyGateway;
}

export async function triggerLedgerAIReply(
  params: TriggerLedgerAIReplyParams,
  deps: TriggerLedgerAIReplyDeps
): Promise<TriggerLedgerAIReplyResult> {
  const { aiProfile, newRecords } = params;

  if (newRecords.length === 0) {
    return { success: false, error: '缺少新记账记录' };
  }

  if (!aiProfile.apiKey || !aiProfile.model) {
    return { success: false, error: '记账 AI 缺少模型或 API Key 配置' };
  }

  await deps.hostRepository.cleanupExpiredBlocks();
  const blockedState = await deps.hostRepository.isAIBlocked(aiProfile.id);
  if (aiProfile.isBlocked || blockedState.isBlocked) {
    return { success: false, error: '记账 AI 当前已被拉黑，已跳过自动回复' };
  }

  const triggerData = await buildLedgerTriggerData(newRecords, deps.ledgerRepository);
  const chatReply = await deps.chatReplyGateway.generateReply({ aiProfile, triggerData, newRecords });

  if (chatReply.error || !chatReply.sessionId) {
    return {
      success: false,
      error: chatReply.error || '无法为记账 AI 准备会话',
    };
  }

  if (!chatReply.text.trim()) {
    return {
      success: false,
      error: '记账 AI 未生成可用回复',
    };
  }

  return {
    success: true,
    error: null,
  };
}

async function buildLedgerTriggerData(
  newRecords: WalletRecord[],
  ledgerRepository: ILedgerRepository
): Promise<string> {
  const batchIds = new Set(newRecords.map((record) => record.id));
  const targetDate = newRecords[0]?.recordDate;

  const sameDayRecords = targetDate
    ? await ledgerRepository.getRecords({
        startDate: targetDate,
        endDate: targetDate,
        limit: 30,
      })
    : [];

  const earlierRecords = sameDayRecords
    .filter((record) => !batchIds.has(record.id))
    .slice(0, 8);

  const batchExpense = sumAmount(newRecords, 'expense');
  const batchIncome = sumAmount(newRecords, 'income');

  // Wallet 只提供账目资料；交互位置、触发来源与回复要求由 Host 统一装配。
  const lines = [
    '【本次新增记录｜最高优先级】',
    `记录日期：${targetDate || '未知'}`,
    `新增笔数：${newRecords.length}`,
    `本批次支出合计：¥${batchExpense.toFixed(2)}`,
    `本批次收入合计：¥${batchIncome.toFixed(2)}`,
    formatDetailedRecords(newRecords),
    '',
    '【今日较早记录｜低优先级参考】',
    earlierRecords.length > 0
      ? getRecordsSummary(earlierRecords)
      : '今天更早的记录暂无，或无需参考。',
  ];

  return lines.join('\n');
}

function formatDetailedRecords(records: WalletRecord[]): string {
  return records
    .map((record, index) => {
      const typeLabel = record.type === 'expense' ? '支出' : '收入';
      const detail = record.detail ? `（${record.detail}）` : '';
      return `${index + 1}. ${typeLabel} ${record.category}${detail} ¥${record.amount.toFixed(2)}`;
    })
    .join('\n');
}

function sumAmount(records: WalletRecord[], type: WalletRecord['type']): number {
  return records
    .filter((record) => record.type === type)
    .reduce((total, record) => total + record.amount, 0);
}
