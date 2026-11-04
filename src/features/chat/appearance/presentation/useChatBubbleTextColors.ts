import { getThemeById, supportsChatBubbleSkins, useThemeContext, type ChatColorToken } from '@shared/theme';
import { setChatBubblePresetTextColor } from '../application/ChatBubbleSkinRuntime';
import { DEFAULT_BUBBLE_TEXT_COLORS } from '../domain/ChatBubbleSkin';
import { useChatBubbleSkins } from './useChatBubbleSkins';

/** 外观页只是当前气泡字色的另一个入口，组合色不复制到主题存储。 */
export function useChatBubbleTextColors() {
  const context = useThemeContext();
  const enabled = supportsChatBubbleSkins(context.theme);
  const skins = useChatBubbleSkins(enabled);
  const entry = (token: ChatColorToken) => {
    const role = token === 'userText' ? 'user' : 'ai';
    const preset = enabled ? skins[role] : null;
    return { preset, color: preset ? preset.textColor : context.theme.colors.chat[token],
      defaultColor: preset ? DEFAULT_BUBBLE_TEXT_COLORS[role] : getThemeById(context.themeId).colors.chat[token],
      label: preset ? preset.name : context.chatColorOverrides[token] ? '自定义' : '主题默认' };
  };
  return {
    userText: entry('userText'), aiText: entry('aiText'),
    setColor(token: ChatColorToken, color: string) {
      const { preset } = entry(token);
      return preset ? setChatBubblePresetTextColor(preset.id, color) : context.setChatColorOverride(token, color);
    },
    resetColor(token: ChatColorToken) {
      const { preset, defaultColor } = entry(token);
      return preset ? setChatBubblePresetTextColor(preset.id, defaultColor) : context.resetChatColorOverride(token);
    },
  };
}
