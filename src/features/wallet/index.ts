/**
 * Wallet 功能公共出口，外部调用方只能从这里访问。
 * 宿主专用的装配能力（队列关闭、写入命令）在 composition 出口。
 */
export { default as WalletScreen } from './presentation/WalletScreen';
export { default as WalletHistoryScreen } from './presentation/HistoryScreen';
export { default as WalletHistoryDetailScreen } from './presentation/HistoryDetailScreen';
export type { ViewType } from './presentation/historyTypes';
export {
  decodeWalletHistoryRangeId,
  encodeWalletHistoryRangeId,
} from './presentation/historyRoute';
export { GetLedgerContextTool } from './aiTools/GetLedgerContextTool';
export { AddLedgerRecordTool, UpdateLedgerRecordTool, DeleteLedgerRecordTool } from './aiTools/LedgerRecordTools';
export {
  CreateLedgerQuickActionTool,
  UpdateLedgerQuickActionTool,
  DeleteLedgerQuickActionTool,
  UseLedgerQuickActionTool,
} from './aiTools/LedgerQuickActionTools';
export { ledgerRepository } from './infrastructure/SQLiteLedgerRepository';
export { configureWalletRuntime } from './composition';
export type { WalletChatReplyGateway } from './application/TriggerLedgerAIReply';
