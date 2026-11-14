import React, { useEffect, useSyncExternalStore } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, CircleAlert, Info, TriangleAlert } from 'lucide-react-native';
import { ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import {
  clearAppDialogs,
  finishAppDialog,
  getAppDialogSnapshot,
  subscribeAppDialog,
} from './appDialogStore';
import type { AppDialogButton } from './appDialogStore';

const DEFAULT_BUTTONS: readonly AppDialogButton[] = [{ text: '知道了' }];
const ICONS = { info: Info, success: Check, warning: TriangleAlert, error: CircleAlert };

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: theme.spacing.xxl,
    backgroundColor: theme.effects.overlay.dim,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    maxHeight: '100%',
    padding: theme.spacing.xxl,
    borderRadius: theme.radius.xl + theme.spacing.sm,
    backgroundColor: theme.colors.surface.raised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.light,
    gap: theme.spacing.xl,
    ...theme.shadow.md,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
  icon: {
    width: 40,
    height: 40,
    borderRadius: theme.radius.round,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface.muted,
  },
  title: { ...theme.typography.title, color: theme.colors.text.primary, flex: 1 },
  scroll: { flexShrink: 1 },
  message: {
    ...theme.typography.bodySmall,
    lineHeight: 23,
    color: theme.colors.text.primary,
    opacity: 0.8,
  },
  buttons: { gap: theme.spacing.sm },
  button: {
    minHeight: 48,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { ...theme.typography.bodySmall, fontWeight: '600', textAlign: 'center' },
});

/** 全应用唯一提示展示宿主；原生 Modal 让表单弹窗中的报错也能位于最上层。 */
export default function AppDialogHost() {
  const dialog = useSyncExternalStore(subscribeAppDialog, getAppDialogSnapshot);
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  useEffect(() => () => clearAppDialogs(), []);
  if (!dialog) return null;

  const tone = dialog.tone ?? 'info';
  const Icon = ICONS[tone];
  const accent = tone === 'info' ? theme.colors.brand.primary : theme.colors.feedback[tone];
  const buttons = dialog.buttons ?? DEFAULT_BUTTONS;
  const dismissible = dialog.dismissible ?? true;
  const close = () => { if (dismissible) finishAppDialog(dialog); };

  return <Modal
    transparent
    statusBarTranslucent
    navigationBarTranslucent
    animationType="fade"
    onRequestClose={close}
  >
    <View style={[styles.overlay, {
      paddingTop: insets.top + theme.spacing.xxl,
      paddingBottom: insets.bottom + theme.spacing.xxl,
      paddingLeft: insets.left + theme.spacing.xxl,
      paddingRight: insets.right + theme.spacing.xxl,
    }]}>
      <Pressable
        style={StyleSheet.absoluteFill}
        accessible={dismissible}
        accessibilityRole="button"
        accessibilityLabel="关闭提示"
        onPress={close}
      />
      <ThemedSurface variant="modal" backgroundColor={theme.colors.surface.raised} style={styles.card} accessibilityViewIsModal>
        <View style={styles.header}>
          <View style={styles.icon} accessible={false}>
            <Icon size={20} strokeWidth={1.75} color={accent} />
          </View>
          <Text style={styles.title} accessibilityRole={tone === 'error' ? 'alert' : 'header'}>
            {dialog.title}
          </Text>
        </View>
        {dialog.message ? <ScrollView style={styles.scroll} showsVerticalScrollIndicator>
          <Text style={styles.message} selectable>{dialog.message}</Text>
        </ScrollView> : null}
        <View style={styles.buttons}>
          {buttons.map((button, index) => {
            const primary = button.style !== 'cancel' && index === buttons.length - 1;
            const destructive = button.style === 'destructive';
            const strongDestructive = destructive && button.emphasis === 'strong';
            return <Pressable
              key={index}
              accessibilityRole="button"
              accessibilityLabel={button.text}
              onPress={() => finishAppDialog(dialog, button)}
              style={({ pressed }) => [styles.button, {
                backgroundColor: strongDestructive ? theme.colors.feedback.error : primary && !destructive
                  ? (pressed ? theme.colors.brand.primaryPressed : theme.colors.brand.primary)
                  : theme.colors.surface.muted,
                opacity: pressed ? 0.8 : 1,
              }]}
            >
              <Text style={[styles.buttonText, { color: strongDestructive ? theme.colors.brand.onPrimary : destructive
                ? theme.colors.feedback.error
                : primary ? theme.colors.brand.onPrimary : theme.colors.text.primary,
              }]}>{button.text}</Text>
            </Pressable>;
          })}
        </View>
      </ThemedSurface>
    </View>
  </Modal>;
}
