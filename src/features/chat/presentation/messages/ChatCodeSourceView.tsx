import React, { useCallback } from 'react';
import { Pressable, StyleSheet, Text, ToastAndroid, View } from 'react-native';
import { Copy } from 'lucide-react-native';
import { copyTextToClipboard, TextSelectionScrollView } from '@platform/device';
import { useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';

export default function ChatCodeSourceView({ source, language }: { source: string; language: string }) {
  const styles = useThemedStyles(createStyles);
  const theme = useTheme();
  const copy = useCallback(() => {
    copyTextToClipboard(source);
    ToastAndroid.show('已复制源码', ToastAndroid.SHORT);
  }, [source]);
  return <View style={styles.body}>
    <View style={styles.toolbar}><View style={styles.info}><Text style={styles.label}>{(language || 'CODE').toUpperCase()}</Text>
      <Text style={styles.caption}>{source.length.toLocaleString()} 字符 · 长按选择文字</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel="复制全部源码" onPress={copy} style={styles.copyAll}><Copy size={15} color={theme.colors.brand.primary} /><Text style={styles.action}>复制全文</Text></Pressable>
    </View>
    <TextSelectionScrollView style={styles.body} contentContainerStyle={styles.content}>
      {/* 同一个原生文字选区允许跨任意行选择，不把复制范围绑到字符阈值。 */}
      <Text selectable style={styles.code}>{source}</Text>
    </TextSelectionScrollView>
  </View>;
}

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  body: { flex: 1 },
  toolbar: { padding: 16, flexDirection: 'row', gap: 12, alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border.light },
  info: { flex: 1, gap: 5 },
  label: { color: theme.colors.text.primary, fontSize: 12, fontWeight: '600', letterSpacing: 1 },
  caption: { color: theme.colors.text.secondary, fontSize: 11 },
  action: { color: theme.colors.brand.primary, fontSize: 12 },
  copyAll: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8 },
  content: { padding: 16 },
  code: { fontFamily: 'monospace', fontSize: 12, lineHeight: 20, color: theme.colors.text.primary },
});
