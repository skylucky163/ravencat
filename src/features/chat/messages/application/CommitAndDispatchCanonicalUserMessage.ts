/** 提交 canonical 用户消息，并把 commit 后执行交还给 Host turn coordinator。 */

import { logTurnTimeline } from '@shared/diagnostics/TurnTimelineLog';
import type { ChatMessage, CreateMessageInput } from '../domain/ChatMessage';
import type { CommitMessageInput, IMessageRepository } from '../domain/MessageRepository';
import type { DatabaseTransactionExecutor } from '@platform/persistence';
import { emitChatMessagesUpdated } from '../events/ChatEvents';
import type { AIReplyConfig, ProcessAIReplyCallbacks } from '../../reply/application/ProcessAIReply';
import { commitCanonicalUserMessage } from './CommitCanonicalUserMessage';
import {
  getChatMessageRuntimeDependencies,
  type ConversationTurnExecutionMode,
} from './ChatMessageRuntime';

export interface CommitAndDispatchCanonicalUserMessageParams {
  message: CreateMessageInput;
  precedingMessages?: readonly CommitMessageInput[];
  previewText: string;
  aiConfig: AIReplyConfig;
  executionMode?: ConversationTurnExecutionMode;
  replyCallbacks?: ProcessAIReplyCallbacks;
  deliveryTiming?: 'paced' | 'immediate';
  correlationId?: string;
  signal?: AbortSignal;
  executionDeadlineAt?: number;
  repository?: IMessageRepository;
  materializeMessagesInTransaction?: (transaction: DatabaseTransactionExecutor, messages: readonly CommitMessageInput[]) => Promise<CommitMessageInput[]>;
  materializeMessageInTransaction?: (
    transaction: DatabaseTransactionExecutor,
    message: CreateMessageInput,
  ) => Promise<CreateMessageInput>;
}

export interface CommitAndDispatchCanonicalUserMessageResult {
  userMessage: ChatMessage | null;
  userMessages: ChatMessage[];
  success: boolean;
  error: string | null;
}

export async function commitAndDispatchCanonicalUserMessage(
  params: CommitAndDispatchCanonicalUserMessageParams,
): Promise<CommitAndDispatchCanonicalUserMessageResult> {
  let committedUserMessage: ChatMessage | null = null;
  let committedUserMessages: ChatMessage[] = [];
  try {
    const { message, messages, supersededRunId } = await commitCanonicalUserMessage({
      repository: params.repository,
      message: params.message,
      precedingMessages: params.precedingMessages,
      previewText: params.previewText,
      notifyUI: emitChatMessagesUpdated,
      materializeMessageInTransaction: params.materializeMessageInTransaction,
      materializeMessagesInTransaction: params.materializeMessagesInTransaction,
    });
    committedUserMessage = message;
    committedUserMessages = messages;

    logTurnTimeline('user_message_committed', {
      sessionId: message.sessionId,
      correlationId: params.correlationId,
    });
    await getChatMessageRuntimeDependencies().canonicalUserMessage?.onCommitted({
      sessionId: message.sessionId,
      message,
      supersededRunId,
      aiConfig: params.aiConfig,
      executionMode: params.executionMode ?? 'delegate_to_android_host',
      replyCallbacks: {
        ...params.replyCallbacks,
        notifyUI: emitChatMessagesUpdated,
      },
      deliveryTiming: params.deliveryTiming,
      correlationId: params.correlationId,
      signal: params.signal,
      executionDeadlineAt: params.executionDeadlineAt,
    });

    return { userMessage: message, userMessages: messages, success: true, error: null };
  } catch (error) {
    return {
      userMessage: committedUserMessage,
      userMessages: committedUserMessages,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
