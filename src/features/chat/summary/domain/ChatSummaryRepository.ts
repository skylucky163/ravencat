/** 自动摘要只追加；用户与显式编辑工具维护已有正文。 */
import type { ChatCanonicalCursor, ChatContextItem } from './ChatContext';
import type { CallSummarySource } from '@features/calls';
import type { ConversationContextItem } from './ChatSummaryTimeline';
/** 包含首次请求，真正失败后只允许一次自动重试；取消不消耗失败预算。 */
export const CHAT_SUMMARY_MAX_AUTOMATIC_ATTEMPTS = 2;
export interface ChatSummarySegment {
  id: string; conversationId: string; sequence: number; content: string;
  level: 'primary' | 'secondary'; compactionId: string | null; contextSequence: number;
  messageCount: number; batchSize: number | null; sourceStartAt: string | null; sourceEndAt: string | null;
  timeZone: string; createdAt: string; updatedAt: string;
}
export interface ChatSummaryCallBoundary { processedCallIds: string[]; historyStartsAfter: string | null }
export interface ChatSummarySnapshot {
  tasks: ChatSummaryTask[];
  segments: ChatSummarySegment[]; raw: ChatContextItem[];
  settings: ChatSummarySettings; contextSegments: ChatSummarySegment[];
  pendingCalls: CallSummarySource[];
  timeline: ConversationContextItem[];
  fixedStart: { messageId: number; content: string; messageCount: number } | null;
}
export interface ChatSummarySettings {
  generationEnabled: boolean; injectEnabled: boolean;
  secondaryEnabled: boolean; secondaryTokenThreshold: number; fixedMessageId: number | null;
  requestTimeoutSeconds: number; maxOutputTokens: number | null;
  /** null 明确选择当前聊天模型／群管理员；非空值持续引用通用资产。 */
  modelConfigId: string | null; groupTriggerCount: number;
  /** 单聊每次整理的对话条数；null 跟随 AI 的单聊主视角条数，手动设置后固定不再跟随。 */
  primaryLimit: number | null;
}
export type ChatSummarySettingsPatch = Partial<Omit<ChatSummarySettings, 'fixedMessageId'>>;
export const DEFAULT_CHAT_SUMMARY_SETTINGS: ChatSummarySettings = {
  generationEnabled: true, injectEnabled: true, secondaryEnabled: true, secondaryTokenThreshold: 8000, fixedMessageId: null,
  requestTimeoutSeconds: 300, maxOutputTokens: null,
  modelConfigId: null, groupTriggerCount: 40, primaryLimit: null,
};
export type ChatSummaryLevel = 'primary' | 'secondary';
export interface ChatSummaryRequestSettings { requestTimeoutSeconds: number; maxOutputTokens: number | null; modelConfigId: string | null }
export interface ChatSummaryCallDiagnostics {
  httpStatus?: number | null;
  model: string; requestedMaxTokens: number | null; timeoutSeconds: number; durationMs: number;
  promptTokens: number | null; completionTokens: number | null; totalTokens: number | null; cachedTokens: number | null;
  finishReason: string | null; contentCharacters: number; reasoningCharacters: number; serverError: string | null;
}
export interface ChatSummaryFailure { kind: 'timeout' | 'request' | 'output_limit' | 'empty_output' | 'invalid_output' | 'context_overflow' | 'commit_lost'; message: string; retryable: boolean }
export interface ChatSummaryTask {
  id: string; conversationId: string; level: ChatSummaryLevel;
  status: 'running' | 'waiting' | 'failed' | 'completed';
  attemptCount: number; automaticFailures: number; nextAttemptAt: string | null;
  error: (ChatSummaryFailure & { occurredAt: string }) | null; calls: ChatSummaryCallDiagnostics[]; segmentIds: string[];
  createdAt: string; updatedAt: string;
}
export class ChatSummaryGenerationError extends Error {
  constructor(readonly failure: ChatSummaryFailure) { super(failure.message); }
}
export interface ChatSummaryTaskClaim { conversationId: string; claimId: string; generation: number; taskId: string }
export interface SecondaryChatSummaryClaim {
  requestSettings: ChatSummaryRequestSettings;
  taskId: string;
  conversationId: string; claimId: string; generation: number;
  segments: ChatSummarySegment[]; timeZone: string;
}
export interface ChatSummarySearchInput {
  conversationId?: string;
  from?: string; to?: string; keywords?: string[]; offset?: number;
}
export interface ChatSummarySearchPage {
  entries: ChatSummarySegment[]; nextOffset: number | null;
}
export interface ChatSecondarySummary { conversationId: string; content: string }
export interface ChatSummaryTextEdit {
  mode: 'replace_text' | 'replace_all'; oldText: string; newText: string;
}
export class ChatSummaryEditError extends Error {}
/** 原文匹配在持久化事务的当前正文上执行，两级使用相同的精确替换语义。 */
export function editChatSummaryText(original: string, input: ChatSummaryTextEdit): string {
  const index = original.indexOf(input.oldText);
  if (index < 0 || (input.mode === 'replace_all' && original !== input.oldText)) {
    throw new ChatSummaryEditError('摘要原文不匹配或已变化，请重新读取后再编辑');
  }
  if (input.mode === 'replace_text' && original.indexOf(input.oldText, index + 1) !== -1) {
    throw new ChatSummaryEditError('原文片段有多处匹配，请提供更长且唯一的片段');
  }
  const content = original.slice(0, index) + input.newText + original.slice(index + input.oldText.length);
  if (!content.trim()) throw new ChatSummaryEditError('编辑后的摘要正文不能为空');
  return content;
}
export interface ChatSummaryClaim {
  requestSettings: ChatSummaryRequestSettings;
  taskId: string;
  conversationId: string; claimId: string; generation: number; revision: number;
  previous: ChatSummarySegment[]; timeZone: string;
  fromCursor: ChatCanonicalCursor | null; toCursor: ChatCanonicalCursor | null; batchSize: number;
  messages: ConversationContextItem[];
  calls: CallSummarySource[];
}
export interface ChatSummaryAddition {
  id: string; content: string; messages: ConversationContextItem[];
}
export interface ChatSummaryModelInput {
  conversationId: string; timeZone: string; previous: ChatSummarySegment[];
  messages: ConversationContextItem[]; calls: CallSummarySource[];
}
export interface ChatBackgroundContextOptions {
  privateLimit: number; groupLimit: number;
  upperBound?: { messageId: number; createdAt: string };
}
export interface ChatBackgroundContext {
  conversationId: string; kind: 'direct' | 'group'; name: string;
  timeline: ConversationContextItem[]; contextSegments: ChatSummarySegment[];
  /** 退出快照保留正文供用户管理，自动读取另遵循退出时的摘要注入选择。 */
  summaryInjectionEnabled?: boolean;
  membership?: { status: 'left'; exitedAt: string };
}
export interface ChatSummaryRepository {
  captureGroupHistoryInTransaction(transaction: import('@platform/persistence').DatabaseTransactionExecutor, groupId: string, groupName: string): Promise<ChatBackgroundContext>;
  invalidateModelReferencesInTransaction(transaction: import('@platform/persistence').DatabaseTransactionExecutor, modelConfigId: string): Promise<void>;
  invalidateServiceReferencesInTransaction(transaction: import('@platform/persistence').DatabaseTransactionExecutor, serviceConfigId: string): Promise<void>;
  readBackgroundContexts(assistantId: string, currentConversationId: string, options: ChatBackgroundContextOptions): Promise<ChatBackgroundContext[]>;
  readContext(conversationId: string, protectedMessageIds: readonly number[]): Promise<ChatSummarySnapshot>;
  prepareConversations(now: string, conversationIds?: readonly string[]): Promise<{ conversationIds: string[]; pausedConversationIds: string[] }>;
  readQueuedRevision(conversationId: string): Promise<number | null>;
  acknowledgeQueuedRevision(conversationId: string, revision: number): Promise<void>;
  getNextWakeAt(): Promise<string | null>;
  claim(conversationId: string, batchSize: number, claimId: string, now: string, expiresAt: string, timeZone: string, recentWindowLimit: number): Promise<ChatSummaryClaim | null>;
  /** 空 additions 仍成功交接原文游标、通话标记与任务，不创建摘要记录。 */
  appendClaim(claim: ChatSummaryClaim, additions: readonly ChatSummaryAddition[], now: string): Promise<boolean>;
  releaseClaim(claim: ChatSummaryClaim): Promise<void>;
  readSettings(conversationId: string): Promise<ChatSummarySettings>;
  updateSettings(conversationId: string, patch: ChatSummarySettingsPatch): Promise<void>;
  setFixedStart(conversationId: string, messageId: number | null): Promise<void>;
  recordInvocation(claim: ChatSummaryTaskClaim, diagnostics: ChatSummaryCallDiagnostics, now: string): Promise<void>;
  failTask(claim: ChatSummaryTaskClaim, failure: ChatSummaryFailure, now: string): Promise<'failed' | 'waiting' | null>;
  retryTask(conversationId: string, taskId: string, now: string): Promise<void>;
  claimSecondary(conversationId: string, claimId: string, now: string, expiresAt: string, timeZone: string): Promise<SecondaryChatSummaryClaim | null>;
  /** null 正文只消费来源；segmentId 仍作为持久归纳标记，不要求存在对应正文。 */
  appendSecondary(claim: SecondaryChatSummaryClaim, segmentId: string, content: string | null, now: string): Promise<boolean>;
  releaseSecondaryClaim(claim: SecondaryChatSummaryClaim): Promise<void>;
  search(assistantId: string, input: ChatSummarySearchInput): Promise<ChatSummarySearchPage>;
  readSecondaryForAssistant(assistantId: string, conversationId: string): Promise<ChatSecondarySummary>;
  editSecondaryForAssistant(assistantId: string, conversationId: string, input: ChatSummaryTextEdit, now: string): Promise<ChatSecondarySummary>;
  editPrimaryForAssistant(assistantId: string, conversationId: string, segmentId: string, input: ChatSummaryTextEdit, now: string): Promise<ChatSummarySegment>;
  deletePrimaryForAssistant(assistantId: string, conversationId: string, segmentId: string, expectedContent: string): Promise<void>;
  create(conversationId: string, segmentId: string, content: string, now: string, timeZone: string): Promise<void>;
  edit(conversationId: string, segmentId: string, content: string, now: string): Promise<void>;
  replaceSecondary(conversationId: string, expected: readonly ChatSummarySegment[], content: string | null, now: string): Promise<void>;
  delete(conversationId: string, segmentId: string): Promise<void>;
  clear(conversationId: string): Promise<void>;
}
