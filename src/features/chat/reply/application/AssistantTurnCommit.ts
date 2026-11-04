/**
 * @fileoverview Assistant 回复的提交接缝（Phase 5A 方案 16.5）。
 *
 * - buildAssistantTurnItems：纯转换，reasoning + visibleSegments → 本轮待提交条目
 *   列表（CreateMessageInput），不做任何 IO；turn_run_id / turn_item_index 由
 *   commit 事务统一赋值。
 * - AssistantTurnCommitPort：processAIReply 最终落库的显式策略端口，由调用方
 *   传入，禁止隐式 fallback：
 *   - createLegacySegmentedReplyPersistence：现状逐泡独立事务落库（旁路 writer）；
 *   - createSingleTransactionTurnCommit（见 SingleTransactionTurnCommit.ts）：T3
 *     单事务 commitTurn（canonical user_reply 路径）。
 */

import type { ConversationTurnCommitItem } from '../domain/ConversationTurn';
import type { ChatMessage } from '../../messages/domain/ChatMessage';
import type { IMessageRepository } from '../../messages/domain/MessageRepository';
import {
  persistCompletedAssistantReply,
  type PersistCompletedAssistantReplyParams,
} from './AssistantReplyPersistence';
import { buildMessageMetadata } from './ChatReplyMetadata';
import { buildLogicalMessageId, formatMessageTime } from './ChatReplyUtils';
import type {
  AIReplyConfig,
  AIReplyRuntimeContext,
  AIResponse,
} from './ChatReplyTypes';

export interface AssistantTurnCommitPort {
  /** 为持久展示绑定本次交付上下文；媒体部分输出与 T3 共享该提交 owner。 */
  configureSegmentDelivery?: (params: Pick<PersistCompletedAssistantReplyParams, 'aiConfig' | 'runtimeContext' | 'callbacks'>) => void;
  /** canonical 展示快照接缝；旁路提交不拥有 ConversationTurn 展示记录。 */
  timelineSink?: import('../agent/ChatAgentTimeline').AgentTimelineTransientSink;
  recordToolExecutionStarted?: () => Promise<void>;
  observeRunEvent?: (event: import('@platform/agentRuntime').AgentRunEvent) => void;
  /** 只有 canonical 用户回合持有跨轮拆包状态；旁路运行只在当前 run 展开。 */
  readOpenToolPackageIds?: () => Promise<string[]>;
  persistCompletedAssistantReply(
    params: PersistCompletedAssistantReplyParams
  ): Promise<void>;
  /**
   * 工具续轮的中间 assistant 文本（工具调用前言）的落库接缝：
   * - Legacy：与现状一致，逐泡独立事务落库；
   * - canonical：不单独落库，并入本轮 items，随最终 T3 单事务提交。
   */
  persistAssistantPrelude(
    params: PersistCompletedAssistantReplyParams
  ): Promise<void>;
  /**
   * canonical Agent timeline 的唯一 T3 接缝：调用方已按 run-local sequence
   * 转换好 reasoning / assistant / tool 条目；实现只负责原子提交和 assistant
   * 交付回调，不重新解释或重排 timeline。
   */
  commitAgentTimeline?: (
    params: PersistCompletedAssistantReplyParams & {
      items: ConversationTurnCommitItem[];
    }
  ) => Promise<{
    outcome: AssistantTurnCommitOutcome;
    messages: ChatMessage[];
  }>;
  /**
   * true = Legacy：流式/工具链的中间产物（streaming 草稿、前言）允许直接落库；
   * false = canonical：普通正文只经 T3 最终落库；媒体部分输出由 commitAgentOutput 裁决。
   */
  readonly persistsIntermediates: boolean;
  /** 图片／表情可在工具完成后提交；重写明确返回 deferred，仍随整轮原子替换。 */
  commitAgentOutput?: (
    params: PersistCompletedAssistantReplyParams & { item: ConversationTurnCommitItem }
  ) => Promise<{ outcome: 'committed' | 'fence_failed' | 'deferred'; messages: ChatMessage[] }>;
  /**
   * run 是否仍保有提交资格。fence 是事务内的最终裁决；这里只表达
   * “本策略已 settled（已提交或已 fence 失败）”，供错误回复落库门控使用。
   */
  isCommitEligible?: () => boolean;
  /**
   * 异步持久资格探针：错误气泡落库前的最终确认，返回 false 表示该 run 已
   * 失去落库资格（如群聊 plan 已被换代），错误气泡与失败回调必须跳过。
   * 同步 isCommitEligible 只覆盖本地 settled 状态；需要查询持久事实的策略
   * （群聊逐泡提交）实现本探针。canonical 无需实现。
   */
  confirmCommitEligible?: () => Promise<boolean>;
  /**
   * 错误气泡等补充落库的 fence 装饰：返回把 commitMessage 包进同一提交
   * fence 事务的 repository。探针（confirmCommitEligible）只是落库前的廉价
   * 短路，真正的裁决在装饰后的事务内——fence 与 INSERT 之间不存在交错窗口。
   * 未实现的策略（单聊 / canonical）按原样落库。
   */
  decorateCommitRepository?: (repository: IMessageRepository) => IMessageRepository;
  /** canonical 策略的最终提交结果；Legacy 恒为 null（无此概念）。 */
  turnCommitOutcome?: () => AssistantTurnCommitOutcome | null;
}

/** canonical 单事务提交策略的最终结果；empty_items = 本轮没有任何可提交条目。 */
export type AssistantTurnCommitOutcome = 'committed' | 'fence_failed' | 'empty_items';

export interface BuildAssistantTurnItemsParams {
  sessionId: string;
  aiConfig?: AIReplyConfig;
  runtimeContext?: AIReplyRuntimeContext;
  response: AIResponse;
  /** 归一化后的可见全文（visibleSegments 的联接）。 */
  normalizedText: string;
  /** 归一化后的可见分段。 */
  visibleSegments: string[];
}

/**
 * 纯转换：reasoning + 全部可见分段 → 本轮待提交条目列表。
 * 分段元数据规则与 Legacy 逐泡落库一致：token 只记在最后一个分段。
 */
export function buildAssistantTurnItems(
  params: BuildAssistantTurnItemsParams
): ConversationTurnCommitItem[] {
  const {
    sessionId,
    aiConfig,
    runtimeContext = {},
    response,
    normalizedText,
    visibleSegments,
  } = params;

  const now = new Date();
  const timeStr = formatMessageTime(now);
  const createdAt = now.toISOString();

  const reasoningText = response.reasoningText?.trim();
  const segments = visibleSegments.map((segment) => segment.trim()).filter(Boolean);
  const willSegment = segments.length > 1;
  const logicalMessageId = reasoningText || willSegment
    ? buildLogicalMessageId()
    : null;

  const items: ConversationTurnCommitItem[] = [];

  if (reasoningText) {
    items.push({
      message: {
        sessionId,
        text: reasoningText,
        isMe: false,
        senderType: 'reasoning',
        agentId: aiConfig?.agentId || null,
        apiMessageId: null,
        time: timeStr,
        createdAt,
        updatedAt: createdAt,
        replyToId: null,
        replyToText: null,
        status: 'sent',
        tokensUsed: 0,
        promptTokens: 0,
        completionTokens: 0,
        metadataJson: JSON.stringify(
          buildMessageMetadata(aiConfig, runtimeContext, { kind: 'reasoning' })
        ),
        logicalMessageId,
      },
    });
  }

  if (!normalizedText) {
    return items;
  }

  const finalText = normalizedText.trim();
  const normalizedSegments = segments.length > 0 ? segments : [finalText];
  const segmentTotal = normalizedSegments.length;

  normalizedSegments.forEach((segmentText, segmentIndex) => {
    const isFinalSegment = segmentIndex === segmentTotal - 1;
    items.push({
      message: {
        sessionId,
        text: segmentText,
        isMe: false,
        senderType: 'assistant',
        agentId: aiConfig?.agentId || null,
        apiMessageId: response.messageId || null,
        time: timeStr,
        createdAt,
        updatedAt: createdAt,
        replyToId: null,
        replyToText: null,
        status: 'sent',
        tokensUsed: isFinalSegment ? response.totalTokens || 0 : 0,
        promptTokens: isFinalSegment ? response.promptTokens || 0 : 0,
        completionTokens: isFinalSegment ? response.completionTokens || 0 : 0,
        metadataJson: JSON.stringify(buildMessageMetadata(aiConfig, runtimeContext, {
          kind: 'reply',
          cachedTokens: isFinalSegment ? response.cachedTokens : undefined,
        })),
        logicalMessageId,
        segmentIndex,
        segmentTotal,
        deliveryStatus: 'delivered',
      },
    });
  });

  return items;
}

/** Legacy 策略：现状逐泡独立事务落库，行为不变。旁路 writer 显式使用。 */
export function createLegacySegmentedReplyPersistence(): AssistantTurnCommitPort {
  return {
    persistsIntermediates: true,
    persistCompletedAssistantReply: (params) => persistCompletedAssistantReply(params),
    persistAssistantPrelude: (params) => persistCompletedAssistantReply(params),
  };
}
