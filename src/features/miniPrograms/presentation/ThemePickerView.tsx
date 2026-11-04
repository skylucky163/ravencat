import { showAppDialog } from '@shared/ui';
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { pickCroppedImage } from '@platform/device/DeviceMediaService';
import { Ionicons } from '@expo/vector-icons';
import { MessageCircle } from 'lucide-react-native';
import { isPaperNoteTheme, supportsChatBubbleSkins, useThemeContext, useThemedStyles, useWallpaper } from '@shared/theme';
import type {
  ChatColorToken,
  PresentationTheme,
  PresentationThemeId,
  PresentationThemeMode,
} from '@shared/theme';
import type { WallpaperSelection, WallpaperSlot } from '@shared/theme/wallpaper';
import NavigationHeader from '@shared/ui/NavigationHeader';
import ColorPickerModal from '@shared/ui/ColorPickerModal';
import BackgroundPickerCard from '@shared/ui/BackgroundPickerCard';
import GlassBlurSettings from './GlassBlurSettings';
import PaperNoteChatFooterSettings from './PaperNoteChatFooterSettings';

import { listAIAssistants } from '@features/assistants';
import { getCanonicalChatConversation, listGroupChats, useChatBubbleTextColors } from '@features/chat';

type ChatWallpaperApplyScope = 'all' | 'single' | 'group';

interface ThemePickerViewProps {
  onOpenBubbleSkins(): void;
  onBack: () => void;
}

function modeLabel(mode: PresentationThemeMode): string {
  return mode === 'dark' ? '深色' : '浅色';
}

const createStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background.screen,
    },
    scrollContent: {
      paddingVertical: theme.spacing.lg,
    },
    sectionTitle: {
      marginHorizontal: theme.spacing.lg,
      marginBottom: theme.spacing.xs,
      fontSize: 13,
      color: theme.colors.text.secondary,
      fontWeight: '600',
    },
    card: {
      backgroundColor: theme.colors.surface.default,
      borderRadius: theme.radius.lg,
      marginHorizontal: theme.spacing.lg,
      overflow: 'hidden',
    },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 14,
      paddingHorizontal: theme.spacing.lg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border.light,
    },
    itemLast: {
      borderBottomWidth: 0,
    },
    itemSelected: {
      backgroundColor: theme.colors.surface.muted,
    },
    textContainer: {
      flex: 1,
    },
    name: {
      fontSize: 16,
      color: theme.colors.text.primary,
    },
    mode: {
      fontSize: 13,
      color: theme.colors.text.secondary,
      marginTop: 2,
    },
    checkmark: {
      marginLeft: theme.spacing.md,
    },
    entryIcon: { marginRight: theme.spacing.md },
    sectionGap: {
      height: theme.spacing.xl,
    },
    wallpaperCard: {
      marginHorizontal: theme.spacing.lg,
    },
    segmentedRow: {
      flexDirection: 'row',
      gap: theme.spacing.sm,
    },
    segmentButton: {
      flex: 1,
      minHeight: 34,
      borderRadius: theme.radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.surface.muted,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border.default,
    },
    segmentButtonSelected: {
      backgroundColor: theme.colors.brand.primary,
      borderColor: theme.colors.brand.primary,
    },
    segmentText: {
      fontSize: 13,
      fontWeight: '600',
      color: theme.colors.text.secondary,
    },
    segmentTextSelected: {
      color: theme.colors.brand.onPrimary,
    },
    colorSwatch: {
      width: 28,
      height: 28,
      borderRadius: theme.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border.default,
      marginRight: theme.spacing.md,
    },
    colorHexLabel: {
      fontSize: 13,
      color: theme.colors.text.tertiary,
      marginLeft: 'auto',
    },
  });

function wallpaperTitle(selection: WallpaperSelection): string {
  return selection.mode === 'custom' ? '自定义背景' : '跟随主题';
}

async function listExistingChatWallpaperKeys(scope: ChatWallpaperApplyScope): Promise<string[]> {
  const [assistants, groups] = await Promise.all([
    listAIAssistants(),
    listGroupChats(),
  ]);
  const conversations = [];
  for (const assistant of assistants) {
    const conversation = await getCanonicalChatConversation(assistant.id);
    if (conversation) conversations.push(conversation);
  }

  const singleKeys = conversations.map((conversation) => `single:${conversation.id}`);
  const groupKeys = groups.map((group) => `group:${group.id}`);
  if (scope === 'single') {
    return singleKeys;
  }
  if (scope === 'group') {
    return groupKeys;
  }
  return [...singleKeys, ...groupKeys];
}

const CHAT_WALLPAPER_SCOPES: { id: ChatWallpaperApplyScope; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'single', label: '单聊' },
  { id: 'group', label: '群聊' },
];

export default function ThemePickerView({ onBack, onOpenBubbleSkins }: ThemePickerViewProps) {
  const {
    theme,
    themeId,
    setThemeId,
    availableThemes,
  } = useThemeContext();
  const {
    appWallpaper,
    chatWallpaper,
    setCustomAppWallpaper,
    setCustomChatWallpaper,
    setDefaultAppWallpaper,
    setDefaultChatWallpaper,
  } = useWallpaper();
  const styles = useThemedStyles(createStyles);
  const [pickingWallpaperSlot, setPickingWallpaperSlot] = useState<WallpaperSlot | null>(null);
  const [chatWallpaperScope, setChatWallpaperScope] = useState<ChatWallpaperApplyScope>('all');
  const [colorPickerToken, setColorPickerToken] = useState<ChatColorToken | null>(null);
  const supportsAppWallpaper = theme.effects.glass.enabled;

  const textColors = useChatBubbleTextColors();
  const defaultUserText = textColors.userText.defaultColor;
  const defaultAiText = textColors.aiText.defaultColor;
  const currentUserText = textColors.userText.color;
  const currentAiText = textColors.aiText.color;

  const handleSelect = useCallback(
    async (id: PresentationThemeId) => {
      if (id !== themeId) {
        await setThemeId(id);
      }
    },
    [themeId, setThemeId]
  );

  const handlePickWallpaper = useCallback(async (slot: WallpaperSlot) => {
    if (slot === 'app' && !supportsAppWallpaper) {
      showAppDialog({ title: '当前主题不支持', message: '全局背景只在玻璃材质主题中启用。' });
      return;
    }

    try {
      setPickingWallpaperSlot(slot);
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        showAppDialog({ title: '需要权限', message: '请允许访问相册以选择背景图片', tone: 'warning' });
        return;
      }

      const asset = await pickCroppedImage({ aspect: 'screen' });
      if (!asset) return;

      if (slot === 'app') {
        await setCustomAppWallpaper(asset.uri);
      } else {
        const chatKeys = await listExistingChatWallpaperKeys(chatWallpaperScope);
        await setCustomChatWallpaper(asset.uri, chatKeys);
      }

    } catch (error) {
      console.error('[ThemePickerView] Failed to update wallpaper:', error);
      showAppDialog({ title: '错误', message: '更换背景失败，请稍后重试', tone: 'error' });
    } finally {
      setPickingWallpaperSlot(null);
    }
  }, [
    setCustomAppWallpaper,
    setCustomChatWallpaper,
    supportsAppWallpaper,
    chatWallpaperScope,
  ]);

  const handleRestoreDefaultWallpaper = useCallback((slot: WallpaperSlot) => {
    const selection = slot === 'app' ? appWallpaper : chatWallpaper;
    if (selection.mode === 'default') {
      return;
    }

    showAppDialog({ title: '恢复默认背景', message: '默认背景会跟随当前主题切换为浅色或深色。', buttons: [
      { text: '取消', style: 'cancel' },
      {
        text: '恢复',
        onPress: async () => {
          try {
            if (slot === 'app') {
              await setDefaultAppWallpaper();
            } else {
              const chatKeys = await listExistingChatWallpaperKeys(chatWallpaperScope);
              await setDefaultChatWallpaper(chatKeys);
            }
          } catch (error) {
            console.error('[Wallpaper] 恢复默认背景失败：', error);
            showAppDialog({ title: '错误', message: '恢复默认背景失败，请稍后重试', tone: 'error' });
          }
        },
      },
    ] });
  }, [
    appWallpaper,
    chatWallpaper,
    setDefaultAppWallpaper,
    setDefaultChatWallpaper,
    chatWallpaperScope,
  ]);

  const renderWallpaperCard = (
    slot: WallpaperSlot,
    title: string,
    selection: WallpaperSelection,
    description: string,
    disabled = false
  ) => {
    const isPicking = pickingWallpaperSlot === slot;

    return (
      <>
        <Text style={styles.sectionTitle}>{title}</Text>
        <BackgroundPickerCard
          style={styles.wallpaperCard}
          previewSource={selection.mode === 'custom' && selection.uri ? { uri: selection.uri } : null}
          previewTitle={wallpaperTitle(selection)}
          previewSubtitle={disabled ? '当前主题不支持全局背景' : description}
          isPicking={isPicking}
          pickDisabled={disabled || (Boolean(pickingWallpaperSlot) && !isPicking)}
          resetDimmed={selection.mode === 'default'}
          resetDisabled={disabled}
          onPick={() => handlePickWallpaper(slot)}
          onReset={() => handleRestoreDefaultWallpaper(slot)}
        >
          {slot === 'chat' ? (
            <View style={styles.segmentedRow}>
              {CHAT_WALLPAPER_SCOPES.map((scope) => {
                const selected = chatWallpaperScope === scope.id;
                return (
                  <TouchableOpacity
                    key={scope.id}
                    style={[
                      styles.segmentButton,
                      selected && styles.segmentButtonSelected,
                    ]}
                    activeOpacity={0.8}
                    onPress={() => setChatWallpaperScope(scope.id)}
                  >
                    <Text
                      style={[
                        styles.segmentText,
                        selected && styles.segmentTextSelected,
                      ]}
                    >
                      {scope.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : null}
        </BackgroundPickerCard>
      </>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <NavigationHeader
        title="外观主题"
        onGoBack={onBack}
      />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.sectionTitle}>主题</Text>
        <View style={styles.card}>
          {availableThemes.map((t, index) => {
            const isSelected = t.id === themeId;
            const isLast = index === availableThemes.length - 1;

            return (
              <TouchableOpacity
                key={t.id}
                style={[
                  styles.item,
                  isLast && styles.itemLast,
                  isSelected && styles.itemSelected,
                ]}
                disabled={Boolean(t.disabledReason)}
                accessibilityRole="button"
                accessibilityState={{ disabled: Boolean(t.disabledReason), selected: isSelected }}
                activeOpacity={0.7}
                onPress={() => handleSelect(t.id)}
              >
                <View style={styles.textContainer}>
                  <Text style={[styles.name, t.disabledReason && { color: theme.colors.text.tertiary }]}>{t.name}</Text>
                  {t.disabledReason && <Text style={styles.mode}>{t.disabledReason}</Text>}
                </View>
                {isSelected && (
                  <Ionicons
                    name="checkmark"
                    size={20}
                    color={theme.colors.brand.primary}
                    style={styles.checkmark}
                  />
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.sectionGap} />

        {theme.effects.glass.enabled && (
          <>
            <GlassBlurSettings />
            <View style={styles.sectionGap} />
          </>
        )}

        {supportsChatBubbleSkins(theme) && (
          <>
            <Text style={styles.sectionTitle}>气泡</Text>
            <View style={styles.card}>
              <TouchableOpacity
                style={[styles.item, styles.itemLast]}
                accessibilityRole="button"
                activeOpacity={0.7}
                onPress={onOpenBubbleSkins}
              >
                <MessageCircle size={20} color={theme.colors.text.secondary} style={styles.entryIcon} />
                <View style={styles.textContainer}>
                  <Text style={styles.name}>气泡编辑</Text>
                  <Text style={styles.mode}>自定义用户与 AI 的消息气泡</Text>
                </View>
              </TouchableOpacity>
            </View>
            <View style={styles.sectionGap} />
          </>
        )}

        {/* 文字颜色 */}
        <Text style={styles.sectionTitle}>文字颜色</Text>
        <View style={styles.card}>
          <TouchableOpacity
            style={[styles.item, styles.itemLast]}
            activeOpacity={0.7}
            onPress={() => setColorPickerToken('userText')}
          >
            <View style={[styles.colorSwatch, { backgroundColor: currentUserText }]} />
            <View style={styles.textContainer}>
              <Text style={styles.name}>用户文字</Text>
              <Text style={styles.mode}>
                {textColors.userText.label}
              </Text>
            </View>
            <Text style={styles.colorHexLabel}>{currentUserText}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.sectionGap} />

        <View style={styles.card}>
          <TouchableOpacity
            style={[styles.item, styles.itemLast]}
            activeOpacity={0.7}
            onPress={() => setColorPickerToken('aiText')}
          >
            <View style={[styles.colorSwatch, { backgroundColor: currentAiText }]} />
            <View style={styles.textContainer}>
              <Text style={styles.name}>AI 文字</Text>
              <Text style={styles.mode}>
                {textColors.aiText.label}
              </Text>
            </View>
            <Text style={styles.colorHexLabel}>{currentAiText}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.sectionGap} />

        {isPaperNoteTheme(theme) && (
          <>
            <Text style={styles.sectionTitle}>聊天底栏</Text>
            <PaperNoteChatFooterSettings />
            <View style={styles.sectionGap} />
          </>
        )}

        {renderWallpaperCard(
          'app',
          '全局背景',
          appWallpaper,
          '仅玻璃材质主题显示',
          !supportsAppWallpaper
        )}

        <View style={styles.sectionGap} />

        {renderWallpaperCard(
          'chat',
          '聊天背景',
          chatWallpaper,
          chatWallpaper.mode === 'custom' ? `已应用到当前已有${chatWallpaperScope === 'all' ? '聊天' : chatWallpaperScope === 'single' ? '单聊' : '群聊'}` : modeLabel(theme.mode)
        )}
      </ScrollView>

      {/* 文字颜色选择弹窗 */}
      <ColorPickerModal
        visible={colorPickerToken !== null}
        title={colorPickerToken === 'userText' ? '用户文字颜色' : 'AI 文字颜色'}
        currentColor={
          colorPickerToken === 'userText' ? currentUserText : currentAiText
        }
        defaultColor={
          colorPickerToken === 'userText' ? defaultUserText : defaultAiText
        }
        onClose={() => setColorPickerToken(null)}
        onConfirm={(color) => {
          if (colorPickerToken) {
            void textColors.setColor(colorPickerToken, color);
          }
        }}
        onReset={
          colorPickerToken
            ? () => {
                void textColors.resetColor(colorPickerToken);
              }
            : null
        }
      />
    </SafeAreaView>
  );
}
