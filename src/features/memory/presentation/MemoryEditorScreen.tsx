/** 记忆正文编辑独立于列表路由，草稿不会随向量状态刷新而被覆盖。 */
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { MemoryEntry } from '../domain/Memory';
import { addMemoryTrigger, editMemory, forgetMemory, rememberMemory, retryMemoryEmbedding } from '../application/MemoryCommands';
import { useTheme, useThemedStyles } from '@shared/theme';
import { KeyboardAvoidingContainer, NavigationHeader, useBusyBackHandler, showAppDialog } from '@shared/ui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createMemoryScreenStyles } from './memoryScreenStyles';
import useMemoryManagementSnapshot from './useMemoryManagementSnapshot';
const STATUS_LABELS: Record<MemoryEntry['embeddingStatus'], string> = {
  not_requested: '未请求向量化 · 可按关键词检索', pending: '等待向量化', retry_wait: '等待自动重试',
  ready: '语义检索已就绪', stale: '等待更新向量', failed: '向量更新失败',
};
export default function MemoryEditorScreen({ assistantId, memoryId, onBack }: {
  assistantId: string; memoryId?: string; onBack(): void;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(createMemoryScreenStyles);
  const { snapshot, error } = useMemoryManagementSnapshot(assistantId);
  const selected = snapshot?.selectedSpace;
  const editing = memoryId !== undefined;
  const currentEditing = snapshot?.entries.find((entry) => entry.id === memoryId);
  const [content, setContent] = useState('');
  const [summary, setSummary] = useState('');
  const [triggerInput, setTriggerInput] = useState('');
  const [busy, setBusy] = useState(false);
  const initialized = useRef(false);
  useBusyBackHandler(busy);
  useEffect(() => {
    if (!snapshot || initialized.current) return;
    initialized.current = true;
    if (currentEditing) { setContent(currentEditing.content); setSummary(currentEditing.summary ?? ''); }
  }, [snapshot, currentEditing]);
  const count = Array.from(content.trim()).length;
  const summaryCount = Array.from(summary.trim()).length;
  const run = async (operation: () => Promise<unknown>, close = false) => {
    setBusy(true);
    try { await operation(); if (close) onBack(); }
    catch (failure) { showAppDialog({ title: '操作失败', message: failure instanceof Error ? failure.message : '请稍后重试', tone: 'error' }); }
    finally { setBusy(false); }
  };
  const confirmDelete = () => {
    showAppDialog({ title: '删除这条记忆？', message: '删除后将不再参与召回。', buttons: [
      { text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: () => { void run(() => forgetMemory(assistantId, memoryId!), true); } },
    ] });
  };
  return <SafeAreaView style={styles.screen}><KeyboardAvoidingContainer style={styles.screen}>
    <NavigationHeader title={editing ? '编辑记忆' : '新建记忆'} onGoBack={() => { if (!busy) onBack(); }} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      {error && <Text style={styles.danger}>{error}</Text>}
      {!snapshot && !error && <ActivityIndicator color={theme.colors.brand.primary} />}
      {snapshot && editing && !currentEditing && <Text style={styles.subtitle}>这条记忆已不存在。</Text>}
      {selected && (!editing || currentEditing) && <>

            <Text style={styles.meta}>{selected.assistantName} 的记忆空间</Text>
            <TextInput style={styles.input} value={summary} onChangeText={setSummary} editable={!busy} placeholder="摘要（选填，用于检索）" placeholderTextColor={theme.colors.text.tertiary} />
            <Text style={summaryCount > 50 ? styles.danger : styles.meta}>摘要 {summaryCount} / 50 字</Text>
            <TextInput multiline style={[styles.input, styles.editor]} value={content} onChangeText={setContent} editable={!busy} placeholder="写下值得记住的内容…" placeholderTextColor={theme.colors.text.tertiary} />
            <Text style={count > 500 ? styles.danger : styles.meta}>{count} / 500 字</Text>
            <Pressable style={[styles.button, (busy || !count || count > 500 || summaryCount > 50) && styles.disabled]} disabled={busy || !count || count > 500 || summaryCount > 50} onPress={() => { void run(() => editing ? editMemory(assistantId, memoryId!, content, summary) : rememberMemory(assistantId, content, null, summary), true); }}><Text style={styles.buttonText}>{busy ? '正在保存…' : '保存记忆'}</Text></Pressable>
            {editing && <>
              <View style={styles.card}>
                <Text style={styles.label}>为这条记忆新建关联组</Text>
                <Text style={styles.subtitle}>多个词用逗号、顿号、分号或换行分隔，保存为同一组。命中任一词即可带入这条记忆，也可在触发词页为本组添加其他记忆。</Text>
                <TextInput multiline accessibilityLabel="这条记忆的触发词" style={styles.input} value={triggerInput} onChangeText={setTriggerInput} editable={!busy} placeholder="例如：难过，心情不好，需要安慰" placeholderTextColor={theme.colors.text.tertiary} />
                <Pressable disabled={busy || !triggerInput.trim()} style={(busy || !triggerInput.trim()) && styles.disabled} onPress={() => { void run(async () => {
                  await addMemoryTrigger(assistantId, triggerInput, [memoryId!]);
                  setTriggerInput('');
                  showAppDialog({ title: '已创建关联组', message: '输入包含其中任一触发词时，这条记忆可自动带入。' });
                }); }}><Text style={styles.action}>添加并关联</Text></Pressable>
              </View>
              {currentEditing && <>
              <View style={styles.card}>
                <Text style={styles.meta}>记于 {new Date(currentEditing.rememberedAt).toLocaleString()}</Text>
                <Text style={styles.meta}>更新于 {new Date(currentEditing.updatedAt).toLocaleString()}</Text>
                <Text style={styles.meta}>{STATUS_LABELS[currentEditing.embeddingStatus]}{currentEditing.embeddingModelName ? ' · ' + currentEditing.embeddingModelName : ''}</Text>
                {currentEditing.embeddingFailedAt && <Text style={styles.meta}>失败于 {new Date(currentEditing.embeddingFailedAt).toLocaleString()}</Text>}
                {currentEditing.embeddingError && <Text selectable style={styles.subtitle}>{currentEditing.embeddingError}</Text>}
                <Text style={styles.meta}>{snapshot.embeddingEnabled ? '仅为这条记忆已保存的正文与摘要请求向量，不影响其他记忆。' : '请先在记忆设置中开启向量化。'}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="向量化这条记忆"
                  disabled={busy || !snapshot.embeddingEnabled || currentEditing.embeddingStatus === 'pending' || currentEditing.embeddingStatus === 'retry_wait'}
                  onPress={() => { void run(() => retryMemoryEmbedding(assistantId, currentEditing.id)); }}>
                  <Text style={[styles.action, (!snapshot.embeddingEnabled || currentEditing.embeddingStatus === 'pending' || currentEditing.embeddingStatus === 'retry_wait') && styles.disabled]}>
                    {currentEditing.embeddingStatus === 'pending' || currentEditing.embeddingStatus === 'retry_wait' ? '等待向量化' : currentEditing.embeddingStatus === 'ready' ? '重新向量化这条' : '向量化这条'}
                  </Text>
                </Pressable>
              </View>
              </>}
              <Pressable disabled={busy} onPress={() => confirmDelete()}><Text style={styles.danger}>删除记忆</Text></Pressable>
            </>}

      </>}
    </ScrollView>
  </KeyboardAvoidingContainer></SafeAreaView>;
}
