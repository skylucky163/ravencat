/** MCP Server 配置页：编辑元数据、连接测试与工具授权；服务启停由工具列表管理。 */

import { Button, Card, InputField, KeyboardAvoidingContainer, ToggleDetailRow, showAppDialog } from '@shared/ui';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChevronDown, ChevronUp } from 'lucide-react-native';
import { ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { listAIAssistantSummaries, type AIAssistantSummary } from '@features/assistants';
import type { McpProtocolEra } from '@platform/mcp';
import { McpConfigError } from '../application/McpConfigError';
import {
  getMcpServer,
} from '../application/GetMcpServer';
import {
  saveMcpServer,
  MCP_SERVER_DESCRIPTION_MAX_LENGTH,
  MCP_SERVER_NAME_MAX_LENGTH,
} from '../application/SaveMcpServer';
import {
  deleteMcpServer,
} from '../application/DeleteMcpServer';
import {
  testMcpServerConnection,
} from '../application/TestMcpServerConnection';
import {
  listMcpDiscoveredToolGrants,
  setMcpToolGrant,
  type McpDiscoveredToolGrantView,
} from '../application/SetMcpToolGrant';
import type { McpServerAuthMode, McpServerConfig } from '../domain/McpServerConfig';
import McpConnectionFields from './McpConnectionFields';
import McpAssistantSelection from './McpAssistantSelection';

interface McpServerConfigScreenProps {
  serverId: string | null;
  onBack: () => void;
}

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background.screen },
  body: { flex: 1 },
  scrollContent: { padding: 16, gap: 16, paddingBottom: 24 },
  sectionTitle: { fontSize: 15, fontWeight: '600', color: theme.colors.text.primary, marginBottom: 16 },
  lastField: { marginBottom: 0 },
  descriptionInput: { minHeight: 72 },
  hint: { fontSize: 12, lineHeight: 18, color: theme.colors.text.tertiary },
  testActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
  testButton: { flex: 1, minWidth: 132, paddingHorizontal: 12 },
  connectionInfo: {
    marginTop: 16, padding: 12, gap: 4,
    borderRadius: theme.radius.md, backgroundColor: theme.colors.surface.muted,
  },
  connectionLabel: { fontSize: 12, color: theme.colors.text.secondary },
  connectionValue: { fontSize: 13, color: theme.colors.text.primary },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  toolCard: { borderRadius: theme.radius.lg, overflow: 'hidden' },
  toolCardHeader: { padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  toolTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: theme.colors.text.primary },
  toolHint: { paddingHorizontal: 16, paddingBottom: 12 },
  toolDescription: { fontSize: 12, lineHeight: 18, color: theme.colors.text.secondary },
  staleText: { fontSize: 12, lineHeight: 18, color: theme.colors.feedback.warning },
  deleteText: { color: theme.colors.feedback.error },
  loading: { marginTop: 48 },
});

function getErrorMessage(error: unknown): string {
  if (error instanceof McpConfigError) {
    const messages: Record<string, string> = {
      NAME_REQUIRED: '显示名称不能为空',
      NAME_INVALID: '显示名称不能包含换行或控制字符',
      NAME_TOO_LONG: `显示名称不能超过 ${MCP_SERVER_NAME_MAX_LENGTH} 个字符`,
      NAME_CONFLICT: '已有同名 MCP Server，请换一个名称',
      DESCRIPTION_TOO_LONG: `服务简介不能超过 ${MCP_SERVER_DESCRIPTION_MAX_LENGTH} 个字符`,
      ASSISTANT_REQUIRED: '请先在“生效 AI”中至少选择一位 AI，再测试连接。只有选中的 AI 可以使用此服务。',
      URL_INVALID: 'Server URL 不是合法地址',
      URL_PROTOCOL: '地址只允许 https://，或本机回环/局域网/Tailscale（100.x / *.ts.net）的 http://',
      URL_USERINFO: 'URL 中禁止包含用户名或密码',
      URL_FRAGMENT: 'URL 中禁止包含 fragment',
      SERVER_NOT_FOUND: 'MCP Server 不存在',
      CONNECTION_NOT_VERIFIED: '启用前必须先成功测试连接',
      TOOL_NAMESPACE_CONFLICT: '发现工具与已有 MCP Server 命名冲突',
      TOOL_DISCOVERY_FAILED: '工具发现失败，Server 返回了非法协议响应',
      DISCOVERY_SNAPSHOT_INVALID: '本地工具快照损坏，请重新测试连接',
      TOOL_NOT_DISCOVERED: '该工具不在最近一次发现结果中',
    };
    return messages[error.code] ?? error.message;
  }
  return error instanceof Error ? error.message : '操作失败，请稍后重试';
}

export default function McpServerConfigScreen({
  serverId: initialServerId,
  onBack,
}: McpServerConfigScreenProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const [serverId, setServerId] = useState(initialServerId);
  const [loading, setLoading] = useState(true);
  const [assistants, setAssistants] = useState<AIAssistantSummary[] | null>(null);
  const [assistantIds, setAssistantIds] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [authMode, setAuthMode] = useState<McpServerAuthMode>('none');
  const [bearerToken, setBearerToken] = useState('');
  const [hasSavedToken, setHasSavedToken] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [savedConnection, setSavedConnection] = useState<McpServerConfig | null>(null);
  const [toolGrants, setToolGrants] = useState<McpDiscoveredToolGrantView[] | null>(null);
  const [toolGrantsExpanded, setToolGrantsExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 错误展示由页面生命周期拥有，异步操作结束时无需用户滚回顶部查看。
  useEffect(() => {
    if (error !== null) {
      showAppDialog({ title: 'MCP 操作失败', message: error, buttons: [
        { text: '确定', onPress: () => setError(null) },
      ], dismissible: true, onDismiss: () => setError(null), tone: 'error' });
    }
  }, [error]);

  const loadToolGrants = useCallback(async (targetServerId: string) => {
    try {
      setToolGrants(await listMcpDiscoveredToolGrants(targetServerId));
    } catch (grantError) {
      setError(getErrorMessage(grantError));
    }
  }, []);

  useEffect(() => {
    if (initialServerId) {
      void loadToolGrants(initialServerId);
    }
  }, [initialServerId, loadToolGrants]);

  useEffect(() => {
    let isMounted = true;
    Promise.all([
      initialServerId ? getMcpServer(initialServerId) : Promise.resolve(null),
      listAIAssistantSummaries(),
    ])
      .then(([loaded, options]) => {
        if (!isMounted) {
          return;
        }
        setAssistants(options);
        if (initialServerId && !loaded) {
          setError('MCP Server 不存在');
        } else if (loaded) {
          setSavedConnection(loaded);
          setName(loaded.name);
          setUrl(loaded.url);
          setDescription(loaded.description);
          setAssistantIds(loaded.assistantIds);
          setAuthMode(loaded.authMode);
          setHasSavedToken(loaded.credentialRef !== null);
          setEnabled(loaded.enabled);
        }
      })
      .catch((loadError) => {
        if (isMounted) {
          setError(getErrorMessage(loadError));
        }
      })
      .finally(() => {
        if (isMounted) {
          setLoading(false);
        }
      });
    return () => {
      isMounted = false;
    };
  }, [initialServerId]);

  const handleTestConnection = useCallback(async (protocolEra: McpProtocolEra) => {
    setTesting(true);
    setError(null);
    setToolGrantsExpanded(false);
    try {
      // 测试必须使用屏幕当前配置；先保存，再沿同一持久配置链路连接。
      const saved = await saveMcpServer({ id: serverId, name, url, description, assistantIds, enabled, authMode,
        bearerToken: bearerToken.trim() || undefined });
      setServerId(saved.id);
      setSavedConnection(saved);
      setBearerToken('');
      setHasSavedToken(saved.credentialRef !== null);
      setEnabled(saved.enabled);
      // 显示当前配置的授权，失败测试不会抹掉原成功链路的工具列表。
      await loadToolGrants(saved.id);
      const result = await testMcpServerConnection(saved.id, protocolEra);
      setSavedConnection(result.server);
      setEnabled(result.server.enabled);
      await loadToolGrants(saved.id);
      showAppDialog({ title: '连接成功' });
    } catch (testError) {
      setError(getErrorMessage(testError));
    } finally {
      setTesting(false);
    }
  }, [serverId, name, url, description, assistantIds, enabled, authMode, bearerToken, loadToolGrants]);

  const handleToggleToolGrant = useCallback(async (
    remoteToolName: string,
    next: boolean
  ) => {
    if (!serverId) {
      return;
    }
    setError(null);
    try {
      await setMcpToolGrant({ serverId, remoteToolName, enabled: next });
      await loadToolGrants(serverId);
    } catch (grantError) {
      setError(getErrorMessage(grantError));
    }
  }, [serverId, loadToolGrants]);

  const handleDelete = useCallback(() => {
    if (!serverId) {
      return;
    }
    showAppDialog({
      title: '删除 MCP 服务',
      message: '删除后将同时移除此服务的全部工具授权，且无法恢复。',
      buttons: [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            setDeleting(true);
            setError(null);
            deleteMcpServer(serverId)
              .then(onBack)
              .catch((deleteError) => {
                setError(getErrorMessage(deleteError));
                setDeleting(false);
              });
          },
        },
      ],
    });
  }, [serverId, onBack]);

  const title = initialServerId === null ? '新增 MCP 服务' : 'MCP 服务配置';
  const busy = deleting || testing;
  const ToolChevron = toolGrantsExpanded ? ChevronUp : ChevronDown;

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <NavigationHeader title={title} onGoBack={onBack} />
        <ActivityIndicator style={styles.loading} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right', 'bottom']}>
      <NavigationHeader
        title={title}
        onGoBack={onBack}
        help={{ sections: [
          { title: '填写或导入', body: '填写服务名称和地址，或在连接设置中导入官方 mcpServers JSON。仅支持远程 Streamable HTTP 服务，不支持本地 command / stdio。简介可帮助 AI 了解服务用途。' },
          { title: '生效 AI', body: '新增时至少选择一位 AI，只有选中的 AI 可以使用此服务。之后可在工具列表或配置页修改。' },
          { title: '连接测试', body: '根据服务文档选择传统握手或新版协议测试。每次测试前都会自动保存当前配置，连接失败也会保留；修改后再次测试会更新同一服务。成功后使用对应协议，另一种测试失败不会覆盖当前配置已有的成功链路。' },
          { title: '认证与备份', body: 'Bearer Token 只需粘贴令牌，不含 Bearer 前缀。编辑时留空保留已保存的令牌，更换地址需重新填写。令牌保存在设备安全存储中，完整本地备份会包含明文令牌；旧备份未包含的令牌需重新填写。' },
        ] }}
      />
      <KeyboardAvoidingContainer style={styles.body}>
        <ScrollView style={styles.body} contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled">
          <Card>
            <Text style={styles.sectionTitle}>服务信息</Text>
            <InputField label="服务名称" value={name} onChangeText={setName}
              placeholder="例如：我的知识库" maxLength={MCP_SERVER_NAME_MAX_LENGTH} editable={!busy} />
            <InputField label="服务简介（可选）" value={description} onChangeText={setDescription}
              placeholder="告诉 AI 这个服务可以做什么" multiline autoGrow
              style={styles.lastField} inputStyle={styles.descriptionInput}
              maxLength={MCP_SERVER_DESCRIPTION_MAX_LENGTH} editable={!busy} />
          </Card>

          <Card>
            <McpConnectionFields url={url} authMode={authMode} bearerToken={bearerToken}
              hasSavedToken={hasSavedToken} disabled={busy} onUrlChange={setUrl}
              onAuthModeChange={(mode) => { setAuthMode(mode); setBearerToken(''); }}
              onTokenChange={setBearerToken} onImport={(draft) => {
                setName(draft.name); setUrl(draft.url); setAuthMode(draft.authMode);
                setBearerToken(draft.bearerToken ?? '');
              }} />
          </Card>

          {assistants !== null && <Card>
            <McpAssistantSelection assistants={assistants} selectedIds={assistantIds}
              collapsible disabled={busy} required={serverId === null}
              onToggle={(id, selected) => {
                setAssistantIds((current) => selected ? [...current, id] : current.filter((value) => value !== id));
              }} />
          </Card>}

          <Card>
            <Text style={styles.sectionTitle}>连接测试</Text>
            <Text style={styles.hint}>按服务支持的协议测试。</Text>
            <View style={styles.testActions}>
              <Button title="传统握手测试" variant="outline" style={styles.testButton}
                disabled={busy || assistants === null} onPress={() => { void handleTestConnection('legacy'); }} />
              <Button title="新版协议测试" variant="outline" style={styles.testButton}
                disabled={busy || assistants === null} onPress={() => { void handleTestConnection('modern'); }} />
            </View>
            {testing && <View style={styles.progress}>
              <ActivityIndicator size="small" color={theme.colors.brand.primary} />
              <Text style={styles.hint}>正在测试连接…</Text>
            </View>}
            {savedConnection !== null && savedConnection.connectionStatus === 'available' && (
              <View style={styles.connectionInfo}>
                <Text style={styles.connectionLabel}>已验证链路</Text>
                <Text style={styles.connectionValue}>
                  {savedConnection.lastProtocolEra === 'legacy' ? '传统握手' : '新版协议'} · {savedConnection.lastNegotiatedProtocolVersion}
                </Text>
              </View>
            )}
          </Card>

          {toolGrants && toolGrants.length > 0 ? (
            <ThemedSurface variant="card" cornerRadius={theme.radius.lg} style={styles.toolCard}>
              <TouchableOpacity style={styles.toolCardHeader} activeOpacity={0.7}
                accessibilityRole="button" accessibilityLabel="工具授权"
                accessibilityState={{ expanded: toolGrantsExpanded }}
                onPress={() => setToolGrantsExpanded((current) => !current)}>
                <Text style={styles.toolTitle}>工具授权</Text>
                <ToolChevron size={18} color={theme.colors.text.tertiary} />
              </TouchableOpacity>
              {toolGrantsExpanded && <>
                <Text style={[styles.hint, styles.toolHint]}>新发现的工具默认允许 AI 使用，可按需关闭。</Text>
                {toolGrants.map((grant, index) => (
                  <ToggleDetailRow key={grant.localToolName} title={grant.remoteToolName}
                    detail={<>
                      {grant.description ? <Text style={styles.toolDescription} numberOfLines={2}>{grant.description}</Text> : null}
                      {grant.stale ? <Text style={styles.staleText}>
                        {grant.canAuthorize ? '工具定义已变化，请确认后重新授权' : '服务已不再提供此工具'}
                      </Text> : null}
                    </>}
                    value={grant.enabled} toggleAccessibilityLabel={`允许 AI 请求：${grant.remoteToolName}`}
                    onValueChange={(next) => { void handleToggleToolGrant(grant.remoteToolName, next); }}
                    disabled={!grant.canAuthorize || busy} divider={index < toolGrants.length - 1} />
                ))}
              </>}
            </ThemedSurface>
          ) : null}

          {serverId ? <Button title="删除服务" variant="text" textStyle={styles.deleteText}
            disabled={busy} onPress={handleDelete} /> : null}
        </ScrollView>
      </KeyboardAvoidingContainer>
    </SafeAreaView>
  );
}
