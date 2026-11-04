import React, { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Pencil, Trash2, Phone, Video } from 'lucide-react-native';
import { ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import { Button, InputField, ModalSheet, NavigationHeader, showAppDialog, ToggleField } from '@shared/ui';
import { deleteCallHistory, listCallHistory, renameCallHistory, getCallHistorySnapshotSaving, setCallHistorySnapshotSaving } from '../application/CallHistory';
import type { CallHistoryRecord } from '../domain/CallHistory';
import { createCallHistoryStyles } from './callHistoryStyles';

export default function CallHistoryScreen({ assistantId, onBack, onOpenRecord }: {
  assistantId: string; onBack(): void; onOpenRecord(callId: string): void;
}) {
  const theme = useTheme(), styles = useThemedStyles(createCallHistoryStyles);
  const [records, setRecords] = useState<CallHistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CallHistoryRecord | null>(null);
  const [title, setTitle] = useState('');
  const [renameError, setRenameError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [saveSnapshots, setSaveSnapshots] = useState(false);
  const [savingPreference, setSavingPreference] = useState(false);
  const refresh = useCallback(async () => {
    const result = await listCallHistory(assistantId);
    setRecords(result);
  }, [assistantId]);
  useFocusEffect(useCallback(() => {
    let active = true;
    setLoading(true); setError(null);
    void Promise.all([listCallHistory(assistantId), getCallHistorySnapshotSaving(assistantId)])
      .then(([result, enabled]) => { if (active) { setRecords(result); setSaveSnapshots(enabled); } })
      .catch(failure => { if (active) setError(failure.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [assistantId]));
  const changeSnapshotSaving = async (enabled: boolean) => {
    setSavingPreference(true);
    try { await setCallHistorySnapshotSaving(assistantId, enabled); setSaveSnapshots(enabled); }
    catch (failure) { showAppDialog({ title: '设置保存失败', message: failure instanceof Error ? failure.message : '请稍后再试', tone: 'error' }); }
    finally { setSavingPreference(false); }
  };
  const save = async () => {
    if (!editing || busy) return;
    setBusy(true); setRenameError(undefined);
    try {
      await renameCallHistory(editing.callId, assistantId, title);
      await refresh(); setEditing(null);
    } catch (failure) { setRenameError(failure instanceof Error ? failure.message : '保存失败'); }
    finally { setBusy(false); }
  };
  const remove = (record: CallHistoryRecord) => showAppDialog({
    title: '删除通话记录？', message: `将删除「${record.title}」及其中保存的音频和截图。已进入 AI 上下文或摘要的内容不会被撤回。`,
    buttons: [{ text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: async () => {
      setBusy(true);
      try { await deleteCallHistory(record.callId, assistantId); await refresh(); }
      catch (failure) { showAppDialog({ title: '删除失败', message: failure instanceof Error ? failure.message : '请稍后再试', tone: 'error' }); }
      finally { setBusy(false); }
    } }],
  });
  return <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
    <NavigationHeader title="通话记录" onGoBack={onBack} />
    <FlatList data={records} keyExtractor={record => record.callId} contentContainerStyle={styles.content}
      ListHeaderComponent={<View>
        <ToggleField label="保存 AI 获取的截图" value={saveSnapshots} disabled={loading || savingPreference || error !== null}
          onValueChange={enabled => { void changeSnapshotSaving(enabled); }}
          hint="默认关闭，仅影响这个 AI 之后获取的截图。关闭不会删除已保存的图片，可在记录详情中单独删除。" />
        <Text style={styles.meta}>按时间从新到旧排列。新增通话会保存文字与分段语音；此前已清理的音频无法补录。</Text>
        {loading && <ActivityIndicator color={theme.colors.brand.primary} />}
        {error && <Text style={styles.error}>{error}</Text>}
      </View>}
      ListEmptyComponent={!loading && !error ? <Text style={styles.meta}>暂无已结束的通话记录</Text> : null}
      renderItem={({ item }) => <Pressable onPress={() => onOpenRecord(item.callId)} disabled={busy} accessibilityRole="button" accessibilityLabel={`查看通话 ${item.title}`}>
        <ThemedSurface variant="card" style={styles.card}>
          <View style={styles.row}>{item.mediaMode === 'video' ? <Video size={20} color={theme.colors.brand.primary} /> : <Phone size={20} color={theme.colors.brand.primary} />}<Text style={styles.title}>{item.title}</Text></View>
          <Text style={styles.meta}>{new Date(item.startedAt).toLocaleString()} · {item.mediaMode === 'video' ? '视频通话' : '语音通话'}</Text>
          <View style={styles.row}>
            <Pressable style={styles.action} disabled={busy} accessibilityLabel={`重命名 ${item.title}`} onPress={() => { setEditing(item); setTitle(item.title); setRenameError(undefined); }}><Pencil size={19} color={theme.colors.text.secondary} /></Pressable>
            <Pressable style={styles.action} disabled={busy} accessibilityLabel={`删除 ${item.title}`} onPress={() => remove(item)}><Trash2 size={19} color={theme.colors.feedback.error} /></Pressable>
          </View>
        </ThemedSurface>
      </Pressable>} />
    <ModalSheet visible={editing !== null} title="修改通话标题" onClose={() => { if (!busy) setEditing(null); }}>
      <View style={styles.form}>
        <InputField label="标题" value={title} onChangeText={setTitle} maxLength={100} editable={!busy} error={renameError} hint="同一个 AI 的通话标题不能重复" />
        <Button title={busy ? '保存中…' : '保存'} disabled={busy} onPress={() => { void save(); }} />
      </View>
    </ModalSheet>
  </SafeAreaView>;
}
