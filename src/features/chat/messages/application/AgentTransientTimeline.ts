/**
 * Agent run 的短生命周期展示投影。
 *
 * canonical user_reply 的 assistant/reasoning/tool 事实仍只由 T3 写入数据库。
 * 这个 store 只保存当前 JS runtime 中尚未完成 reconciliation 的展示条目，
 * 不参与 MessageTimeline、分页游标或 sessionTimelineCache。应用进程重启后
 * store 自然为空，历史仍以 SQLite 为唯一来源。
 */

import type { ChatMessage } from '../domain/ChatMessage';
import {
  AGENT_TIMELINE_CLIENT_MESSAGE_PREFIX,
  buildAgentTimelineClientMessageId,
  buildAgentTimelineIdentity,
  parseAgentTimelineClientMessageId,
} from '../domain/AgentTimelineIdentity';

export type AgentTransientTimelineKind = 'reasoning' | 'assistant' | 'tool';

interface AgentTransientTimelineItem {
  sessionId: string;
  runId: string;
  stepIndex: number;
  segmentIndex?: number;
  sequence: number;
  kind: AgentTransientTimelineKind;
  /** 当前展示所需消息；不得把它交给历史 cache 或 persistence。 */
  message: ChatMessage;
}

/** ChatAgentTimeline sink 的 structural DTO；保持消息层不依赖 reply projector。 */
export interface AgentTransientTimelineSnapshot {
  runId: string;
  sequence: number;
  stepIndex: number;
  segmentIndex?: number;
  kind: AgentTransientTimelineKind;
  status: 'streaming' | 'running' | 'sent' | 'completed' | 'failed';
  text: string;
  clientMessageId: string;
  createdAt: string;
  time: string;
  toolNames?: readonly string[];
  toolDisplayNames?: readonly string[];
  toolExecutionStarted?: boolean;
  apiMessageId?: string | null;
  interrupted?: boolean;
  pendingDelivery?: boolean;
  tokensUsed?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  metadataJson?: string | null;
}

export interface ApplyAgentTransientTimelineSnapshotsParams {
  sessionId: string;
  snapshots: readonly AgentTransientTimelineSnapshot[];
  agentId?: string | null;
  /** 来源拥有投影回收权；历史窗口不能清理仍由执行器更新的片段。 */
  source?: 'execution' | 'history';
}

export interface AgentTransientTimelineSink {
  onChanged?: (event: {
    runId: string;
    items: readonly AgentTransientTimelineSnapshot[];
  }) => void;
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

export function createAgentTransientTimelineSink(params: {
  sessionId: string;
  agentId?: string | null;
}): AgentTransientTimelineSink {
  return {
    onChanged: ({ items }) => {
      applyAgentTransientTimelineSnapshots({
        sessionId: params.sessionId,
        snapshots: items,
        agentId: params.agentId,
      });
    },
    onCommitted: ({ runId, messages, outcome }) => {
      if (outcome === 'committed') {
        reconcileAgentTransientTimelineCommit(params.sessionId, runId, messages);
        return;
      }
      clearAgentTransientTimelineRun(runId, params.sessionId);
    },
    onCleared: ({ runId }) => {
      clearAgentTransientTimelineRun(runId, params.sessionId);
    },
  };
}

export interface AgentTransientTimelineMessage extends ChatMessage {
  /** UI key 的稳定 identity，不依赖文本、数据库 id 或创建时间。 */
  readonly transientTimelineIdentity: string;
  readonly transientTimelineRunId: string;
  readonly transientTimelineSequence: number;
  readonly transientTimelineKind: AgentTransientTimelineKind;
}

interface ReplaceAgentTransientTimelineParams {
  sessionId: string;
  runId: string;
  /** T3 返回的最终消息；每条应含同一 reserved clientMessageId。 */
  messages: readonly ChatMessage[];
}

type TimelineListener = () => void;
type TimelineMessageWithOrder = ChatMessage & {
  turnItemIndex?: number | null;
};

interface RunState {
  readonly sessionId: string;
  readonly runId: string;
  readonly createdOrder: number;
  source: 'execution' | 'history';
  readonly items: Map<string, AgentTransientTimelineItem>;
  /** commit 返回后暂存，等历史查询包含同一条消息再移除，避免 commit/reload 空窗闪烁。 */
  replacements: Map<string, ChatMessage>;
}

interface SessionState {
  readonly runs: Map<string, RunState>;
  revision: number;
}

const sessions = new Map<string, SessionState>();
const listeners = new Map<string, Set<TimelineListener>>();
let createdOrder = 0;

export function getAgentTimelineMessageIdentity(
  message: Pick<ChatMessage, 'clientMessageId'>
): string | null {
  const clientMessageId = message.clientMessageId?.trim();
  if (clientMessageId?.startsWith(AGENT_TIMELINE_CLIENT_MESSAGE_PREFIX)) {
    return clientMessageId;
  }
  return null;
}

/** T3 分段会重排连续 itemIndex；混合展示以稳定的 source sequence + segment 为准。 */
export function getAgentTimelineSourceOrder(message: ChatMessage) {
  return message.clientMessageId ? parseAgentTimelineClientMessageId(message.clientMessageId) : null;
}

export function isAgentTransientTimelineMessage(
  message: ChatMessage
): message is AgentTransientTimelineMessage {
  const candidate = message as Partial<AgentTransientTimelineMessage>;
  return Boolean(
    candidate.transientTimelineIdentity
    && candidate.transientTimelineRunId
    && Number.isInteger(candidate.transientTimelineSequence)
  );
}

export function getAgentTransientTimelineMessageKey(message: ChatMessage): string | null {
  if (isAgentTransientTimelineMessage(message)) {
    return getAgentTimelineMessageIdentity(message)
      ?? message.transientTimelineIdentity;
  }
  return getAgentTimelineMessageIdentity(message);
}

function getSessionState(sessionId: string): SessionState {
  const existing = sessions.get(sessionId);
  if (existing) {
    return existing;
  }
  const state: SessionState = { runs: new Map(), revision: 0 };
  sessions.set(sessionId, state);
  return state;
}

function notify(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.revision += 1;
  }
  for (const listener of Array.from(listeners.get(sessionId) ?? [])) {
    listener();
  }
}

export function getAgentTransientTimelineRevision(sessionId?: string | null): number {
  return sessionId ? sessions.get(sessionId)?.revision ?? 0 : 0;
}

/**
 * 当前 runtime 仍然活跃的 Agent run id。
 *
 * run state 只在本 runtime 尚未完成 reconciliation 期间存在：transient item 被
 * DB 读回、committed replacement 被 DB 读回后 run 即被清理。因此这个集合就是
 * 「本 runtime 亲眼看着发生的 run」，presentation 用它区分
 * "本页 live run 刚提交的 canonical group" 与 "hydration / reload / remount
 * 读回的既有事实" —— 两者的数据形状完全相同，无法靠数组比较区分。
 */
export function getLiveAgentTimelineRunIds(sessionId?: string | null): ReadonlySet<string> {
  const session = sessionId ? sessions.get(sessionId) : undefined;
  return session ? new Set(session.runs.keys()) : EMPTY_RUN_IDS;
}

/** 历史读取只能移除自己回填过的 run，不拥有其他执行器的实时投影。 */
export function getHistoryAgentTimelineRunIds(sessionId: string): ReadonlySet<string> {
  const session = sessions.get(sessionId);
  return session ? new Set([...session.runs.values()].filter(run => run.source === 'history').map(run => run.runId)) : EMPTY_RUN_IDS;
}

const EMPTY_RUN_IDS: ReadonlySet<string> = new Set();

function ensureRun(sessionId: string, runId: string): RunState {
  const session = getSessionState(sessionId);
  const existing = session.runs.get(runId);
  if (existing) {
    return existing;
  }
  const run: RunState = {
    sessionId,
    runId,
    createdOrder: createdOrder += 1,
    source: 'execution',
    items: new Map(),
    replacements: new Map(),
  };
  session.runs.set(runId, run);
  return run;
}

function decorateTransientMessage(item: AgentTransientTimelineItem): AgentTransientTimelineMessage {
  const transientIdentity = buildAgentTimelineIdentity(item.runId, item.sequence);
  const source = item.message as TimelineMessageWithOrder;
  const clientMessageId = source.clientMessageId
    || buildAgentTimelineClientMessageId(item.runId, item.sequence);
  return {
    ...item.message,
    // 负数 id 只为满足 ChatMessage 的渲染 contract；presentation key 使用 identity，
    // 该 id 不会进入 MessageTimeline、lastMessageId 或数据库。
    id: source.id < 0 ? source.id : -stableTransientMessageId(clientMessageId),
    clientMessageId,
    turnRunId: item.runId,
    turnItemIndex: item.sequence,
    transientTimelineIdentity: transientIdentity,
    transientTimelineRunId: item.runId,
    transientTimelineSequence: item.sequence,
    transientTimelineKind: item.kind,
  } as AgentTransientTimelineMessage;
}

function stableTransientMessageId(identity: string): number {
  // 仅作渲染层的非持久 id；真正的 identity 仍是 runId + sequence。
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}

function buildTransientMessageFromSnapshot(
  sessionId: string,
  snapshot: AgentTransientTimelineSnapshot,
  agentId?: string | null,
): ChatMessage {
  const isTool = snapshot.kind === 'tool';
  const status = snapshot.status === 'failed'
    ? 'failed'
    : snapshot.status === 'streaming' || snapshot.status === 'running'
      ? 'streaming'
      : 'sent';
  const metadataJson = isTool
    ? JSON.stringify({
        type: 'toolStatus',
        status: snapshot.status === 'running' || snapshot.status === 'streaming'
          ? 'running'
          : snapshot.status === 'failed' ? 'failed' : 'completed',
        toolNames: [...(snapshot.toolNames ?? [])],
        displayNames: [...(snapshot.toolDisplayNames ?? [])],
        displayText: snapshot.text,
        source: 'chatToolFlow',
        interrupted: snapshot.interrupted === true,
      })
    : JSON.stringify({ interrupted: snapshot.interrupted === true, pendingDelivery: snapshot.pendingDelivery === true,
        cachedTokens: snapshot.cachedTokens });
  return {
    id: 0,
    sessionId,
    text: snapshot.text,
    isMe: false,
    isRead: true,
    senderType: isTool ? 'system' : snapshot.kind,
    agentId: agentId ?? null,
    apiMessageId: snapshot.apiMessageId ?? null,
    clientMessageId: snapshot.clientMessageId,
    time: snapshot.time,
    createdAt: snapshot.createdAt,
    showTimeSeparatorBefore: false,
    updatedAt: snapshot.createdAt,
    replyToId: null,
    replyToText: null,
    status,
    segmentIndex: snapshot.segmentIndex ?? 0,
    tokensUsed: snapshot.tokensUsed ?? 0,
    promptTokens: snapshot.promptTokens ?? 0,
    completionTokens: snapshot.completionTokens ?? 0,
    metadataJson: snapshot.metadataJson
      ? JSON.stringify({ ...JSON.parse(snapshot.metadataJson), interrupted: snapshot.interrupted === true }) : metadataJson,
  };
}

/** 执行与历史回填共用 store；来源随更新交接，回收时按来源隔离。 */
export function applyAgentTransientTimelineSnapshots(
  params: ApplyAgentTransientTimelineSnapshotsParams
): void {
  const firstSnapshot = params.snapshots[0];
  if (!firstSnapshot) {
    return;
  }
  const run = ensureRun(params.sessionId, firstSnapshot.runId);
  run.source = params.source ?? 'execution';
  for (const snapshot of params.snapshots) {
    const item: AgentTransientTimelineItem = {
      sessionId: params.sessionId,
      runId: snapshot.runId,
      stepIndex: snapshot.stepIndex,
      sequence: snapshot.sequence,
      kind: snapshot.kind,
      message: buildTransientMessageFromSnapshot(
        params.sessionId,
        snapshot,
        params.agentId,
      ),
    };
    run.items.set(snapshot.clientMessageId, {
      ...item,
      message: decorateTransientMessage(item),
    });
  }
  notify(params.sessionId);
}

export function reconcileAgentTransientTimelineCommit(
  sessionId: string,
  runId: string,
  messages: readonly ChatMessage[]
): void {
  replaceAgentTransientTimelineWithCommitted({
    sessionId,
    runId,
    messages: [...messages],
  });
}

/** 当前 run 的 committed overlay + transient snapshot，供 presentation 一次性合并。 */
export function snapshotAgentTransientTimelineWithReplacements(
  sessionId?: string | null
): ChatMessage[] {
  if (!sessionId) {
    return [];
  }
  const session = sessions.get(sessionId);
  if (!session) {
    return [];
  }
  return Array.from(session.runs.values())
    .sort((left, right) => left.createdOrder - right.createdOrder)
    .flatMap((run) => buildRunRenderMessages(run));
}

function buildRunRenderMessages(run: RunState): ChatMessage[] {
  const replacementKeys = new Set(run.replacements.keys());
  const rendered: { message: ChatMessage; sequence: number; segmentIndex: number }[] = [];
  for (const item of run.items.values()) {
    const message = item.message;
    const identity = getAgentTimelineMessageIdentity(message as TimelineMessageWithOrder);
    if (identity && replacementKeys.has(identity)) {
      continue;
    }
    rendered.push({ message, sequence: item.sequence, segmentIndex: message.segmentIndex ?? 0 });
  }
  for (const [identity, message] of run.replacements) {
    const parsed = parseAgentTimelineClientMessageId(identity)!;
    rendered.push({
      message,
      sequence: parsed.sequence,
      segmentIndex: parsed.segmentIndex,
    });
  }
  rendered.sort((left, right) => left.sequence - right.sequence || left.segmentIndex - right.segmentIndex);
  return rendered.map((entry) => entry.message);
}

function replaceAgentTransientTimelineWithCommitted(
  params: ReplaceAgentTransientTimelineParams
): void {
  const run = ensureRun(params.sessionId, params.runId);
  run.source = 'execution';
  for (const message of params.messages) {
    const identity = getAgentTimelineMessageIdentity(message as TimelineMessageWithOrder);
    const parsed = identity ? parseAgentTimelineClientMessageId(identity) : null;
    if (!identity || !parsed || parsed.runId !== params.runId) {
      throw new Error('Agent committed replacement identity 必须属于当前 run');
    }
    run.replacements.set(identity, message);
    for (const [sequence, item] of run.items) {
      const itemIdentity = getAgentTimelineMessageIdentity(
        item.message as TimelineMessageWithOrder
      );
      if (itemIdentity === identity) {
        run.items.delete(sequence);
      }
    }
  }
  notify(params.sessionId);
}

/**
 * DB reload 后确认已落库的 identity，移除 replacement overlay；不按文本匹配。
 * 当某个 run 的全部 transient/replacement 都已被 DB 读回时，run state 也一并清理。
 */
export function acknowledgeAgentTransientTimelineCommitted(
  sessionId: string,
  messages: readonly ChatMessage[]
): void {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  const persistedKeys = new Set(
    messages
      .map((message) => getAgentTimelineMessageIdentity(message as TimelineMessageWithOrder))
      .filter((identity): identity is string => Boolean(identity))
  );
  let changed = false;
  for (const run of session.runs.values()) {
    for (const identity of run.replacements.keys()) {
      if (persistedKeys.has(identity)) {
        run.replacements.delete(identity);
        changed = true;
      }
    }
    for (const [sequence, item] of run.items) {
      const identity = getAgentTimelineMessageIdentity(
        item.message as TimelineMessageWithOrder
      );
      if (identity && persistedKeys.has(identity)) {
        run.items.delete(sequence);
        changed = true;
      }
    }
    if (run.items.size === 0 && run.replacements.size === 0) {
      session.runs.delete(run.runId);
      changed = true;
    }
  }
  if (changed) {
    notify(sessionId);
  }
}

export function clearAgentTransientTimelineRun(
  runId: string,
  sessionId: string,
): void {
  const session = sessions.get(sessionId);
  if (!session?.runs.delete(runId)) {
    return;
  }
  notify(sessionId);
}

export function subscribeAgentTransientTimeline(
  sessionId: string,
  listener: TimelineListener
): () => void {
  const sessionListeners = listeners.get(sessionId) ?? new Set<TimelineListener>();
  sessionListeners.add(listener);
  listeners.set(sessionId, sessionListeners);
  return () => {
    sessionListeners.delete(listener);
    if (sessionListeners.size === 0) {
      listeners.delete(sessionId);
    }
  };
}

/**
 * 渲染层统一 key：Agent timeline 使用 commit 前后不变的 clientMessageId，
 * 用户消息使用发送前已确定的 clientMessageId，落库不重建列表项；
 * 其它 canonical 历史消息使用 turnRunId + turnItemIndex，其余消息继续使用数据库 id。
 */
export function getAgentTimelineRenderKey(message: ChatMessage): string {
  const identity = getAgentTransientTimelineMessageKey(message);
  if (identity) {
    return identity;
  }
  if (message.isMe && message.clientMessageId) return `client:${message.clientMessageId}`;
  const orderedMessage = message as TimelineMessageWithOrder;
  if (orderedMessage.turnRunId && Number.isInteger(orderedMessage.turnItemIndex)) {
    return `turn:${orderedMessage.turnRunId}:${orderedMessage.turnItemIndex}`;
  }
  return `msg_${message.id}`;
}

export const agentTransientTimeline = {
  applySnapshots: applyAgentTransientTimelineSnapshots,
  createSink: createAgentTransientTimelineSink,
  snapshotWithReplacements: snapshotAgentTransientTimelineWithReplacements,
  reconcileCommit: reconcileAgentTransientTimelineCommit,
  acknowledgeCommitted: acknowledgeAgentTransientTimelineCommitted,
  clear: clearAgentTransientTimelineRun,
  getRevision: getAgentTransientTimelineRevision,
  getLiveRunIds: getLiveAgentTimelineRunIds,
  subscribe: subscribeAgentTransientTimeline,
};
