import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatColorOverrides, PresentationThemeId } from './types';
import { DEFAULT_THEME_ID, getThemeSelectionDisabledReason, isValidThemeId, THEME_REGISTRY } from './themeRegistry';
import { parseGlassBlurRadius } from './glassBlur';
import type { ChatFooterSettings } from './chatFooterSettings';
import {
  loadStoredChatFooterBackupState,
  parseChatFooterSettings,
  restoreStoredChatFooterBackupState,
} from './chatFooterSettings';

const STORAGE_KEY = 'presentation.theme.selectedThemeId';
const CHAT_COLOR_OVERRIDES_KEY_PREFIX = 'presentation.theme.chatColorOverrides.';
const GLASS_BLUR_RADIUS_KEY = 'presentation.theme.glassBlurRadius';
// 纠正曾误加的独立主题；只在持久化/备份边界归回 daylight，运行时不保留该主题身份。
const REMOVED_BUBBLE_THEME_ID = 'custom-bubble';

function parseStoredThemeId(value: unknown): PresentationThemeId {
  const themeId = value === REMOVED_BUBBLE_THEME_ID ? DEFAULT_THEME_ID : value;
  if (typeof themeId !== 'string' || !isValidThemeId(themeId)) throw new Error('备份主题标识无效');
  return themeId;
}

export interface StoredThemeBackupState {
  selectedThemeId: PresentationThemeId;
  chatColorOverrides: Partial<Record<PresentationThemeId, ChatColorOverrides>>;
  glassBlurRadius?: number;
  paperNoteChatFooter?: ChatFooterSettings;
}

export async function loadGlassBlurRadius(): Promise<number | undefined> {
  try {
    const stored = await AsyncStorage.getItem(GLASS_BLUR_RADIUS_KEY);
    if (stored === null) return undefined;
    const parsed: unknown = JSON.parse(stored);
    return parsed === null ? undefined : parseGlassBlurRadius(parsed);
  } catch {
    // 外部存储损坏或不可读时，运行时使用主题默认材质。
    return undefined;
  }
}

export async function saveGlassBlurRadius(radius: number): Promise<void> {
  try {
    await AsyncStorage.setItem(GLASS_BLUR_RADIUS_KEY, JSON.stringify(radius));
  } catch {
    // 与其他外观偏好一致，存储失败不阻断当前会话中的调整。
  }
}

export async function loadStoredThemeId(): Promise<PresentationThemeId> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (stored === REMOVED_BUBBLE_THEME_ID) {
      const oldKey = CHAT_COLOR_OVERRIDES_KEY_PREFIX + REMOVED_BUBBLE_THEME_ID;
      const targetKey = CHAT_COLOR_OVERRIDES_KEY_PREFIX + DEFAULT_THEME_ID;
      const colors = new Map(await AsyncStorage.multiGet([oldKey, targetKey]));
      const oldColors = colors.get(oldKey);
      await AsyncStorage.multiSet([
        [STORAGE_KEY, DEFAULT_THEME_ID],
        ...(colors.get(targetKey) === null && oldColors !== null ? [[targetKey, oldColors] as [string, string]] : []),
      ]);
      await AsyncStorage.removeItem(oldKey);
      return DEFAULT_THEME_ID;
    }
    if (stored && isValidThemeId(stored)) {
      // 旧设置和备份可保留未开放的主题，运行时只加载已开放主题。
      return getThemeSelectionDisabledReason(stored) ? DEFAULT_THEME_ID : stored;
    }
  } catch {
    // 主题持久化属于外部存储边界，读取失败时使用默认主题。
  }
  return DEFAULT_THEME_ID;
}

export async function saveThemeId(themeId: PresentationThemeId): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, themeId);
  } catch {
    // 写入失败不应阻断当前会话中的主题切换。
  }
}

/** 加载指定主题的聊天文字颜色覆盖层。 */
export async function loadChatColorOverrides(
  themeId: PresentationThemeId
): Promise<ChatColorOverrides> {
  try {
    const stored = await AsyncStorage.getItem(CHAT_COLOR_OVERRIDES_KEY_PREFIX + themeId);
    if (stored) {
      const parsed = JSON.parse(stored) as ChatColorOverrides;
      if (parsed && typeof parsed === 'object') {
        return {
          userText: typeof parsed.userText === 'string' ? parsed.userText : undefined,
          aiText: typeof parsed.aiText === 'string' ? parsed.aiText : undefined,
        };
      }
    }
  } catch {
    // 覆盖层读取失败时回退到主题默认值。
  }
  return {};
}

/** 保存指定主题的聊天文字颜色覆盖层。 */
export async function saveChatColorOverrides(
  themeId: PresentationThemeId,
  overrides: ChatColorOverrides
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      CHAT_COLOR_OVERRIDES_KEY_PREFIX + themeId,
      JSON.stringify(overrides)
    );
  } catch {
    // 写入失败不应阻断当前会话中的颜色调整。
  }
}

/** 备份专用严格读取：只有“从未持久化”才表示默认值，读取或格式错误必须上抛。 */
export async function loadStoredThemeBackupState(): Promise<StoredThemeBackupState> {
  const themeIds = Object.keys(THEME_REGISTRY) as PresentationThemeId[];
  const storedColorIds = [...themeIds, REMOVED_BUBBLE_THEME_ID];
  const keys = [
    STORAGE_KEY,
    GLASS_BLUR_RADIUS_KEY,
    ...storedColorIds.map((themeId) => CHAT_COLOR_OVERRIDES_KEY_PREFIX + themeId),
  ];
  const stored = new Map(await AsyncStorage.multiGet(keys));
  const selectedValue = stored.get(STORAGE_KEY);
  const selectedThemeId = selectedValue === null || selectedValue === undefined
    ? DEFAULT_THEME_ID
    : selectedValue;
  const chatColorOverrides = Object.fromEntries(storedColorIds.flatMap((themeId) => {
    const raw = stored.get(CHAT_COLOR_OVERRIDES_KEY_PREFIX + themeId);
    if (raw === null || raw === undefined) return [];
    return [[themeId, JSON.parse(raw) as unknown]];
  }));
  const rawBlur = stored.get(GLASS_BLUR_RADIUS_KEY);
  const glassBlurRadius: unknown = rawBlur === null || rawBlur === undefined ? null : JSON.parse(rawBlur);
  const paperNoteChatFooter = await loadStoredChatFooterBackupState();
  return parseStoredThemeBackupState({
    selectedThemeId, chatColorOverrides,
    ...(glassBlurRadius === null ? {} : { glassBlurRadius }),
    ...(paperNoteChatFooter === undefined ? {} : { paperNoteChatFooter }),
  });
}

export function parseStoredThemeBackupState(value: unknown): StoredThemeBackupState {
  if (!value || typeof value !== 'object') throw new Error('备份主题设置无效');
  const state = value as Partial<StoredThemeBackupState>;
  const glassBlurRadius = state.glassBlurRadius === undefined
    ? undefined : parseGlassBlurRadius(state.glassBlurRadius);
  const selectedThemeId = parseStoredThemeId(state.selectedThemeId);
  const overrides = state.chatColorOverrides;
  if (overrides !== undefined &&
    (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))) {
    throw new Error('备份主题颜色设置无效');
  }
  const validatedOverrides: [PresentationThemeId, ChatColorOverrides][] = [];
  for (const [themeId, colors] of Object.entries(overrides ?? {})) {
    const normalizedThemeId = themeId === REMOVED_BUBBLE_THEME_ID ? DEFAULT_THEME_ID : themeId;
    if (!isValidThemeId(normalizedThemeId) || !colors ||
      typeof colors !== 'object' || Array.isArray(colors)) {
      throw new Error('备份主题颜色设置无效');
    }
    const candidate = colors as ChatColorOverrides;
    if ((candidate.userText !== undefined && typeof candidate.userText !== 'string') ||
      (candidate.aiText !== undefined && typeof candidate.aiText !== 'string')) {
      throw new Error('备份主题颜色值无效');
    }
    // daylight 自己已有配色时保留它；只有独立主题的旧配色才迁入 daylight。
    if (themeId === REMOVED_BUBBLE_THEME_ID && overrides[DEFAULT_THEME_ID] !== undefined) continue;
    validatedOverrides.push([normalizedThemeId, candidate]);
  }

  return {
    selectedThemeId,
    chatColorOverrides: Object.fromEntries(validatedOverrides),
    ...(glassBlurRadius === undefined ? {} : { glassBlurRadius }),
    ...(state.paperNoteChatFooter === undefined
      ? {}
      : { paperNoteChatFooter: parseChatFooterSettings(state.paperNoteChatFooter) }),
  };
}

export async function restoreStoredThemeBackupState(value: unknown): Promise<void> {
  const state = parseStoredThemeBackupState(value);
  const themeIds = Object.keys(THEME_REGISTRY) as PresentationThemeId[];
  await AsyncStorage.multiSet([
    [STORAGE_KEY, state.selectedThemeId],
    [GLASS_BLUR_RADIUS_KEY, JSON.stringify(state.glassBlurRadius ?? null)],
    ...themeIds.map((themeId) => [
      CHAT_COLOR_OVERRIDES_KEY_PREFIX + themeId,
      JSON.stringify(state.chatColorOverrides[themeId] ?? {}),
    ] as [string, string]),
  ]);
  await restoreStoredChatFooterBackupState(state.paperNoteChatFooter);
}
