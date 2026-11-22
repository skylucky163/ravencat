import { createRuntimeSlot } from '@shared/runtime/RuntimeSlot';
import type {
  AssembleStandalonePromptPackParams,
  PromptPack,
} from '@shared/prompt';
import type { TogetherListeningActivity } from '../domain/TogetherListeningActivity';
import type { ITogetherListeningRepository } from '../domain/TogetherListeningRepository';
import type { TogetherListeningSystemPresentationState } from './TogetherListeningSystemPresentation';

export type TogetherListeningObservedPlaybackState =
  | 'none'
  | 'stopped'
  | 'paused'
  | 'playing'
  | 'fast_forwarding'
  | 'rewinding'
  | 'buffering'
  | 'error'
  | 'connecting'
  | 'skipping_to_previous'
  | 'skipping_to_next'
  | 'skipping_to_queue_item'
  | 'unknown';

export type TogetherListeningNetEaseObservation =
  | {
      status: 'snapshot_available';
      playbackState: TogetherListeningObservedPlaybackState;
      mediaId: string | null;
      title: string | null;
      artist: string | null;
      album: string | null;
      positionMs: number | null;
      speed: number | null;
      updatedAtEpochMs: number | null;
      durationMs: number | null;
      /** 系统当前媒体输出名称；不通过名称推断蓝牙设备类别。 */
      audioOutput: { playbackType: 'local' | 'remote'; deviceNames: string[] } | null;
    }
  | {
      status:
        | 'no_active_session'
        | 'permission_not_granted'
        | 'protected_app'
        | 'observation_failed';
    };

/**
 * 首张卡投影的排序 hint。
 *
 * AI 在 Chat Agent run 内发起邀请时，把该 run 的标识带给首张卡，使卡片在
 * Chat 持久时间线中保持「tool 调用 → 卡片 → 后续 assistant 文本」的真实顺序。
 * 它只是投影排序身份，不属于 Activity 真值；lifecycle 后续 patch 不携带也不
 * 改写它。
 */
export interface TogetherListeningChatProjectionHint {
  timelineRunId?: string;
  groupSpeechTaskId?: string;
}

/**
 * Host 注入的 Chat 窄投影端口。
 *
 * Activity 是 Together Listening 的产品真值；Chat 只负责把已经提交的
 * Activity 生命周期投影成稳定 timeline entry。实现必须以 activity.id 为
 * 幂等键，并且不能在该端口内反向裁决 Activity phase。
 */
export interface TogetherListeningChatProjectionPort {
  projectActivityToChat(
    activity: TogetherListeningActivity,
    hint?: TogetherListeningChatProjectionHint,
  ): Promise<void>;
}

/** Android 系统 presentation 的窄 transport port；实现不得拥有 Activity truth。 */
export interface TogetherListeningSystemPresentationPort {
  upsertActivePresentation(state: TogetherListeningSystemPresentationState): Promise<void>;
  cancelPresentation(activityId?: string): Promise<void>;
}

/**
 * 用户拒绝 AI 邀请后的 standalone 决策所需的最小 AI 配置。
 *
 * 只覆盖一次无 Tool JSON 决策调用与一条外部 assistant 消息的落款身份，
 * 不泄漏 Assistants 的完整配置实体。
 */
export interface TogetherListeningDeclineFollowUpAIConfig {
  id: string;
  agentId: string | null;
  name: string;
  avatar: string | null;
  model: string;
  apiKey: string;
  apiBaseUrl: string;
  systemPrompt?: string;
  temperature?: number | null;
  topP?: number | null;
  disableThinking?: boolean;
  reasoningEffort?: import('@platform/ai').ReasoningEffort;
  maxTokens?: number;
}

/** send_message 决策落地为普通 assistant 聊天消息时所需的最小输入。 */
export interface TogetherListeningDeclineFollowUpMessageInput {
  sessionId: string;
  text: string;
  aiId: string;
  aiName: string;
  aiAvatar: string | null;
  agentId: string | null;
  deliveryKind: 'passive' | 'proactive';
  triggerSource: string;
  relatedEntityType: string;
  relatedEntityId: string;
}

/**
 * Host 注入的用户拒绝跟进窄端口。
 *
 * Together Listening 不静态依赖 Chat / Assistants / Host 实现；
 * Chat append 的具体实现继续由 Host composition 装配。
 */
export interface TogetherListeningDeclineFollowUpPort {
  resolveAIConfig(
    aiId: string,
  ): Promise<TogetherListeningDeclineFollowUpAIConfig | null>;
  assembleStandalonePromptPack(
    params: AssembleStandalonePromptPackParams,
  ): Promise<PromptPack>;
  appendExternalAssistantMessage(
    input: TogetherListeningDeclineFollowUpMessageInput,
  ): Promise<unknown>;
}

export interface TogetherListeningRuntimeDependencies {
  repository: ITogetherListeningRepository;
  chat: TogetherListeningChatProjectionPort;
  systemPresentation: TogetherListeningSystemPresentationPort;
  declineFollowUp: TogetherListeningDeclineFollowUpPort;
  generateId: () => string;
  nowEpochMs: () => number;
  observeNetEasePlayback: () => Promise<TogetherListeningNetEaseObservation>;
  readCurrentNetEaseLyric: (
    playback: Pick<Extract<TogetherListeningNetEaseObservation, { status: 'snapshot_available' }>,
      'mediaId' | 'playbackState' | 'positionMs' | 'speed' | 'updatedAtEpochMs' | 'durationMs'>,
    capturedAtEpochMs: number,
  ) => Promise<TogetherListeningCurrentLyric | null>;
  /** Host authority 属于 Assistants，由 Host composition 注入当前权威身份。 */
  getCurrentHostAIId: () => Promise<string | null>;
  resolveSystemPresentationAIIdentity: (
    aiId: string,
  ) => Promise<{ name: string; avatar: string | null } | null>;
}

/** 仅承载当前一句，不允许把完整歌词交给 Prompt 或写入 Activity。 */
export interface TogetherListeningCurrentLyric {
  text: string;
  startTimeMs: number;
  positionMs: number;
}

const runtimeSlot = createRuntimeSlot<TogetherListeningRuntimeDependencies>(
  'Together Listening',
);

export function configureTogetherListeningRuntimeDependencies(
  dependencies: TogetherListeningRuntimeDependencies,
): void {
  runtimeSlot.configure(dependencies);
}

export function getTogetherListeningRuntimeDependencies(): TogetherListeningRuntimeDependencies {
  return runtimeSlot.get();
}
