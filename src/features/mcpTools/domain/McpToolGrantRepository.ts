/** MCP 工具授权仓储 port；SQLite 实现位于同 Feature infrastructure。 */

import type { McpToolGrant } from './McpToolGrant';

export interface UpsertMcpToolGrantInput {
  serverId: string;
  remoteToolName: string;
  localToolName: string;
  enabled: boolean;
  schemaFingerprint: string;
  updatedAt: string;
}

export interface McpToolGrantRepository {
  listByServer(serverId: string): Promise<McpToolGrant[]>;
  listEnabledByServer(serverId: string): Promise<McpToolGrant[]>;
  upsert(input: UpsertMcpToolGrantInput): Promise<McpToolGrant>;
}
