/** 二级集中展示，一级列表只显示尚未归纳的记录；已归纳来源留在二级编辑页。 */
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { ChevronRight, Settings } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import { HeaderAddButton, NavigationHeader, showAppDialog } from '@shared/ui';
import { createChatSummaryStyles } from './chatSummaryStyles';
import { clearChatSummary } from '../application/ChatSummary';
import { useChatSummarySnapshot } from './useChatSummarySnapshot';
import type { ChatSummarySegment, ChatSummaryTask } from '../domain/ChatSummaryRepository';

type Entry = { kind: 'summary'; value: ChatSummarySegment } | { kind: 'task'; value: ChatSummaryTask };
export default function ChatSummaryScreen({ conversationId, onBack, onCreateSummary, onEditSummary, onEditSecondary, onTask, onSettings }: {
  conversationId: string; onBack(): void; onCreateSummary(): void; onEditSummary(segmentId: string): void;
  onEditSecondary(): void; onTask(taskId: string): void; onSettings(): void;
}) {
  const theme = useTheme(), styles = useThemedStyles(createChatSummaryStyles);
  const { snapshot, error } = useChatSummarySnapshot(conversationId);
  const [clearing, setClearing] = useState(false);
  const secondary = snapshot ? snapshot.segments.filter((value) => value.level === 'secondary').sort((a, b) => a.contextSequence - b.contextSequence) : [];
  const archivedCount = snapshot?.segments.filter((value) => value.level === 'primary' && value.compactionId !== null).length ?? 0;
  const pending = snapshot?.segments.filter((value) => value.level === 'primary' && value.compactionId === null) ?? [];
  const tasks = snapshot?.tasks.filter((task) => task.status !== 'completed') ?? [];
  const primary: Entry[] = [
    ...pending.map((value): Entry => ({ kind: 'summary', value })),
    ...tasks.filter((value) => value.level === 'primary').map((value): Entry => ({ kind: 'task', value })),
  ].sort((a, b) => a.value.createdAt.localeCompare(b.value.createdAt) || a.value.id.localeCompare(b.value.id));
  const clear = () => showAppDialog({ title: '清空聊天摘要？', message: '删除全部摘要和任务记录，并从当前消息边界开始总结新消息。', buttons: [
    { text: '取消', style: 'cancel' }, { text: '清空摘要', style: 'destructive', onPress: async () => {
      setClearing(true);
      try { await clearChatSummary(conversationId); }
      catch (failure) { showAppDialog({ title: '清空失败', message: failure instanceof Error ? failure.message : '请稍后再试', tone: 'error' }); }
      finally { setClearing(false); }
    } },
  ] });
  const renderTask = (task: ChatSummaryTask, number: number) => <Pressable key={task.id} disabled={clearing} onPress={() => onTask(task.id)}>
    <ThemedSurface variant="card" nativeGlass={false} style={styles.card}>
      <Text style={task.error && task.status !== 'running' ? styles.danger : styles.cardTitle}>
        {task.level === 'secondary' ? '二级摘要' : '一级摘要'}{number}{task.status === 'running' ? '：生成中' : task.error ? '：失败，查看失败原因' : '：等待处理'}
      </Text>
      <Text style={styles.meta}>{task.nextAttemptAt ? '等待自动重试 · ' + new Date(task.nextAttemptAt).toLocaleString() : task.error?.message ?? '任务由会话队列执行'}</Text>
    </ThemedSurface>
  </Pressable>;
  return <SafeAreaView style={styles.screen}>
    <NavigationHeader title="聊天摘要" onGoBack={onBack} rightButton={<View style={styles.headerActions}>
      <HeaderAddButton variant="inline" style={styles.headerAction} accessibilityLabel="新增摘要" disabled={clearing} onPress={onCreateSummary} />
      <Pressable style={styles.headerAction} accessibilityLabel="摘要设置" onPress={onSettings}><Settings size={24} color={theme.colors.brand.primary} /></Pressable>
    </View>} />
    <ScrollView contentContainerStyle={styles.content}>
      {error && <Text style={styles.danger}>{error}</Text>}
      {!snapshot && !error && <ActivityIndicator color={theme.colors.brand.primary} />}
      {(secondary.length > 0 || archivedCount > 0) && <Pressable accessibilityLabel="编辑二级摘要" disabled={clearing} onPress={onEditSecondary}>
        <ThemedSurface variant="card" nativeGlass={false} style={styles.card}>
          <View style={styles.row}><Text style={styles.sectionLabel}>二级摘要</Text><ChevronRight size={16} color={theme.colors.text.secondary} /></View>
          <Text numberOfLines={6} style={styles.body}>{secondary.length ? secondary.map((value) => value.content).join('\n\n') : '暂无二级正文，原摘要仍可查看和编辑。'}</Text>
          <Text style={styles.meta}>集中编辑 · {archivedCount} 条原摘要</Text>
        </ThemedSurface>
      </Pressable>}
      {tasks.filter((task) => task.level === 'secondary').map((task, index) => renderTask(task, secondary.length + index + 1))}
      {snapshot && secondary.length === 0 && archivedCount === 0 && <Text style={styles.meta}>尚无二级摘要，一级记录达到阈值后会在这里归纳。</Text>}
      {snapshot && <View style={styles.group}>
        <Text style={styles.sectionLabel}>一级摘要 · 待归纳 {pending.length} 条</Text>
        {primary.map((entry, index) => entry.kind === 'task' ? renderTask(entry.value, index + 1) : <Pressable key={entry.value.id} disabled={clearing} onPress={() => onEditSummary(entry.value.id)}>
          <ThemedSurface variant="card" nativeGlass={false} style={styles.card}>
            <Text style={styles.meta}>保存于 {new Date(entry.value.createdAt).toLocaleString()}</Text>
            <Text numberOfLines={4} style={styles.body}>{entry.value.content}</Text>
          </ThemedSurface>
        </Pressable>)}
        {primary.length === 0 && <Text style={styles.meta}>暂无待归纳记录</Text>}
      </View>}
      {snapshot && (snapshot.segments.length > 0 || snapshot.tasks.length > 0) && <Pressable style={styles.textButton} disabled={clearing} onPress={clear}><Text style={styles.danger}>清空全部摘要及任务记录</Text></Pressable>}
    </ScrollView>
  </SafeAreaView>;
}
