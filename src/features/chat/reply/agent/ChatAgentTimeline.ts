/**
 * Agent run 的短生命周期时间线。
 *
 * 按 Runtime 事件首次可见的顺序分配 run-local sequence，并把发送意图和最终
 * 时间线转换为同一回合提交项。图片／表情可提前取得正式消息身份，T3 只绑定
 * 它们在整轮中的最终顺序；正文、语音与重写仍沿各自原有提交策略。
 *
 * Legacy（persistence.persistsIntermediates=true）不使用这里的提交转换，仍由
 * 原有流式草稿和工具状态 projector 负责逐条落库。
 */
import { isSharedMomentSendIntent, type SharedMomentSendIntent } from './SharedMomentSendIntent';
import type { ModelToolCall } from '@platform/ai';
import type { AgentTerminalCode, AgentToolOutcome } from '@platform/agentRuntime';
import {
  isStickerSendIntent,
  type StickerMessageSnapshot,
} from '@features/stickers';
import type { ChatMessage, CreateMessageInput } from '../../messages/domain/ChatMessage';
import {
  buildAgentTimelineClientMessageId,
  buildAgentTimelineIdentity,
} from '../../messages/domain/AgentTimelineIdentity';
import type {
  AIReplyConfig,
  AIReplyRuntimeContext,
  AIResponse,
} from '../application/ChatReplyTypes';
import type { AIReplyPolicy } from '../application/ReplyPolicy';
import {
  buildChatToolStatusMessageMetadata,
  buildMessageMetadata,
} from '../application/ChatReplyMetadata';
import { normalizeAssistantResponseText } from '../application/AssistantReplyPersistence';
import { segmentAssistantReplyProgress } from '../application/AssistantReplySegmentation';
import { AUTONOMOUS_SILENT_REPLY, isAutonomousSilentReply } from '../application/AutonomousReplyContract';
import { buildAssistantTurnItems } from '../application/AssistantTurnCommit';
import { formatMessageTime } from '../application/ChatReplyUtils';
import type { ConversationTurnCommitItem } from '../domain/ConversationTurn';
import type { ChatToolExecutionSnapshot } from '../domain/ChatTurnPresentation';
import type { ChatAgentModelTurn } from './ChatAgentModelGateway';
import {
  buildToolStatusText,
  joinToolDisplayNames,
  resolveToolCallDisplayName,
} from './ToolReplyPresentation';
import {
  isVoiceMessageSendIntent,
  type VoiceMessageSendIntent,
} from './SendVoiceMessageTool';
import { buildChatVoiceMessageMetadata } from '../../messages/domain/chatMessageMetadata';
import { isImageSendIntent, type ImageSendIntent } from './SendImageTool';

export type FinalAssistantPolicy = 'commit_as_reply' | 'autonomous_reply';

export type AgentTimelineItemKind = 'reasoning' | 'assistant' | 'tool';

export type AgentTimelineItemStatus =
  | 'streaming'
  | 'running'
  | 'sent'
  | 'completed'
  | 'failed';

/**
 * transient presentation 使用的稳定条目快照。
 * clientMessageId 是同一 run 内唯一的 replacement key；文本不是 identity。
 */
export interface AgentTimelineItemSnapshot {
  readonly runId: string;
  readonly sequence: number;
  readonly identity: string;
  readonly stepIndex: number;
  readonly segmentIndex?: number;
  readonly pendingDelivery?: boolean;
  /** 本版本来自生成中的正文，闭合气泡也不另等完整回复的分段间隔。 */
  readonly streamingDelivery?: boolean;
  readonly toolExecutionStarted?: boolean;
  readonly toolExecutions?: readonly ChatToolExecutionSnapshot[];
  readonly kind: AgentTimelineItemKind;
  readonly status: AgentTimelineItemStatus;
  readonly text: string;
  readonly clientMessageId: string;
  readonly createdAt: string;
  readonly time: string;
  readonly apiMessageId?: string | null;
  readonly toolNames?: readonly string[];
  readonly toolDisplayNames?: readonly string[];
  readonly tokensUsed?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly cachedTokens?: number;
}

interface AgentTimelineItem extends AgentTimelineItemSnapshot {
  readonly startedToolCallIds?: readonly string[];
  readonly toolCalls: readonly ModelToolCall[];
  readonly outcomes: ReadonlyMap<string, AgentToolOutcome>;
  turn: ChatAgentModelTurn | null;
}

interface TimelineStep {
  readonly stepIndex: number;
  turn: ChatAgentModelTurn | null;
  reasoningItem: AgentTimelineItem | null;
  assistantItem: AgentTimelineItem | null;
  toolItem: AgentTimelineItem | null;
  readonly stickerItems: StickerTimelineItem[];
  readonly voiceItems: VoiceTimelineItem[];
  readonly contentItems: ContentTimelineItem[];
  readonly outcomes: Map<string, AgentToolOutcome>;
  readonly committedOutputs: Map<string, number>;
}

/** 表情意图交由回合 owner 提交；未取得正式消息身份前不另建 transient 媒体气泡。 */
interface StickerTimelineItem {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly toolCallId: string;
  readonly sticker: StickerMessageSnapshot;
  readonly apiMessageId: string | null;
  readonly createdAt: string;
  readonly time: string;
}

interface VoiceTimelineItem {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly toolCallId: string;
  readonly intent: VoiceMessageSendIntent;
  readonly apiMessageId: string | null;
  readonly createdAt: string;
  readonly time: string;
}

interface ContentTimelineItem {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly toolCallId: string;
  readonly intent: ImageSendIntent | SharedMomentSendIntent;
  readonly apiMessageId: string | null;
  readonly createdAt: string;
  readonly time: string;
}

export interface AgentTimelineChangedEvent {
  readonly runId: string;
  readonly items: readonly AgentTimelineItemSnapshot[];
}

export interface AgentTimelineTransientSink {
  /** 持久展示消费者在批次边界读取增量；不在每个 token 上构造整轮快照。 */
  onDirty?: (readChanges: () => readonly AgentTimelineItemSnapshot[]) => void;
  onChanged?: (event: AgentTimelineChangedEvent) => void;
  onCommitted?: (event: {
    runId: string;
    messages: readonly ChatMessage[];
    outcome: 'committed' | 'fence_failed' | 'empty_items';
  }) => void;
  onCleared?: (event: {
    runId: string;
    reason?: 'superseded' | 'cancelled' | 'fence_failed' | 'model_failure' | 'completed';
  }) => void;
}

export interface BuildAgentTimelineItemsParams {
  sessionId: string;
  aiConfig?: AIReplyConfig;
  runtimeContext?: AIReplyRuntimeContext;
  policy: Pick<AIReplyPolicy, 'bubbleDeliveryMode'>;
  finalAssistantPolicy: FinalAssistantPolicy;
  finalStepIndex: number;
}

export class ChatAgentTimeline {
  private readonly steps = new Map<number, TimelineStep>();
  private readonly items: AgentTimelineItem[] = [];
  private readonly dirtyItems = new Map<number, AgentTimelineItem>();
  private readonly emittedAssistantSnapshots = new Map<string, AgentTimelineItemSnapshot>();
  private readonly readChanges = () => {
    const items = [...this.dirtyItems.values()];
    this.dirtyItems.clear();
    return this.snapshotItems(items).filter(snapshot => {
      if (snapshot.kind !== 'assistant') return true;
      const previous = this.emittedAssistantSnapshots.get(snapshot.clientMessageId);
      this.emittedAssistantSnapshots.set(snapshot.clientMessageId, snapshot);
      return !previous || previous.text !== snapshot.text || previous.status !== snapshot.status
        || previous.streamingDelivery !== snapshot.streamingDelivery
        || previous.apiMessageId !== snapshot.apiMessageId || previous.tokensUsed !== snapshot.tokensUsed
        || previous.promptTokens !== snapshot.promptTokens || previous.completionTokens !== snapshot.completionTokens
        || previous.cachedTokens !== snapshot.cachedTokens;
    });
  };
  private nextSequence = 1;

  constructor(
    private readonly runId: string,
    private readonly sink: AgentTimelineTransientSink = {},
    private readonly presentationPolicy?: Pick<AIReplyPolicy, 'bubbleDeliveryMode'>,
    private readonly finalAssistantPolicy: FinalAssistantPolicy = 'commit_as_reply',
  ) {}

  /** model_turn_started 是所有 delta 的前置事件，先建立 step 所有权。 */
  startStep(stepIndex: number): void {
    if (this.steps.has(stepIndex)) {
      throw new Error(`Chat Agent step ${stepIndex} was projected more than once`);
    }
    this.steps.set(stepIndex, {
      stepIndex,
      turn: null,
      reasoningItem: null,
      assistantItem: null,
      toolItem: null,
      stickerItems: [],
      voiceItems: [],
      contentItems: [],
      outcomes: new Map(),
      committedOutputs: new Map(),
    });
  }

  /** 完整 transport 没有 delta 时也从 model turn 建立同样的 reasoning → assistant 顺序。 */
  reconcileModelTurn(
    stepIndex: number,
    turn: ChatAgentModelTurn,
    includeAssistant = true,
  ): void {
    const step = this.requireStep(stepIndex);
    if (step.turn) {
      throw new Error(`Chat Agent model turn ${stepIndex} was projected more than once`);
    }
    step.turn = turn;
    this.reconcileText(step, 'reasoning', turn.reasoningText);
    if (includeAssistant) {
      this.reconcileText(step, 'assistant', turn.assistantText);
    }
    if (step.reasoningItem) {
      step.reasoningItem.turn = turn;
      step.reasoningItem = this.replaceItem(step.reasoningItem, { status: 'sent' });
    }
    if (step.assistantItem) {
      step.assistantItem.turn = turn;
      step.assistantItem = this.replaceItem(step.assistantItem, { status: 'sent' });
    }
    this.publish();
  }

  /** streaming delta 的唯一写入口：首次非空 delta 创建 item，后续只更新原 item。 */
  appendDelta(
    stepIndex: number,
    kind: Extract<AgentTimelineItemKind, 'reasoning' | 'assistant'>,
    text: string,
  ): void {
    if (!text) {
      return;
    }
    const step = this.requireStep(stepIndex);
    const current = kind === 'reasoning' ? step.reasoningItem : step.assistantItem;
    if (!current) {
      const item = this.createTextItem(stepIndex, kind, text);
      if (kind === 'reasoning') {
        step.reasoningItem = item;
      } else {
        step.assistantItem = item;
      }
    } else {
      const updated = this.replaceItem(current, {
        text: current.text + text,
        status: 'streaming',
      });
      if (kind === 'reasoning') {
        step.reasoningItem = updated;
      } else {
        step.assistantItem = updated;
      }
    }
    this.publish();
  }

  /** 首次工具意图创建批次记录，参数或授权被拒绝的调用也保留终态。 */
  startToolStatus(stepIndex: number): void {
    const step = this.requireStep(stepIndex);
    if (step.toolItem) {
      return;
    }
    const toolCalls = this.timelineToolCalls(step);
    if (toolCalls.length === 0) {
      return;
    }
    const now = new Date();
    const toolNames = toolCalls.map((toolCall) => toolCall.name);
    const toolDisplayNames = this.resolveToolDisplayNames(toolCalls);
    step.toolItem = this.createItem({
      stepIndex,
      kind: 'tool',
      text: `准备调用：${joinToolDisplayNames(toolDisplayNames)}`,
      status: 'streaming',
      createdAt: now.toISOString(),
      time: formatMessageTime(now),
      toolCalls,
      outcomes: step.outcomes,
      toolNames,
      toolDisplayNames,
      turn: step.turn,
    });
    this.publish();
  }

  completeToolCall(
    stepIndex: number,
    toolCallId: string,
    outcome: AgentToolOutcome,
  ): void {
    const step = this.requireStep(stepIndex);
    if (step.outcomes.has(toolCallId)) {
      throw new Error(`Chat Agent tool call ${toolCallId} completed more than once`);
    }
    step.outcomes.set(toolCallId, outcome);
    if (step.toolItem) this.markDirty(step.toolItem);
    if (outcome.status === 'success' && isStickerSendIntent(outcome.data)) {
      step.stickerItems.push(this.createStickerTimelineItem(step, toolCallId, outcome.data.sticker));
    }
    if (outcome.status === 'success' && isVoiceMessageSendIntent(outcome.data)) {
      step.voiceItems.push(this.createVoiceTimelineItem(step, toolCallId, outcome.data));
    }
    if (outcome.status === 'success' && (isImageSendIntent(outcome.data) || isSharedMomentSendIntent(outcome.data))) {
      const now = new Date();
      step.contentItems.push({
        sequence: this.nextSequence++,
        stepIndex,
        toolCallId,
        intent: outcome.data,
        apiMessageId: step.turn!.messageId,
        createdAt: now.toISOString(),
        time: formatMessageTime(now),
      });
    }
    if (!step.toolItem || !step.turn || step.outcomes.size !== step.turn.toolCalls.length) {
      this.publish();
      return;
    }
    const toolCalls = this.timelineToolCalls(step);
    const toolDisplayNames = this.resolveToolDisplayNames(toolCalls);
    const failed = [...step.outcomes.values()].some(isToolStatusFailure);
    step.toolItem = this.replaceItem(step.toolItem, {
      text: buildToolStatusText(joinToolDisplayNames(toolDisplayNames), failed ? 'failed' : 'completed')
        + this.outputDeliveryText(step),
      status: failed ? 'failed' : 'completed',
      toolNames: toolCalls.map((toolCall) => toolCall.name),
      toolDisplayNames,
    });
    this.publish();
  }

  markToolStarted(stepIndex: number, toolCallId: string): void {
    const step = this.requireStep(stepIndex);
    if (!step.toolItem) this.startToolStatus(stepIndex);
    const item = step.toolItem!;
    const replacement = { ...item, toolExecutionStarted: true,
      startedToolCallIds: [...(item.startedToolCallIds ?? []), toolCallId], status: 'running' as const,
      text: buildToolStatusText(joinToolDisplayNames([...(item.toolDisplayNames ?? [])]), 'running') };
    this.items[this.items.indexOf(item)] = replacement;
    this.markDirty(replacement);
    step.toolItem = replacement;
    this.publish();
  }

  /** 终态失败时收口 transient 状态；成功路径的 tool completed 已在事件中完成。 */
  closeRun(terminalCode: AgentTerminalCode): void {
    if (terminalCode === 'COMPLETED') {
      return;
    }
    for (const step of this.steps.values()) {
      if (step.toolItem && step.outcomes.size < (step.turn?.toolCalls.length ?? 0)) {
        const toolCalls = this.timelineToolCalls(step);
        step.toolItem = this.replaceItem(step.toolItem, {
          status: 'failed',
          text: buildToolStatusText(
            joinToolDisplayNames(this.resolveToolDisplayNames(toolCalls)),
            'failed',
          ),
          toolNames: toolCalls.map((toolCall) => toolCall.name),
          toolDisplayNames: this.resolveToolDisplayNames(toolCalls),
        });
      }
      if (step.toolItem && (step.stickerItems.length > 0 || step.contentItems.some(item => isImageSendIntent(item.intent)))) {
        const reason = terminalCode === 'CANCELLED_BY_USER' ? '本轮已取消'
          : terminalCode === 'SUPERSEDED' ? '已被新输入替代' : `本轮回复失败（${terminalCode}）`;
        step.toolItem = this.replaceItem(step.toolItem, {
          text: buildToolStatusText(joinToolDisplayNames(this.resolveToolDisplayNames(this.timelineToolCalls(step))),
            step.toolItem.status === 'failed' ? 'failed' : 'completed') + this.outputDeliveryText(step, reason),
        });
      }
      if (step.reasoningItem && step.reasoningItem.status !== 'sent') {
        step.reasoningItem = this.replaceItem(step.reasoningItem, { status: 'failed' });
      }
      if (step.assistantItem && step.assistantItem.status !== 'sent') {
        step.assistantItem = this.replaceItem(step.assistantItem, { status: 'failed' });
      }
    }
    this.publish();
  }

  /** 需要 requestVideoCall 等外部动作时，保持原有停止 Runtime 语义。 */
  shouldWaitForExternalAction(): boolean {
    for (const step of this.steps.values()) {
      if (
        step.turn
        && step.turn.toolCalls.length > 0
        && step.turn.toolCalls.every((toolCall) => toolCall.name === 'requestVideoCall')
        && step.outcomes.size === step.turn.toolCalls.length
        && [...step.outcomes.values()].every(isSuppressedSuccessfulOutcome)
      ) {
        return true;
      }
    }
    return false;
  }

  snapshots(): readonly AgentTimelineItemSnapshot[] {
    return this.snapshotItems(this.items);
  }

  /** 只转换已有素材的工具输出；语音暂存物化和重写策略仍由原提交 owner 裁决。 */
  buildImmediateOutputItem(
    stepIndex: number,
    toolCallId: string,
    params: BuildAgentTimelineItemsParams,
  ): ConversationTurnCommitItem | null {
    const step = this.requireStep(stepIndex);
    const sticker = step.stickerItems.find(item => item.toolCallId === toolCallId);
    if (sticker) return { message: this.buildStickerMessage(sticker, params) };
    const image = step.contentItems.find(item => item.toolCallId === toolCallId && isImageSendIntent(item.intent));
    return image ? { message: this.buildContentMessage(image, params) } : null;
  }

  recordCommittedOutput(stepIndex: number, toolCallId: string, messages: readonly ChatMessage[]): void {
    const step = this.requireStep(stepIndex);
    step.committedOutputs.set(toolCallId, messages[0].id);
    if (step.toolItem) {
      const status = step.toolItem.status === 'failed' ? 'failed'
        : step.toolItem.status === 'completed' ? 'completed' : 'running';
      step.toolItem = this.replaceItem(step.toolItem, {
        text: buildToolStatusText(joinToolDisplayNames(this.resolveToolDisplayNames(this.timelineToolCalls(step))), status)
          + this.outputDeliveryText(step),
      });
    }
    // 交接一条已提交消息，不清除仍在执行的时间线或宣布整轮完成。
    this.sink.onCommitted?.({ runId: this.runId, messages, outcome: 'committed' });
    this.publish();
  }

  private outputDeliveryText(step: TimelineStep, failureReason?: string): string {
    return [
      { label: '表情', items: step.stickerItems },
      { label: '图片', items: step.contentItems.filter(item => isImageSendIntent(item.intent)) },
    ].flatMap(({ label, items }) => {
      const committed = items.filter(item => step.committedOutputs.has(item.toolCallId)).length;
      return [
        ...(committed > 0 ? [`\n${label}消息已提交。`] : []),
        ...(committed < items.length ? [failureReason
          ? `\n${label}未发送：${failureReason}。` : `\n${label}已准备，等待提交。`] : []),
      ];
    }).join('');
  }

  private snapshotItems(items: readonly AgentTimelineItem[]): AgentTimelineItemSnapshot[] {
    return items.flatMap(item => {
      let snapshot = toSnapshot(item);
      // 静默控制信号尚未收齐时也不能泄漏到普通气泡；其余正文沿统一流式分段展示。
      if (this.finalAssistantPolicy === 'autonomous_reply' && item.kind === 'assistant'
        && AUTONOMOUS_SILENT_REPLY.startsWith(item.text.trim())) return [];
      if (item.kind === 'assistant' && item.status === 'streaming') snapshot = { ...snapshot, streamingDelivery: true };
      if (!this.presentationPolicy || item.kind !== 'assistant'
        || (item.status === 'streaming' && this.presentationPolicy.bubbleDeliveryMode === 'single-bubble')) return [snapshot];
      const segments = segmentAssistantReplyProgress(item.text, this.presentationPolicy.bubbleDeliveryMode, item.status !== 'streaming');
      return segments.map((segment, segmentIndex) => ({ ...snapshot, text: segment.text, segmentIndex,
        status: item.status === 'streaming' && segment.completed ? 'sent' as const : item.status,
        clientMessageId: buildAgentTimelineClientMessageId(this.runId, item.sequence, segmentIndex),
        // 与正式消息相同：每次模型请求的统计随尾段交付，不等整轮工具 Loop 的 T3。
        ...(segmentIndex < segments.length - 1 ? {
          tokensUsed: 0, promptTokens: 0, completionTokens: 0, cachedTokens: undefined,
        } : {}),
      }));
    });
  }

  /** canonical T3 的唯一纯转换边界。顺序只由 run-local sequence 决定。 */
  buildCommitItems(params: BuildAgentTimelineItemsParams): ConversationTurnCommitItem[] {
    const runtimeContext = params.runtimeContext ?? {};
    const projected: {
      sourceSequence: number;
      segmentIndex: number;
      item: AgentTimelineItem | StickerTimelineItem | VoiceTimelineItem | ContentTimelineItem;
      commitItem: ConversationTurnCommitItem;
    }[] = [];

    // 同一 step 必须一次调用 buildAssistantTurnItems：这样 reasoning 与 assistant
    // 共享原有 logicalMessageId、token 归属和分段规则；工具仍由专用 builder 负责。
    for (const step of this.steps.values()) {
      const reasoningItem = step.reasoningItem;
      const assistantItem = step.assistantItem;
      const silent = params.finalAssistantPolicy === 'autonomous_reply'
        && step.stepIndex === params.finalStepIndex
        && step.turn!.toolCalls.length === 0
        && isAutonomousSilentReply(assistantItem?.text ?? '');
      if (reasoningItem || assistantItem) {
        const response = toAIResponseForStep(step);
        const normalized = assistantItem
          ? silent
            ? { text: '本次选择不发送消息', segments: ['本次选择不发送消息'] }
            : normalizeAssistantResponseText(assistantItem.text, params.policy)
          : { text: '', segments: [] };
        const built = buildAssistantTurnItems({
          sessionId: params.sessionId,
          aiConfig: params.aiConfig,
          runtimeContext,
          response,
          normalizedText: normalized.text,
          visibleSegments: normalized.segments,
        });
        let assistantSegmentIndex = 0;
        for (const entry of built) {
          const target = entry.message.senderType === 'reasoning'
            ? reasoningItem
            : assistantItem;
          if (!target) {
            throw new Error(`Chat Agent step ${step.stepIndex} builder returned an unowned item`);
          }
          const segmentIndex = entry.message.senderType === 'assistant'
            ? assistantSegmentIndex++
            : 0;
          projected.push({
            sourceSequence: target.sequence,
            segmentIndex,
            item: target,
            commitItem: {
              message: this.withStableIdentity(
                silent && entry.message.senderType === 'assistant'
                  ? { ...entry.message,
                      senderType: 'system',
                      metadataJson: JSON.stringify({ ...parseMetadata(entry.message.metadataJson),
                        type: 'agentActivity', source: 'chatAgentRun', phase: 'assistant' }),
                    }
                  : entry.message,
                target, segmentIndex,
              ),
            },
          });
        }
      }
      if (step.toolItem) {
        projected.push({
          sourceSequence: step.toolItem.sequence,
          segmentIndex: 0,
          item: step.toolItem,
          commitItem: {
            message: this.buildToolMessage(step.toolItem, params),
          },
        });
      }
      for (const stickerItem of step.stickerItems) {
        projected.push({
          sourceSequence: stickerItem.sequence,
          segmentIndex: 0,
          item: stickerItem,
          commitItem: {
            message: this.buildStickerMessage(stickerItem, params),
            committedMessageId: step.committedOutputs.get(stickerItem.toolCallId),
          },
        });
      }
      for (const voiceItem of step.voiceItems) {
        projected.push({
          sourceSequence: voiceItem.sequence,
          segmentIndex: 0,
          item: voiceItem,
          commitItem: this.buildVoiceMessage(voiceItem, params),
        });
      }
      for (const contentItem of step.contentItems) {
        projected.push({
          sourceSequence: contentItem.sequence,
          segmentIndex: 0,
          item: contentItem,
          commitItem: { message: this.buildContentMessage(contentItem, params),
            committedMessageId: step.committedOutputs.get(contentItem.toolCallId) },
        });
      }
    }

    const commitItems = projected
      .sort((left, right) => left.sourceSequence - right.sourceSequence || left.segmentIndex - right.segmentIndex)
      .map((entry) => entry.commitItem);
    return commitItems;
  }

  /** supersede/cancel/fence failure 后清理旧 run transient，避免新 run 被旧投影回灌。 */
  clear(reason?: 'superseded' | 'cancelled' | 'fence_failed' | 'model_failure' | 'completed'): void {
    for (const step of this.steps.values()) {
      for (const item of step.voiceItems) {
        // clear 只在本 run 确定不会提交时执行，因此按“事务未提交”语义清理。
        void item.intent.preparedMedia.discardAfterRollback().catch((error) => {
          console.warn('[ChatAgentTimeline] 清理未提交语音媒体失败', error);
        });
      }
    }
    this.items.length = 0;
    this.steps.clear();
    this.emittedAssistantSnapshots.clear();
    this.nextSequence = 1;
    this.sink.onCleared?.({ runId: this.runId, reason });
  }

  /** T3 提交后的 replacement 先通知 sink，再丢弃 execution-side timeline。 */
  commit(
    messages: readonly ChatMessage[],
    outcome: 'committed' | 'fence_failed' | 'empty_items',
  ): void {
    this.sink.onCommitted?.({ runId: this.runId, messages, outcome });
    this.items.length = 0;
    this.steps.clear();
    this.emittedAssistantSnapshots.clear();
    this.nextSequence = 1;
  }

  private reconcileText(
    step: TimelineStep,
    kind: Extract<AgentTimelineItemKind, 'reasoning' | 'assistant'>,
    text: string,
  ): void {
    const current = kind === 'reasoning' ? step.reasoningItem : step.assistantItem;
    const currentText = current?.text ?? '';
    if (text === currentText) {
      return;
    }
    if (!text.startsWith(currentText)) {
      throw new Error(`Chat Agent ${kind} payload conflicts at step ${step.stepIndex}`);
    }
    this.appendDelta(step.stepIndex, kind, text.slice(currentText.length));
  }

  private timelineToolCalls(step: TimelineStep): ModelToolCall[] {
    if (!step.turn) {
      throw new Error(`Chat Agent tool event references step ${step.stepIndex} before model turn`);
    }
    return step.turn.toolCalls;
  }

  private createTextItem(
    stepIndex: number,
    kind: Extract<AgentTimelineItemKind, 'reasoning' | 'assistant'>,
    text: string,
  ): AgentTimelineItem {
    const now = new Date();
    return this.createItem({
      stepIndex,
      kind,
      text,
      status: 'streaming',
      createdAt: now.toISOString(),
      time: formatMessageTime(now),
      toolCalls: [],
      outcomes: new Map(),
      turn: null,
    });
  }

  private createStickerTimelineItem(
    step: TimelineStep,
    toolCallId: string,
    sticker: StickerMessageSnapshot,
  ): StickerTimelineItem {
    const now = new Date();
    return {
      sequence: this.nextSequence++,
      stepIndex: step.stepIndex,
      toolCallId,
      sticker,
      apiMessageId: step.turn?.messageId ?? null,
      createdAt: now.toISOString(),
      time: formatMessageTime(now),
    };
  }

  private createVoiceTimelineItem(
    step: TimelineStep,
    toolCallId: string,
    intent: VoiceMessageSendIntent,
  ): VoiceTimelineItem {
    const now = new Date();
    return {
      sequence: this.nextSequence++,
      stepIndex: step.stepIndex,
      toolCallId,
      intent,
      apiMessageId: step.turn?.messageId ?? null,
      createdAt: now.toISOString(),
      time: formatMessageTime(now),
    };
  }

  private createItem(params: {
    stepIndex: number;
    kind: AgentTimelineItemKind;
    text: string;
    status: AgentTimelineItemStatus;
    createdAt: string;
    time: string;
    toolCalls: readonly ModelToolCall[];
    outcomes: ReadonlyMap<string, AgentToolOutcome>;
    turn: ChatAgentModelTurn | null;
    toolNames?: readonly string[];
    toolDisplayNames?: readonly string[];
  }): AgentTimelineItem {
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    const item: AgentTimelineItem = {
      runId: this.runId,
      sequence,
      identity: buildAgentTimelineIdentity(this.runId, sequence),
      stepIndex: params.stepIndex,
      kind: params.kind,
      status: params.status,
      text: params.text,
      clientMessageId: buildAgentTimelineClientMessageId(this.runId, sequence),
      createdAt: params.createdAt,
      time: params.time,
      toolNames: params.toolNames,
      toolDisplayNames: params.toolDisplayNames,
      toolCalls: params.toolCalls,
      outcomes: params.outcomes,
      turn: params.turn,
    };
    this.items.push(item);
    this.markDirty(item);
    return item;
  }

  private replaceItem(
    item: AgentTimelineItem,
    updates: Partial<Pick<AgentTimelineItem, 'text' | 'status' | 'toolNames' | 'toolDisplayNames'>>,
  ): AgentTimelineItem {
    const replacement = { ...item, ...updates };
    const index = this.items.findIndex((candidate) => candidate.sequence === item.sequence);
    if (index < 0) {
      throw new Error(`Chat Agent timeline item ${item.identity} is not owned by this run`);
    }
    this.items[index] = replacement;
    this.markDirty(replacement);
    return replacement;
  }

  private withStableIdentity(
    message: CreateMessageInput,
    item: AgentTimelineItem,
    segmentIndex: number,
  ): CreateMessageInput {
    const clientMessageId = buildAgentTimelineClientMessageId(
      this.runId,
      item.sequence,
      segmentIndex,
    );
    const metadata = parseMetadata(message.metadataJson);
    return {
      ...message,
      clientMessageId,
      createdAt: item.createdAt,
      updatedAt: item.createdAt,
      time: item.time,
      logicalMessageId: buildAgentTimelineLogicalMessageId(this.runId, item.stepIndex),
      metadataJson: JSON.stringify({
        ...metadata,
        transientIdentity: clientMessageId,
        timelineSequence: item.sequence,
        timelineKind: item.kind,
        stepIndex: item.stepIndex,
        toolExecutions: toSnapshot(item).toolExecutions,
      }),
    };
  }

  private buildToolMessage(
    item: AgentTimelineItem,
    params: BuildAgentTimelineItemsParams,
  ): CreateMessageInput {
    if (!params.aiConfig) {
      throw new Error('canonical Agent tool timeline requires aiConfig');
    }
    const runtimeContext = params.runtimeContext ?? {};
    const toolNames = [...(item.toolNames ?? [])];
    const toolDisplayNames = [...(item.toolDisplayNames ?? [])];
    const status = item.status === 'failed' ? 'failed' : item.status === 'completed' ? 'completed' : 'running';
    // 选择结果与表情消息同属 T3；正式工具记录不再保留提交前的等待文案。
    const text = this.requireStep(item.stepIndex).stickerItems.length > 0
      ? buildToolStatusText(joinToolDisplayNames(toolDisplayNames), status)
      : item.text;
    const metadata = buildChatToolStatusMessageMetadata({
      aiConfig: params.aiConfig,
      runtimeContext,
      status,
      toolNames,
      toolDisplayNames,
      displayText: text,
    });
    return {
      sessionId: params.sessionId,
      text,
      isMe: false,
      senderType: 'system',
      agentId: params.aiConfig.agentId,
      apiMessageId: item.turn?.messageId ?? null,
      clientMessageId: item.clientMessageId,
      time: item.time,
      createdAt: item.createdAt,
      updatedAt: item.createdAt,
      replyToId: null,
      replyToText: null,
      status: status === 'running' ? 'streaming' : status === 'failed' ? 'failed' : 'sent',
      tokensUsed: item.turn?.usage.totalTokens ?? 0,
      promptTokens: item.turn?.usage.promptTokens ?? 0,
      completionTokens: item.turn?.usage.completionTokens ?? 0,
      metadataJson: JSON.stringify({
        ...metadata,
        cachedTokens: item.turn?.usage.cachedTokens,
        transientIdentity: item.clientMessageId,
        timelineSequence: item.sequence,
        timelineKind: item.kind,
        stepIndex: item.stepIndex,
        toolExecutions: toSnapshot(item).toolExecutions,
      }),
    };
  }

  private buildStickerMessage(
    item: StickerTimelineItem,
    params: BuildAgentTimelineItemsParams,
  ): CreateMessageInput {
    const runtimeContext = params.runtimeContext ?? {};
    const clientMessageId = buildAgentTimelineClientMessageId(this.runId, item.sequence);
    const metadata = buildMessageMetadata(params.aiConfig, runtimeContext, {
      kind: 'sticker',
      sticker: item.sticker,
    });
    return {
      sessionId: params.sessionId,
      text: '',
      isMe: false,
      senderType: 'assistant',
      agentId: params.aiConfig?.agentId ?? null,
      apiMessageId: item.apiMessageId,
      clientMessageId,
      time: item.time,
      createdAt: item.createdAt,
      updatedAt: item.createdAt,
      replyToId: null,
      replyToText: null,
      status: 'sent',
      deliveryStatus: 'delivered',
      tokensUsed: 0,
      promptTokens: 0,
      completionTokens: 0,
      logicalMessageId: buildAgentTimelineLogicalMessageId(this.runId, item.stepIndex),
      metadataJson: JSON.stringify({
        ...metadata,
        transientIdentity: clientMessageId,
        timelineSequence: item.sequence,
        timelineKind: 'sticker',
        stepIndex: item.stepIndex,
      }),
    };
  }

  private buildContentMessage(
    item: ContentTimelineItem,
    params: BuildAgentTimelineItemsParams,
  ): CreateMessageInput {
    const clientMessageId = buildAgentTimelineClientMessageId(this.runId, item.sequence);
    return {
      sessionId: params.sessionId,
      text: '',
      isMe: false,
      senderType: 'assistant',
      agentId: params.aiConfig?.agentId ?? null,
      apiMessageId: item.apiMessageId,
      clientMessageId,
      time: item.time,
      createdAt: item.createdAt,
      updatedAt: item.createdAt,
      replyToId: null,
      replyToText: null,
      status: 'sent',
      deliveryStatus: 'delivered',
      tokensUsed: 0,
      promptTokens: 0,
      completionTokens: 0,
      logicalMessageId: buildAgentTimelineLogicalMessageId(this.runId, item.stepIndex),
      metadataJson: JSON.stringify(buildMessageMetadata(params.aiConfig, params.runtimeContext ?? {}, {
        ...(isImageSendIntent(item.intent) ? { kind: 'image', attachments: [item.intent.attachment] } : { kind: 'shared_moment', sharedMoment: item.intent.moment }),
        transientIdentity: clientMessageId,
        timelineSequence: item.sequence,
        timelineKind: isImageSendIntent(item.intent) ? 'image' : 'shared_moment',
        stepIndex: item.stepIndex,
      })),
    };
  }

  private buildVoiceMessage(
    item: VoiceTimelineItem,
    params: BuildAgentTimelineItemsParams,
  ): ConversationTurnCommitItem {
    const runtimeContext = params.runtimeContext ?? {};
    const clientMessageId = buildAgentTimelineClientMessageId(this.runId, item.sequence);
    const baseMetadata = buildMessageMetadata(params.aiConfig, runtimeContext, {
      transientIdentity: clientMessageId,
      timelineSequence: item.sequence,
      timelineKind: 'voice',
      stepIndex: item.stepIndex,
    });
    const message: CreateMessageInput = {
      sessionId: params.sessionId,
      text: item.intent.transcript,
      isMe: false,
      senderType: 'assistant',
      agentId: params.aiConfig?.agentId ?? null,
      apiMessageId: item.apiMessageId,
      clientMessageId,
      time: item.time,
      createdAt: item.createdAt,
      updatedAt: item.createdAt,
      replyToId: null,
      replyToText: null,
      status: 'sent',
      deliveryStatus: 'delivered',
      voicePlayedAt: null,
      tokensUsed: 0,
      promptTokens: 0,
      completionTokens: 0,
      logicalMessageId: buildAgentTimelineLogicalMessageId(this.runId, item.stepIndex),
      metadataJson: JSON.stringify(baseMetadata),
    };
    return {
      message,
      materializeInTransaction: async (transaction, input) => {
        const [asset] = (await item.intent.preparedMedia.commitInTransaction(transaction)).assets;
        return {
          ...input,
          metadataJson: JSON.stringify({
            ...baseMetadata,
            ...buildChatVoiceMessageMetadata({
              schemaVersion: 1,
              mediaAssetId: asset.id,
              mimeType: asset.mimeType,
              // 语音时长是本次 send intent 已确定的业务事实。MediaAsset 可能被 catalog
              // 复用为历史行，其 durationMs 只是资产 metadata，不能反向覆盖本次
              // 语音消息的 duration。
              durationMs: item.intent.durationMs,
              transcriptSource: 'assistant_source_text',
            }),
          }),
        };
      },
      finalizeAfterCommit: () => item.intent.preparedMedia.finalizeAfterCommit(),
      // T3 已确认未提交（fence 失败或事务回滚）时才允许按回滚清理 prepared backing。
      discardAfterRollback: () => item.intent.preparedMedia.discardAfterRollback(),
    };
  }

  private publish(): void {
    this.sink.onDirty?.(this.readChanges);
    this.sink.onChanged?.({
      runId: this.runId,
      items: this.snapshots(),
    });
  }

  private markDirty(item: AgentTimelineItem): void {
    if (this.sink.onDirty) this.dirtyItems.set(item.sequence, item);
  }

  private resolveToolDisplayNames(toolCalls: readonly ModelToolCall[]): string[] {
    return toolCalls.map((toolCall) => resolveToolCallDisplayName(toolCall));
  }

  private requireStep(stepIndex: number): TimelineStep {
    const step = this.steps.get(stepIndex);
    if (!step) {
      throw new Error(`Chat Agent event references unknown step ${stepIndex}`);
    }
    return step;
  }
}

export function buildAgentTimelineLogicalMessageId(runId: string, stepIndex: number): string {
  return `agent_timeline:${encodeURIComponent(runId)}:step:${stepIndex}`;
}

function toSnapshot(item: AgentTimelineItem): AgentTimelineItemSnapshot {
  return {
    runId: item.runId,
    sequence: item.sequence,
    identity: item.identity,
    stepIndex: item.stepIndex,
    kind: item.kind,
    status: item.status,
    text: item.text,
    clientMessageId: item.clientMessageId,
    createdAt: item.createdAt,
    time: item.time,
    apiMessageId: item.turn?.messageId ?? null,
    ...(item.kind === 'assistant' && item.turn ? {
      tokensUsed: item.turn.usage.totalTokens,
      promptTokens: item.turn.usage.promptTokens,
      completionTokens: item.turn.usage.completionTokens,
      cachedTokens: item.turn.usage.cachedTokens,
    } : {}),
    toolNames: item.toolNames,
    toolExecutionStarted: item.toolExecutionStarted,
    toolExecutions: item.kind === 'tool' ? item.toolCalls.map(call => {
      const outcome = item.outcomes.get(call.id);
      return { toolCallId: call.id, name: call.name, arguments: call.arguments,
        status: outcome?.status ?? (item.startedToolCallIds?.includes(call.id) ? 'running' : 'proposed'),
        ...(outcome ? { modelContent: outcome.modelContent } : {}),
      };
    }) : undefined,
    toolDisplayNames: item.toolDisplayNames,
  };
}

function toAIResponseForStep(step: TimelineStep): AIResponse {
  const turn = step.turn;
  return {
    success: true,
    text: step.assistantItem?.text ?? '',
    reasoningText: step.reasoningItem?.text,
    messageId: turn?.messageId ?? null,
    totalTokens: turn?.usage.totalTokens ?? 0,
    promptTokens: turn?.usage.promptTokens ?? 0,
    completionTokens: turn?.usage.completionTokens ?? 0,
    cachedTokens: turn?.usage.cachedTokens,
    isToolCall: Boolean(turn && turn.toolCalls.length > 0),
    toolCalls: turn?.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: 'function' as const,
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    })) ?? [],
  };
}

function parseMetadata(metadataJson: string | null | undefined): Record<string, unknown> {
  if (!metadataJson) {
    return {};
  }
  const metadata = JSON.parse(metadataJson) as unknown;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Chat Agent timeline message metadata must be an object');
  }
  return metadata as Record<string, unknown>;
}

function isSuppressedSuccessfulOutcome(outcome: AgentToolOutcome): boolean {
  return outcome.status === 'success' && outcome.metadata?.suppressAssistantReply === true;
}

function isToolStatusFailure(outcome: AgentToolOutcome): boolean {
  return outcome.status === 'error';
}
