import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { AppTextInput, ModalSheet } from '@shared/ui';
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
  label: { fontSize: 14, color: theme.colors.text.primary, marginBottom: 8 },
  input: {
    borderWidth: 1, borderColor: theme.colors.border.light, borderRadius: theme.radius.md,
    padding: 12, fontSize: 14, color: theme.colors.text.primary,
    backgroundColor: theme.colors.surface.default, marginBottom: 16,
  },
  row: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  button: { padding: 12, borderRadius: theme.radius.md, backgroundColor: theme.colors.surface.default },
  selected: { borderWidth: 1, borderColor: theme.colors.brand.primary },
  buttonText: { color: theme.colors.brand.primary, fontSize: 14 },
  hint: { color: theme.colors.text.secondary, fontSize: 12, marginBottom: 16 },
  dialog: { padding: 20 },
  json: { minHeight: 160, textAlignVertical: 'top' },
  error: { color: theme.colors.feedback.error, marginBottom: 12 },
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
    <TouchableOpacity style={[styles.button, { marginBottom: 16 }]} disabled={props.disabled} onPress={() => setOpen(true)}>
      <Text style={styles.buttonText}>从官方配置 JSON 导入</Text>
    </TouchableOpacity>
    <Text style={styles.label}>Server URL</Text>
    <AppTextInput style={styles.input} value={props.url} onChangeText={props.onUrlChange}
      placeholder="请输入 MCP Server 地址" placeholderTextColor={theme.colors.text.tertiary}
      autoCapitalize="none" autoCorrect={false} keyboardType="url" editable={!props.disabled} />
    <Text style={styles.label}>认证方式</Text>
    <View style={styles.row}>
      {(['none', 'bearer_token'] as const).map((mode) => <TouchableOpacity key={mode}
        style={[styles.button, props.authMode === mode && styles.selected]} disabled={props.disabled}
        onPress={() => props.onAuthModeChange(mode)}>
        <Text style={styles.buttonText}>{mode === 'none' ? '无认证' : 'Bearer Token'}</Text>
      </TouchableOpacity>)}
    </View>
    {props.authMode === 'bearer_token' && <>
      <Text style={styles.label}>Token</Text>
      <AppTextInput style={styles.input} value={props.bearerToken} onChangeText={props.onTokenChange}
        placeholder={props.hasSavedToken ? '已保存，留空保留；更换地址时需重新填写' : '粘贴 Token，无需 Bearer 前缀'}
        placeholderTextColor={theme.colors.text.tertiary} secureTextEntry autoCapitalize="none"
        autoCorrect={false} editable={!props.disabled} />
      <Text style={styles.hint}>Token 保存在设备安全存储中。恢复备份或换机后需要重新填写。</Text>
    </>}
    <ModalSheet visible={open} onClose={close} title="粘贴官方 MCP 配置">
      <ScrollView contentContainerStyle={styles.dialog} keyboardShouldPersistTaps="handled">
        <AppTextInput style={[styles.input, styles.json]} value={json} onChangeText={(value) => { setJson(value); setDrafts([]); }}
          multiline autoCapitalize="none" autoCorrect={false} placeholder={'{"mcpServers": { ... }}'}
          placeholderTextColor={theme.colors.text.tertiary} />
        {error && <Text style={styles.error}>{error}</Text>}
        {drafts.length > 0 && <Text style={styles.hint}>选择要填写到当前页面的服务：</Text>}
        {drafts.map((draft) => <TouchableOpacity key={draft.name} style={styles.button} onPress={() => select(draft)}>
          <Text style={styles.buttonText}>{draft.name}</Text>
        </TouchableOpacity>)}
        <View style={styles.row}>
          <TouchableOpacity style={styles.button} onPress={parse}><Text style={styles.buttonText}>读取配置</Text></TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={close}><Text style={styles.buttonText}>取消</Text></TouchableOpacity>
        </View>
      </ScrollView>
    </ModalSheet>
  </>;
}
