import { prepareMediaAssetBatch, MEDIA_ASSET_STORAGE_BACKEND } from '@features/media';
import { startVoiceMessageTranscription } from '@features/speech';
import {
  createRandomUUID,
  requestMicrophonePermission,
  temporarySpeechAudioStore,
  voiceRecordingPort,
  type VoiceRecordingError,
  type VoiceRecordingProgress,
  type VoiceRecordingSession,
} from '@platform/device';

import type { AIReplyConfig } from '../../reply/application/ChatReplyTypes';
import type { ChatMessage, CreateMessageInput } from '../domain/ChatMessage';
import {
  buildChatVoiceMessageMetadata,
  type ChatVoiceTranscriptSource,
} from '../domain/chatMessageMetadata';
import { commitAndDispatchCanonicalUserMessage } from './CommitAndDispatchCanonicalUserMessage';

export type UserVoiceMessageResult =
  | { success: true; message: ChatMessage }
  | { success: false; code: string; message: string };

/**
 * 录音阶段的句柄：只负责“结束录音并识别”。
 *
 * 它不提交任何 Chat 事实。识别成功后返回 `UserVoiceMessageDraft`，由 presentation
 * 让用户校对 transcript，再显式 commit。
 */
export interface UserVoiceMessageRecording {
  finish(): Promise<UserVoiceMessageDraftResult>;
  cancel(): Promise<void>;
}

export type UserVoiceMessageDraftResult =
  | { success: true; draft: UserVoiceMessageDraft }
  | Extract<UserVoiceMessageResult, { success: false }>;

/**
 * “发送前校对”阶段的 draft 句柄。
 *
 * 所有权边界：draft 持有 source temp 录音文件，但不长期持有 prepared media backing，
 * 且**没有**任何 canonical
 * Chat message 存在——AI 不会收到这条消息，conversation preview 也不会更新。只有当
 * 用户确认发送并 `commit(finalTranscript)` 成功后，事实才写进 Chat。
 *
 * draft 只进入终态一次：commit 成功或 discard 之后，再次调用都会返回失败/无操作，
 * 避免重复提交或误删已经被 MediaAsset 接管的 backing。
 */
export interface UserVoiceMessageDraft {
  /** STT 原始转写，用于 comparing 用户是否修改过（corrected 判定）。 */
  readonly originalTranscript: string;
  readonly durationMs: number;

  /** 用用户最终确认的 transcript 提交 canonical 用户语音消息。 */
  commit(transcript: string): Promise<UserVoiceMessageResult>;
  /** 释放 source temp 录音文件；若 commit 正在运行，会等待该 attempt 到达终态。 */
  discard(): Promise<void>;
}

export type UserVoiceRecordingEntryCheck =
  | { ready: true }
  | { ready: false; code: 'VOICE_MICROPHONE_PERMISSION_DENIED'; message: string };

/**
 * 进入语音输入模式前的 preflight：只确认设备是否允许录音。
 *
 * 这里不解析 STT 选择、不连接识别服务。STT session 只在
 * `startUserVoiceMessageRecording()` 真正准备录音时创建；模型配置与识别错误
 * 由真正的启动流程报告。
 *
 * 与 `voiceRecordingPort.start()` 共用 `requestMicrophonePermission()`，因此
 * preflight 与真正 start 之间没有第二套权限逻辑；唯一的竞态是用户在两者之间
 * 撤销权限，此时 start 会以 VOICE_MICROPHONE_PERMISSION_DENIED 正常失败。
 */
export async function prepareUserVoiceMessageRecording(): Promise<UserVoiceRecordingEntryCheck> {
  if (await requestMicrophonePermission()) {
    return { ready: true };
  }

  return {
    ready: false,
    code: 'VOICE_MICROPHONE_PERMISSION_DENIED',
    message: '需要麦克风权限才能录制语音消息',
  };
}

export async function startUserVoiceMessageRecording(params: {
  sessionId: string;
  assistantId: string;
  aiConfig: AIReplyConfig;
  onProgress?: (progress: VoiceRecordingProgress) => void;
}): Promise<
  UserVoiceMessageRecording
  | Extract<UserVoiceMessageResult, { success: false }>
> {
  const transcription = await startVoiceMessageTranscription({ assistantId: params.assistantId });
  if ('success' in transcription) {
    return {
      success: false,
      code: transcription.code,
      message: transcription.errorInfo.message,
    };
  }

  let recordingFailure: VoiceRecordingError | null = null;
  let recording: VoiceRecordingSession;
  try {
    recording = await voiceRecordingPort.start({
      onAudioChunk: (chunk) => transcription.acceptAudioChunk(chunk),
      onError: (error) => { recordingFailure = error; },
      onProgress: params.onProgress,
    });
  } catch (error) {
    await transcription.cancel();
    const failure = error as VoiceRecordingError;
    return { success: false, code: failure.code, message: failure.message };
  }

  let active = true;
  return {
    cancel: async () => {
      if (!active) return;
      active = false;
      await Promise.all([recording.cancel(), transcription.cancel()]);
    },
    finish: async () => {
      if (!active) {
        return { success: false, code: 'VOICE_RECORDING_FAILED', message: '录音已经结束' };
      }
      active = false;
      if (recordingFailure) {
        await Promise.all([recording.cancel(), transcription.cancel()]);
        return { success: false, code: recordingFailure.code, message: recordingFailure.message };
      }

      // recording.stop() 本身也可能失败（native stop/WAV materialization）。它必须在
      // try 内执行：一旦 reject，finally 仍负责删除临时录音与 transcription session，
      // 不能把清理留在 stop 之后。
      let recordedUri: string | null = null;
      try {
        let recorded: Awaited<ReturnType<VoiceRecordingSession['stop']>>;
        try {
          recorded = await recording.stop();
          recordedUri = recorded.uri;
        } catch (error) {
          await transcription.cancel().catch(() => undefined);
          const failure = error as VoiceRecordingError;
          return {
            success: false,
            code: failure.code || 'VOICE_RECORDING_FAILED',
            message: failure.message || '结束录音失败',
          };
        }

        if (recorded.durationMs < 300) {
          await transcription.cancel().catch(() => undefined);
          return { success: false, code: 'VOICE_RECORDING_TOO_SHORT', message: '录音时间太短，请重新录制' };
        }
        const transcribed = await transcription.finish();
        if (transcribed.success === false) {
          return { success: false, code: transcribed.code, message: transcribed.errorInfo.message };
        }

        // STT 成功后只把 source temp 的所有权移交给 draft。MediaAsset prepare 留到
        // 每次 commit attempt 内，确保 rollback 后的 retry 一定从新的 open batch 开始。
        // 此处仍不提交 canonical message —— AI、preview、timeline 都对草稿一无所知。
        const ownedRecordedUri = recorded.uri;
        recordedUri = null;
        return {
          success: true,
          draft: createUserVoiceMessageDraft({
            sessionId: params.sessionId,
            aiConfig: params.aiConfig,
            transcript: transcribed.text,
            durationMs: recorded.durationMs,
            mimeType: recorded.mimeType,
            fileName: `${recording.sessionId}.wav`,
            recordedUri: ownedRecordedUri,
          }),
        };
      } finally {
        await transcription.cancel().catch(() => undefined);
        if (recordedUri) {
          await temporarySpeechAudioStore.deleteIfExists(recordedUri).catch(() => undefined);
        }
      }
    },
  };
}

/**
 * 构造 draft：只有 source temp 从 recording 阶段转移到这里。每次 commit attempt
 * 独占自己的 PreparedMediaAssetBatch；rollback 后不会把 staged batch 留给 retry。
 */
function createUserVoiceMessageDraft(params: {
  sessionId: string;
  aiConfig: AIReplyConfig;
  transcript: string;
  durationMs: number;
  mimeType: string;
  fileName: string;
  recordedUri: string;
}): UserVoiceMessageDraft {
  let terminal = false;
  let commitInFlight: Promise<UserVoiceMessageResult> | null = null;
  let sourceReleased = false;

  const releaseSourceRecording = async () => {
    if (sourceReleased) return;
    sourceReleased = true;
    await temporarySpeechAudioStore.deleteIfExists(params.recordedUri).catch(() => undefined);
  };

  return {
    originalTranscript: params.transcript,
    durationMs: params.durationMs,
    commit: async (transcript: string) => {
      if (terminal) {
        return { success: false, code: 'VOICE_MESSAGE_COMMIT_FAILED', message: '这条语音已经结束，无法再次发送' };
      }
      if (commitInFlight) {
        return { success: false, code: 'VOICE_MESSAGE_COMMIT_FAILED', message: '这条语音正在发送' };
      }

      const finalTranscript = normalizeVoiceTranscript(transcript);
      if (!finalTranscript) {
        // 空文本不构成一次提交尝试，也不终结 draft：用户可以继续修改后重试。
        return { success: false, code: 'VOICE_TEXT_EMPTY', message: '请输入语音内容后再发送' };
      }

      const attempt = (async (): Promise<UserVoiceMessageResult> => {
        let prepared: Awaited<ReturnType<typeof prepareMediaAssetBatch>>;
        try {
          prepared = await prepareMediaAssetBatch([{
            storageBackend: MEDIA_ASSET_STORAGE_BACKEND.persistentMedia,
            sourceUri: params.recordedUri,
            fileName: params.fileName,
            mimeType: params.mimeType,
            width: null,
            height: null,
            durationMs: params.durationMs,
          }]);
        } catch (error) {
          return {
            success: false,
            code: 'VOICE_MEDIA_PREPARATION_FAILED',
            message: error instanceof Error ? error.message : '语音媒体准备失败',
          };
        }

        const now = new Date().toISOString();
        const draft: CreateMessageInput = {
          sessionId: params.sessionId,
          text: finalTranscript,
          isMe: true,
          senderType: 'user',
          time: now,
          createdAt: now,
          updatedAt: now,
          clientMessageId: `voice-${createRandomUUID()}`,
          metadataJson: null,
        };
        const transcriptSource: ChatVoiceTranscriptSource = isCorrectedTranscript(
          finalTranscript,
          params.transcript,
        )
          ? 'user_corrected'
          : 'user_stt';

        let committed;
        try {
          committed = await commitAndDispatchCanonicalUserMessage({
            message: draft,
            previewText: '[语音消息]',
            aiConfig: params.aiConfig,
            materializeMessageInTransaction: async (transaction, message) => {
              const [asset] = (await prepared.commitInTransaction(transaction)).assets;
              return {
                ...message,
                metadataJson: JSON.stringify(buildChatVoiceMessageMetadata({
                  schemaVersion: 1,
                  mediaAssetId: asset.id,
                  mimeType: asset.mimeType,
                  // 语音时长是本次发送链路测得的业务事实。MediaAsset 可能被 catalog
                  // 复用为历史行，其 durationMs 只是资产 metadata，不能反向覆盖本次
                  // 语音消息的 duration。
                  durationMs: params.durationMs,
                  transcriptSource,
                })),
              };
            },
          });
        } catch (error) {
          await discardPreparedSafely(prepared);
          return {
            success: false,
            code: 'VOICE_MESSAGE_COMMIT_FAILED',
            message: error instanceof Error ? error.message : '语音消息发送失败',
          };
        }

        if (!committed.userMessage) {
          await discardPreparedSafely(prepared);
          return {
            success: false,
            code: 'VOICE_MESSAGE_COMMIT_FAILED',
            message: committed.error || '语音消息发送失败',
          };
        }

        // userMessage 非空即表示 canonical transaction 已提交。之后的 backing cleanup
        // 只能走 finalize；即使 cleanup 失败，也不能把已提交事实伪装成 rollback。
        terminal = true;
        await finalizePreparedSafely(prepared);
        await releaseSourceRecording();
        return { success: true, message: committed.userMessage };
      })();

      commitInFlight = attempt;
      try {
        return await attempt;
      } finally {
        if (commitInFlight === attempt) commitInFlight = null;
      }
    },
    discard: async () => {
      if (terminal) return;
      const pendingCommit = commitInFlight;
      if (pendingCommit) {
        await pendingCommit.catch(() => undefined);
        if (terminal) return;
      }
      terminal = true;
      await releaseSourceRecording();
    },
  };
}

/**
 * corrected 判定：比较“用户最终确认的 transcript”与“STT 原始 transcript”的
 * 规范化形式。仅首尾空白或连续空白差异不算修改，避免用户只是键盘没删干净就被记为
 * corrected。这里不保存原始错误文本，`user_corrected` 只表达“用户改过”。
 */
export function isCorrectedTranscript(
  finalTranscript: string,
  originalTranscript: string,
): boolean {
  return normalizeVoiceTranscript(finalTranscript) !== normalizeVoiceTranscript(originalTranscript);
}

function normalizeVoiceTranscript(transcript: string): string {
  return String(transcript || '').replace(/\s+/g, ' ').trim();
}

/**
 * 回滚清理不允许把自身的 IO 失败升级为新的异常：调用方此刻已经在报告原始的
 * 业务失败，孤儿文件只应记录，不能再覆盖真实错误码。
 */
async function discardPreparedSafely(
  prepared: Awaited<ReturnType<typeof prepareMediaAssetBatch>>,
): Promise<void> {
  try {
    await prepared.discardAfterRollback();
  } catch (error) {
    console.warn('[UserVoiceMessage] 回滚清理未接管的 prepared backing 失败', error);
  }
}

/** canonical transaction 已提交后的清理失败只报告，不能改走 rollback 语义。 */
async function finalizePreparedSafely(
  prepared: Awaited<ReturnType<typeof prepareMediaAssetBatch>>,
): Promise<void> {
  try {
    await prepared.finalizeAfterCommit();
  } catch (error) {
    console.warn('[UserVoiceMessage] commit 后清理复用 prepared backing 失败', error);
  }
}
