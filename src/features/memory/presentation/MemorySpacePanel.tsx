/** 面板复用 Memory 的查询和命令，星空不拥有记忆事实或路由。 */
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { Check, ChevronRight, Plus, Search, X } from 'lucide-react-native';
import { AppTextInput, ModalSheet, ToggleField } from '@shared/ui';
import { useTheme, useThemedStyles } from '@shared/theme';
import { normalizeMemoryText, memorySearchText } from '../domain/Memory';
import { addMemoryTrigger } from '../application/MemoryCommands';
import type { MemoryManagementSnapshot } from '../application/MemoryQueries';
import { createMemoryGalaxyStyles } from './memoryGalaxyStyles';

export default function MemorySpacePanel({ visible, snapshot, error, busy, refreshing, refresh, onClose, onCreateMemory, onEditMemory, onOpenTrigger, run }: {
  visible: boolean; snapshot: MemoryManagementSnapshot | null; error: string | null; busy: boolean; refreshing: boolean;
  refresh(): void; onClose(): void; onCreateMemory(assistantId: string): void;
  onEditMemory(assistantId: string, memoryId: string): void;
  onOpenTrigger(assistantId: string, triggerId: string): void;
  run(operation: () => Promise<unknown>): Promise<void>;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(createMemoryGalaxyStyles);
  const secondaryColor = styles.meta.color;
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'entries' | 'triggers'>('entries');
  const [triggerInput, setTriggerInput] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [selectedMemoryIds, setSelectedMemoryIds] = useState<string[]>([]);
  const [autoAssociate, setAutoAssociate] = useState(false);
  const selected = snapshot?.selectedSpace;
  useEffect(() => {
    setCreatingGroup(false); setTriggerInput(''); setSelectedMemoryIds([]); setAutoAssociate(false); setQuery('');
  }, [selected?.poolId]);
  const filtered = useMemo(() => {
    const normalized = normalizeMemoryText(query);
    return snapshot?.entries.filter(entry => normalizeMemoryText(memorySearchText(entry)).includes(normalized)) ?? [];
  }, [snapshot, query]);

  return <ModalSheet visible={visible} onClose={onClose} style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.sheetHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.sheetName}>{selected ? selected.assistantName : '记忆空间'}</Text>
            {snapshot && <Text style={styles.sheetMeta}>{snapshot.entries.length} 段记忆 · {snapshot.triggers.length} 个关联组{selected?.isHost ? ' · 主理' : ''}</Text>}
          </View>
          {selected && tab === 'entries' && <Pressable accessibilityRole="button" accessibilityLabel="新建记忆" style={styles.sheetButton} disabled={busy} onPress={() => onCreateMemory(selected.assistantId)}><Plus size={24} color={theme.colors.brand.primary} /></Pressable>}
          <Pressable accessibilityRole="button" accessibilityLabel="收起记忆面板" style={styles.sheetButton} onPress={onClose}><X size={20} color={secondaryColor} /></Pressable>
        </View>
        {error && <><Text style={styles.error}>{error}</Text><Pressable accessibilityRole="button" accessibilityLabel="重新读取记忆" onPress={refresh}><Text style={[styles.activeTabText, { textAlign: 'center' }]}>重新读取</Text></Pressable></>}
        {!snapshot && !error && <ActivityIndicator color={theme.colors.brand.primary} />}
        {snapshot && selected && <>
          <View style={styles.tabs}>
            {(['entries', 'triggers'] as const).map(value => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: tab === value }} style={[styles.tab, tab === value && styles.selectedTab]} onPress={() => setTab(value)}><Text style={tab === value ? styles.activeTabText : styles.tabText}>{value === 'entries' ? '记忆' : '触发词'}</Text></Pressable>)}
          </View>
          {tab === 'entries' ? <>
            <View style={styles.search}><Search size={17} color={secondaryColor} /><AppTextInput accessibilityLabel="查找记忆里的文字" style={styles.input} value={query} onChangeText={setQuery} placeholder="查找记忆里的文字" placeholderTextColor={secondaryColor} /></View>
            {!snapshot.embeddingEnabled && <Text style={styles.description}>记忆向量化已关闭，可在记忆设置中开启后逐条请求。</Text>}
            <FlatList key="entries" data={filtered} keyExtractor={entry => entry.id} contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled" refreshing={refreshing} onRefresh={refresh} initialNumToRender={8} maxToRenderPerBatch={8} windowSize={5}
              renderItem={({ item: entry }) => <View style={styles.card}>
                <Pressable accessibilityRole="button" style={{ gap: theme.spacing.md }} disabled={busy} onPress={() => onEditMemory(selected.assistantId, entry.id)}>
                {entry.summary && <Text style={styles.meta} numberOfLines={2}>{entry.summary}</Text>}
                <Text style={styles.body} numberOfLines={4}>{entry.content}</Text>
                <View style={styles.row}><Text style={styles.meta}>{new Date(entry.rememberedAt).toLocaleDateString()}{entry.embeddingStatus === 'failed' ? ' · 向量更新失败' : ''}</Text><ChevronRight size={16} color={secondaryColor} /></View>
                </Pressable>
              </View>}
              ListEmptyComponent={<Text style={styles.meta}>{query ? '没有包含这些文字的记忆。' : '这里还没有记忆。点右上角加号，留下第一件重要的事。'}</Text>} />
          </> : <>
            {creatingGroup ? <FlatList key="create-group" data={filtered} keyExtractor={entry => entry.id} contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled" initialNumToRender={8} maxToRenderPerBatch={8} windowSize={5}
              ListHeaderComponent={<View style={{ gap: 12 }}>
                <Text style={styles.body}>新建关联组</Text>
                <Text style={styles.meta}>多个词用逗号、顿号、分号或换行分隔。命中任一词，带入本组开启的记忆；相同词可以出现在其他组。</Text>
                <AppTextInput multiline accessibilityLabel="关联组的触发词" style={styles.groupInput} value={triggerInput} onChangeText={setTriggerInput} editable={!busy} placeholder="chatgpt、openai的ai、codex" placeholderTextColor={secondaryColor} />
                <ToggleField layout="inline" rowStyle={styles.row} label="自动关联包含触发词的记忆" disabled={busy} value={autoAssociate} onValueChange={setAutoAssociate}>
                  <Text style={[styles.meta, { flex: 1 }]}>自动关联正文或摘要含任一词的记忆</Text>
                </ToggleField>
                <Text style={styles.meta}>选择关联记忆（已选 {selectedMemoryIds.length} 条）</Text>
                <AppTextInput accessibilityLabel="查找要关联的记忆" style={styles.groupInput} value={query} onChangeText={setQuery} placeholder="查找记忆" placeholderTextColor={secondaryColor} />
                <View style={styles.row}>
                  <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setCreatingGroup(false); setQuery(''); }}><Text style={styles.activeTabText}>取消</Text></Pressable>
                  <Pressable accessibilityRole="button" style={(busy || !triggerInput.trim() || (!autoAssociate && !selectedMemoryIds.length)) && styles.disabled} disabled={busy || !triggerInput.trim() || (!autoAssociate && !selectedMemoryIds.length)} onPress={() => { void run(async () => {
                    await addMemoryTrigger(selected.assistantId, triggerInput, selectedMemoryIds, autoAssociate);
                    setCreatingGroup(false); setTriggerInput(''); setSelectedMemoryIds([]); setAutoAssociate(false); setQuery('');
                  }); }}><Text style={styles.activeTabText}>{busy ? '保存中…' : '保存关联组'}</Text></Pressable>
                </View>
              </View>}
              renderItem={({ item: entry }) => <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selectedMemoryIds.includes(entry.id) }} disabled={busy} style={styles.card} onPress={() => setSelectedMemoryIds(ids => ids.includes(entry.id) ? ids.filter(id => id !== entry.id) : [...ids, entry.id])}>
                <View style={styles.row}><Text style={[styles.body, { flex: 1 }]} numberOfLines={3}>{entry.summary ?? entry.content}</Text>{selectedMemoryIds.includes(entry.id) && <Check size={20} color={theme.colors.brand.primary} />}</View>
                {entry.summary && <Text style={styles.meta} numberOfLines={3}>{entry.content}</Text>}
              </Pressable>}
              ListEmptyComponent={<Text style={styles.meta}>{query ? '没有匹配的记忆。' : '先添加记忆，再建立关联组。'}</Text>} /> : <>
            <Text style={styles.description}>每个组可有多个词和多条记忆。命中任一词，带入该组开启的记忆；同名词可命中多个组，同一条记忆只带入一次。</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="新建关联组" disabled={busy} style={styles.tabs} onPress={() => { setCreatingGroup(true); setQuery(''); }}><Plus size={20} color={theme.colors.brand.primary} /><Text style={styles.activeTabText}>新建关联组</Text></Pressable>
            <FlatList key="triggers" data={snapshot.triggers} keyExtractor={trigger => trigger.id} contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled" refreshing={refreshing} onRefresh={refresh} initialNumToRender={8} maxToRenderPerBatch={8} windowSize={5}
              renderItem={({ item: trigger }) => <Pressable accessibilityRole="button" disabled={busy} style={styles.card} onPress={() => onOpenTrigger(selected.assistantId, trigger.id)}><View style={styles.row}><View style={{ flex: 1 }}><Text style={styles.body}>{trigger.keywords.map(word => word.keyword).join('、')}</Text><Text style={styles.meta}>已关联 {trigger.associatedCount} 条记忆 · {trigger.enabledCount} 条自动带入</Text></View><ChevronRight size={18} color={secondaryColor} /></View></Pressable>}
              ListEmptyComponent={<Text style={styles.meta}>添加一个关联组，让有关的记忆在聊天时浮现。</Text>} />
            </>}
          </>}
        </>}
  </ModalSheet>;
}
