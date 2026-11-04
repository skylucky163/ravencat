/** MCP Server 配置仓储 port；SQLite 实现位于同 Feature infrastructure。 */

import type { McpServerConfig, McpServerAuthMode } from './McpServerConfig';

export interface SaveMcpServerInput {
  id: string | null;
  name: string;
  url: string;
  description: string;
  assistantIds: readonly string[];
  authMode: McpServerAuthMode;
  credentialRef: string | null;
  endpointClass: string;
  expectedConnection: { url: string; credentialRef: string | null } | null;
  enabled: boolean;
  nowIso: string;
}

/**
 * 一次连接测试成功后提交的完整事实；server 快照、协议诊断、可用状态与授权
 * 必须由同一个 repository 事务一起提交，避免出现“快照已换但 grants 仍是旧工具”。
 */
export interface CommitMcpConnectionSuccessInput {
  id: string;
  expectedUrl: string;
  expectedCredentialRef: string | null;
  toolSnapshotJson: string;
  lastNegotiatedProtocolVersion: string;
  lastProtocolEra: string;
  endpointClass: string;
  nowIso: string;
  tools: readonly {
    remoteToolName: string;
    localToolName: string;
    schemaFingerprint: string;
  }[];
}

export interface McpServerConfigRepository {
  list(): Promise<McpServerConfig[]>;
  getById(id: string): Promise<McpServerConfig | null>;
  save(input: SaveMcpServerInput): Promise<McpServerConfig>;
  /** 返回同一事务删除的配置，供 application 在 commit 后回收准确的凭据引用。 */
  delete(id: string): Promise<McpServerConfig | null>;
  /** 失败只更新尚未验证成功的连接；另一条测试或较晚结束的失败不能覆盖 available。 */
  recordConnectionFailure(input: {
    id: string;
    expectedUrl: string;
    expectedCredentialRef: string | null;
    connectionStatus: 'unavailable' | 'authentication_required';
    lastErrorCode: string;
    nowIso: string;
  }): Promise<void>;
  updateEnabled(id: string, enabled: boolean, nowIso: string): Promise<McpServerConfig | null>;
  /** 单个对象的修改在事务中提交，不覆盖其他对象的并发选择。 */
  updateAssistantEnabled(id: string, assistantId: string, enabled: boolean, nowIso: string): Promise<McpServerConfig | null>;
  commitConnectionSuccess(
    input: CommitMcpConnectionSuccessInput
  ): Promise<McpServerConfig | null>;
  /**
   * URL/认证身份变化的原子失效：
   * 在同一个 SQLite 事务中更新显示名称、规范化 URL 与凭据引用、强制 enabled=false、
   * 重置连接状态为 unverified、清空所有连接诊断与工具快照，
   * 并删除该 Server 的全部工具授权。
   * 任一步失败整体回滚，不允许出现 enabled=true + unverified 的半更新状态。
   * 注意：编辑 URL 不得先执行普通 save()，否则会出现 URL 已变但 enabled 仍为 true 的中间态。
   */
  invalidateAndUpdateEndpoint(input: {
    id: string;
    name: string;
    url: string;
    description: string;
    assistantIds: readonly string[];
    authMode: McpServerAuthMode;
    credentialRef: string | null;
    expectedConnection: { url: string; credentialRef: string | null };
    endpointClass: string;
    nowIso: string;
  }): Promise<McpServerConfig | null>;
}
