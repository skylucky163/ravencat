/** MCP 工具授权的 SQLite 适配器；只保存本地授权、本地名称与 schema fingerprint。 */

import { databaseCoordinator } from '@platform/persistence';
import {
  createMcpToolGrantFromRow,
  type McpToolGrant,
  type McpToolGrantRow,
} from '../domain/McpToolGrant';
import type {
  McpToolGrantRepository,
  UpsertMcpToolGrantInput,
} from '../domain/McpToolGrantRepository';

export class SQLiteMcpToolGrantRepository implements McpToolGrantRepository {
  async listByServer(serverId: string): Promise<McpToolGrant[]> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'mcpTools.listByServer', feature: 'mcpTools', priority: 'runtime' });
    const rows = await db.getAllAsync<McpToolGrantRow>(
      'SELECT * FROM mcp_tool_grants WHERE server_id = ? ORDER BY remote_tool_name ASC',
      [serverId]
    );
    return rows
      .map(createMcpToolGrantFromRow)
      .filter((grant): grant is McpToolGrant => grant !== null);
  }

  async listEnabledByServer(serverId: string): Promise<McpToolGrant[]> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'mcpTools.listEnabledByServer', feature: 'mcpTools', priority: 'runtime' });
    const rows = await db.getAllAsync<McpToolGrantRow>(
      'SELECT * FROM mcp_tool_grants WHERE server_id = ? AND enabled = 1 ORDER BY local_tool_name ASC',
      [serverId]
    );
    return rows
      .map(createMcpToolGrantFromRow)
      .filter((grant): grant is McpToolGrant => grant !== null);
  }

  async upsert(input: UpsertMcpToolGrantInput): Promise<McpToolGrant> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'mcpTools.upsert', feature: 'mcpTools', priority: 'runtime' });
    await db.runAsync(
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
        input.serverId,
        input.remoteToolName,
        input.localToolName,
        input.enabled ? 1 : 0,
        input.schemaFingerprint,
        input.updatedAt,
      ]
    );
    const row = await db.getFirstAsync<McpToolGrantRow>(
      'SELECT * FROM mcp_tool_grants WHERE server_id = ? AND remote_tool_name = ? LIMIT 1',
      [input.serverId, input.remoteToolName]
    );
    const grant = createMcpToolGrantFromRow(row);
    if (!grant) {
      throw new Error('MCP 工具授权保存后无法读取记录');
    }
    return grant;
  }
}

export const sqliteMcpToolGrantRepository = new SQLiteMcpToolGrantRepository();
