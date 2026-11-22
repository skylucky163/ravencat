/** 独立原文窗口按 canonical 顺序读取，查看搜索语境不改聊天列表与摘要进度。 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import { NavigationHeader } from '@shared/ui';
import { readConversationMessageContext } from '../../messages/application/ReadChatMessageContext';
import type { ChatMessageContext } from '../../messages/domain/ChatMessageContext';
import type { FilePreviewParams } from '../shell/chatScreenTypes';
import AttachmentCard from './MessageBubble/AttachmentCard';
import FilePreview from './FilePreview';

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background.screen },
  card: { marginHorizontal: theme.spacing.md, marginBottom: theme.spacing.sm, padding: theme.spacing.md, borderRadius: theme.radius.lg, backgroundColor: theme.colors.surface.default, borderWidth: 1, borderColor: 'transparent' },
  anchor: { borderColor: theme.colors.brand.primary },
  author: { color: theme.colors.text.primary, fontWeight: '600', marginBottom: 6 },
  date: { color: theme.colors.text.secondary, fontSize: 12, marginBottom: 8 },
  text: { color: theme.colors.text.primary, fontSize: 15, lineHeight: 24 },
  button: { padding: theme.spacing.md, alignItems: 'center' },
  action: { color: theme.colors.brand.primary },
  status: { padding: theme.spacing.md, color: theme.colors.text.secondary, textAlign: 'center' },
  error: { padding: theme.spacing.md, color: theme.colors.feedback.error, textAlign: 'center' },
});

export default function ChatMessageContextScreen({ conversationId, messageId, onBack }: {
  conversationId: string; messageId: number; onBack(): void;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const [context, setContext] = useState<ChatMessageContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<FilePreviewParams | null>(null);
  const request = useRef({ revision: 0, pending: false }).current;
  const list = useRef<FlatList>(null);
  const load = useCallback(async (anchorId: number, before = 10, after = 10) => {
    if (request.pending) return;
    const revision = ++request.revision;
    request.pending = true;
    setLoading(true);
    setError(null);
    try {
      const result = await readConversationMessageContext(conversationId, { messageId: anchorId, before, after });
      if (revision !== request.revision) return;
      setContext(result);
      list.current?.scrollToOffset({ offset: 0, animated: false });
    } catch (cause) {
      if (revision === request.revision) setError(cause instanceof Error ? cause.message : '读取聊天记录失败');
    } finally {
      if (revision === request.revision) { request.pending = false; setLoading(false); }
    }
  }, [conversationId, request]);
  useEffect(() => {
    void load(messageId);
    return () => { request.revision++; request.pending = false; };
  }, [load, messageId, request]);

  return <SafeAreaView style={styles.container} edges={['top', 'bottom', 'left', 'right']}>
    <NavigationHeader title="聊天记录上下文" onGoBack={onBack} />
    <FlatList ref={list} data={context?.entries ?? []} keyExtractor={item => String(item.messageId)}
      ListHeaderComponent={<View>
        <Text style={styles.status}>按聊天顺序展示 · 边框标记搜索命中的消息</Text>
        {context?.hasMoreBefore && <TouchableOpacity style={styles.button} disabled={loading} onPress={() => void load(context.entries[0].messageId, 20, 0)}><Text style={styles.action}>查看更早的消息</Text></TouchableOpacity>}
      </View>}
      renderItem={({ item }) => <View style={[styles.card, item.messageId === messageId && styles.anchor]}>
        <Text style={styles.author}>{item.author.role === 'user' ? '我' : item.author.name}{item.messageId === messageId ? ' · 搜索结果' : ''}</Text>
        <Text style={styles.date}>{new Date(item.createdAt).toLocaleString()}</Text>
        {item.text ? <Text style={styles.text} selectable>{item.text}</Text> : null}
        {item.userAttachments?.map(attachment => <AttachmentCard key={attachment.id} attachment={attachment}
          isMe={item.author.role === 'user'} onPreview={setFile} />)}
      </View>}
      ListEmptyComponent={!loading && !error ? <Text style={styles.status}>这条消息已删除或不再可见</Text> : null}
      ListFooterComponent={<View>
        {loading && <ActivityIndicator color={theme.colors.brand.primary} />}
        {error && <TouchableOpacity style={styles.button} onPress={() => void load(messageId)}><Text style={styles.error}>{error}，点击重试</Text></TouchableOpacity>}
        {context?.hasMoreAfter && <TouchableOpacity style={styles.button} disabled={loading} onPress={() => void load(context.entries[context.entries.length - 1].messageId, 0, 20)}><Text style={styles.action}>查看更晚的消息</Text></TouchableOpacity>}
        {context && <TouchableOpacity style={styles.button} disabled={loading} onPress={() => void load(messageId)}><Text style={styles.action}>回到搜索结果</Text></TouchableOpacity>}
      </View>}
    />
    {file && <Modal visible animationType="slide" onRequestClose={() => setFile(null)}>
      <FilePreview {...file} onBack={() => setFile(null)} />
    </Modal>}
  </SafeAreaView>;
}
