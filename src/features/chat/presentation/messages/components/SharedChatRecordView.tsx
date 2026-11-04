/** 记录详情复用原附件与表情卡片，保持来源作者，不把历史工具状态做成操作按钮。 */
import React from 'react';
import { useRecyclingState } from '@shopify/flash-list';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessagesSquare } from 'lucide-react-native';
import { useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import type { SharedChatRecord } from '../../../messages/domain/SharedChatRecord';
import AttachmentCard from '../MessageBubble/AttachmentCard';
import StickerMessageCard from '../MessageBubble/StickerMessageCard';
import type { PreviewFileHandler } from '../MessageBubble/MessageBubbleContent';
import SharedMomentCard from './SharedMomentCard';

export function SharedChatRecordEntries({ record, onPreviewFile, preview = false, onOpenMoment }: { record: SharedChatRecord; onPreviewFile: PreviewFileHandler; preview?: boolean; onOpenMoment?: () => void }) {
  const styles = useThemedStyles(createStyles);
  return <View style={styles.entries}>
    {record.entries.map((entry, index) => <View key={index} style={styles.entry}>
      <Text style={styles.author}>{entry.author.name} · {entry.author.kind === 'user' ? '用户' : 'AI'}{entry.kind === 'tool_status' ? ' · 历史工具状态' : ''}</Text>
      <Text style={styles.time}>{new Date(entry.createdAt).toLocaleString()}</Text>
      {entry.text ? <Text selectable style={styles.text}>{entry.text}</Text> : null}
      {entry.moment ? <SharedMomentCard moment={entry.moment} preview={preview} onOpen={onOpenMoment} /> : null}
      {entry.sticker ? <StickerMessageCard sticker={entry.sticker} /> : null}
      {entry.attachments.map((attachment) => <AttachmentCard key={attachment.id} attachment={attachment} isMe={false} onPreview={onPreviewFile} />)}
    </View>)}
  </View>;
}

export default function SharedChatRecordCard({ messageId, record, comment, onPreviewFile, onLongPress }: {
  messageId?: number; record: SharedChatRecord; comment: string; onPreviewFile: PreviewFileHandler; onLongPress?: (position: { x: number; y: number }) => void;
}) {
  const [expanded, setExpanded] = useRecyclingState(false, [messageId]);
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  return <>
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="查看分享的聊天记录" onPress={() => setExpanded(true)} onLongPress={onLongPress ? (event) => onLongPress({ x: event.nativeEvent.pageX, y: event.nativeEvent.pageY }) : undefined} style={styles.card}>
      <MessagesSquare size={24} color={theme.colors.brand.primary} />
      <Text style={styles.author}>{record.sourceName}的聊天记录</Text>
      {record.entries.slice(0, 3).map((entry, index) => <Text key={index} numberOfLines={1} style={styles.text}>{entry.author.name}：{entry.text || (entry.moment ? `[时刻] ${entry.moment.author.displayName}：${entry.moment.content}` : entry.sticker ? `[表情：${entry.sticker.name}]` : '[附件]')}</Text>)}
      {comment ? <Text style={styles.text}>{comment}</Text> : null}
      <Text style={styles.time}>{record.selectionCount} 条消息 · 点击查看</Text>
    </TouchableOpacity>
    <Modal visible={expanded} animationType="slide" statusBarTranslucent navigationBarTranslucent onRequestClose={() => setExpanded(false)}>
      <View style={[styles.page, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.header}><Text style={styles.author}>{record.sourceName}的聊天记录</Text><TouchableOpacity onPress={() => setExpanded(false)} style={styles.close}><Text style={styles.link}>关闭</Text></TouchableOpacity></View>
        <ScrollView>{comment ? <Text style={[styles.text, styles.entries]}>附言：{comment}</Text> : null}<SharedChatRecordEntries record={record} onOpenMoment={() => setExpanded(false)} onPreviewFile={(params) => { setExpanded(false); onPreviewFile(params); }} /></ScrollView>
      </View>
    </Modal>
  </>;
}

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.colors.background.screen },
  // 分享消息外层保留玻璃材质，卡片白底会遮住它采样的会话背景。
  card: { padding: 12, gap: 6, backgroundColor: theme.effects.glass.enabled ? 'transparent' : theme.colors.surface.default, borderRadius: theme.effects.glass.enabled ? theme.radius.lg : 4, minWidth: 200, maxWidth: '100%', flexShrink: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, minHeight: 52, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border.light },
  close: { padding: 12 }, link: { color: theme.colors.brand.primary },
  entries: { padding: 16, gap: 16 },
  entry: { gap: 6, paddingBottom: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border.light },
  author: { color: theme.colors.text.primary, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  text: { color: theme.colors.text.primary, fontSize: 14, lineHeight: 21 },
  time: { color: theme.colors.text.secondary, fontSize: 12 },
});
