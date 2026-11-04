/** MCP Server 配置的 SQLite 适配器；仅保存元数据、诊断与状态，不保存任何凭据明文。 */

import { databaseCoordinator } from '@platform/persistence';
import {
  createMcpServerConfigFromRow,
  type McpServerConfig,
  type McpServerConfigRow,
  type McpServerAuthMode,
} from '../domain/McpServerConfig';
import type {
  CommitMcpConnectionSuccessInput,
  McpServerConfigRepository,
  SaveMcpServerInput,
} from '../domain/McpServerConfigRepository';
import { McpConfigError } from '../application/McpConfigError';

// 从关联表聚合生效对象；没有授权的服务返回空数组，不继承全局权限。
const SERVER_SELECT = `SELECT mcp_servers.*, (
  SELECT json_group_array(assistant_id) FROM (
    SELECT assistant_id FROM mcp_server_assistants
    WHERE server_id = mcp_servers.id ORDER BY assistant_id
  )
) AS assistant_ids_json FROM mcp_servers`;

export class SQLiteMcpServerConfigRepository implements McpServerConfigRepository {
  async list(): Promise<McpServerConfig[]> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'mcpTools.list', feature: 'mcpTools', priority: 'runtime' });
    const rows = await db.getAllAsync<McpServerConfigRow>(
      `${SERVER_SELECT} ORDER BY created_at ASC, id ASC`
    );
    return rows
      .map(createMcpServerConfigFromRow)
      .filter((server): server is McpServerConfig => server !== null);
  }

  async getById(id: string): Promise<McpServerConfig | null> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'mcpTools.getById', feature: 'mcpTools', priority: 'runtime' });
    const row = await db.getFirstAsync<McpServerConfigRow>(
      `${SERVER_SELECT} WHERE id = ? LIMIT 1`,
      [id]
    );
    return createMcpServerConfigFromRow(row);
  }

  async save(input: SaveMcpServerInput): Promise<McpServerConfig> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'mcpTools.save', feature: 'mcpTools', priority: 'runtime' });
    const id = input.id ?? `mcp_server_${Math.random().toString(36).slice(2, 10)}`;
    // 写入和返回记录共用事务；抛错意味着凭据引用尚未发布，application 才能安全回收。
    return db.withExclusiveTransactionAsync(async (transaction) => {
      if (input.id) {
        const result = await transaction.runAsync(
          `UPDATE mcp_servers
           SET name = ?, url = ?, description = ?, auth_mode = ?, credential_ref = ?,
               enabled = ?, endpoint_class = ?, updated_at = ?
           WHERE id = ? AND url = ? AND credential_ref IS ?`,
          [
            input.name,
            input.url,
            input.description,
            input.authMode,
            input.credentialRef,
            input.enabled ? 1 : 0,
            input.endpointClass,
            input.nowIso,
            id,
            input.expectedConnection!.url,
            input.expectedConnection!.credentialRef,
          ]
        );
        if (result.changes !== 1) throw new McpConfigError('CONFIG_CHANGED', '服务已删除或连接配置已改变，请重新打开配置页');
      } else {
        await transaction.runAsync(
          `INSERT INTO mcp_servers (
             id, name, url, description, transport, auth_mode, credential_ref,
             enabled, connection_status, endpoint_class, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'streamable_http', ?, ?, ?, 'unverified', ?, ?, ?)`,
          [
            id,
            input.name,
            input.url,
            input.description,
            input.authMode,
            input.credentialRef,
            input.enabled ? 1 : 0,
            input.endpointClass,
            input.nowIso,
            input.nowIso,
          ]
        );
      }
      await transaction.runAsync('DELETE FROM mcp_server_assistants WHERE server_id = ?', [id]);
      for (const assistantId of input.assistantIds) {
        await transaction.runAsync(
          'INSERT INTO mcp_server_assistants (server_id, assistant_id) VALUES (?, ?)', [id, assistantId],
        );
      }
      const saved = createMcpServerConfigFromRow(await transaction.getFirstAsync<McpServerConfigRow>(
        `${SERVER_SELECT} WHERE id = ?`, [id]
      ));
      if (!saved) throw new Error('MCP Server 保存后无法读取记录');
      return saved;
    });
  }

  async delete(id: string): Promise<McpServerConfig | null> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'mcpTools.delete', feature: 'mcpTools', priority: 'runtime' });
    return db.withExclusiveTransactionAsync(async (transaction) => {
      const deleted = createMcpServerConfigFromRow(await transaction.getFirstAsync<McpServerConfigRow>(
        `${SERVER_SELECT} WHERE id = ?`, [id]
      ));
      if (!deleted) return null;
      await transaction.runAsync('DELETE FROM mcp_tool_grants WHERE server_id = ?', [id]);
      await transaction.runAsync('DELETE FROM mcp_servers WHERE id = ?', [id]);
      return deleted;
    });
  }

  async recordConnectionFailure(input: {
    id: string;
    expectedUrl: string;
    expectedCredentialRef: string | null;
    connectionStatus: 'unavailable' | 'authentication_required';
    lastErrorCode: string;
    nowIso: string;
  }): Promise<void> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'mcpTools.recordConnectionFailure', feature: 'mcpTools', priority: 'runtime' });
    // 由数据库在写入时判断，不能使用网络请求前读到的状态决定是否覆盖成功链路。
    await db.runAsync(
      `UPDATE mcp_servers
       SET connection_status = ?, last_connected_at = NULL, last_error_code = ?,
           updated_at = ?
       WHERE id = ? AND url = ? AND credential_ref IS ? AND connection_status <> 'available'`,
      [
        input.connectionStatus,
        input.lastErrorCode,
        input.nowIso,
        input.id,
        input.expectedUrl,
        input.expectedCredentialRef,
      ]
    );
  }

  async updateEnabled(id: string, enabled: boolean, nowIso: string): Promise<McpServerConfig | null> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'mcpTools.updateEnabled', feature: 'mcpTools', priority: 'runtime' });
    await db.runAsync(
      'UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?',
      [enabled ? 1 : 0, nowIso, id]
    );
    return this.getById(id);
  }

  async updateAssistantEnabled(id: string, assistantId: string, enabled: boolean, nowIso: string): Promise<McpServerConfig | null> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'mcpTools.updateAssistantEnabled', feature: 'mcpTools', priority: 'runtime' });
    return db.withExclusiveTransactionAsync(async (transaction) => {
      const result = await transaction.runAsync('UPDATE mcp_servers SET updated_at = ? WHERE id = ?', [nowIso, id]);
      if (result.changes === 0) return null;
      if (enabled) {
        await transaction.runAsync(
          'INSERT INTO mcp_server_assistants (server_id, assistant_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
          [id, assistantId],
        );
      } else {
        await transaction.runAsync('DELETE FROM mcp_server_assistants WHERE server_id = ? AND assistant_id = ?', [id, assistantId]);
      }
      return createMcpServerConfigFromRow(await transaction.getFirstAsync<McpServerConfigRow>(`${SERVER_SELECT} WHERE id = ?`, [id]));
    });
  }

  async commitConnectionSuccess(
    input: CommitMcpConnectionSuccessInput
  ): Promise<McpServerConfig | null> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'mcpTools.commitConnectionSuccess', feature: 'mcpTools', priority: 'runtime' });
    const committed = await db.withExclusiveTransactionAsync(async (transaction) => {
      const serverUpdate = await transaction.runAsync(
        `UPDATE mcp_servers
         SET tool_snapshot_json = ?,
             last_negotiated_protocol_version = ?,
             last_protocol_family = ?,
             endpoint_class = ?,
             connection_status = 'available',
             enabled = 1,
             last_connected_at = ?,
             last_error_code = NULL,
             updated_at = ?
         WHERE id = ? AND url = ? AND credential_ref IS ?`,
        [
          input.toolSnapshotJson,
          input.lastNegotiatedProtocolVersion,
          input.lastProtocolEra,
          input.endpointClass,
          input.nowIso,
          input.nowIso,
          input.id,
          input.expectedUrl,
          input.expectedCredentialRef,
        ]
      );
      if (serverUpdate.changes !== 1) {
        return false;
      }

      const existingRows = await transaction.getAllAsync<{
        remote_tool_name: string;
        enabled: number;
      }>(
        `SELECT remote_tool_name, enabled
         FROM mcp_tool_grants
         WHERE server_id = ?`,
        [input.id]
      );
      const existingEnabledByRemote = new Map(
        existingRows.map((row) => [row.remote_tool_name, row.enabled === 1])
      );

      for (const tool of input.tools) {
        const enabled = existingEnabledByRemote.get(tool.remoteToolName) ?? true;
        await transaction.runAsync(
          `INSERT INTO mcp_tool_grants (
             server_id, remote_tool_name, local_tool_name, enabled,
             schema_fingerprint, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (server_id, remote_tool_name) DO UPDATE SET
             local_tool_name = excluded.local_tool_name,
             enabled = excluded.enabled,
             schema_fingerprint = excluded.schema_fingerprint,
             updated_at = excluded.updated_at`,
          [
            input.id,
            tool.remoteToolName,
            tool.localToolName,
            enabled ? 1 : 0,
            tool.schemaFingerprint,
            input.nowIso,
          ]
        );
      }

      if (input.tools.length === 0) {
        await transaction.runAsync(
          'DELETE FROM mcp_tool_grants WHERE server_id = ?',
          [input.id]
        );
      } else {
        const placeholders = input.tools.map(() => '?').join(', ');
        await transaction.runAsync(
          `DELETE FROM mcp_tool_grants
           WHERE server_id = ?
             AND remote_tool_name NOT IN (${placeholders})`,
          [input.id, ...input.tools.map((tool) => tool.remoteToolName)]
        );
      }
      return true;
    });
    return committed ? this.getById(input.id) : null;
  }

  async invalidateAndUpdateEndpoint(input: {
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
  }): Promise<McpServerConfig | null> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'mcpTools.invalidateAndUpdateEndpoint', feature: 'mcpTools', priority: 'runtime' });
    // 单个事务内完成 URL/认证身份变更的全部失效语义：更新名称、URL 与凭据引用、
    // 强制 enabled=false、重置连接状态、清空诊断与快照、删除全部 grants。
    // 任一步失败整体回滚，杜绝 enabled=true + unverified 的半更新状态。
    return db.withExclusiveTransactionAsync(async (transaction) => {
      const updated = await transaction.runAsync(
        `UPDATE mcp_servers
         SET name = ?, url = ?, description = ?, auth_mode = ?, credential_ref = ?, enabled = 0,
             connection_status = 'unverified',
             last_connected_at = NULL,
             last_error_code = NULL,
             last_negotiated_protocol_version = NULL,
             last_protocol_family = NULL,
             tool_snapshot_json = '{}',
             endpoint_class = ?,
             updated_at = ?
         WHERE id = ? AND url = ? AND credential_ref IS ?`,
        [
          input.name,
          input.url,
          input.description,
          input.authMode,
          input.credentialRef,
          input.endpointClass,
          input.nowIso,
          input.id,
          input.expectedConnection.url,
          input.expectedConnection.credentialRef,
        ]
      );
      if (updated.changes !== 1) return null;
      await transaction.runAsync('DELETE FROM mcp_server_assistants WHERE server_id = ?', [input.id]);
      for (const assistantId of input.assistantIds) {
        await transaction.runAsync('INSERT INTO mcp_server_assistants (server_id, assistant_id) VALUES (?, ?)', [input.id, assistantId]);
      }
      await transaction.runAsync('DELETE FROM mcp_tool_grants WHERE server_id = ?', [input.id]);
      return createMcpServerConfigFromRow(await transaction.getFirstAsync<McpServerConfigRow>(
        `${SERVER_SELECT} WHERE id = ?`, [input.id]
      ));
    });
  }
}

export const sqliteMcpServerConfigRepository = new SQLiteMcpServerConfigRepository();
