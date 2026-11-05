/** 手机工具小程序：Phone Tools 产品能力目录。 */

import { ToggleDetailRow, ToggleField } from '@shared/ui';
import React from 'react';
import { StyleSheet, ScrollView, Text, View } from 'react-native';
import { ClipboardPaste, MapPin, Music2, NotebookPen } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  PHONE_TOOL_CATALOG,
  PHONE_TOOL_CATEGORIES,
  PHONE_TOOL_PACKAGE_CATALOG,
} from '@features/phoneTools';
import type {
  PhoneToolCatalogItemId,
} from '@features/phoneTools';
import { ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { buildPhoneToolsDirectory } from './PhoneToolsDirectoryModel';
import { usePhoneToolSettings } from './usePhoneToolSettings';

interface PhoneToolsScreenProps {
  onBack: () => void;
  onOpenToolPackage: (packageId: string) => void;
}

const PHONE_TOOL_SECTIONS = buildPhoneToolsDirectory(
  PHONE_TOOL_CATALOG,
  PHONE_TOOL_CATEGORIES,
);

const PHONE_TOOL_ICONS = {
  installedAppSearch: 'search-outline',
  foregroundApp: 'apps-outline',
  appUsage: 'time-outline',
  accessibilityScreenRead: 'reader-outline',
  ocrScreenRead: 'scan-outline',
  appLaunch: 'open-outline',
  softAppLock: 'lock-closed-outline',
  softAppLockRelease: 'lock-open-outline',
} as const satisfies Record<Exclude<PhoneToolCatalogItemId, 'currentLocation' | 'clipboardRead'>, keyof typeof Ionicons.glyphMap>;

const PACKAGE_ICONS = { notebook: NotebookPen, music: Music2 };

const createStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background.screen,
    },
    scrollContent: {
      paddingTop: theme.spacing.md,
      paddingBottom: 48,
    },
    categoryTitle: {
      marginTop: theme.spacing.md,
      marginBottom: theme.spacing.xs,
      marginHorizontal: theme.spacing.lg,
      color: theme.colors.text.secondary,
      fontSize: 12,
    },
    guidance: {
      marginHorizontal: theme.spacing.lg,
      color: theme.colors.text.secondary,
      fontSize: 12,
      lineHeight: 18,
    },
    card: {
      borderRadius: theme.radius.lg,
      marginHorizontal: theme.spacing.lg,
      overflow: 'hidden',
    },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 14,
      paddingHorizontal: theme.spacing.lg,
    },
    itemDivider: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border.light,
    },
    plannedItem: {
      opacity: 0.72,
    },
    iconContainer: {
      width: 28,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
    },
    textContainer: {
      flex: 1,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      rowGap: 4,
    },
    itemName: {
      flexShrink: 1,
      fontSize: 16,
      color: theme.colors.text.primary,
    },
    itemDescription: {
      fontSize: 12,
      color: theme.colors.text.secondary,
      marginTop: 2,
      lineHeight: 17,
    },
    status: {
      marginLeft: theme.spacing.sm,
      paddingHorizontal: 7,
      paddingVertical: 3,
      borderRadius: theme.radius.sm,
      backgroundColor: theme.colors.surface.input,
    },
    statusText: {
      fontSize: 11,
    },
    statusAvailable: {
      color: theme.colors.feedback.success,
    },
    statusPlanned: {
      color: theme.colors.text.tertiary,
    },
  });

export default function PhoneToolsScreen({
  onBack,
  onOpenToolPackage,
}: PhoneToolsScreenProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const settings = usePhoneToolSettings();

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <NavigationHeader title="手机工具" onGoBack={onBack} help={{ sections: [
        { title: '调用权限', body: `开关与提示词中心共用主理 AI${settings.hostName ? `「${settings.hostName}」` : ''}的单项调用权限；授权系统权限不会自动打开调用开关。` },
        { title: '应用工具包', body: '默认关闭，按需开启。关闭后不再向 AI 提供该包的目录、说明和工具参数；单项权限与星标偏好保留。应用工具包仅供主理 AI 使用。' },
        { title: '系统状态', body: '权限就绪只表示系统前提已满足，目标应用、当前页面、受保护应用及执行时状态仍共同决定调用结果。返回页面后刷新系统权限状态。' },
      ] }} />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {settings.notice && <Text style={styles.guidance}>{settings.notice}</Text>}
        {PHONE_TOOL_SECTIONS.map((section) => (
          <View key={section.id}>
            <Text style={styles.categoryTitle}>{section.title}</Text>
            <ThemedSurface nativeGlass variant="card" style={styles.card}>
              {section.items.map((tool, index) => {
                const rowStyle = [
                  styles.item,
                  index < section.items.length - 1 && styles.itemDivider,
                  tool.implementationStatus === 'planned' && styles.plannedItem,
                ];
                const rowContent = (
                  <>
                    <View style={styles.iconContainer}>
                      {tool.id === 'currentLocation' ? <MapPin size={20} color={theme.colors.brand.primary} />
                        : tool.id === 'clipboardRead' ? <ClipboardPaste size={20} color={theme.colors.brand.primary} /> : <Ionicons
                        name={PHONE_TOOL_ICONS[tool.id]}
                        size={20}
                        color={
                          tool.implementationStatus === 'available'
                            ? theme.colors.brand.primary
                            : theme.colors.text.tertiary
                        }
                      />}
                    </View>
                    <View style={styles.textContainer}>
                      <View style={styles.titleRow}>
                        <Text style={styles.itemName}>{tool.title}</Text>
                        <View style={styles.status}>
                          <Text
                            style={[
                              styles.statusText,
                              tool.implementationStatus === 'available' && settings.statusLabel(tool.toolName) === '权限就绪'
                                ? styles.statusAvailable
                                : styles.statusPlanned,
                            ]}
                          >
                            {tool.implementationStatus === 'available' ? settings.statusLabel(tool.toolName) : '开发中'}
                          </Text>
                        </View>
                      </View>
                      <Text style={styles.itemDescription}>{tool.description}</Text>
                    </View>
                  </>
                );

                return (
                  tool.implementationStatus === 'available' ? <ToggleField key={tool.id} layout="inline" rowStyle={rowStyle} label={tool.title}
                    accessibilityLabel={`允许调用${tool.title}`}
                    disabled={settings.disabled}
                    value={settings.isEnabled(tool.toolName)}
                    onValueChange={(enabled) => { void settings.toggleTool(tool.toolName, enabled); }}
                  >
                    {rowContent}
                  </ToggleField> : <View key={tool.id} style={rowStyle}>{rowContent}</View>
                );
              })}
            </ThemedSurface>
          </View>
        ))}
        <View>
          <Text style={styles.categoryTitle}>应用工具包</Text>
          <ThemedSurface nativeGlass variant="card" style={styles.card}>
            {PHONE_TOOL_PACKAGE_CATALOG.map((toolPackage, index) => {
              const Icon = PACKAGE_ICONS[toolPackage.icon];
              return <ToggleDetailRow key={toolPackage.id} title={toolPackage.title}
                description={toolPackage.description}
                icon={<Icon size={20} color={theme.colors.brand.primary} />}
                value={settings.isPackageEnabled(toolPackage.id)}
                disabled={settings.packageDisabled || toolPackage.implementationStatus !== 'available'}
                onValueChange={(enabled) => { void settings.togglePackage(toolPackage.id, enabled); }}
                onOpenDetail={() => onOpenToolPackage(toolPackage.id)}
                divider={index < PHONE_TOOL_PACKAGE_CATALOG.length - 1}
              />;
            })}
          </ThemedSurface>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
