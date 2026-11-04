/** 召回设置与全局向量模型选择集中在记忆设置入口。 */
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { ACTIVE_RECALL_PAGE_SIZE_OPTIONS, PASSIVE_RECALL_LIMIT_OPTIONS } from '../domain/Memory';
import { setMemoryRecallSettings } from '../application/MemoryCommands';
import { clearMemoryEmbeddings, setMemoryEmbeddingEnabled, getMemoryEmbeddingIndexStatus, rebuildMemoryEmbeddingIndex } from '../application/MemoryEmbeddingModels';
import MemoryEmbeddingModelPicker from './MemoryEmbeddingModelPicker';
import { useTheme, useThemedStyles } from '@shared/theme';
import { NavigationHeader, ToggleField, useBusyBackHandler, showAppDialog } from '@shared/ui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createMemoryScreenStyles } from './memoryScreenStyles';
import useMemoryManagementSnapshot from './useMemoryManagementSnapshot';

const SETTINGS_HELP = { sections: [
  { title: '自动带入数量', body: '只带入本次输入命中触发词的记忆。设为 0 可关闭自动带入。' },
  { title: '主动查询每页条数', body: '控制 AI 每次查询返回的记忆数量，AI 可以继续翻页读取完整结果。' },
  { title: '记忆向量化', body: '所有记忆空间共用开关与模型。更换模型或重新开启不会自动重建已有记忆；仍匹配模型与正文版本的旧向量直接恢复使用。每条记忆都可单独请求向量化，不要求整批重建。新增或编辑仍只生成对应条目的向量。关闭不影响正文、关键词检索与触发词自动带入。' },
  { title: '重建索引', body: '手动确认后为全部记忆生成新向量；全部成功且模型与记忆内容未变化时，才一次性替换。失败、取消或退出应用保留旧索引，未发布的结果需要重新生成。' },
  { title: '清除已有向量', body: '主动删除全部空间的向量与任务状态，保留模型选择、正文、摘要和触发关系；不会立即重建。' },
] };

export default function MemorySettingsScreen({ assistantId, onBack }: {
  assistantId?: string; onBack(): void;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(createMemoryScreenStyles);
  const { snapshot, error } = useMemoryManagementSnapshot(assistantId);
  const selected = snapshot?.selectedSpace;
  const [busy, setBusy] = useState(false);
  const rebuildController = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState('');
  const [indexStatus, setIndexStatus] = useState<{ total: number; valid: number } | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  useEffect(() => () => rebuildController.current?.abort(), []);
  useEffect(() => {
    let current = true;
    void getMemoryEmbeddingIndexStatus().then(status => { if (current) { setIndexStatus(status); setIndexError(null); } }).catch(failure => { if (current) setIndexError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { current = false; };
  }, [snapshot]);
  useBusyBackHandler(busy);
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try { await operation(); }
    catch (failure) { showAppDialog({ title: '操作失败', message: failure instanceof Error ? failure.message : '请稍后重试', tone: 'error' }); }
    finally { setBusy(false); }
  };
  return <SafeAreaView style={styles.screen}>
    <NavigationHeader title="记忆设置" help={SETTINGS_HELP} onGoBack={() => { if (!busy) onBack(); }} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      {error && <Text style={styles.danger}>{error}</Text>}
      {!snapshot && !error && <ActivityIndicator color={theme.colors.brand.primary} />}
      {selected && snapshot?.settings && <>

            <Text style={styles.label}>自动带入数量</Text>
            <View style={styles.wrap}>{PASSIVE_RECALL_LIMIT_OPTIONS.map((value) => <Pressable key={value} disabled={busy} style={[styles.chip, snapshot.settings!.passiveLimit === value && styles.selectedChip]} onPress={() => { void run(() => setMemoryRecallSettings(selected.assistantId, { ...snapshot.settings!, passiveLimit: value })); }}><Text style={styles.body}>{value}</Text></Pressable>)}</View>
            <Text style={styles.label}>主动查询每页条数</Text>
            <View style={styles.wrap}>{ACTIVE_RECALL_PAGE_SIZE_OPTIONS.map((value) => <Pressable key={value} disabled={busy} style={[styles.chip, snapshot.settings!.activePageSize === value && styles.selectedChip]} onPress={() => { void run(() => setMemoryRecallSettings(selected.assistantId, { ...snapshot.settings!, activePageSize: value })); }}><Text style={styles.body}>{value}</Text></Pressable>)}</View>

      </>}
      <View style={styles.divider} />
      {snapshot && <ToggleField layout="inline" rowStyle={styles.row} label="记忆向量化" value={snapshot.embeddingEnabled} disabled={busy}
        onValueChange={(enabled) => { void run(() => setMemoryEmbeddingEnabled(enabled)); }} />}
      <MemoryEmbeddingModelPicker disabled={busy} />
      <Text style={styles.meta}>更换模型不会自动重建。切回旧模型时，仍匹配模型与正文版本的旧向量会恢复使用；其他条目可逐条请求向量化。{indexStatus ? ` 当前有效 ${indexStatus.valid} / ${indexStatus.total} 条。` : ''}</Text>
      {indexError && <Text style={styles.danger}>{indexError}</Text>}
      <Pressable accessibilityRole="button" style={styles.button} disabled={busy} onPress={() => showAppDialog({
        title: '重建全部记忆索引？', message: '将使用当前模型请求全部记忆的新向量，可能产生 API 费用。全部成功后才替换旧索引；失败或取消保留旧数据。',
        buttons: [{ text: '取消', style: 'cancel' }, { text: '开始重建', onPress: () => {
          const controller = new AbortController(); rebuildController.current = controller;
          void run(async () => {
            try {
              await rebuildMemoryEmbeddingIndex(controller.signal, (completed, total) => setProgress(`重建中 ${completed} / ${total}`));
              showAppDialog({ title: '记忆索引已更新', message: '新向量已全部生成并完整替换旧索引。', tone: 'success' });
            } catch (failure) {
              if (!controller.signal.aborted) throw failure;
              showAppDialog({ title: '重建已取消', message: '未完成的新索引没有发布，旧索引保留。' });
            } finally { rebuildController.current = null; setProgress(''); }
          });
        } }],
      })}><Text style={styles.buttonText}>重建全部记忆索引</Text></Pressable>
      {progress !== '' && <>
        <Text style={styles.meta}>{progress}</Text>
        <Pressable accessibilityRole="button" onPress={() => rebuildController.current?.abort()}><Text style={styles.danger}>取消重建</Text></Pressable>
      </>}
      <Pressable accessibilityRole="button" disabled={busy} style={busy && styles.disabled} onPress={() => {
        showAppDialog({ title: '清除已有记忆向量？', message: '将清除所有记忆空间的已有向量与向量任务状态，保留开关、模型选择、正文、摘要和触发词。清除后不立即重建；可手动重建，开启时新增或编辑记忆只生成对应条目的向量。', buttons: [
          { text: '取消', style: 'cancel' }, { text: '清除向量', style: 'destructive', onPress: () => { void run(clearMemoryEmbeddings); } },
        ] });
      }}><Text style={styles.danger}>清除已有记忆向量</Text></Pressable>
    </ScrollView>
  </SafeAreaView>;
}
