/** 定义聊天 Shell 的子页面、预加载状态、文件预览参数与入口回调契约。 */

import type { ConversationKind } from '../../conversation/domain/ConversationRef';

export type ChatSubScreen =
  | 'search'
  | 'menu'
  | 'protocol'
  | 'callHistory'
  | 'statistics'
  | 'filePreview';

export type GroupChatSubScreen =
  | 'search'
  | 'menu'
  | 'summary'
  | 'adminSettings';

/**
 * 预热候选：来自统一会话列表排序结果，direct / group 共用同一条调度链。
 * 它只描述「读哪条会话的时间线」，不携带任何业务展示字段。
 */
export interface ChatPreloadCandidate {
  kind: ConversationKind;
  /** direct 为 AI id，group 为 groupId。 */
  id: string;
  /**
   * 已知的 canonical session id。
   * direct 没有 canonical 会话时为 null（不预热、更不创建）；
   * group 的会话身份就是 groupId。
   */
  sessionId: string | null;
  isPinned: boolean;
  /** 最后一条可见消息时间；为空表示可见时间线没有消息。 */
  lastActivityAt: string | null;
  /** 最近一次置顶时刻；只在置顶区参与排序（与列表项同一套语义）。 */
  pinnedAt: string | null;
  createdAt: string;
}

/**
 * 一次预热运行的诊断结果。
 *
 * 它记录「这一次预热跑出来了什么」，不是「缓存里现在有没有内容」的第二份权威
 * 状态 —— 后者只有 `sessionTimelineCache` 自己知道。预热成败绝不参与导航正确性。
 */
export interface ChatPreloadEntry {
  key: string;
  status: 'loading' | 'ready' | 'error';
  timelineStatus: 'ready' | 'error' | 'skipped';
  error: string | null;
  updatedAt: number;
  promise: Promise<ChatPreloadEntry> | null;
}

export interface FilePreviewParams {
  fileUri: string;
  fileName: string;
  mimeType?: string | null;
}

export interface UseChatScreenParams {
  onAddAI?: (() => void) | null;
  sessionRefreshTrigger?: number;
  onConversationViewed?: ((aiId: string) => void) | null;
  dbReady?: boolean;
  conversationListLoadEnabled?: boolean;
  /**
   * 会话列表事实失效（消息落地 / 通知导航）时的回调。
   * Shell 只负责报告「列表事实可能变了」，重新读取哪些数据由列表 owner 决定。
   */
  onConversationListInvalidated?: (() => void) | null;
}

export function chatPreloadCandidateKey(candidate: Pick<ChatPreloadCandidate, 'kind' | 'id'>): string {
  return `${candidate.kind}:${candidate.id}`;
}
