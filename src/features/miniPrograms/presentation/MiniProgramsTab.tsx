import React, { useState, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import { useFloatingTabBarScrollPadding, showAppDialog } from '@shared/ui';
import NavigationHeader from '@shared/ui/NavigationHeader';

export type MiniProgramId =
  | 'wallet'
  | 'auxiliaryModels'
  | 'aiRequestDiagnostics'
  | 'mcpTools'
  | 'webSearch'
  | 'memory'
  | 'promptCenter'
  | 'ravenCatCompanion'
  | 'ravenCatFloating'
  | 'ravenCatSystemAccess'
  | 'phoneTools'
  | 'stickerSystem'
  | 'themePicker';

interface MiniProgramConfig {
  id: MiniProgramId;
  name: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconColor?: string;
  category: string;
}

const MINI_PROGRAMS: MiniProgramConfig[] = [
  {
    id: 'wallet',
    name: '羽库',
    icon: 'wallet-outline',
    iconColor: '#FF9500',
    category: '实用工具',
  },
  {
    id: 'auxiliaryModels',
    name: '辅助模型中心',
    icon: 'hardware-chip-outline',
    iconColor: '#3A9BEF',
    category: 'AI 工具',
  },
  {
    id: 'promptCenter',
    name: '提示词中心',
    icon: 'code-slash-outline',
    iconColor: '#AF52DE',
    category: 'AI 工具',
  },
  {
    id: 'aiRequestDiagnostics',
    name: 'AI 请求诊断',
    icon: 'pulse-outline',
    category: 'AI 工具',
  },
  {
    id: 'mcpTools',
    name: 'MCP 工具',
    icon: 'server-outline',
    iconColor: '#5856D6',
    category: 'AI 工具',
  },
  {
    id: 'webSearch',
    name: '联网搜索',
    icon: 'search-outline',
    iconColor: '#34C759',
    category: 'AI 工具',
  },
  {
    id: 'phoneTools',
    name: '手机工具',
    icon: 'phone-portrait-outline',
    iconColor: '#3A9BEF',
    category: 'AI 工具',
  },
  {
    id: 'ravenCatCompanion',
    name: '本地伴随',
    icon: 'chatbubble-ellipses-outline',
    iconColor: '#5856D6',
    category: 'AI 陪伴',
  },
  {
    id: 'ravenCatFloating',
    name: '悬浮交互',
    icon: 'layers-outline',
    iconColor: '#0A84FF',
    category: 'AI 陪伴',
  },
  {
    id: 'memory',
    name: '记忆系统',
    icon: 'library-outline',
    iconColor: '#34C759',
    category: 'AI 陪伴',
  },
  {
    id: 'stickerSystem',
    name: '表情包系统',
    icon: 'happy-outline',
    iconColor: '#FF2D55',
    category: 'AI 陪伴',
  },
  {
    id: 'ravenCatSystemAccess',
    name: '权限与后台运行',
    icon: 'shield-checkmark-outline',
    iconColor: '#34C759',
    category: 'AI 陪伴',
  },
  {
    id: 'themePicker',
    name: '外观主题',
    icon: 'color-palette-outline',
    category: '外观设置',
  },
];

const createStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    tabContainer: {
      flex: 1,
      backgroundColor: theme.colors.background.app,
    },
    container: {
      flex: 1,
      backgroundColor: theme.colors.background.screen,
    },
    categoryTitle: {
      fontSize: 12,
      color: theme.colors.text.secondary,
      marginTop: theme.spacing.lg,
      marginBottom: theme.spacing.xs,
      marginHorizontal: theme.spacing.lg,
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
      paddingVertical: 12,
      paddingHorizontal: theme.spacing.lg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border.light,
    },
    itemLast: {
      borderBottomWidth: 0,
    },
    iconContainer: {
      width: 28,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
    },
    itemName: {
      fontSize: 16,
      color: theme.colors.text.primary,
    },
    pinIcon: {
      marginLeft: 'auto',
    },
  });

interface MiniProgramsTabProps {
  onOpenApp?: ((appId: MiniProgramId) => void) | null;
}

export default function MiniProgramsTab({ onOpenApp = null }: MiniProgramsTabProps) {
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const scrollContentPaddingBottom = useFloatingTabBarScrollPadding();

  const handleLongPress = useCallback((app: MiniProgramConfig) => {
    const isPinned = pinnedIds.includes(app.id);
    showAppDialog({
      title: app.name,
      message: undefined,
      buttons: [
        {
          text: isPinned ? '取消置顶' : '置顶',
          onPress: () => {
            setPinnedIds((prev) =>
              isPinned ? prev.filter((id) => id !== app.id) : [...prev, app.id]
            );
          },
        },
        { text: '取消', style: 'cancel' },
      ],
    });
  }, [pinnedIds]);

  const groupedApps = useMemo(() => {
    const groups: Record<string, MiniProgramConfig[]> = {};
    MINI_PROGRAMS.forEach((app) => {
      if (!groups[app.category]) groups[app.category] = [];
      groups[app.category].push(app);
    });

    Object.keys(groups).forEach((category) => {
      groups[category].sort((a, b) => {
        const aPinned = pinnedIds.includes(a.id) ? 1 : 0;
        const bPinned = pinnedIds.includes(b.id) ? 1 : 0;
        return bPinned - aPinned;
      });
    });

    return groups;
  }, [pinnedIds]);

  const categories = Object.keys(groupedApps);

  return (
    <SafeAreaView style={styles.tabContainer} edges={theme.effects.glass.enabled ? ['left', 'right'] : ['top', 'left', 'right']}>
      <NavigationHeader title="发现" includeTopInset={theme.effects.glass.enabled} />
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingBottom: scrollContentPaddingBottom }}
      >
        {categories.map((category) => (
          <View key={category}>
            <Text style={styles.categoryTitle}>{category}</Text>
            <ThemedSurface nativeGlass variant="card" style={styles.card}>
              {groupedApps[category].map((app, index) => (
                <TouchableOpacity
                  key={app.id}
                  style={[
                    styles.item,
                    index === groupedApps[category].length - 1 && styles.itemLast,
                  ]}
                  activeOpacity={0.7}
                  onPress={() => onOpenApp?.(app.id)}
                  onLongPress={() => handleLongPress(app)}
                >
                  <View style={styles.iconContainer}>
                    <Ionicons
                      name={app.icon}
                      size={20}
                      color={app.iconColor ?? theme.colors.brand.primary}
                    />
                  </View>
                  <Text style={styles.itemName}>{app.name}</Text>
                  {pinnedIds.includes(app.id) && (
                    <Ionicons
                      name="pin-outline"
                      size={14}
                      color={theme.colors.text.tertiary}
                      style={styles.pinIcon}
                    />
                  )}
                </TouchableOpacity>
              ))}
            </ThemedSurface>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
