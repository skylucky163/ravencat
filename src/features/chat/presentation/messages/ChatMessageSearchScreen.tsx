/** 单聊与群聊共用用户检索界面，查询覆盖全部仍可见的持久原文。 */
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Keyboard, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Search, Star, X } from 'lucide-react-native';
import { useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import { AppTextInput, KeyboardAvoidingContainer, NavigationHeader } from '@shared/ui';
import { searchConversationMessages } from '../../messages/application/SearchChatMessages';
import type { ChatSearchRecord, ChatMessageSearchPage } from '../../messages/domain/ChatMessageSearch';
import { useSearchResultFavorites } from './components/useSearchResultFavorites';

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background.screen },
  body: { flex: 1 },
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 8, margin: theme.spacing.md },
  input: { flex: 1, minHeight: 46, paddingHorizontal: 12, borderRadius: theme.radius.lg, backgroundColor: theme.colors.surface.default },
  button: { padding: 10 },
  action: { color: theme.colors.brand.primary, fontSize: 15 },
  status: { color: theme.colors.text.secondary, textAlign: 'center', padding: theme.spacing.md },
  card: { marginHorizontal: theme.spacing.md, marginBottom: theme.spacing.sm, padding: theme.spacing.md, borderRadius: theme.radius.lg, backgroundColor: theme.colors.surface.default },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  // 名称只占自身内容宽度并在过长时省略，星号始终紧跟其后；日期固定靠右。
  author: { flexShrink: 1, color: theme.colors.text.primary, fontWeight: '600' },
  metaFill: { flex: 1 },
  date: { color: theme.colors.text.secondary, fontSize: 12 },
  text: { color: theme.colors.text.primary, fontSize: 15, lineHeight: 23 },
  highlight: { color: theme.colors.brand.primary, fontWeight: '700' },
  error: { color: theme.colors.feedback.error, textAlign: 'center', padding: theme.spacing.md },
});

function excerpt(text: string, keyword: string) {
  const match = text.toLowerCase().indexOf(keyword.toLowerCase());
  const start = Math.max(0, match - 50);
  const end = Math.min(text.length, Math.max(start + 180, match + keyword.length + 50));
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export default function ChatMessageSearchScreen({ conversationId, sourceName, assistantId, onBack, onOpenMessage, onOpenCall }: {
  conversationId: string;
  sourceName: string;
  assistantId?: string;
  onBack(): void;
  onOpenMessage(messageId: number): void;
  onOpenCall?(callId: string): void;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const [query, setQuery] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState<ChatMessageSearchPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { favorites, toggle } = useSearchResultFavorites(page?.entries ?? null, sourceName, assistantId);
  // 输入变化、重新搜索和卸载撤销旧读取的展示资格，慢查询不能覆盖新结果。
  const request = useRef({ revision: 0, pending: false }).current;
  useEffect(() => () => { request.revision++; }, [request]);

  function changeQuery(value: string) {
    request.revision++;
    request.pending = false;
    setQuery(value);
    setKeyword('');
    setPage(null);
    setLoading(false);
    setError(null);
  }

  async function search(more = false) {
    const term = more ? keyword : query.trim();
    if (!term || request.pending || (more && page?.nextOffset == null)) return;
    const revision = ++request.revision;
    request.pending = true;
    setKeyword(term);
    setLoading(true);
    setError(null);
    if (!more) { setPage(null); Keyboard.dismiss(); }
    try {
      const result = await searchConversationMessages({ conversationId, keywords: [term], offset: more ? page!.nextOffset! : 0 });
      if (revision !== request.revision) return;
      setPage(previous => ({ entries: more ? [...previous!.entries, ...result.entries] : result.entries, nextOffset: result.nextOffset }));
    } catch (cause) {
      if (revision === request.revision) setError(cause instanceof Error ? cause.message : '搜索失败，请重试');
    } finally {
      if (revision === request.revision) { request.pending = false; setLoading(false); }
    }
  }

  function renderRecord({ item }: { item: ChatSearchRecord }) {
    const text = excerpt(item.text, keyword);
    const parts: React.ReactNode[] = [];
    const lower = text.toLowerCase(), needle = keyword.toLowerCase();
    let cursor = 0, match = lower.indexOf(needle);
    while (match >= 0) {
      parts.push(text.slice(cursor, match));
      parts.push(<Text key={match} style={styles.highlight}>{text.slice(match, match + keyword.length)}</Text>);
      cursor = match + keyword.length;
      match = lower.indexOf(needle, cursor);
    }
    parts.push(text.slice(cursor));
    const authorName = item.author.role === 'user' ? '我' : item.author.name;
    const message = 'messageId' in item ? item : null;
    const favorited = message !== null && favorites.has(message.messageId);
    const openResult = 'messageId' in item ? () => onOpenMessage(item.messageId) : () => onOpenCall?.(item.callId);
    return <TouchableOpacity style={styles.card} onPress={openResult} accessibilityRole="button" accessibilityLabel={message ? `查看${item.author.name}的消息上下文` : '查看通话记录'}>
      <View style={styles.meta}>
        <Text style={styles.author} numberOfLines={1}>{authorName}{message ? message.callId && ' · 通话状态' : ' · 通话内容'}</Text>
        {message?.canFavorite ? <TouchableOpacity hitSlop={10} accessibilityRole="button"
          accessibilityLabel={favorited ? `取消收藏${authorName}的这条消息` : `收藏${authorName}的这条消息`}
          accessibilityState={{ selected: favorited }} onPress={() => void toggle(message)}>
          <Star size={18} color={favorited ? theme.colors.brand.primary : theme.colors.icon.secondary}
            fill={favorited ? theme.colors.brand.primary : 'none'} />
        </TouchableOpacity> : null}
        <View style={styles.metaFill} />
        <Text style={styles.date}>{new Date(item.createdAt).toLocaleString()}</Text>
      </View>
      <Text style={styles.text} numberOfLines={4}>{parts}</Text>
      {message?.attachments?.map(attachment => <Text key={attachment.attachmentId} style={styles.text}>{attachment.fileName}</Text>)}
    </TouchableOpacity>;
  }

  return <SafeAreaView style={styles.container} edges={['top', 'bottom', 'left', 'right']}>
    <NavigationHeader title="搜索聊天记录" onGoBack={onBack} />
    <KeyboardAvoidingContainer style={styles.body}>
      <View style={styles.searchBar}>
        <Search size={20} color={theme.colors.text.secondary} />
        <AppTextInput style={styles.input} value={query} onChangeText={changeQuery} placeholder="输入聊天关键词" accessibilityLabel="聊天记录关键词" returnKeyType="search" onSubmitEditing={() => void search()} autoFocus />
        {query.length > 0 && <TouchableOpacity style={styles.button} onPress={() => changeQuery('')} accessibilityLabel="清空关键词"><X size={18} color={theme.colors.text.secondary} /></TouchableOpacity>}
        <TouchableOpacity style={styles.button} onPress={() => void search()} disabled={!query.trim() || loading} accessibilityRole="button"><Text style={styles.action}>搜索</Text></TouchableOpacity>
      </View>
      <FlatList data={page?.entries ?? []} keyExtractor={item => 'messageId' in item ? String(item.messageId) : `call:${item.entryId}`} renderItem={renderRecord} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
        ListHeaderComponent={page && page.entries.length > 0 ? <Text style={styles.status}>已找到 {page.entries.length} 条{page.nextOffset !== null ? '，可继续加载' : ''} · 点击查看上下文</Text> : null}
        ListEmptyComponent={!loading && !error ? <Text style={styles.status}>{page ? '没有找到相关聊天记录' : '搜索当前会话的全部可见聊天记录'}</Text> : null}
        ListFooterComponent={<View>
          {loading && <ActivityIndicator color={theme.colors.brand.primary} />}
          {error && <Text style={styles.error}>{error}</Text>}
          {!loading && (error || page?.nextOffset != null) && <TouchableOpacity style={styles.button} onPress={() => void search(page !== null)}><Text style={[styles.action, { textAlign: 'center' }]}>{error ? '重试' : '加载更多'}</Text></TouchableOpacity>}
        </View>}
      />
    </KeyboardAvoidingContainer>
  </SafeAreaView>;
}
