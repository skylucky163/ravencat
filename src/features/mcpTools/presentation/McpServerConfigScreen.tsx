/** MCP Server 配置页：编辑元数据、连接测试与工具授权；服务启停由工具列表管理。 */

import { ToggleDetailRow, showAppDialog } from '@shared/ui';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
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
  type McpConnectionTestResult,
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

const createStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background.screen,
    },
    scrollContent: {
      padding: 16,
      paddingBottom: 48,
    },
    fieldLabel: {
      fontSize: 13,
      color: theme.colors.text.secondary,
      marginBottom: 6,
    },
    input: {
      minHeight: 44,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border.strong,
      backgroundColor: theme.colors.surface.default,
      fontSize: 15,
      color: theme.colors.text.primary,
      marginBottom: 16,
    },
    descriptionInput: {
      minHeight: 96,
      textAlignVertical: 'top',
    },
    infoRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 12,
      paddingHorizontal: 12,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border.light,
      backgroundColor: theme.colors.surface.default,
      marginBottom: 16,
    },
    infoLabel: {
      fontSize: 15,
      color: theme.colors.text.primary,
    },
    infoValue: {
      fontSize: 15,
      color: theme.colors.text.secondary,
    },
    saveButton: {
      alignItems: 'center',
      paddingVertical: 12,
      borderRadius: theme.radius.lg,
      backgroundColor: theme.colors.brand.primary,
      marginTop: 8,
    },
    saveButtonText: {
      fontSize: 15,
      fontWeight: '600',
      color: '#FFFFFF',
    },
    deleteButton: {
      alignItems: 'center',
      paddingVertical: 12,
      borderRadius: theme.radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border.strong,
      marginTop: 12,
    },
    deleteButtonText: {
      fontSize: 15,
      color: '#FF3B30',
    },
    testButton: {
      alignItems: 'center',
      paddingVertical: 12,
      borderRadius: theme.radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border.strong,
      marginTop: 12,
    },
    testButtonText: {
      fontSize: 15,
      color: theme.colors.brand.primary,
    },
    discoveryCard: {
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border.light,
      backgroundColor: theme.colors.surface.default,
      padding: 12,
      marginTop: 12,
    },
    discoveryTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text.primary,
      marginBottom: 4,
    },
    // 工具行自带左右内边距，卡片只负责圆角与裁切。
    toolCard: {
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border.light,
      backgroundColor: theme.colors.surface.default,
      marginTop: 12,
      overflow: 'hidden',
    },
    toolCardHeader: {
      padding: 12,
      paddingBottom: 0,
    },
    discoveryMeta: {
      fontSize: 12,
      color: theme.colors.text.secondary,
      marginBottom: 8,
    },
    toolRow: {
      paddingVertical: 6,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.border.light,
    },
    toolName: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.text.primary,
    },
    toolLocalName: {
      fontSize: 11,
      color: theme.colors.text.tertiary,
      marginTop: 1,
    },
    toolDescription: {
      fontSize: 12,
      color: theme.colors.text.secondary,
      marginTop: 2,
    },
    staleText: {
      fontSize: 11,
      color: '#FF9500',
      marginTop: 2,
    },
    saving: {
      marginTop: 12,
    },
  });

function getErrorMessage(error: unknown): string {
  if (error instanceof McpConfigError) {
    const messages: Record<string, string> = {
      NAME_REQUIRED: '显示名称不能为空',
      NAME_INVALID: '显示名称不能包含换行或控制字符',
      NAME_TOO_LONG: `显示名称不能超过 ${MCP_SERVER_NAME_MAX_LENGTH} 个字符`,
      NAME_CONFLICT: '已有同名 MCP Server，请换一个名称',
      DESCRIPTION_TOO_LONG: `服务简介不能超过 ${MCP_SERVER_DESCRIPTION_MAX_LENGTH} 个字符`,
      ASSISTANT_REQUIRED: '请至少选择一位生效 AI',
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
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [discovery, setDiscovery] = useState<McpConnectionTestResult | null>(null);
  const [savedConnection, setSavedConnection] = useState<McpServerConfig | null>(null);
  const [toolGrants, setToolGrants] = useState<McpDiscoveredToolGrantView[] | null>(null);
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

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await saveMcpServer({ id: serverId, name, url, description, assistantIds,
        enabled: initialServerId === null || enabled, authMode,
        bearerToken: bearerToken.trim() || undefined });
      onBack();
    } catch (saveError) {
      setError(getErrorMessage(saveError));
      setSaving(false);
    }
  }, [serverId, initialServerId, name, url, description, assistantIds, enabled, authMode, bearerToken, onBack]);

  const handleTestConnection = useCallback(async (protocolEra: McpProtocolEra) => {
    setTesting(true);
    setError(null);
    setDiscovery(null);
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
      setDiscovery(result);
      setSavedConnection(result.server);
      setEnabled(result.server.enabled);
      await loadToolGrants(saved.id);
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
      title: '删除 MCP Server',
      message: '删除后将同时移除该 Server 的全部工具授权，且无法恢复。',
      buttons: [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            setSaving(true);
            setError(null);
            deleteMcpServer(serverId)
              .then(onBack)
              .catch((deleteError) => {
                setError(getErrorMessage(deleteError));
                setSaving(false);
              });
          },
        },
      ],
    });
  }, [serverId, onBack]);

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <NavigationHeader title="Server 配置" onGoBack={onBack} />
        <ActivityIndicator style={{ marginTop: 48 }} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <NavigationHeader
        title={serverId ? 'Server 配置' : '新增 MCP Server'}
        onGoBack={onBack}
      />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.fieldLabel}>显示名称</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="例如：我的知识库"
          placeholderTextColor={theme.colors.text.tertiary}
          maxLength={MCP_SERVER_NAME_MAX_LENGTH}
          editable={!saving && !testing}
        />

        <McpConnectionFields url={url} authMode={authMode} bearerToken={bearerToken}
          hasSavedToken={hasSavedToken} disabled={saving || testing} onUrlChange={setUrl}
          onAuthModeChange={(mode) => { setAuthMode(mode); setBearerToken(''); }}
          onTokenChange={setBearerToken} onImport={(draft) => {
            setName(draft.name); setUrl(draft.url); setAuthMode(draft.authMode);
            setBearerToken(draft.bearerToken ?? ''); setDiscovery(null);
          }} />

        <Text style={styles.fieldLabel}>服务简介（可选，注入 AI 上下文）</Text>
        <TextInput
          style={[styles.input, styles.descriptionInput]}
          value={description}
          onChangeText={setDescription}
          placeholder="例如：我的记忆库，存放日常对话摘要与笔记"
          placeholderTextColor={theme.colors.text.tertiary}
          multiline
          maxLength={MCP_SERVER_DESCRIPTION_MAX_LENGTH}
          editable={!saving && !testing}
        />

        {assistants !== null && <McpAssistantSelection assistants={assistants} selectedIds={assistantIds}
          collapsible={initialServerId !== null}
          disabled={saving || testing} required={serverId === null} onToggle={(id, selected) => {
            setAssistantIds((current) => selected ? [...current, id] : current.filter((value) => value !== id));
          }} />}

        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Transport</Text>
          <Text style={styles.infoValue}>Streamable HTTP</Text>
        </View>

        {savedConnection !== null && savedConnection.connectionStatus === 'available' && (
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>已验证链路</Text>
            <Text style={styles.infoValue}>
              {savedConnection.lastProtocolEra === 'legacy' ? '传统握手' : '新版协议'} · {savedConnection.lastNegotiatedProtocolVersion}
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={styles.testButton}
          activeOpacity={0.7}
          onPress={() => {
            void handleTestConnection('legacy');
          }}
          disabled={testing || saving || assistants === null || (serverId === null && assistantIds.length === 0)}
        >
          <Text style={styles.testButtonText}>传统握手测试</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.testButton}
          activeOpacity={0.7}
          onPress={() => {
            void handleTestConnection('modern');
          }}
          disabled={testing || saving || assistants === null || (serverId === null && assistantIds.length === 0)}
        >
          <Text style={styles.testButtonText}>新版协议测试</Text>
        </TouchableOpacity>
        <Text style={styles.discoveryMeta}>
          测试会保存当前配置。成功后使用对应链路；另一条测试失败不会覆盖已验证链路。
        </Text>
        {testing && <ActivityIndicator style={styles.saving} />}

        {discovery ? (
          <ThemedSurface variant="card" cornerRadius={theme.radius.md} style={styles.discoveryCard}>
            <Text style={styles.discoveryTitle}>
              连接成功：{discovery.serverInfo?.name ?? '未知 Server'}
            </Text>
            <Text style={styles.discoveryMeta}>
              协议版本：{discovery.protocolVersion}
            </Text>
            <Text style={styles.discoveryMeta}>
              发现 {discovery.tools.length} 个工具；首次发现和新增工具默认开启，已有工具保留当前开关；耗时 {discovery.durationMs} ms
            </Text>
            {discovery.tools.map((tool) => (
              <View key={tool.localName} style={styles.toolRow}>
                <Text style={styles.toolName}>{tool.remoteName}</Text>
                <Text style={styles.toolLocalName}>{tool.localName}</Text>
                {tool.description ? (
                  <Text style={styles.toolDescription} numberOfLines={2}>
                    {tool.description}
                  </Text>
                ) : null}
              </View>
            ))}
          </ThemedSurface>
        ) : null}

        {toolGrants && toolGrants.length > 0 ? (
          <ThemedSurface variant="card" cornerRadius={theme.radius.md} style={styles.toolCard}>
            <View style={styles.toolCardHeader}>
              <Text style={styles.discoveryTitle}>工具授权</Text>
              <Text style={styles.discoveryMeta}>
                首次发现和新增工具默认允许 AI 请求，可按需关闭
              </Text>
            </View>
            {toolGrants.map((grant, index) => (
              <ToggleDetailRow key={grant.localToolName} title={grant.remoteToolName}
                detail={<>
                  <Text style={styles.toolLocalName}>{grant.localToolName}</Text>
                  {grant.description ? <Text style={styles.toolDescription} numberOfLines={2}>{grant.description}</Text> : null}
                  {grant.stale ? <Text style={styles.staleText}>
                    {grant.canAuthorize
                      ? 'schema 已变化，请确认后重新授权'
                      : '工具已从最近一次发现快照中消失'}
                  </Text> : null}
                </>}
                value={grant.enabled}
                toggleAccessibilityLabel={`允许 AI 请求：${grant.remoteToolName}`}
                onValueChange={(next) => {
                  void handleToggleToolGrant(grant.remoteToolName, next);
                }}
                disabled={!grant.canAuthorize || testing}
                divider={index < toolGrants.length - 1} />
            ))}
          </ThemedSurface>
        ) : null}

        <TouchableOpacity
          style={styles.saveButton}
          activeOpacity={0.7}
          onPress={() => {
            void handleSave();
          }}
          disabled={saving || testing || assistants === null || (serverId === null && assistantIds.length === 0)}
        >
          <Text style={styles.saveButtonText}>保存</Text>
        </TouchableOpacity>

        {serverId ? (
          <TouchableOpacity
            style={styles.deleteButton}
            activeOpacity={0.7}
            onPress={handleDelete}
            disabled={saving || testing}
          >
            <Text style={styles.deleteButtonText}>删除 Server</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
