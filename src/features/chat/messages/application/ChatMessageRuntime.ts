/** 消息应用运行时依赖：承接消息、T1/T3 回合提交与宿主回调端口。 */

import type { AIReplyConfig, ProcessAIReplyCallbacks } from '../../reply/application/ChatReplyTypes';
import type { IConversationTurnRepository } from '../../reply/domain/ConversationTurnRepository';
import type { ChatAssistantDirectory } from '../../ChatAssistantDirectory';
import type { ChatMessage } from '../domain/ChatMessage';
import type { ChatAttachmentType } from '../domain/ChatAttachment';
import type { IMessageRepository } from '../domain/MessageRepository';
import type { DatabaseTransactionExecutor } from '@platform/persistence';
import type { MediaAsset } from '@features/media';
import { createRuntimeSlot } from '@shared/runtime/RuntimeSlot';

/** canonical 用户消息提交后的执行宿主所有权。 */
export type ConversationTurnExecutionMode =
  | 'delegate_to_android_host'
  | 'inline_current_host';

/** canonical 用户消息已提交的回调负载（T1 commit 后交给 Host）。 */
export interface CanonicalUserMessageCommittedPayload {
  sessionId: string;
  message: ChatMessage;
  supersededRunId: string | null;
  aiConfig: AIReplyConfig;
  executionMode: ConversationTurnExecutionMode;
  replyCallbacks?: ProcessAIReplyCallbacks;
  deliveryTiming?: 'paced' | 'immediate';
  correlationId?: string;
  signal?: AbortSignal;
  executionDeadlineAt?: number;
}

/** Media Host 为 M3a 提供的 legacy Chat backing 定位结果。 */
export interface LegacyChatAttachmentLocator {
  storageBackend: string;
  storageKey: string;
  localUri: string;
}

/** Media Host 批量接管 legacy 文件时所需的最终业务 metadata。 */
export interface LegacyChatAttachmentAdoptionInput extends LegacyChatAttachmentLocator {
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

/**
 * Chat 只依赖这组窄端口，不持有 Media backing、resolver 或 catalog 实现。
 * Host/Media 必须在 callback 收到的同一 transaction 中提交 asset 与 Chat CAS，
 * 并按 inputs 顺序返回 MediaAsset；callback 抛错时整批应回滚。
 */
export interface ChatAttachmentMediaAssetPort {
  locateLegacyChatFile(
    localUri: string,
    attachmentType: ChatAttachmentType,
  ): Promise<LegacyChatAttachmentLocator | null>;
  adoptLegacyChatFiles<T>(
    inputs: readonly LegacyChatAttachmentAdoptionInput[],
    commit: (
      transaction: DatabaseTransactionExecutor,
      assets: readonly MediaAsset[],
    ) => Promise<T>,
  ): Promise<T>;
}

export interface ChatMessageRuntimeDependencies {
  messages: IMessageRepository;
  assistantDirectory: Pick<ChatAssistantDirectory, 'getBlockState'>;
  /** T1/T3 事务使用的回合仓储；具体回合生命周期仍由 reply/Host 持有。 */
  turns: IConversationTurnRepository;
  turnPresentation: {
    freeze(sessionId: string): Promise<(committed: boolean) => Promise<void>>;
    interrupt(sessionId: string): Promise<void>;
  };
  /** M3a legacy Chat attachment migration 的 Media/Host 窄端口。 */
  legacyChatAttachments?: ChatAttachmentMediaAssetPort;
  /** canonical 用户消息 commit 后通知 Host 启动受控执行宿主。 */
  canonicalUserMessage?: {
    onCommitted: (payload: CanonicalUserMessageCommittedPayload) => void | Promise<void>;
  };
  /** 页面只提交重写意图，宿主负责启动并持续等待完整执行。 */
  regeneration?: {
    onRequested(sessionId: string): Promise<boolean>;
    onInvalidated(sessionId: string): Promise<void>;
  };
}

const chatMessageRuntimeSlot = createRuntimeSlot<ChatMessageRuntimeDependencies>(
  'Chat messages',
);

export function configureChatMessageRuntime(
  dependencies: ChatMessageRuntimeDependencies,
): void {
  chatMessageRuntimeSlot.configure(dependencies);
}

export function getChatMessageRuntimeDependencies(): ChatMessageRuntimeDependencies {
  return chatMessageRuntimeSlot.get();
}
