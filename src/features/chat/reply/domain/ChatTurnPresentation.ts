import type { ChatToolExecutionSnapshot } from '../../messages/domain/chatMessageMetadata';
export type { ChatToolExecutionSnapshot } from '../../messages/domain/chatMessageMetadata';

/** 交付先持久化再投影；折叠与屏幕测量不能撤销已交付的版本。 */
export interface ChatTurnDisplaySnapshot {
  runId: string;
  sequence: number;
  stepIndex: number;
  segmentIndex?: number;
  kind: 'reasoning' | 'assistant' | 'tool';
  status: 'streaming' | 'running' | 'sent' | 'completed' | 'failed';
  text: string;
  clientMessageId: string;
  createdAt: string;
  time: string;
  toolNames?: readonly string[];
  toolDisplayNames?: readonly string[];
  toolExecutionStarted?: boolean;
  toolExecutions?: readonly ChatToolExecutionSnapshot[];
  apiMessageId?: string | null;
  pendingDelivery?: boolean;
  /** 生成中的正文随持久批次交付，不叠加非流式的分段间隔。 */
  streamingDelivery?: boolean;
  tokensUsed?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  /** 仅 T3 物化后的正式消息元数据；运行时快照不提前取得媒体所有权。 */
  metadataJson?: string | null;
}

export interface ChatTurnDisplayVersion {
  version: number;
  snapshot: ChatTurnDisplaySnapshot;
}

export type ChatTurnExecutionPhase = 'preparing' | 'waiting_model' | 'receiving_model' | 'executing_tool'
  | 'processing_result' | 'committing' | 'delivering' | 'closing' | 'request_failed';

export interface ChatTurnExecutionProgress { phase: ChatTurnExecutionPhase; at: string }

export interface ChatTurnExecutionStatus {
  phase: ChatTurnExecutionPhase | 'waiting_host' | 'host_started' | 'failed' | 'interrupted';
  at: string;
  reason?: string | null;
}

export interface ChatTurnPresentationHistory {
  runId: string;
  state: 'open' | 'completed' | 'interrupted';
  reason: string | null;
  createdAt: string;
  items: ChatTurnDisplayVersion[];
}

export interface ChatTurnPresentationWindow {
  fromMessageId: number;
  runIds: readonly string[];
}

/** 独立执行资料；正文可已封存为消息，资料本身不授予执行或工具重放资格。 */
export interface ChatInterruptedTurnContext {
  runId: string;
  /** 用户输入或自主触发来源的消息定位；不改变执行回合的用户游标。 */
  inputHighWatermark: number;
  createdAt: string;
  items: readonly ChatTurnDisplaySnapshot[];
}
