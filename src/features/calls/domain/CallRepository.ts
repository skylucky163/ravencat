import type {
  CallDirection,
  CallEndReason,
  CallMediaMode,
  CallSession,
  CallSource,
  CallState,
} from './CallSession';
import type {
  CallAttachment,
  CallAttachmentKind,
  CallEvent,
  CallEventActorType,
  CallEventKind,
} from './CallEvent';
import type {
  CallParticipant,
  CallParticipantRole,
} from './CallParticipant';
import type { CallSummarySource } from './CallSummary';
import type { DatabaseTransactionExecutor } from '@platform/persistence';
import type { CallHistoryEntry, CallHistoryRecord, CallHistoryImage, CallHistoryPage } from './CallHistory';

export interface CreateCallSessionInput {
  id?: string;
  chatSessionId: string;
  aiAssistantId: string;
  agentId: string;
  direction: CallDirection;
  state?: CallState;
  requestedMode: CallMediaMode;
  activeMode?: CallMediaMode;
  source: CallSource;
  sourceToolCallId?: string | null;
  openingLine?: string | null;
  reason?: string | null;
  aiRejectionReason?: string | null;
  startedAt?: string | null;
  acceptedAt?: string | null;
  endedAt?: string | null;
  endReason?: CallEndReason | null;
}

export interface UpdateCallSessionInput {
  state?: CallState;
  activeMode?: CallMediaMode;
  sourceToolCallId?: string | null;
  openingLine?: string | null;
  reason?: string | null;
  aiRejectionReason?: string | null;
  startedAt?: string | null;
  acceptedAt?: string | null;
  endedAt?: string | null;
  endReason?: CallEndReason | null;
}

export interface CreateCallParticipantInput {
  id?: string;
  callId: string;
  role: CallParticipantRole;
  aiAssistantId?: string | null;
  agentId?: string | null;
  displayName: string;
  joinedAt?: string | null;
  leftAt?: string | null;
}

export interface CreateCallEventInput {
  id?: string;
  callId: string;
  chatSessionId: string;
  kind: CallEventKind;
  actorType: CallEventActorType;
  actorId?: string | null;
  text?: string | null;
  attachmentId?: string | null;
  visibleInChat?: boolean;
  includeInAIContext?: boolean;
  payloadJson?: string | null;
  createdAt?: string | null;
}

export interface UpdateCallEventInput {
  text?: string | null;
  attachmentId?: string | null;
  visibleInChat?: boolean;
  includeInAIContext?: boolean;
  payloadJson?: string | null;
}

export interface CreateCallSnapshotAttachmentInput {
  id?: string;
  kind: CallAttachmentKind;
  localUri?: string | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  sizeBytes?: number | null;
  createdAt?: string | null;
}

/**
 * 通话截图需要同时写入事件事实和附件元数据；两个输入共享预生成的关联 ID。
 * 该端口只表达这一种原子组合，不让 application 层自行编排两个独立写入。
 */
export interface CreateCallSnapshotInput {
  callId: string;
  chatSessionId: string;
  event: Omit<CreateCallEventInput, 'callId' | 'chatSessionId' | 'attachmentId'>;
  attachment: CreateCallSnapshotAttachmentInput;
}

export interface CallSnapshotWriteResult {
  event: CallEvent;
  attachment: CallAttachment;
}

export interface ICallRepository {
  listHistory(assistantId: string): Promise<CallHistoryRecord[]>;
  getHistory(callId: string, assistantId: string): Promise<CallHistoryRecord | null>;
  readHistoryPage(callId: string, assistantId: string, offset: number): Promise<CallHistoryPage | null>;
  listHistoryEntries(callId: string): Promise<CallHistoryEntry[]>;
  renameHistory(callId: string, assistantId: string, title: string): Promise<'saved' | 'duplicate' | 'missing'>;
  deleteHistory(callId: string, assistantId: string): Promise<string[]>;
  appendHistoryEntry(input: Omit<CallHistoryEntry, 'mediaAssetId' | 'durationMs'>): Promise<void>;
  attachHistoryAudio(transaction: DatabaseTransactionExecutor, entryId: string, assetId: string, durationMs: number): Promise<void>;
  getHistorySnapshotSaving(assistantId: string): Promise<boolean>;
  setHistorySnapshotSaving(assistantId: string, enabled: boolean): Promise<void>;
  listHistoryImages(callId: string): Promise<CallHistoryImage[]>;
  appendHistoryImage(transaction: DatabaseTransactionExecutor, image: CallHistoryImage): Promise<void>;
  deleteHistoryImage(imageId: string, callId: string, assistantId: string): Promise<string>;
  createSession(input: CreateCallSessionInput): Promise<CallSession>;
  /** 创建非终态通话并原子取得全局占用；已有通话时返回 null，不产生第二个会话。 */
  createSessionIfIdle(input: CreateCallSessionInput): Promise<CallSession | null>;
  updateSession(id: string, patch: UpdateCallSessionInput): Promise<CallSession>;
  updateSessionIfState(
    id: string,
    expectedStates: [CallState, ...CallState[]],
    patch: UpdateCallSessionInput
  ): Promise<CallSession | null>;
  getSessionById(id: string): Promise<CallSession | null>;
  getActiveSession(): Promise<CallSession | null>;
  listRecentSessions(params: { chatSessionId?: string; limit: number }): Promise<CallSession[]>;
  deleteSession(id: string): Promise<boolean>;

  addParticipant(input: CreateCallParticipantInput): Promise<CallParticipant>;
  listParticipants(callId: string): Promise<CallParticipant[]>;

  appendEvent(input: CreateCallEventInput): Promise<CallEvent>;
  updateEvent(id: string, patch: UpdateCallEventInput): Promise<CallEvent>;
  deleteEvent(id: string): Promise<boolean>;
  listEvents(params: { callId: string; limit?: number }): Promise<CallEvent[]>;
  /**
   * conversation 内可进入 AI 上下文的通话事件（created_at 升序）。
   * 只返回该 conversation 历史边界（sessions.visible_after_at）之后产生的事件，
   * 因此「清除聊天记录」不会连带隐藏同一通仍在进行的电话后半段。
   */
  listContextEvents(params: { chatSessionId: string; limit: number }): Promise<CallEvent[]>;
  /** 完整的待处理通话事实（含进行中状态），不按近期窗口裁剪；进度由 Chat 提供。 */
  listSummarySources(params: {
    chatSessionId: string; excludedCallIds: readonly string[]; after: string | null;
  }): Promise<CallSummarySource[]>;

  appendSnapshot(input: CreateCallSnapshotInput): Promise<CallSnapshotWriteResult>;
  listAttachments(callId: string): Promise<CallAttachment[]>;
  listSnapshotFiles(callId?: string): Promise<{ id: string; uri: string }[]>;
  clearSnapshotFile(id: string, expectedUri: string): Promise<void>;
}
