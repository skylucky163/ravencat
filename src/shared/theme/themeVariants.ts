import type { PresentationTheme } from './types';

export type ChatPresentationVariant = 'default' | 'moon-kimi' | 'paper-note';

export interface ChatInteractionProfile {
  messageActionSurface: 'long-press-menu' | 'inline-assistant-actions';
  emptyStateSurface: 'default' | 'official-replica';
  reasoningSurface: 'default' | 'official-replica';
  toolStatusSurface: 'system-text' | 'official-replica';
  enableMessageLongPressMenu: boolean;
  /**
   * 语音消息是否可以用长按打开语音专属 action menu（“转文字 / 收起文字”）。
   *
   * 语音卡内部的播放 Pressable 需要独立声明长按回调，不能依赖外层正文触控。
   * 各主题保留消息管理入口，包括收藏与转写展开；inline actions 仍独立展示。
   */
  enableVoiceMessageLongPressMenu: boolean;
  showAssistantInlineActions: boolean;
  enableAssistantMessageSegmentation: boolean;
  preferStreamingReply: boolean;
}

const DEFAULT_CHAT_INTERACTION_PROFILE: ChatInteractionProfile = {
  messageActionSurface: 'long-press-menu',
  emptyStateSurface: 'default',
  reasoningSurface: 'default',
  toolStatusSurface: 'system-text',
  enableMessageLongPressMenu: true,
  enableVoiceMessageLongPressMenu: true,
  showAssistantInlineActions: false,
  enableAssistantMessageSegmentation: true,
  preferStreamingReply: false,
};

const OFFICIAL_REPLICA_CHAT_INTERACTION_PROFILE: ChatInteractionProfile = {
  messageActionSurface: 'inline-assistant-actions',
  emptyStateSurface: 'official-replica',
  reasoningSurface: 'official-replica',
  toolStatusSurface: 'official-replica',
  enableMessageLongPressMenu: true,
  // 内联操作保留；用户和 AI 都可通过长按管理消息与收藏。
  enableVoiceMessageLongPressMenu: true,
  showAssistantInlineActions: true,
  enableAssistantMessageSegmentation: false,
  preferStreamingReply: true,
};

const PAPER_NOTE_CHAT_INTERACTION_PROFILE: ChatInteractionProfile = {
  messageActionSurface: 'long-press-menu',
  emptyStateSurface: 'default',
  reasoningSurface: 'default',
  toolStatusSurface: 'system-text',
  enableMessageLongPressMenu: true,
  enableVoiceMessageLongPressMenu: true,
  showAssistantInlineActions: false,
  enableAssistantMessageSegmentation: false,
  preferStreamingReply: true,
};

export function getChatPresentationVariant(theme: PresentationTheme): ChatPresentationVariant {
  if (theme.id === 'moon-kimi') {
    return 'moon-kimi';
  }

  return theme.id === 'paper-note' ? 'paper-note' : 'default';
}

export function isMoonKimiTheme(theme: PresentationTheme): boolean {
  return getChatPresentationVariant(theme) === 'moon-kimi';
}

export function isPaperNoteTheme(theme: PresentationTheme): boolean {
  return getChatPresentationVariant(theme) === 'paper-note';
}

/** 自定义气泡是 daylight/night 的装饰，不改变其他主题自己的消息表面。 */
export function supportsChatBubbleSkins(theme: PresentationTheme): boolean {
  return theme.id === 'default-light' || theme.id === 'default-dark';
}

export function getChatInteractionProfile(theme: PresentationTheme): ChatInteractionProfile {
  const variant = getChatPresentationVariant(theme);
  if (variant === 'moon-kimi') {
    return OFFICIAL_REPLICA_CHAT_INTERACTION_PROFILE;
  }

  return variant === 'paper-note'
    ? PAPER_NOTE_CHAT_INTERACTION_PROFILE
    : DEFAULT_CHAT_INTERACTION_PROFILE;
}
