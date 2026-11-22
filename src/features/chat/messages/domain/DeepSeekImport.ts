import type { ChatAttachment } from './ChatAttachment';

/** 已入库历史使用这个来源值，摘要领取按同一个值排除所有 DeepSeek 导入。 */
export const DEEPSEEK_HISTORY_IMPORT_SOURCE = 'deepseek_share';

export interface DeepSeekExportFile {
  fileName: string;
  archivePath?: string;
  isImage: boolean;
  fileSize: number | null;
  width: number | null;
  height: number | null;
}

export interface DeepSeekExportMessage {
  id: number;
  role: 'USER' | 'ASSISTANT';
  timestamp: number;
  text: string;
  thinking: string;
  files: DeepSeekExportFile[];
}

export interface DeepSeekConversation {
  messages: DeepSeekExportMessage[];
  hasHistoryGap: boolean;
}

export interface DeepSeekExportConversation {
  id: string;
  title: string;
  messageCount: number;
}

export interface DeepSeekExportArchive {
  conversations: readonly DeepSeekExportConversation[];
  readConversation(id: string, signal: AbortSignal): Promise<DeepSeekConversation>;
  extractAttachments(conversation: DeepSeekConversation, signal: AbortSignal): Promise<{
    files: ReadonlyMap<DeepSeekExportFile, ChatAttachment>;
    dispose(): void;
  }>;
  dispose(): void;
}
