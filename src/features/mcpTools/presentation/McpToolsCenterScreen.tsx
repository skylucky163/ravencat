/** MCP 工具中心：Server 列表与添加入口；不自动连接任何 Server。 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ThemedSurface, useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import { EmptyState, HeaderAddButton, ToggleDetailRow } from '@shared/ui';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { listAIAssistantSummaries, type AIAssistantSummary } from '@features/assistants';
import { setMcpServerAssistantEnabled } from '../application/SetMcpServerAssistantEnabled';
import { setMcpServerEnabled } from '../application/SetMcpServerEnabled';
import McpAssistantSelection from './McpAssistantSelection';
import { canCommitPresentationLoad } from '@shared/utils/presentationLoadRevision';
import {
  listMcpServersWithEnabledToolCounts,
  type McpServerListItemWithEnabledToolCount,
} from '../application/ListMcpServers';
import type { McpServerConnectionStatus } from '../domain/McpServerConfig';

interface McpToolsCenterScreenProps {
  onBack: () => void;
  onAddServer: () => void;
  onOpenServer: (serverId: string) => void;
  refreshRevision?: number;
}

const CONNECTION_STATUS_LABELS: Record<McpServerConnectionStatus, string> = {
  unverified: '未验证',
  available: '可用',
  unavailable: '不可用',
  authentication_required: '需要认证',
};

const CONNECTION_STATUS_COLORS: Record<McpServerConnectionStatus, string> = {
  unverified: '#8E8E93',
  available: '#34C759',
  unavailable: '#FF3B30',
  authentication_required: '#FF9500',
};

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
    errorText: {
      fontSize: 13,
      lineHeight: 19,
      color: theme.colors.text.secondary,
      marginBottom: 16,
    },
    listCard: {
      borderRadius: theme.radius.lg,
      backgroundColor: theme.colors.surface.default,
      overflow: 'hidden',
    },
    server: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border.light },
    itemLast: {
      borderBottomWidth: 0,
    },
    selection: { paddingHorizontal: 16, paddingBottom: 12 },
    itemMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 3,
    },
    statusDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    itemStatus: {
      fontSize: 12,
      color: theme.colors.text.secondary,
    },
    enabledText: {
      fontSize: 12,
      color: theme.colors.text.tertiary,
    },
    loading: {
      marginTop: 48,
    },
  });

export default function McpToolsCenterScreen({
  onBack,
  onAddServer,
  onOpenServer,
  refreshRevision = 0,
}: McpToolsCenterScreenProps) {
  const styles = useThemedStyles(createStyles);
  const [servers, setServers] = useState<McpServerListItemWithEnabledToolCount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assistants, setAssistants] = useState<AIAssistantSummary[]>([]);
  const [savingServerId, setSavingServerId] = useState<string | null>(null);
  const savingRef = useRef(false);
  const mountedRef = useRef(false);
  const loadRevisionRef = useRef(0);
  const previousRefreshRevisionRef = useRef(refreshRevision);

  const load = useCallback(async () => {
    const loadRevision = loadRevisionRef.current + 1;
    loadRevisionRef.current = loadRevision;
    try {
      const [rows, options] = await Promise.all([listMcpServersWithEnabledToolCounts(), listAIAssistantSummaries()]);
      if (!canCommitPresentationLoad(mountedRef.current, loadRevisionRef.current, loadRevision)) return;
      setError(null);
      setServers(rows);
      setAssistants(options);
    } catch (loadError) {
      if (!canCommitPresentationLoad(mountedRef.current, loadRevisionRef.current, loadRevision)) return;
      setError(loadError instanceof Error ? loadError.message : 'MCP Server 列表暂时无法加载');
    }
  }, []);

  const toggleAssistant = useCallback(async (serverId: string, assistantId: string, enabled: boolean) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSavingServerId(serverId);
    // 过期列表读取不能覆盖刚提交的选择。
    loadRevisionRef.current += 1;
    try {
      const updated = await setMcpServerAssistantEnabled(serverId, assistantId, enabled);
      if (!mountedRef.current) return;
      setServers((current) => current!.map((server) => server.id === serverId ? { ...server, ...updated } : server));
      setError(null);
    } catch (saveError) {
      if (mountedRef.current) setError(saveError instanceof Error ? saveError.message : '生效 AI 保存失败');
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSavingServerId(null);
    }
  }, []);

  const toggleServer = useCallback(async (serverId: string, enabled: boolean) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSavingServerId(serverId);
    // 过期列表读取不能覆盖刚提交的开关。
    loadRevisionRef.current += 1;
    try {
      const updated = await setMcpServerEnabled(serverId, enabled);
      if (!mountedRef.current) return;
      setServers((current) => current!.map((server) => server.id === serverId
        ? { ...server, enabled: updated.enabled } : server));
      setError(null);
    } catch (saveError) {
      if (mountedRef.current) setError(saveError instanceof Error ? saveError.message : '服务开关保存失败');
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSavingServerId(null);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      loadRevisionRef.current += 1;
    };
  }, [load]);
  useEffect(() => {
    if (previousRefreshRevisionRef.current === refreshRevision) return;
    previousRefreshRevisionRef.current = refreshRevision;
    void load();
  }, [load, refreshRevision]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <NavigationHeader title="MCP 工具" onGoBack={onBack} rightButton={
        <HeaderAddButton accessibilityLabel="添加 MCP Server" onPress={onAddServer} />
      } help={{ sections: [
        { title: '连接与授权', body: '连接 MCP 服务并选择生效 AI，只有勾选的 AI 可使用。' },
        { title: '服务开关', body: '开关即时启用或关闭整个 Server，需先完成连接测试；点击下方说明行进入配置。' },
        { title: '修改生效 AI', body: '点击列表中的“生效 AI”展开修改，勾选即时保存。' },
      ] }} />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scrollContent}
      >
        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {servers === null ? (
          <ActivityIndicator style={styles.loading} />
        ) : servers.length === 0 ? (
          <EmptyState
            title="还没有 MCP Server"
            description="点击右上角 + 添加一个支持 Streamable HTTP 的 Server，并选择可使用它的 AI。"
          />
        ) : (
          <ThemedSurface variant="card" style={styles.listCard}>
            {servers.map((server, index) => {
              const statusColor = CONNECTION_STATUS_COLORS[server.connectionStatus];
              return (
                <View key={server.id} style={[styles.server, index === servers.length - 1 && styles.itemLast]}>
                  <ToggleDetailRow title={server.name}
                    detail={<View style={styles.itemMeta}>
                      <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                      <Text style={styles.itemStatus}>
                        {CONNECTION_STATUS_LABELS[server.connectionStatus]}
                      </Text>
                      <Text style={styles.enabledText}>
                        {server.enabledToolCount} 个已授权工具
                      </Text>
                    </View>}
                    value={server.enabled}
                    disabled={savingServerId !== null || server.connectionStatus !== 'available'}
                    toggleAccessibilityLabel={`启用${server.name}`}
                    detailAccessibilityLabel={`打开${server.name}配置`}
                    onValueChange={(enabled) => { void toggleServer(server.id, enabled); }}
                    onOpenDetail={() => onOpenServer(server.id)} />
                  <View style={styles.selection}>
                    <McpAssistantSelection assistants={assistants} selectedIds={server.assistantIds}
                      collapsible
                      disabled={savingServerId !== null} onToggle={(assistantId, enabled) => {
                        void toggleAssistant(server.id, assistantId, enabled);
                      }} />
                  </View>
                </View>
              );
            })}
          </ThemedSurface>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
