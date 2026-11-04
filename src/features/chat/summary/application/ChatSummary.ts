/** 用户与显式工具可维护已有摘要，自动总结只能消费固定批次并追加。 */
import { buildSharedMomentText } from '../../messages/domain/SharedMoment';
import { randomUUID } from 'expo-crypto';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { emitChatSummaryChanged, getChatSummaryRuntime } from './ChatSummaryRuntime';
import { DEFAULT_CHAT_SUMMARY_SETTINGS, ChatSummaryEditError, type ChatSummaryTextEdit, ChatSummaryGenerationError, type ChatSummaryTaskClaim, type ChatSummaryModelInput, type ChatSummarySettingsPatch, type ChatSummarySearchInput, type ChatSummarySegment , ChatBackgroundContextOptions } from '../domain/ChatSummaryRepository';
import { buildSharedChatRecordText } from '../../messages/domain/SharedChatRecord';
import { getChatConversationRuntimeDependencies } from '../../conversation/application/ChatConversationRuntime';
import type { DatabaseTransactionExecutor } from '@platform/persistence';

/** Host在资产变更事务中调用；正文、进度和配置引用保持不变。 */
export function invalidateChatSummaryServiceReferencesInTransaction(transaction: DatabaseTransactionExecutor, serviceConfigId: string): Promise<void> {
  return getChatSummaryRuntime().repository.invalidateServiceReferencesInTransaction(transaction, serviceConfigId);
}
export function invalidateChatSummaryModelReferencesInTransaction(transaction: DatabaseTransactionExecutor, modelConfigId: string): Promise<void> {
  return getChatSummaryRuntime().repository.invalidateModelReferencesInTransaction(transaction, modelConfigId);
}

function requireSummaryContent(value: string): string {
  const content = value.trim();
  if (!content) throw new Error('摘要正文不能为空');
  return content;
}
export async function getChatSummaryContext(conversationId: string, protectedMessageIds: readonly number[] = []) {
  return getChatSummaryRuntime().repository.readContext(conversationId, protectedMessageIds);
}
export function getChatBackgroundContexts(assistantId: string, currentConversationId: string, options: ChatBackgroundContextOptions) {
  return getChatSummaryRuntime().repository.readBackgroundContexts(assistantId, currentConversationId, options);
}
export async function createChatSummary(conversationId: string, content: string) {
  await getChatSummaryRuntime().repository.create(conversationId, randomUUID(), requireSummaryContent(content), new Date().toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  emitChatSummaryChanged(conversationId);
}
export async function editChatSummary(conversationId: string, segmentId: string, content: string) {
  await getChatSummaryRuntime().repository.edit(conversationId, segmentId, requireSummaryContent(content), new Date().toISOString());
  emitChatSummaryChanged(conversationId);
}
export async function editCombinedSecondarySummary(conversationId: string, expected: readonly ChatSummarySegment[], content: string) {
  await getChatSummaryRuntime().repository.replaceSecondary(conversationId, expected, requireSummaryContent(content), new Date().toISOString());
  emitChatSummaryChanged(conversationId);
}
export async function deleteCombinedSecondarySummary(conversationId: string, expected: readonly ChatSummarySegment[]) {
  await getChatSummaryRuntime().repository.replaceSecondary(conversationId, expected, null, new Date().toISOString());
  emitChatSummaryChanged(conversationId);
}
export function getSecondarySummaryForAssistant(assistantId: string, conversationId: string) {
  return getChatSummaryRuntime().repository.readSecondaryForAssistant(assistantId, conversationId);
}
export async function editSecondarySummaryForAssistant(assistantId: string, conversationId: string, input: ChatSummaryTextEdit) {
  if (!input.oldText.trim()) throw new ChatSummaryEditError('oldText 必须包含要替换的原文');
  const result = await getChatSummaryRuntime().repository.editSecondaryForAssistant(assistantId, conversationId, input, new Date().toISOString());
  emitChatSummaryChanged(conversationId);
  return result;
}
export async function editPrimarySummaryForAssistant(assistantId: string, conversationId: string, segmentId: string, input: ChatSummaryTextEdit) {
  if (!input.oldText.trim()) throw new ChatSummaryEditError('oldText 必须包含要替换的原文');
  const result = await getChatSummaryRuntime().repository.editPrimaryForAssistant(assistantId, conversationId, segmentId, input, new Date().toISOString());
  emitChatSummaryChanged(conversationId);
  return result;
}
export async function deletePrimarySummaryForAssistant(assistantId: string, conversationId: string, segmentId: string, expectedContent: string) {
  await getChatSummaryRuntime().repository.deletePrimaryForAssistant(assistantId, conversationId, segmentId, expectedContent);
  emitChatSummaryChanged(conversationId);
  return { conversationId, segmentId, deleted: true };
}
export async function deleteChatSummary(conversationId: string, segmentId: string) {
  await getChatSummaryRuntime().repository.delete(conversationId, segmentId);
  emitChatSummaryChanged(conversationId);
}
export async function clearChatSummary(conversationId: string) {
  await getChatSummaryRuntime().repository.clear(conversationId);
  emitChatSummaryChanged(conversationId);
}
export class ChatSummaryInputError extends Error {}
/** 阈值在页面草稿边界验证；内部命令信任合法字段，独立增量由 Repository 原子合并。 */
export async function updateChatSummarySettings(conversationId: string, patch: ChatSummarySettingsPatch) {
  await getChatSummaryRuntime().repository.updateSettings(conversationId, patch);
  emitChatSummaryChanged(conversationId);
}
export function getChatSummarySettings(conversationId: string) {
  return getChatSummaryRuntime().repository.readSettings(conversationId);
}
/** 提示词启用状态派生自摘要 owner，不在提示词配置中另存一份开关。 */
export async function getAssistantChatSummaryGenerationState(assistantId: string) {
  const conversation = await getChatConversationRuntimeDependencies().sessions.getCanonicalConversation(assistantId);
  const settings = conversation ? await getChatSummarySettings(conversation.id) : DEFAULT_CHAT_SUMMARY_SETTINGS;
  const primaryEnabled = settings.generationEnabled && settings.fixedMessageId === null;
  return { primaryEnabled, secondaryEnabled: primaryEnabled && settings.secondaryEnabled };
}
export async function setFixedChatContextStart(conversationId: string, messageId: number | null) {
  await getChatSummaryRuntime().repository.setFixedStart(conversationId, messageId);
  emitChatSummaryChanged(conversationId);
}
export async function retryChatSummaryTask(conversationId: string, taskId: string) {
  await getChatSummaryRuntime().repository.retryTask(conversationId, taskId, new Date().toISOString());
  emitChatSummaryChanged(conversationId);
}
async function recordFailure(claim: ChatSummaryTaskClaim, error: unknown, signal: AbortSignal) {
  if (signal.aborted) return false;
  if (!(error instanceof ChatSummaryGenerationError)) throw error;
  const failure = error.failure;
  const now = new Date().toISOString();
  const outcome = await getChatSummaryRuntime().repository.failTask(claim, failure, now);
  if (outcome) emitChatSummaryChanged(claim.conversationId, 'task',
    outcome === 'failed' ? { finalFailure: { ...failure, occurredAt: now } } : undefined);
  return false;
}
export async function searchChatSummaries(assistantId: string, input: ChatSummarySearchInput) {
  const normalizeDate = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw new ChatSummaryInputError('摘要查询时间无效，请提供 ISO 8601 时间');
    return new Date(time).toISOString();
  };
  const from = normalizeDate(input.from), to = normalizeDate(input.to);
  if (from !== undefined && to !== undefined && from > to) throw new ChatSummaryInputError('查询开始时间不能晚于结束时间');
  return getChatSummaryRuntime().repository.search(assistantId, { ...input, from, to });
}
export async function processChatSummary(conversationId: string, signal: AbortSignal): Promise<boolean> {
  const repository = getChatSummaryRuntime().repository;
  const revision = await repository.readQueuedRevision(conversationId);
  const processed = await processQueuedChatSummary(conversationId, signal);
  // 成功后继续消费积压；取消或本地故障不确认，重启仍能从持久队列恢复。
  if (!processed && !signal.aborted && revision !== null) await repository.acknowledgeQueuedRevision(conversationId, revision);
  return processed;
}
async function processQueuedChatSummary(conversationId: string, signal: AbortSignal): Promise<boolean> {
  const runtime = getChatSummaryRuntime();
  const batchSettings = await runtime.getBatchSettings(conversationId);
  if (batchSettings === null) return false;
  // 已有一级达到新阈值时先处理二级；某一层失败不阻止另一层读取自己的可处理范围。
  const existingSecondary = await processSecondaryChatSummary(conversationId, signal);
  if (signal.aborted) return false;
  if (existingSecondary) return true;
  const primary = await processPrimaryChatSummary(conversationId, batchSettings, signal);
  const secondary = primary ? await processSecondaryChatSummary(conversationId, signal) : false;
  return primary || secondary;
}
async function processPrimaryChatSummary(conversationId: string, { batchSize, recentWindowLimit }: { batchSize: number; recentWindowLimit: number }, signal: AbortSignal): Promise<boolean> {
  const runtime = getChatSummaryRuntime();
  throwIfAbortSignalAborted(signal);
  const now = new Date();
  const initialSettings = await runtime.repository.readSettings(conversationId);
  const initialLeaseMs = initialSettings.requestTimeoutSeconds * 1000 + 60_000;
  const expiresAt = new Date(now.getTime() + initialLeaseMs).toISOString();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const claim = await runtime.repository.claim(conversationId, batchSize, randomUUID(), now.toISOString(), expiresAt, timeZone, recentWindowLimit);
  if (!claim) return false;
  // 请求选择与generation必须来自领取事务的同一快照，不能沿用领取前的旧设置。
  const settings = claim.requestSettings;
  emitChatSummaryChanged(conversationId, 'task');
  try {
    // 一次领取只调用一次模型：正文、游标与已处理通话标记在 appendClaim 同事务交接。
    const callIds = new Set(claim.messages.map((message) => message.callId));
    const input: ChatSummaryModelInput = { conversationId, timeZone, previous: claim.previous, messages: claim.messages,
      calls: claim.calls.filter((call) => callIds.has(call.info.callId)) };
    const content = await runtime.generateAddition(input, signal,
      (diagnostics) => runtime.repository.recordInvocation(claim, diagnostics, new Date().toISOString()), settings);
    throwIfAbortSignalAborted(signal);
    const appended = await runtime.repository.appendClaim(claim,
      content === null ? [] : [{ id: randomUUID(), content, messages: claim.messages }], new Date().toISOString());
    // 领取被 settings/clear 递增 generation 撤销时 failTask 同样不落账（状态已易主）；租约过期等
    // 状态仍引用本 claim 的失效必须记账，否则任务被静默放回 waiting 并用同范围无限重试。
    if (!appended) throw new ChatSummaryGenerationError({ kind: 'commit_lost',
      message: '摘要交接时领取已失效或租约已过期，本次结果未保存。', retryable: true });
    emitChatSummaryChanged(conversationId);
    return true;
  } catch (error) { return await recordFailure(claim, error, signal); }
  finally { await runtime.repository.releaseClaim(claim); emitChatSummaryChanged(conversationId, 'task'); }
}
async function processSecondaryChatSummary(conversationId: string, signal: AbortSignal): Promise<boolean> {
  const runtime = getChatSummaryRuntime();
  throwIfAbortSignalAborted(signal);
  const now = new Date();
  const settings = await runtime.repository.readSettings(conversationId);
  const claim = await runtime.repository.claimSecondary(conversationId, randomUUID(), now.toISOString(),
    new Date(now.getTime() + settings.requestTimeoutSeconds * 1000 + 60_000).toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (!claim) return false;
  emitChatSummaryChanged(conversationId, 'task');
  try {
    const request = claim.requestSettings;
    const content = await runtime.generateSecondary(claim, signal,
      (diagnostics) => runtime.repository.recordInvocation(claim, diagnostics, new Date().toISOString()), request);
    throwIfAbortSignalAborted(signal);
    const committed = await runtime.repository.appendSecondary(claim, randomUUID(), content, new Date().toISOString());
    if (!committed) throw new ChatSummaryGenerationError({ kind: 'commit_lost',
      message: '二级摘要交接时领取已失效或来源已变化，本次结果未保存。', retryable: true });
    emitChatSummaryChanged(conversationId);
    return true;
  } catch (error) { return await recordFailure(claim, error, signal); }
  finally { await runtime.repository.releaseSecondaryClaim(claim); emitChatSummaryChanged(conversationId, 'task'); }
}
export async function prepareChatSummaryConversations(requestedConversationIds?: readonly string[]) {
  const { conversationIds, pausedConversationIds } = await getChatSummaryRuntime().repository.prepareConversations(new Date().toISOString(), requestedConversationIds);
  for (const id of pausedConversationIds) emitChatSummaryChanged(id, 'task');
  return conversationIds;
}
export function getNextChatSummaryWakeAt() { return getChatSummaryRuntime().repository.getNextWakeAt(); }
export function buildChatSummaryModelInput(input: ChatSummaryModelInput, currentAgentId?: string): string {
  return JSON.stringify({ sourceKind: 'conversation', currentAgentId, timeZone: input.timeZone,
    calls: input.calls.map((call) => ({ ...call.info, historyStartsAfter: call.historyStartsAfter })),
    previousSummariesReadOnly: input.previous.map((segment) => ({
    content: segment.content, discussionStart: segment.sourceStartAt, discussionEnd: segment.sourceEndAt, timeZone: segment.timeZone,
  })), newMessagesOnly: input.messages.map((message) => ({
    timestamp: message.timestamp, localDateTime: new Date(message.timestamp).toLocaleString('sv-SE', { timeZone: input.timeZone }),
    source: message.source, callId: message.callId, speaker: message.speaker,
    ...(message.isVoiceMessage ? { isVoiceMessage: true } : {}),
    content: message.sharedMoment ? buildSharedMomentText(message.sharedMoment, currentAgentId) : message.sharedRecord ? buildSharedChatRecordText(message.sharedRecord, message.sharedComment!, currentAgentId) : message.content,
    ...(message.actor ? { actor: message.actor } : {}),
  })) });
}
