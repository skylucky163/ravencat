import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { AppTextInput, Button, InputField, ModalSheet } from '@shared/ui';
import { useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import type { McpServerAuthMode } from '../domain/McpServerConfig';
import { parseMcpServerImport, type McpServerImportDraft } from '../application/ParseMcpServerImport';

interface Props {
  url: string;
  authMode: McpServerAuthMode;
  bearerToken: string;
  hasSavedToken: boolean;
  disabled: boolean;
  onUrlChange(url: string): void;
  onAuthModeChange(mode: McpServerAuthMode): void;
  onTokenChange(token: string): void;
  onImport(draft: McpServerImportDraft): void;
}

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 },
  title: { flex: 1, fontSize: 15, fontWeight: '600', color: theme.colors.text.primary },
  importButton: { paddingVertical: 8, paddingLeft: 8 },
  importText: { color: theme.colors.brand.primary, fontSize: 13, fontWeight: '500' },
  label: { fontSize: 14, fontWeight: '500', color: theme.colors.text.secondary, marginBottom: 8 },
  authOptions: {
    flexDirection: 'row', padding: 4, gap: 4,
    borderRadius: theme.radius.md, backgroundColor: theme.colors.surface.muted,
  },
  authOption: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 10, borderRadius: theme.radius.sm },
  selected: { backgroundColor: theme.colors.surface.default },
  optionText: { color: theme.colors.text.secondary, fontSize: 14 },
  selectedText: { color: theme.colors.brand.primary, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  tokenField: { marginTop: 16 },
  tokenInput: {
    paddingHorizontal: 12, paddingVertical: 12, fontSize: 16,
    color: theme.colors.text.primary, backgroundColor: theme.colors.surface.input, borderRadius: theme.radius.md,
  },
  hint: { color: theme.colors.text.tertiary, fontSize: 12, lineHeight: 18, marginTop: 8 },
  dialogScroll: { flexShrink: 1 },
  dialog: { padding: 20, gap: 16 },
  jsonField: { marginBottom: 0 },
  jsonInput: { minHeight: 160, maxHeight: 280 },
  dialogActions: { flexDirection: 'row', gap: 12, paddingHorizontal: 20, paddingBottom: 20, flexShrink: 0 },
  dialogButton: { flex: 1, paddingHorizontal: 12 },
  draft: { padding: 14, borderRadius: theme.radius.md, backgroundColor: theme.colors.surface.muted },
  draftName: { color: theme.colors.text.primary, fontSize: 15 },
  error: { color: theme.colors.feedback.error, fontSize: 13, lineHeight: 18 },
});

export default function McpConnectionFields(props: Props) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const [open, setOpen] = useState(false);
  const [json, setJson] = useState('');
  const [drafts, setDrafts] = useState<McpServerImportDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const close = () => { setOpen(false); setJson(''); setDrafts([]); setError(null); };
  const select = (draft: McpServerImportDraft) => { props.onImport(draft); close(); };
  const parse = () => {
    try {
      const imported = parseMcpServerImport(json);
      if (imported.length === 1) select(imported[0]);
      else { setDrafts(imported); setError(null); }
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : '配置导入失败');
    }
  };
  return <>
    <View style={styles.header}>
      <Text style={styles.title}>连接设置</Text>
      <TouchableOpacity style={[styles.importButton, props.disabled && styles.disabled]}
        accessibilityRole="button" accessibilityLabel="从官方配置 JSON 导入"
        disabled={props.disabled} onPress={() => setOpen(true)}>
        <Text style={styles.importText}>导入 JSON</Text>
      </TouchableOpacity>
    </View>
    <InputField label="服务地址" value={props.url} onChangeText={props.onUrlChange}
      placeholder="https://example.com/mcp" autoCapitalize="none" autoCorrect={false}
      keyboardType="url" editable={!props.disabled} />
    <Text style={styles.label}>认证方式</Text>
    <View style={styles.authOptions} accessibilityRole="radiogroup" accessibilityLabel="认证方式">
      {(['none', 'bearer_token'] as const).map((mode) => <TouchableOpacity key={mode}
        style={[styles.authOption, props.authMode === mode && styles.selected, props.disabled && styles.disabled]}
        accessibilityRole="radio" accessibilityLabel={mode === 'none' ? '无认证' : 'Bearer Token'}
        accessibilityState={{ checked: props.authMode === mode, disabled: props.disabled }} disabled={props.disabled}
        onPress={() => props.onAuthModeChange(mode)}>
        <Text style={[styles.optionText, props.authMode === mode && styles.selectedText]}>
          {mode === 'none' ? '无认证' : 'Bearer Token'}
        </Text>
      </TouchableOpacity>)}
    </View>
    {props.authMode === 'bearer_token' && <View style={styles.tokenField}>
      <Text style={styles.label}>Token</Text>
      <AppTextInput style={styles.tokenInput} value={props.bearerToken} onChangeText={props.onTokenChange}
        accessibilityLabel="Bearer Token" placeholder={props.hasSavedToken ? '已保存，可留空' : '粘贴 Token'}
        placeholderTextColor={theme.colors.text.tertiary} secureTextEntry autoCapitalize="none"
        autoCorrect={false} editable={!props.disabled} />
      <Text style={styles.hint}>
        {props.hasSavedToken ? '留空保留已保存的令牌，更换地址需重新填写。' : '只粘贴令牌，不含 Bearer 前缀。'}
      </Text>
    </View>}
    <ModalSheet visible={open} onClose={close} title="导入 MCP 配置">
      <ScrollView style={styles.dialogScroll} contentContainerStyle={styles.dialog} keyboardShouldPersistTaps="handled">
        <Text style={styles.hint}>粘贴官方 mcpServers JSON，导入后再选择生效 AI。</Text>
        <InputField label="配置 JSON" style={styles.jsonField} inputStyle={styles.jsonInput}
          value={json} onChangeText={(value) => { setJson(value); setDrafts([]); setError(null); }}
          multiline autoGrow autoCapitalize="none" autoCorrect={false} placeholder={'{"mcpServers": { ... }}'} />
        {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
        {drafts.length > 0 && <Text style={styles.hint}>选择要填写到当前页面的服务：</Text>}
        {drafts.map((draft) => <TouchableOpacity key={draft.name} style={styles.draft}
          accessibilityRole="button" onPress={() => select(draft)}>
          <Text style={styles.draftName}>{draft.name}</Text>
        </TouchableOpacity>)}
      </ScrollView>
      <View style={styles.dialogActions}>
        <Button title="取消" variant="secondary" style={styles.dialogButton} onPress={close} />
        <Button title="读取配置" style={styles.dialogButton} onPress={parse} />
      </View>
    </ModalSheet>
  </>;
}
