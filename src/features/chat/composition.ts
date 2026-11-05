/** 仅供 Host 组装 Chat 具体实现；Feature 根公共出口不暴露这些能力。 */

import {
  configureChatConversationRuntime,
  type ChatConversationRuntimeDependencies,
} from './conversation/application/ChatConversationRuntime';
import type { ChatAssistantDirectory } from './ChatAssistantDirectory';
import {
  configureChatMessageRuntime,
  getChatMessageRuntimeDependencies,
  type ChatMessageRuntimeDependencies,
} from './messages/application/ChatMessageRuntime';
import {
  migrateLegacyChatAttachments as migrateLegacyChatAttachmentsUseCase,
  type MigrateLegacyChatAttachmentsResult,
  type MigrateLegacyChatAttachmentsOptions,
} from './messages/application/MigrateLegacyChatAttachments';
import {
  configureChatGroupRuntime,
  type ChatGroupRuntimeDependencies,
} from './group/application/ChatGroupRuntime';
import {
  configureChatReplyRuntime,
  type ChatReplyRuntimeDependencies,
} from './reply/application/ChatReplyRuntimeDependencies';
import { GROUP_TASK_PROMPT_DEFINITIONS } from './group/application/GroupTaskPromptDefinitions';
import { REPLY_TASK_PROMPT_DEFINITIONS } from './reply/application/ReplyTaskPromptDefinitions';
import type { PromptDefinitionDescriptor } from '@shared/prompt';
import type { DatabaseTransactionExecutor } from '@platform/persistence';
import { groupChatRepository } from './group/infrastructure/SQLiteGroupChatRepository';
import type {
  CommitGroupAvatarMediaAssetReferenceInput,
  GroupAvatarMediaAssetMigrationCandidate,
} from './group/domain/GroupChatRepository';

export { configureChatBubbleSkins } from './appearance/application/ChatBubbleSkinRuntime';
export { SQLiteChatBubbleSkinRepository } from './appearance/infrastructure/SQLiteChatBubbleSkinRepository';
export { configureChatTextDrafts } from './conversation/application/ChatTextDraftRuntime';
export { SQLiteChatTextDraftRepository } from './conversation/infrastructure/SQLiteChatTextDraftRepository';
export { interruptAbandonedGroupSpeechPlans } from './group/application/GroupSpeechTermination';
export { configureChatTurnPresentation, configureTurnDisplayPacing, freezeTurnDisplays, interruptSessionTurnDisplays, recoverTurnPresentationDisplays, interruptChatRunPresentation } from './reply/application/ChatTurnPresentationRuntime';
export { chatTurnPresentationRepository } from './reply/infrastructure/SQLiteChatTurnPresentationRepository';

export {
  configureAssistantMessageArrivalRuntime,
  applyAssistantMessageArrivalSnapshot,
} from './reply/delivery/AssistantMessageArrival';

export { configureChatSummaryRuntime } from './summary/application/ChatSummaryRuntime';
export { SQLiteChatSummaryRepository } from './summary/infrastructure/SQLiteChatSummaryRepository';
export { CHAT_SUMMARY_PROMPT_DEFINITIONS, createChatSummaryPromptBlock, createSecondaryChatSummaryPromptBlock } from './summary/application/ChatSummaryPrompt';
export type { ChatSummaryModelInput, SecondaryChatSummaryClaim } from './summary/domain/ChatSummaryRepository';
export { ChatSummaryGenerationError } from './summary/domain/ChatSummaryRepository';
export type { ChatSummaryCallDiagnostics, ChatSummaryRequestSettings } from './summary/domain/ChatSummaryRepository';
export { buildChatSummaryModelInput } from './summary/application/ChatSummary';

export { processChatSummary, prepareChatSummaryConversations, getNextChatSummaryWakeAt } from './summary/application/ChatSummary';
export { invalidateChatSummaryModelReferencesInTransaction, invalidateChatSummaryServiceReferencesInTransaction } from './summary/application/ChatSummary';

// Host runtime 依赖、执行入口与运行时类型。
export type {
  CanonicalUserMessageCommittedPayload,
  ChatAttachmentMediaAssetPort,
  LegacyChatAttachmentAdoptionInput,
  LegacyChatAttachmentLocator,
} from './messages/application/ChatMessageRuntime';
export type {
  LegacyChatAttachmentMigrationIssue,
  MigrateLegacyChatAttachmentsResult,
  MigrateLegacyChatAttachmentsDependencies,
  MigrateLegacyChatAttachmentsOptions,
} from './messages/application/MigrateLegacyChatAttachments';

/** Host 在 Media runtime 就绪后调用；迁移完成后立即返回并停留在 M3a。 */
export function migrateLegacyChatAttachments(
  options?: MigrateLegacyChatAttachmentsOptions,
): Promise<MigrateLegacyChatAttachmentsResult> {
  const dependencies = getChatMessageRuntimeDependencies();
  if (!dependencies.legacyChatAttachments) {
    throw new Error('Chat legacy attachment migration 尚未配置 MediaAsset port');
  }

  return migrateLegacyChatAttachmentsUseCase(
    {
      messages: dependencies.messages,
      mediaAssets: dependencies.legacyChatAttachments,
    },
    options,
  );
}

/** Host-only M3b maintenance：列出群 owner 的 legacy 头像候选。 */
export function listGroupAvatarMediaAssetMigrationCandidates(): Promise<
  GroupAvatarMediaAssetMigrationCandidate[]
> {
  return groupChatRepository.listAvatarMediaAssetMigrationCandidates();
}

/** Host-only M3b maintenance：读取提交前的当前头像状态，供 CAS 形成 expected state。 */
export function getGroupAvatarMediaAssetMigrationCandidate(
  ownerId: string,
): Promise<GroupAvatarMediaAssetMigrationCandidate | null> {
  return groupChatRepository.getAvatarMediaAssetMigrationCandidate(ownerId);
}

/** Host-only M3b maintenance：与 MediaAsset 行在同一事务内提交 owner 引用。 */
export function commitGroupAvatarMediaAssetReferenceInTransaction(
  transaction: DatabaseTransactionExecutor,
  input: CommitGroupAvatarMediaAssetReferenceInput,
): Promise<void> {
  return groupChatRepository.commitAvatarMediaAssetReferenceInTransaction(transaction, input);
}

export type {
  CommitGroupAvatarMediaAssetReferenceInput,
  GroupAvatarMediaAssetMigrationCandidate,
} from './group/domain/GroupChatRepository';

// Host/测试专用的依赖注入入口；普通 @features/chat facade 不暴露这些参数。
export {
  sendUserMessageInternal,
} from './messages/application/SendUserMessage';
export {
  commitTogetherListeningUserInvitation,
  upsertTogetherListeningTimelineEntry,
} from './messages/application/UpsertTogetherListeningTimelineEntry';
export type {
  TogetherListeningTimelineActivity,
  TogetherListeningTimelineProjectionHint,
  UpsertTogetherListeningTimelineEntryResult,
} from './messages/application/UpsertTogetherListeningTimelineEntry';
export type {
  SendUserMessageDeps,
} from './messages/application/SendUserMessage';
export {
  receiveExternalAIMessageInternal,
} from './messages/application/ReceiveExternalAIMessage';
export type {
  ReceiveExternalAIMessageDeps,
} from './messages/application/ReceiveExternalAIMessage';

export interface ChatRuntimeDependencies {
  repositories: {
    messages: ChatMessageRuntimeDependencies['messages'];
    sessions: ChatConversationRuntimeDependencies['sessions'];
    groups: ChatGroupRuntimeDependencies['groups'];
    membership: ChatGroupRuntimeDependencies['membership'];
    turns: ChatMessageRuntimeDependencies['turns'];
  };
  assistantDirectory: ChatAssistantDirectory;
  currentUserDirectory: ChatGroupRuntimeDependencies['currentUserDirectory'];
  captureGroupHistory: ChatGroupRuntimeDependencies['captureHistory'];
  canonicalUserMessage?: ChatMessageRuntimeDependencies['canonicalUserMessage'];
  regeneration?: ChatMessageRuntimeDependencies['regeneration'];
  turnPresentation: ChatMessageRuntimeDependencies['turnPresentation'];
  legacyChatAttachments?: ChatMessageRuntimeDependencies['legacyChatAttachments'];
  database: ChatConversationRuntimeDependencies['database'];
  media: ChatReplyRuntimeDependencies['media'];
  mutations: ChatReplyRuntimeDependencies['mutations'];
  vision: ChatReplyRuntimeDependencies['vision'];
  agent: ChatReplyRuntimeDependencies['agent'];
  runPreparation: ChatReplyRuntimeDependencies['runPreparation'];
  tools: ChatReplyRuntimeDependencies['tools'];
  prompt: ChatReplyRuntimeDependencies['prompt'];
}

/** Host 只配置一次聚合输入；Chat 内部各子域仅能读取自己的窄运行时端口。 */
export function configureChatRuntimeDependencies(
  dependencies: ChatRuntimeDependencies,
): void {
  configureChatConversationRuntime({
    sessions: dependencies.repositories.sessions,
    assistantDirectory: dependencies.assistantDirectory,
    database: dependencies.database,
  });
  configureChatMessageRuntime({
    messages: dependencies.repositories.messages,
    assistantDirectory: dependencies.assistantDirectory,
    turns: dependencies.repositories.turns,
    turnPresentation: dependencies.turnPresentation,
    legacyChatAttachments: dependencies.legacyChatAttachments,
    canonicalUserMessage: dependencies.canonicalUserMessage,
    regeneration: dependencies.regeneration,
  });
  configureChatGroupRuntime({
    groups: dependencies.repositories.groups,
    membership: dependencies.repositories.membership,
    captureHistory: dependencies.captureGroupHistory,
    assistantDirectory: dependencies.assistantDirectory,
    currentUserDirectory: dependencies.currentUserDirectory,
  });
  configureChatReplyRuntime({
    mutations: dependencies.mutations,
    assistantDirectory: dependencies.assistantDirectory,
    media: dependencies.media,
    vision: dependencies.vision,
    agent: dependencies.agent,
    runPreparation: dependencies.runPreparation,
    tools: dependencies.tools,
    prompt: dependencies.prompt,
  });
}

export {
  configureChatCallGateway,
} from './conversation/application/ChatCallGateway';
export {
  configureChatTogetherListeningGateway,
} from './conversation/application/ChatTogetherListeningGateway';
export type {
  ChatTogetherListeningActivity,
  ChatTogetherListeningGateway,
  ChatTogetherListeningResult,
  ChatTogetherListeningResultStatus,
} from './conversation/application/ChatTogetherListeningGateway';
export {
  configureAIMessageDeliveryHandler,
} from './reply/delivery/AIMessageEvents';
export {
  isChatConversationForeground,
  isGroupConversationForeground,
  setChatForegroundContext,
} from './reply/delivery/ChatForegroundContext';

export {
  executeUserReplyTurn,
} from './reply/application/ExecuteUserReplyTurn';
export type {
  ExecuteUserReplyTurnParams,
  UserReplyTurnOutcome,
} from './reply/application/ExecuteUserReplyTurn';
export { isChatReplyRunCancellationError } from './reply/application/ChatReplyAbort';

// Host 生命周期与执行宿主使用的内部 Chat 信号，不属于普通 Feature facade。
export {
  setChatEventBus,
  emitChatMessagesUpdated,
  emitChatMessagesPatched,
  emitChatMessagesReloadRequested,
  emitChatTurnExecutionChanged,
  emitChatTypingStatusChanged,
  emitChatRegenerationChanged,
} from './messages/events/ChatEvents';

// Host 组合入口使用的图片输入适配能力。
export { resolveChatImageModelInput } from './reply/application/ResolveChatImageModelInput';
export {
  deletePersistedChatAttachment,
  persistChatImageAttachment,
} from './messages/application/PersistChatImageAttachment';

// Host 提示词与维护入口。
export const CHAT_TASK_PROMPT_DEFINITIONS = [
  ...GROUP_TASK_PROMPT_DEFINITIONS,
  ...REPLY_TASK_PROMPT_DEFINITIONS,
] satisfies PromptDefinitionDescriptor[];
export { clearSessionTimelineCache } from './presentation/messages/components/sessionTimelineCache';

// ConversationTurn 是 Host 协调器的内部执行契约，不属于普通 Chat facade。
export type {
  ConversationTurnRun,
} from './reply/domain/ConversationTurn';
export type { IConversationTurnRepository } from './reply/domain/ConversationTurnRepository';

// 具体仓储只由 Host composition 装配。
export { messageRepository } from './messages/infrastructure/SQLiteMessageRepository';
export { configureChatFavoriteRuntime } from './favorites/application/ChatFavoriteRuntime';
export { SQLiteChatFavoriteRepository } from './favorites/infrastructure/SQLiteChatFavoriteRepository';
export { sessionRepository } from './conversation/infrastructure/SQLiteSessionRepository';
export { groupChatRepository } from './group/infrastructure/SQLiteGroupChatRepository';
export { groupMembershipRepository } from './group/infrastructure/SQLiteGroupMembershipRepository';
export { conversationTurnRepository } from './reply/infrastructure/SQLiteConversationTurnRepository';

export { configureChatImageModels, resolveChatRecognitionModel, notifyChatImageModelsChanged } from './reply/application/ChatImageModels';
export { chatImageSettingsRepository } from './reply/infrastructure/SQLiteChatImageSettingsRepository';

export { recordAssistantNicknameChangeInTransaction } from './messages/application/RecordAssistantNicknameChange';
export { createSharedMomentSendIntent } from './reply/agent/SharedMomentSendIntent';
