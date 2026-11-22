/** 回收站只管理助手生命周期，不打开被隐藏的业务空间。 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { RotateCcw, Trash2 } from 'lucide-react-native';
import { ThemedSurface, useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import { AIAvatar, showAppDialog } from '@shared/ui';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { getAssistantDisplayName } from '../../AssistantNickname';
import { listRecycledAIAssistants, permanentlyDeleteAIAssistant, purgeExpiredAIAssistants,
  restoreAIAssistant, subscribeAssistantLifecycleChanged } from '../../AIAssistantManagement';
import type { RecycledAssistant } from '../../domain/AssistantRecycleBin';

const HELP_SECTIONS = [
  { title: '保留期限', body: 'AI 与它的单聊、记忆、通话记录、自己的朋友圈在回收站保留 7 天，到期自动彻底删除。期间它从列表和设置入口隐藏，不再参与群聊发言、主动消息和通话。重复删除不重新计时，从备份恢复后仍按原删除时间计算。' },
  { title: '恢复', body: '恢复沿用回收前的身份与资料，单聊、记忆、通话记录和自己的朋友圈重新出现，之后的新聊天正常参与。回收前未完成的回复、群聊发言和主动任务不会重放。' },
  { title: '角色与知情', body: '回收会移除主理 AI 和记账 AI 的任命，恢复后需重新指派，不会覆盖现有任命。主理冷静期在回收期间照常计时；原主理恢复后仍可使用已授权的解除工具，再由你重新任命。回收和恢复会作为操作记录进入 AI 后续的聊天上下文。' },
  { title: '彻底删除', body: '立即清除它的资料、单聊、记忆、通话记录及自己的朋友圈，无法恢复。群聊历史、分享快照和它在别人朋友圈里的互动会保留。' },
] as const;

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background.screen },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
  description: { fontSize: 14, lineHeight: 22, color: theme.colors.text.secondary },
  card: { borderRadius: theme.radius.lg, padding: theme.spacing.lg, gap: theme.spacing.md },
  identity: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
  details: { flex: 1, gap: theme.spacing.xs },
  title: { fontSize: 16, fontWeight: '600', color: theme.colors.text.primary },
  actions: { flexDirection: 'row', gap: theme.spacing.lg, justifyContent: 'flex-end' },
  action: { minHeight: 44, flexDirection: 'row', gap: theme.spacing.sm, alignItems: 'center', paddingHorizontal: theme.spacing.sm },
  restore: { color: theme.colors.brand.primary, fontSize: 14 },
  danger: { color: theme.colors.feedback.error, fontSize: 14 },
  empty: { textAlign: 'center', paddingVertical: theme.spacing.xxl, color: theme.colors.text.secondary },
});

export default function AIRecycleBinScreen({ onBack }: { onBack(): void }) {
  const styles = useThemedStyles(createStyles);
  const theme = useTheme();
  const [items, setItems] = useState<RecycledAssistant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useRef(false);
  const revision = useRef(0);
  const reload = useCallback(async () => {
    const current = ++revision.current;
    try {
      const records = await listRecycledAIAssistants();
      if (current !== revision.current) return;
      setItems(records);
      setError(null);
    } catch (cause) {
      if (current === revision.current) setError(cause instanceof Error ? cause.message : '读取回收站失败');
    } finally { if (current === revision.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void reload();
    const unsubscribe = subscribeAssistantLifecycleChanged(() => { void reload(); });
    return unsubscribe;
  }, [reload]);

  const run = async (action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    try { await action(); }
    catch (cause) { showAppDialog({ title: '操作失败', message: cause instanceof Error ? cause.message : '请稍后再试', tone: 'error' }); }
    finally { await reload(); operation.current = false; setBusy(false); }
  };
  const confirmRestore = (item: RecycledAssistant) => showAppDialog({
    title: '恢复 AI 身份',
    message: `恢复「${getAssistantDisplayName(item)}」的身份和全部资料？\n单聊、记忆、通话记录和自己的朋友圈会重新出现。主理 AI 和记账 AI 的任命不自动恢复，已有冷静期继续计时。回收前未完成的回复和主动任务不会重放。`,
    buttons: [{ text: '取消', style: 'cancel' }, { text: '恢复',
      onPress: () => run(async () => {
        if (!await restoreAIAssistant(item.id)) {
          await purgeExpiredAIAssistants();
          showAppDialog({ title: '无法恢复', message: '这个 AI 已超过 7 天保留期或已被彻底删除。', tone: 'warning' });
        }
      }) }],
  });
  const confirmDelete = (item: RecycledAssistant) => showAppDialog({
    title: '彻底删除 AI',
    message: `将永久清除「${getAssistantDisplayName(item)}」的资料、单聊、记忆、通话记录及自己的朋友圈，无法恢复。\n群聊历史、分享快照和它在别人朋友圈里的互动会保留。`,
    buttons: [{ text: '取消', style: 'cancel' }, { text: '彻底删除', style: 'destructive',
      onPress: () => run(async () => { await permanentlyDeleteAIAssistant(item.id); }) }],
  });
  return <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
    <NavigationHeader title="AI 回收站" onGoBack={onBack} help={{ sections: HELP_SECTIONS }} />
    <ScrollView contentContainerStyle={styles.content}>
      {loading ? <ActivityIndicator color={theme.colors.brand.primary} /> : null}
      {error ? <TouchableOpacity onPress={() => { void reload(); }} accessibilityRole="button"><Text style={styles.danger}>{error}，点击重试</Text></TouchableOpacity> : null}
      {!loading && !error && items.length === 0 ? <Text style={styles.empty}>AI 回收站是空的</Text> : null}
      {items.map(item => <ThemedSurface key={item.id} variant="card" style={styles.card}>
        <View style={styles.identity}>
          <AIAvatar name={getAssistantDisplayName(item)} avatarUrl={item.avatar} size="medium" />
          <View style={styles.details}>
            <Text style={styles.title}>{getAssistantDisplayName(item)}</Text>
            <Text style={styles.description}>{new Date(item.expiresAt).toLocaleString()} 后自动删除</Text>
          </View>
        </View>
        <View style={styles.actions}>
          <TouchableOpacity style={styles.action} disabled={busy} onPress={() => confirmRestore(item)} accessibilityRole="button" accessibilityLabel={`恢复${getAssistantDisplayName(item)}`} accessibilityState={{ disabled: busy }}>
            <RotateCcw size={18} color={theme.colors.brand.primary} /><Text style={styles.restore}>恢复</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.action} disabled={busy} onPress={() => confirmDelete(item)} accessibilityRole="button" accessibilityLabel={`彻底删除${getAssistantDisplayName(item)}`} accessibilityState={{ disabled: busy }}>
            <Trash2 size={18} color={theme.colors.feedback.error} /><Text style={styles.danger}>彻底删除</Text>
          </TouchableOpacity>
        </View>
      </ThemedSurface>)}
    </ScrollView>
  </SafeAreaView>;
}
