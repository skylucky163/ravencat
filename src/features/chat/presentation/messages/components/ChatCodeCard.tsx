/** 列表只排版有界源码摘要；网页和完整源码只在独立页面挂载。 */
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRecyclingState } from '@shopify/flash-list';
import { ChevronRight, Code2, Globe2 } from 'lucide-react-native';
import { useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import { showAppDialog } from '@shared/ui';
import { prepareChatCodePreview } from '../../../messages/application/ChatCodePreview';
import { canRenderChatCode, chatCodeTitle, type ChatCodeBlock } from '../../../messages/domain/ChatCodeBlock';
import { useOpenChatCodePreview } from './ChatCodeNavigation';

export default function ChatCodeCard({ block, previewId, sourceMessageId, agentId, generating, onLongPress }: {
  block: ChatCodeBlock;
  previewId: string;
  sourceMessageId: number | null;
  agentId: string | null;
  generating: boolean;
  onLongPress?: (position: { x: number; y: number }) => void;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const openPreview = useOpenChatCodePreview();
  const [opening, setOpening] = useRecyclingState(false, [previewId]);
  const renderable = canRenderChatCode(block);
  // 先截字符再取行，超长单行也不能让原生 Text 布局整份源码。
  const excerpt = useMemo(() => block.source.slice(0, 420).split(/\r?\n/).slice(0, 4).join('\n'), [block.source]);
  const ready = block.complete && !generating;
  const open = async () => {
    setOpening(true);
    try {
      await prepareChatCodePreview(previewId, block, sourceMessageId, agentId);
      openPreview(previewId);
    } catch (error) {
      showAppDialog({ title: '打开代码失败', message: error instanceof Error ? error.message : '无法读取代码', tone: 'error' });
    } finally {
      setOpening(false);
    }
  };
  const Icon = renderable ? Globe2 : Code2;
  return <Pressable accessibilityRole="button" accessibilityLabel={ready ? `打开${chatCodeTitle(block)}` : '代码尚未生成完整'}
    accessibilityState={{ disabled: !ready || opening, busy: opening }}
    onPress={ready && !opening ? () => { void open(); } : undefined}
    onLongPress={onLongPress ? event => onLongPress({ x: event.nativeEvent.pageX, y: event.nativeEvent.pageY }) : undefined}
    style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
    <View style={styles.header}>
      <View style={styles.icon}><Icon size={19} color={theme.colors.brand.primary} /></View>
      <View style={styles.heading}><Text numberOfLines={1} style={styles.title}>{chatCodeTitle(block)}</Text>
        <Text style={styles.subtitle}>{(block.language || 'CODE').toUpperCase()} · {block.source.length.toLocaleString()} 字符</Text></View>
      <ChevronRight size={17} color={theme.colors.text.secondary} />
    </View>
    <View style={styles.excerpt}><Text numberOfLines={4} style={styles.code}>{excerpt || '…'}</Text></View>
    <View style={styles.footer}><View style={[styles.dot, !ready && styles.pendingDot]} />
      <Text style={styles.status}>{opening ? '正在打开' : generating ? '正在生成代码' : !block.complete ? '代码未完成' : renderable ? '点击打开网页' : '点击查看源码'}</Text>
      <Text style={styles.badge}>{renderable ? '网页预览' : '源码'}</Text>
    </View>
  </Pressable>;
}

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  card: { width: 280, maxWidth: '100%', flexShrink: 1, borderRadius: theme.radius.lg, overflow: 'hidden',
    backgroundColor: theme.effects.glass.enabled ? 'transparent' : theme.colors.surface.default,
    borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border.light },
  pressed: { opacity: 0.75 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14 },
  icon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.background.screen },
  heading: { flex: 1, gap: 4 },
  title: { color: theme.colors.text.primary, fontSize: 14, fontWeight: '600' },
  subtitle: { color: theme.colors.text.secondary, fontSize: 10, letterSpacing: 0.5 },
  excerpt: { marginHorizontal: 14, borderRadius: 8, padding: 10, height: 92, backgroundColor: theme.colors.background.screen, overflow: 'hidden' },
  code: { color: theme.colors.text.secondary, fontFamily: 'monospace', fontSize: 11, lineHeight: 18 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 14 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: theme.colors.brand.primary },
  pendingDot: { backgroundColor: theme.colors.text.secondary },
  status: { flex: 1, color: theme.colors.text.secondary, fontSize: 11 },
  badge: { fontSize: 10, color: theme.colors.brand.primary },
});
