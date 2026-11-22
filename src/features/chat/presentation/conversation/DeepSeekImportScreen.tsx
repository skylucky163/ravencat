import React, { useEffect, useRef, useState } from 'react';
import { FlatList, Keyboard, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useThemedStyles, type PresentationTheme } from '@shared/theme';
import { Button, InputField, KeyboardAvoidingContainer, ListItem, NavigationHeader } from '@shared/ui';
import { describeDeepSeekConversation, importDeepSeekConversation, loadDeepSeekImport } from '../../messages/application/ImportDeepSeekConversation';
import type { DeepSeekConversation, DeepSeekExportArchive, DeepSeekExportConversation } from '../../messages/domain/DeepSeekImport';

type PendingAction = 'load' | 'select' | 'import';

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background.screen },
  form: { flex: 1 },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
  pickerHeader: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md },
  pickerMessage: { padding: theme.spacing.lg },
  body: { ...theme.typography.body, color: theme.colors.text.primary },
  preview: { ...theme.typography.body, color: theme.colors.text.secondary },
  error: { ...theme.typography.body, color: theme.colors.feedback.error },
});

export default function DeepSeekImportScreen({
  aiId, assistantName, onBack, onImported, onViewConversation,
}: {
  aiId: string;
  assistantName: string;
  onBack: () => void;
  onImported: (sessionId: string) => void;
  onViewConversation: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const [link, setLink] = useState('');
  const [selection, setSelection] = useState<{ conversation: DeepSeekConversation; title: string } | null>(null);
  const [conversations, setConversations] = useState<readonly DeepSeekExportConversation[] | null>(null);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof importDeepSeekConversation>> | null>(null);
  const request = useRef<AbortController | null>(null);
  const archive = useRef<DeepSeekExportArchive | null>(null);
  useEffect(() => () => {
    request.current?.abort();
    archive.current?.dispose();
    archive.current = null;
  }, []);
  const preview = selection && describeDeepSeekConversation(selection.conversation);
  const busy = pending !== null;
  const search = query.trim().toLowerCase();

  const closeArchive = () => {
    archive.current?.dispose();
    archive.current = null;
    setConversations(null);
    setQuery('');
  };

  const run = async (action: PendingAction, operation: (signal: AbortSignal) => Promise<void>) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    Keyboard.dismiss();
    setPending(action);
    setError('');
    try {
      await operation(controller.signal);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : '导入失败，请稍后重试。');
      }
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setPending(null);
    }
  };

  const load = () => run('load', async signal => {
    const loaded = await loadDeepSeekImport(link, signal);
    if (signal.aborted) {
      loaded.dispose();
    } else {
      archive.current = loaded;
      setConversations(loaded.conversations);
    }
  });

  const select = (item: DeepSeekExportConversation) => run('select', async signal => {
    const conversation = await archive.current!.readConversation(item.id, signal);
    if (!signal.aborted) setSelection({ conversation, title: item.title });
  });

  const confirm = (conversation: DeepSeekConversation) => run('import', async signal => {
    const imported = await importDeepSeekConversation(aiId, archive.current!, conversation, signal);
    onImported(imported.sessionId);
    if (!signal.aborted) {
      closeArchive();
      setResult(imported);
    }
  });

  const changeLink = () => {
    closeArchive();
    setSelection(null);
    setError('');
    setLink('');
  };
  const errorText = error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom', 'left', 'right']}>
      <NavigationHeader title="导入 DeepSeek 对话" onGoBack={onBack} />
      <KeyboardAvoidingContainer style={styles.form}>
        {!selection && conversations ? (
          <>
            <View style={styles.pickerHeader}>
              <InputField label="选择要导入的对话" placeholder="搜索对话标题" value={query} onChangeText={setQuery}
                editable={!busy} autoCorrect={false}
                rightAccessory={<Button title="更换链接" variant="text" disabled={busy} onPress={changeLink} />} />
              {errorText}
              {pending === 'select' && <Text style={styles.preview} accessibilityLiveRegion="polite">正在读取对话…</Text>}
            </View>
            <FlatList
              data={conversations.filter(item => item.title.toLowerCase().includes(search))}
              keyExtractor={item => item.id}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={<Text style={[styles.preview, styles.pickerMessage]}>
                {conversations.length ? '没有匹配的对话。' : '这个 ZIP 中没有对话。'}
              </Text>}
              renderItem={({ item }) => (
                <ListItem title={item.title} subtitle={`${item.messageCount} 条消息`} titleNumberOfLines={2}
                  onPress={busy ? null : () => { void select(item); }} />
              )}
            />
          </>
        ) : (
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {result ? (
              <>
                <Text style={styles.body}>已导入 {result.messageCount} 条问答消息。</Text>
                {result.missingFiles > 0 && (
                  <Text style={styles.preview}>{result.missingFiles} 个附件不可用，已保留在原消息中。</Text>
                )}
                <Button title="查看聊天" onPress={onViewConversation} />
              </>
            ) : (
              <>
                <Text style={styles.body}>导入到「{assistantName}」的空白聊天。</Text>
                {selection && preview ? (
                  <>
                    <Text style={styles.body}>{selection.title}</Text>
                    <Text style={styles.body}>{preview.messages} 条问答消息 · {preview.thoughts} 条思考过程 · {preview.files} 个附件</Text>
                    <Text style={styles.preview} numberOfLines={2}>首条 · {preview.first.role}：{preview.first.text}</Text>
                    <Text style={styles.preview} numberOfLines={2}>末条 · {preview.last.role}：{preview.last.text}</Text>
                    {preview.hasHistoryGap && <Text style={styles.preview}>这条对话可能缺少部分历史消息。</Text>}
                    <Text style={styles.preview}>导入的历史不会自动生成摘要。</Text>
                    {errorText}
                    <Button title={busy ? '正在导入…' : '导入到当前 AI'} disabled={busy}
                      onPress={() => { void confirm(selection.conversation); }} />
                    <Button title="重新选择对话" variant="secondary" disabled={busy}
                      onPress={() => { setSelection(null); setError(''); }} />
                    <Button title="更换链接" variant="text" disabled={busy} onPress={changeLink} />
                  </>
                ) : (
                  <>
                    <InputField
                      label="DeepSeek ZIP 导出链接"
                      placeholder="粘贴官方 ZIP 下载链接"
                      value={link}
                      onChangeText={value => { setLink(value); setError(''); }}
                      editable={!busy}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="url"
                    />
                    {errorText}
                    <Button title={busy ? '正在读取…' : '读取对话列表'}
                      disabled={busy || !link.trim()} onPress={() => { void load(); }} />
                  </>
                )}
              </>
            )}
          </ScrollView>
        )}
      </KeyboardAvoidingContainer>
    </SafeAreaView>
  );
}
