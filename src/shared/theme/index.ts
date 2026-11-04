export type {
  PresentationTheme,
  PresentationThemeId,
  PresentationThemeMode,
  ThemeColors,
  ThemeTypography,
  ThemeSpacing,
  ThemeRadius,
  ThemeShadow,
  ThemeEffects,
  ThemeGlassMaterial,
  ThemeComponentTokens,
  ThemeContextValue,
  ChatColorOverrides,
  ChatColorToken,
} from './types';

export { ThemeProvider } from './ThemeProvider';
export { useTheme, useThemeContext } from './useTheme';
export { GLASS_BLUR_RANGE } from './glassBlur';
export { useThemedStyles } from './useThemedStyles';
export { THEME_REGISTRY, DEFAULT_THEME_ID, getThemeById, isValidThemeId, AVAILABLE_THEMES } from './themeRegistry';
export {
  getChatInteractionProfile,
  getChatPresentationVariant,
  isMoonKimiTheme,
  isPaperNoteTheme,
  supportsChatBubbleSkins,
} from './themeVariants';
export { legacyColorsFromTheme } from './legacyTokens';
export {
  loadStoredThemeBackupState,
  parseStoredThemeBackupState,
  restoreStoredThemeBackupState,
} from './themeStorage';
export type { StoredThemeBackupState } from './themeStorage';
export type { ChatFooterImageRef, ChatFooterSettings } from './chatFooterSettings';
export { CHAT_FOOTER_IMAGE_MIME_TYPES, DEFAULT_CHAT_FOOTER_SETTINGS } from './chatFooterSettings';

export type { ChatInteractionProfile, ChatPresentationVariant } from './themeVariants';

export { ThemedSurface } from './components/ThemedSurface';
export { GlassSurface } from './components/GlassSurface';
export {
  APP_GLASS_SCENE_ID,
  GlassBackdrop,
  GlassSceneProvider,
  getChatGlassSceneId,
  useGlassSceneId,
} from './components/GlassScene';

export type {
  ChatWallpaperOverrides,
  WallpaperContextValue,
  WallpaperMode,
  WallpaperSelection,
  StoredWallpaperState,
} from './wallpaper';

export {
  AppBackground,
  DefaultGlassBackdrop,
  WallpaperProvider,
  useWallpaper,
} from './wallpaper';
