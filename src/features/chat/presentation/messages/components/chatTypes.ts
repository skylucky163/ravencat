/** 定义聊天详情展示层的助手配置、回复引用类型及配置转换。 */

import { createChatReplyTarget as createReplySnapshot, parseMessageMetadata, type ChatReplyTarget } from '../../../messages/domain/chatMessageMetadata';
import type { ChatMessage } from '../../../messages/domain/ChatMessage';
import { getAssistantDisplayName } from '@features/assistants';
import type { AIAssistantConfig } from '../../../messages/application/SendUserMessage';


/**
 * AI 助手实体结构
 * 基础信息：id, name, model（模型名称）
 * API 配置：apiKey, apiBaseUrl（兼容不同厂商的接口地址）
 * 生成参数：temperature, topP, maxTokens（控制 AI 的创造性和回复长度）
 * 功能开关：enableTools（是否启用工具调用）, isHostAI（是否为主 AI）
 * systemPrompt：系统级提示词
 */
export interface ChatDetailAIAssistantLike {
  id: string;
  agentId: string;
  name: string;
  nickname?: string | null;
  avatar?: string | null;
  model: string;
  apiKey: string;
  apiBaseUrl: string;
  temperature?: number | null;
  topP?: number | null;
  disableThinking?: boolean;
  maxTokens?: number | null;
  privateContextPrimaryLimit?: number;
  privateContextSecondaryLimit?: number;
  groupContextPrimaryLimit?: number;
  groupContextSecondaryLimit?: number;
  systemPrompt?: string;
  enableTools?: boolean;
  allowMultipleBubbles?: boolean;
  streamingReply?: boolean | null;
  showTokenUsage?: boolean;
  showActionSteps?: boolean;
  isHostAI?: boolean;
  isBlocked?: boolean;
}

export type ReplyTarget = ChatReplyTarget;

/** 界面名称在引用时固定；按稳定身份找发送者，不能把助理回复标成当前主聊 AI。 */
export function createChatReplyTarget(
  message: ChatMessage,
  assistants: readonly ChatDetailAIAssistantLike[],
  userName: string,
  primaryAssistant?: ChatDetailAIAssistantLike | null,
): ChatReplyTarget {
  const metadata = parseMessageMetadata(message);
  const agentId = message.agentId ?? metadata?.helper?.actorAgentId;
  const assistantId = metadata?.helper?.actorAIId ?? metadata?.helper?.helperAIId;
  const sender = agentId || assistantId
    ? assistants.find(assistant => assistant.agentId === agentId || assistant.id === assistantId)
    : primaryAssistant;
  const authorName = message.isMe
    ? metadata?.groupChat?.actorName ?? userName
    : sender ? getAssistantDisplayName(sender) : metadata?.actorName ?? metadata?.groupChat?.actorName ?? 'AI';
  return createReplySnapshot(message, assistants.map(assistant => ({ aiAssistantId: assistant.id, name: assistant.name })), authorName);
}

/**
 * Chat 用户语音录制的 presentation 状态机。
 *
 * `starting` 是「press grant 之后、native recorder 真正开始之前」的显式状态：
 * 这段窗口包含 STT 模型解析、腾讯实时 ASR 建连、麦克风权限确认与 native
 * AudioRecord 初始化，全部是异步的。若这段窗口仍显示 idle，用户会误以为
 * 长按手势没有生效（表现为“按了没反应”）。
 *
 * `reviewing` 是「STT 已成功、用户可以校对转写文本、但尚未提交」的状态。
 * 该状态下 **绝不能已经存在 canonical Chat message**：AI、conversation preview、
 * timeline 都还看不到这条语音。只有用户点“发送”进入 `committing` 后才提交事实。
 *
 * 唯一合法流转：
 *   idle --press--> starting --成功--> recording --release--> processing
 *        --STT 成功--> reviewing --发送--> committing --成功--> idle
 *                                  \--取消--> idle（discard draft）
 *                           \--失败--> idle
 *   任意状态 --cancel / 退出语音模式 / 切 session / unmount--> idle
 */
export type ChatVoiceRecordingState =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'processing'
  | 'reviewing'
  | 'committing';

/**
 * 发送前校对阶段的 presentation 快照。
 *
 * 只携带 UI 需要的信息：原始 STT 文本、录音时长与用户可编辑的当前文本。
 * 刻意不包含 raw local URI 或 media backing——那些是 Chat 内部的资源所有权，
 * 不能被 presentation 拿到（见 `UserVoiceMessageDraft`）。
 */
export interface ChatVoiceMessageReviewDraft {
  /** STT 原始转写，用于判定用户是否修改过（corrected）。 */
  originalTranscript: string;
  /** 录音时长，用于展示。 */
  durationMs: number;
  /** 用户当前编辑中的文本。 */
  transcript: string;
}

/**
 * 配置转换器。
 * 把 UI 层用的 ChatDetailAIAssistantLike 
 * 转换成应用层（useCases）需要的 AIAssistantConfig 格式。
 */
export function buildAIRequestConfig(
  aiAssistant?: ChatDetailAIAssistantLike | null
): AIAssistantConfig | null {
  if (!aiAssistant) return null;

  return {
    id: aiAssistant.id,
    agentId: aiAssistant.agentId,
    name: aiAssistant.name,
    avatar: aiAssistant.avatar || null,
    model: aiAssistant.model,
    apiKey: aiAssistant.apiKey,
    apiBaseUrl: aiAssistant.apiBaseUrl,
    temperature: aiAssistant.temperature,
    topP: aiAssistant.topP,
    disableThinking: aiAssistant.disableThinking,
    maxTokens: aiAssistant.maxTokens,
    privateContextPrimaryLimit: aiAssistant.privateContextPrimaryLimit,
    privateContextSecondaryLimit: aiAssistant.privateContextSecondaryLimit,
    groupContextPrimaryLimit: aiAssistant.groupContextPrimaryLimit,
    groupContextSecondaryLimit: aiAssistant.groupContextSecondaryLimit,
    systemPrompt: aiAssistant.systemPrompt,
    enableTools: aiAssistant.enableTools,
    allowMultipleBubbles: aiAssistant.allowMultipleBubbles,
    enableStreamingReply: aiAssistant.streamingReply ?? undefined,
    isHostAI: aiAssistant.isHostAI,
    isBlocked: aiAssistant.isBlocked,
  };
}
