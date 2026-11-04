/**
 * 将 Wallet 应用端口连接到当前仓储与聊天服务。
 * 这是该功能唯一的装配点，应用代码不依赖具体 SQLite 实现或全局仓储单例。
 */
import { aiAssistantRepository, aiHostRepository } from '@features/assistants';
import {
  addWalletRecord as addWalletRecordUseCase,
  type WalletAIReplyCallbacks,
} from './application/AddRecord';
import {
  applyQuickActionAndReply as applyQuickActionAndReplyUseCase,
  type UseQuickActionParams,
  type WalletQuickActionCallbacks,
} from './application/UseQuickAction';
import {
  queueLedgerAIReply as queueLedgerAIReplyUseCase,
  type QueueLedgerAIReplyCallbacks,
  type QueueLedgerAIReplyParams,
} from './application/QueueLedgerAIReply';
import {
  triggerLedgerAIReply as triggerLedgerAIReplyUseCase,
  type TriggerLedgerAIReplyParams,
  type WalletChatReplyGateway,
} from './application/TriggerLedgerAIReply';
import {
  getWalletScreenData as getWalletScreenDataUseCase,
  getWalletCategories as getWalletCategoriesUseCase,
} from './application/WalletPresentation';
import type { CreateWalletRecordInput, UpdateWalletRecordInput } from './domain/LedgerRepository';
import type { QuickAction } from './domain/WalletRecord';
import { ledgerRepository } from './infrastructure/SQLiteLedgerRepository';

let chatReplyGateway: WalletChatReplyGateway;

export function configureWalletRuntime(gateway: WalletChatReplyGateway): void {
  chatReplyGateway = gateway;
}

const queueDeps = {
  getLedgerAI: () => aiAssistantRepository.getLedgerAI(),
  getRecords: (ids: readonly string[]) => ledgerRepository.getRecords({ ids, limit: ids.length }),
  triggerReply: (params: TriggerLedgerAIReplyParams) =>
    triggerLedgerAIReply(params),
};

export { stopLedgerAIReplyQueueForReset, resumeLedgerAIReplyQueueAfterReset } from './application/QueueLedgerAIReply';

const presentationDeps = {
  assistantRepository: aiAssistantRepository,
  ledgerRepository,
};

export const triggerLedgerAIReply = (params: TriggerLedgerAIReplyParams) =>
  triggerLedgerAIReplyUseCase(params, {
    hostRepository: aiHostRepository,
    ledgerRepository,
    chatReplyGateway,
  });

export const queueLedgerAIReply = (
  params: QueueLedgerAIReplyParams,
  callbacks: QueueLedgerAIReplyCallbacks = {}
) => queueLedgerAIReplyUseCase(params, callbacks, queueDeps);

export const addWalletRecord = (
  params: CreateWalletRecordInput,
  callbacks: WalletAIReplyCallbacks = {}
) => addWalletRecordUseCase(params, callbacks, {
  repository: ledgerRepository,
  queueAIReply: queueLedgerAIReply,
});

export const applyQuickActionAndReply = (
  params: UseQuickActionParams,
  callbacks: WalletQuickActionCallbacks = {}
) => applyQuickActionAndReplyUseCase(params, callbacks, {
  repository: ledgerRepository,
  queueAIReply: queueLedgerAIReply,
});

export const getWalletScreenData = (date = new Date()) =>
  getWalletScreenDataUseCase(date, presentationDeps);

export const getWalletCategories = () => getWalletCategoriesUseCase(presentationDeps);

// 这些操作没有额外的应用编排，校验与写入由仓储负责，装配后直接调用即可。
export const deleteWalletRecord = (recordId: string) => ledgerRepository.deleteRecord(recordId);

export const updateWalletRecord = (recordId: string, updates: UpdateWalletRecordInput) =>
  ledgerRepository.updateRecord(recordId, updates);

export const addWalletQuickAction = (action: Partial<QuickAction>) =>
  ledgerRepository.insertQuickAction(action);

export const deleteWalletQuickAction = (id: string) => ledgerRepository.deleteQuickAction(id);

export const getLedgerRangeSummary = (startDate: string, endDate: string) =>
  ledgerRepository.getRangeSummary(startDate, endDate);
