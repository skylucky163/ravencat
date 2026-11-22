import type { ChatAttachment } from './ChatAttachment';

/** 原文搜索独立于摘要进度，只返回仍可见的历史资料。 */
export interface ChatMessageSearchInput {
  conversationId: string;
  keywords: string[];
  from?: string;
  to?: string;
  offset?: number;
}

export interface ChatMessageRecord {
  messageId: number;
  conversationId: string;
  author: { role: 'user' | 'assistant'; name: string; assistantId: string | null };
  text: string;
  createdAt: string;
  attachments?: { attachmentId: string; type: 'file' | 'image'; fileName: string; mediaAssetId?: string }[];
  callId?: string;
  /** 只有用户界面需要原附件来打开预览。 */
  userAttachments?: ChatAttachment[];
  /** 用户检索结果携带收藏资格，界面直接提供入口；模型检索不需要，不设置该字段。 */
  canFavorite?: boolean;
}

export interface ChatCallTranscriptMatch {
  source: 'call';
  callId: string;
  entryId: string;
  conversationId: string;
  author: ChatMessageRecord['author'];
  text: string;
  createdAt: string;
}

export type ChatSearchRecord = ChatMessageRecord | ChatCallTranscriptMatch;

/** Host 装配 Calls 的只读搜索来源，按统一页序查询，不在 Chat 保存通话副本。 */
export type CallTranscriptSearch = (input: ChatMessageSearchInput, assistantId?: string) => {
  sql: string;
  params: (string | number)[];
};

export interface ChatMessageSearchPage {
  entries: ChatSearchRecord[];
  nextOffset: number | null;
}

export class ChatMessageSearchInputError extends Error {}
