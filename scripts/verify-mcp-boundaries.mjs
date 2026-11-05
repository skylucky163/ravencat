import { agentToolSchemaDependencies } from './helpers/agent-tool-schema-dependencies.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { DatabaseSync } from 'node:sqlite';
import React from 'react';
import { act, create } from 'react-test-renderer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function loadTypeScriptModule(relativePath, mocks = {}) {
  const absolutePath = path.join(repoRoot, relativePath);
  const compiled = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
    },
    fileName: absolutePath,
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(errors, [], `${relativePath} 无法编译`);

  const module = { exports: {} };
  const requireMock = (specifier) => {
    assert.ok(Object.hasOwn(mocks, specifier), `${relativePath} 存在未声明的运行时依赖：${specifier}`);
    return mocks[specifier];
  };
  const executeModule = new Function(
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    compiled.outputText,
  );
  executeModule(module.exports, requireMock, module, absolutePath, path.dirname(absolutePath));
  return module.exports;
}

const agentToolSchemaModule = loadTypeScriptModule('src/shared/aiTools/AgentToolInputSchema.ts', agentToolSchemaDependencies);

const configErrorModule = loadTypeScriptModule(
  'src/features/mcpTools/application/McpConfigError.ts',
);
const { validateMcpServerEndpoint } = loadTypeScriptModule(
  'src/features/mcpTools/application/McpEndpointValidator.ts',
  { './McpConfigError': configErrorModule },
);

function assertEndpointRejected(url, label) {
  assert.throws(
    () => validateMcpServerEndpoint(url),
    (error) => error?.code === 'URL_PROTOCOL',
    `${label} 必须被端点策略拒绝`,
  );
}

assert.equal(
  validateMcpServerEndpoint('http://[fc00::1]:3000/mcp').endpointClass,
  'private_http',
  'fc00::/7 内的 ULA 必须允许 private http',
);
assert.equal(
  validateMcpServerEndpoint('http://[fd7a:115c:a1e0::1]:3000/mcp').endpointClass,
  'private_http',
  'fd7a:115c:a1e0::/48 必须允许 private http',
);
assertEndpointRejected('http://[fc::1]:3000/mcp', 'fc::/64');
assertEndpointRejected('http://[fe00::1]:3000/mcp', 'fe00::/64');
assert.equal(
  validateMcpServerEndpoint('http://[::1]:3000/mcp').endpointClass,
  'loopback_http',
  '精确 IPv6 loopback 必须保留',
);
assertEndpointRejected('http://localhost.example/mcp', '伪装 localhost 的域名');
assertEndpointRejected('http://203.0.113.10:3000/mcp', '公网明文 http');

let savedServerInput;
let configuredServers = [];
const saveServerRuntime = {
  serverConfigRepository: {
    getById: async () => null,
    list: async () => configuredServers,
    save: async (input) => {
      savedServerInput = input;
      return {
        id: 'server-saved',
        ...input,
        transport: 'streamable_http',
        credentialRef: null,
        connectionStatus: 'unverified',
      };
    },
  },
};
const { saveMcpServer } = loadTypeScriptModule(
  'src/features/mcpTools/application/SaveMcpServer.ts',
  {
    './McpToolsRuntimeDependencies': {
      getMcpToolsRuntimeDependencies: () => saveServerRuntime,
    },
    './McpConfigError': configErrorModule,
    './McpEndpointValidator': { validateMcpServerEndpoint },
  },
);
await saveMcpServer({
  id: null,
  name: '  测试服务  ',
  url: 'https://mcp.example/mcp',
  description: '  第一行\r\n第二行  ',
  assistantIds: ['assistant-1'],
  enabled: false,
});
assert.equal(savedServerInput.name, '测试服务');
assert.equal(savedServerInput.description, '第一行\n第二行');
assert.equal(savedServerInput.enabled, true, '新增 MCP 服务保存后默认启用，连接验证独立控制工具暴露');
assert.deepEqual(savedServerInput.assistantIds, ['assistant-1']);
await assert.rejects(() => saveMcpServer({ id: null, name: '未授权服务', url: 'https://mcp.example/mcp',
  description: '', assistantIds: [], enabled: false }), (error) => error.code === 'ASSISTANT_REQUIRED',
  '首次保存不能跳过生效对象选择');

configuredServers = [{ id: 'other-server', name: '测试服务' }];
await assert.rejects(
  () => saveMcpServer({
    id: null,
    name: '测试服务',
    url: 'https://mcp.example/mcp',
    description: '',
    assistantIds: ['assistant-1'],
    enabled: false,
  }),
  (error) => error?.code === 'NAME_CONFLICT',
  '模型侧通过显示名选择服务，因此保存边界必须拒绝同名配置',
);
await assert.rejects(
  () => saveMcpServer({
    id: null,
    name: '测试服务\n伪造条目',
    url: 'https://mcp.example/mcp',
    description: '',
    enabled: false,
  }),
  (error) => error?.code === 'NAME_INVALID',
  '服务显示名不得通过换行伪造额外 Prompt 条目',
);

const currentGrantTool = {
  remoteName: 'search',
  localName: 'mcp_server_search',
  description: '搜索',
  schemaFingerprint: 'sha256:new',
};
const staleGrant = {
  serverId: 'server-1',
  remoteToolName: 'search',
  localToolName: 'mcp_server_search',
  enabled: true,
  schemaFingerprint: 'sha256:old',
  updatedAt: '2026-08-01T00:00:00.000Z',
};
const removedGrant = {
  ...staleGrant,
  remoteToolName: 'removed',
  localToolName: 'mcp_server_removed',
};
let savedGrantInput;
const grantRuntime = {
  serverConfigRepository: {
    getById: async () => ({ id: 'server-1', toolSnapshotJson: '{}' }),
  },
  toolGrantRepository: {
    listByServer: async () => [staleGrant, removedGrant],
    listEnabledByServer: async () => [staleGrant],
    upsert: async (input) => {
      savedGrantInput = input;
      return input;
    },
  },
};
const {
  listMcpDiscoveredToolGrants,
  setMcpToolGrant,
} = loadTypeScriptModule(
  'src/features/mcpTools/application/SetMcpToolGrant.ts',
  {
    './McpToolsRuntimeDependencies': {
      getMcpToolsRuntimeDependencies: () => grantRuntime,
    },
    './McpConfigError': configErrorModule,
    './McpDiscoverySnapshot': {
      parseMcpDiscoverySnapshot: () => ({ tools: [currentGrantTool] }),
    },
  },
);
const refreshedGrantViews = await listMcpDiscoveredToolGrants('server-1');
assert.deepEqual(
  refreshedGrantViews.map(({ remoteToolName, enabled, stale, canAuthorize }) => ({
    remoteToolName,
    enabled,
    stale,
    canAuthorize,
  })),
  [
    { remoteToolName: 'search', enabled: false, stale: true, canAuthorize: true },
    { remoteToolName: 'removed', enabled: false, stale: true, canAuthorize: false },
  ],
  'schema 变化的工具必须允许重新授权；已从快照消失的工具不得授权',
);
await setMcpToolGrant({
  serverId: 'server-1',
  remoteToolName: 'search',
  enabled: true,
});
assert.equal(savedGrantInput.enabled, true);
assert.equal(
  savedGrantInput.schemaFingerprint,
  currentGrantTool.schemaFingerprint,
  '用户重新授权时必须用当前快照指纹覆盖旧 grant',
);

// 连接成功只允许调用一次组合 commit：快照、协议、available/enabled 与本轮 grants
// 应由 repository 在同一事务内写入；这里用 24 个工具覆盖“无 20 个上限”的真实输入。
const discoveredTools = Array.from({ length: 24 }, (_, index) => ({
  name: `tool_${index}`,
  description: `工具 ${index}`,
  inputSchema: { type: 'object' },
}));
let connectionCommitInput;
let connectionStateUpdates = 0;
const successfulConnectionRuntime = {
  serverConfigRepository: {
    getById: async () => ({
      id: 'server-connection',
      url: 'https://mcp.example/mcp',
      enabled: false,
      connectionStatus: 'unverified',
    }),
    list: async () => [{ id: 'server-connection' }],
    commitConnectionSuccess: async (input) => {
      connectionCommitInput = input;
      return {
        id: input.id,
        url: 'https://mcp.example/mcp',
        enabled: true,
        connectionStatus: 'available',
      };
    },
    recordConnectionFailure: async () => {
      connectionStateUpdates += 1;
      return null;
    },
  },
  toolGrantRepository: {
    listByServer: async () => [],
  },
  createMcpClient: () => ({
    connect: async () => ({
      serverInfo: { name: 'test-server', version: '1.0.0' },
      protocolVersion: '2026-07-28',
      protocolEra: 'modern',
    }),
    listAllTools: async () => ({ tools: discoveredTools }),
    close: async () => undefined,
  }),
};
const { testMcpServerConnection } = loadTypeScriptModule(
  'src/features/mcpTools/application/TestMcpServerConnection.ts',
  {
    './ResolveMcpBearerToken': { resolveMcpBearerToken: async () => undefined },
    '@platform/mcp': {
      assertNoMcpInternalNameCollision: () => undefined,
      findMcpNamespaceConflict: () => null,
      isMcpClientError: () => false,
      standardizeMcpTool: (serverId, tool) => ({
        remoteName: tool.name,
        localName: `mcp.${serverId}.${tool.name}`,
        description: tool.description,
        inputSchema: tool.inputSchema,
        schemaFingerprint: `sha256:${tool.name.padEnd(64, '0')}`,
        annotations: null,
      }),
    },
    '../domain/McpServerConfig': {},
    './McpToolsRuntimeDependencies': {
      getMcpToolsRuntimeDependencies: () => successfulConnectionRuntime,
    },
    './McpConfigError': configErrorModule,
    './McpEndpointValidator': {
      validateMcpServerEndpoint: () => ({ endpointClass: 'public_https' }),
    },
  },
);
const successfulConnection = await testMcpServerConnection('server-connection', 'modern');
assert.equal(successfulConnection.tools.length, 24);
assert.equal(connectionStateUpdates, 0, '成功连接不得再通过第二次失败写入暴露中间态');
assert.equal(connectionCommitInput.id, 'server-connection');
assert.equal(connectionCommitInput.lastNegotiatedProtocolVersion, '2026-07-28');
assert.equal(connectionCommitInput.tools.length, 24, '组合 commit 必须接收完整发现结果，不得截断到 20 个');
assert.equal(connectionCommitInput.tools[0].remoteToolName, 'tool_0');

let failedConnectionCommitCount = 0;
let failedConnectionStateInput;
const failedConnectionRuntime = {
  ...successfulConnectionRuntime,
  serverConfigRepository: {
    ...successfulConnectionRuntime.serverConfigRepository,
    commitConnectionSuccess: async () => {
      failedConnectionCommitCount += 1;
      throw new Error('commit failed');
    },
    recordConnectionFailure: async (input) => {
      failedConnectionStateInput = input;
      return null;
    },
  },
  createMcpClient: () => ({
    connect: async () => ({
      serverInfo: null,
      protocolVersion: '2026-07-28',
      protocolEra: 'modern',
    }),
    listAllTools: async () => ({ tools: [] }),
    close: async () => undefined,
  }),
};
const failedConnectionModule = loadTypeScriptModule(
  'src/features/mcpTools/application/TestMcpServerConnection.ts',
  {
    './ResolveMcpBearerToken': { resolveMcpBearerToken: async () => undefined },
    '@platform/mcp': {
      assertNoMcpInternalNameCollision: () => undefined,
      findMcpNamespaceConflict: () => null,
      isMcpClientError: () => false,
      standardizeMcpTool: () => { throw new Error('not reached'); },
    },
    '../domain/McpServerConfig': {},
    './McpToolsRuntimeDependencies': {
      getMcpToolsRuntimeDependencies: () => failedConnectionRuntime,
    },
    './McpConfigError': configErrorModule,
    './McpEndpointValidator': {
      validateMcpServerEndpoint: () => ({ endpointClass: 'public_https' }),
    },
  },
);
await assert.rejects(
  () => failedConnectionModule.testMcpServerConnection('server-connection', 'modern'),
  /commit failed/u,
);
assert.equal(failedConnectionCommitCount, 1);
assert.equal(failedConnectionStateInput.connectionStatus, 'unavailable');

const enabledServerState = {
  id: 'server-empty',
  enabled: false,
  connectionStatus: 'available',
};
const { setMcpServerEnabled } = loadTypeScriptModule(
  'src/features/mcpTools/application/SetMcpServerEnabled.ts',
  {
    './McpToolsRuntimeDependencies': {
      getMcpToolsRuntimeDependencies: () => ({
        serverConfigRepository: {
          getById: async () => enabledServerState,
          updateEnabled: async (_id, enabled) => ({
            ...enabledServerState,
            enabled,
          }),
        },
        toolGrantRepository: {
          listEnabledByServer: async () => {
            throw new Error('启用 Server 不应再读取 grants 数量');
          },
        },
      }),
    },
    './McpConfigError': configErrorModule,
  },
);
const enabledEmptyServer = await setMcpServerEnabled('server-empty', true);
assert.equal(enabledEmptyServer.enabled, true, 'available 且零 grants 的 Server 也必须可以启用');

// 直接驱动 SQLite repository 的组合提交，验证事务输入、默认 enabled、用户意图保留、
// 消失工具删除以及超过旧 20 个上限的多工具快照。fake executor 只实现本测试涉及的 SQL，
// 事务成功才替换 state，因而也覆盖了 repository 的原子边界。
const sqliteState = {
  server: {
    id: 'server-sqlite',
    name: 'SQLite Server',
    url: 'https://mcp.example/mcp',
    description: '',
    transport: 'streamable_http',
    auth_mode: 'none',
    credential_ref: null,
    enabled: 0,
    connection_status: 'unverified',
    last_connected_at: null,
    last_error_code: 'OLD_ERROR',
    tool_snapshot_json: '{}',
    last_negotiated_protocol_version: null,
    last_protocol_family: null,
    endpoint_class: 'public_https',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  },
  grants: [
    {
      server_id: 'server-sqlite',
      remote_tool_name: 'preserve_enabled',
      local_tool_name: 'mcp.old.enabled',
      enabled: 1,
      schema_fingerprint: 'sha256:old-enabled',
      updated_at: '2026-08-01T00:00:00.000Z',
    },
    {
      server_id: 'server-sqlite',
      remote_tool_name: 'preserve_disabled',
      local_tool_name: 'mcp.old.disabled',
      enabled: 0,
      schema_fingerprint: 'sha256:old-disabled',
      updated_at: '2026-08-01T00:00:00.000Z',
    },
    {
      server_id: 'server-sqlite',
      remote_tool_name: 'disappeared',
      local_tool_name: 'mcp.old.disappeared',
      enabled: 1,
      schema_fingerprint: 'sha256:old-disappeared',
      updated_at: '2026-08-01T00:00:00.000Z',
    },
  ],
};
const cloneSqliteState = (value) => structuredClone(value);
const mapSqliteServer = (row) => (row ? {
  id: row.id,
  name: row.name,
  url: row.url,
  description: row.description,
  transport: 'streamable_http',
  authMode: 'none',
  credentialRef: row.credential_ref,
  enabled: row.enabled === 1,
  connectionStatus: row.connection_status,
  lastConnectedAt: row.last_connected_at,
  lastErrorCode: row.last_error_code,
  toolSnapshotJson: row.tool_snapshot_json,
  lastNegotiatedProtocolVersion: row.last_negotiated_protocol_version,
  lastProtocolEra: row.last_protocol_family,
  endpointClass: row.endpoint_class,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
} : null);
const sqliteExecutor = {
  getFirstAsync: async (_sql, params = []) => {
    assert.equal(params.length, 1);
    return sqliteState.server.id === params[0] ? { ...sqliteState.server } : null;
  },
  getAllAsync: async () => [],
  runAsync: async () => ({ changes: 0 }),
  execAsync: async () => undefined,
  withExclusiveTransactionAsync: async (task) => {
    const working = cloneSqliteState(sqliteState);
    const tx = {
      getFirstAsync: async (_sql, params = []) => (
        working.server.id === params[0] ? { ...working.server } : null
      ),
      getAllAsync: async (sql, params = []) => {
        if (/SELECT remote_tool_name,\s*enabled\s+FROM mcp_tool_grants/u.test(sql)) {
          return working.grants
            .filter((grant) => grant.server_id === params[0])
            .map(({ remote_tool_name, enabled }) => ({ remote_tool_name, enabled }));
        }
        throw new Error(`未模拟的事务查询：${sql}`);
      },
      runAsync: async (sql, params = []) => {
        if (sql.startsWith('UPDATE mcp_servers')) {
          const [snapshot, protocolVersion, protocolEra, endpointClass, connectedAt, updatedAt, id, expectedUrl, expectedCredentialRef] = params;
          if (working.server.id !== id || working.server.url !== expectedUrl || working.server.credential_ref !== expectedCredentialRef) {
            return { changes: 0 };
          }
          Object.assign(working.server, {
            tool_snapshot_json: snapshot,
            last_negotiated_protocol_version: protocolVersion,
            last_protocol_family: protocolEra,
            endpoint_class: endpointClass,
            connection_status: 'available',
            enabled: 1,
            last_connected_at: connectedAt,
            last_error_code: null,
            updated_at: updatedAt,
          });
          return { changes: 1 };
        }
        if (sql.startsWith('INSERT INTO mcp_tool_grants')) {
          const [serverId, remoteName, localName, enabled, fingerprint, updatedAt] = params;
          const existing = working.grants.find((grant) => (
            grant.server_id === serverId && grant.remote_tool_name === remoteName
          ));
          if (existing) {
            Object.assign(existing, {
              local_tool_name: localName,
              enabled,
              schema_fingerprint: fingerprint,
              updated_at: updatedAt,
            });
          } else {
            working.grants.push({
              server_id: serverId,
              remote_tool_name: remoteName,
              local_tool_name: localName,
              enabled,
              schema_fingerprint: fingerprint,
              updated_at: updatedAt,
            });
          }
          return { changes: 1 };
        }
        if (sql === 'DELETE FROM mcp_tool_grants WHERE server_id = ?') {
          working.grants = working.grants.filter((grant) => grant.server_id !== params[0]);
          return { changes: 1 };
        }
        if (sql.startsWith('DELETE FROM mcp_tool_grants') && sql.includes('NOT IN')) {
          const [serverId, ...remoteNames] = params;
          working.grants = working.grants.filter((grant) => (
            grant.server_id !== serverId || remoteNames.includes(grant.remote_tool_name)
          ));
          return { changes: 1 };
        }
        throw new Error(`未模拟的事务写入：${sql}`);
      },
    };
    const result = await task(tx);
    sqliteState.server = working.server;
    sqliteState.grants = working.grants;
    return result;
  },
};
const { SQLiteMcpServerConfigRepository } = loadTypeScriptModule(
  'src/features/mcpTools/infrastructure/SQLiteMcpServerConfigRepository.ts',
  {
    '../application/McpConfigError': configErrorModule,
    '@platform/persistence': {
      databaseCoordinator: {
        openTaskExecutor: () => sqliteExecutor,
      },
    },
    '../domain/McpServerConfig': {
      createMcpServerConfigFromRow: mapSqliteServer,
    },
  },
);
const sqliteRepository = new SQLiteMcpServerConfigRepository();
const sqliteTools = [
  {
    remoteToolName: 'preserve_enabled',
    localToolName: 'mcp.current.enabled',
    schemaFingerprint: 'sha256:new-enabled',
  },
  {
    remoteToolName: 'preserve_disabled',
    localToolName: 'mcp.current.disabled',
    schemaFingerprint: 'sha256:new-disabled',
  },
  ...Array.from({ length: 22 }, (_, index) => ({
    remoteToolName: `new_tool_${index}`,
    localToolName: `mcp.current.new_${index}`,
    schemaFingerprint: `sha256:new-${index}`,
  })),
];
const committedSqliteServer = await sqliteRepository.commitConnectionSuccess({
  id: 'server-sqlite',
  expectedUrl: 'https://mcp.example/mcp',
  expectedCredentialRef: null,
  toolSnapshotJson: JSON.stringify({ tools: sqliteTools }),
  lastNegotiatedProtocolVersion: '2026-07-28',
  lastProtocolEra: 'modern',
  endpointClass: 'public_https',
  nowIso: '2026-08-24T00:00:00.000Z',
  tools: sqliteTools,
});
assert.equal(committedSqliteServer.enabled, true);
assert.equal(committedSqliteServer.connectionStatus, 'available');
assert.equal(sqliteState.grants.length, 24, '本轮 24 个工具必须全部进入 grants，不能受旧 20 上限影响');
const preservedEnabled = sqliteState.grants.find((grant) => grant.remote_tool_name === 'preserve_enabled');
const preservedDisabled = sqliteState.grants.find((grant) => grant.remote_tool_name === 'preserve_disabled');
assert.equal(preservedEnabled.enabled, 1, '已有 enabled=true grant 必须保留用户意图');
assert.equal(preservedEnabled.local_tool_name, 'mcp.current.enabled');
assert.equal(preservedEnabled.schema_fingerprint, 'sha256:new-enabled');
assert.equal(preservedDisabled.enabled, 0, '已有 enabled=false grant 必须保留用户意图');
assert.equal(sqliteState.grants.some((grant) => grant.remote_tool_name === 'disappeared'), false);
await sqliteRepository.commitConnectionSuccess({
  id: 'server-sqlite',
  expectedUrl: 'https://mcp.example/mcp',
  expectedCredentialRef: null,
  toolSnapshotJson: JSON.stringify({ tools: [] }),
  lastNegotiatedProtocolVersion: '2026-07-28',
  lastProtocolEra: 'modern',
  endpointClass: 'public_https',
  nowIso: '2026-08-24T00:01:00.000Z',
  tools: [],
});
assert.equal(sqliteState.server.enabled, 1, '无工具快照的 available Server 仍保持可启用');
assert.equal(sqliteState.grants.length, 0, '工具消失后必须删除全部旧 grants');

class TestMcpClientError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const { McpRunClientPool } = loadTypeScriptModule(
  'src/host/composition/agent/McpRunClientPool.ts',
  { '@platform/mcp': { McpClientError: TestMcpClientError } },
);

const createdClients = [];
const createClient = (url, knownProtocol) => {
  const client = {
    url,
    knownProtocol,
    closeCount: 0,
    connect(signal) {
      assert.ok(signal instanceof AbortSignal, '连接必须接收 AbortSignal');
      return Promise.resolve({
        protocolEra: knownProtocol?.protocolEra ?? 'modern',
        protocolVersion: knownProtocol?.protocolVersion ?? '2026-07-28',
      });
    },
    close() {
      this.closeCount += 1;
      return Promise.resolve();
    },
  };
  createdClients.push(client);
  return client;
};

const pool = new McpRunClientPool(createClient);
const firstSignal = new AbortController().signal;
const secondSignal = new AbortController().signal;
const knownProtocol = { protocolEra: 'legacy', protocolVersion: '2025-11-25' };
const firstClient = await pool.getConnected('http://server.test/mcp', knownProtocol, firstSignal);
const secondClient = await pool.getConnected('http://server.test/mcp', knownProtocol, secondSignal);
assert.equal(firstClient, secondClient, '同一 run 内同一 Server 必须复用 client 实例');
assert.equal(createdClients.length, 1, '同一 Server 不得重复创建 client');
await pool.dispose();
await pool.dispose();
assert.equal(firstClient.closeCount, 1, 'run 结束必须只关闭每个 client 一次');
await assert.rejects(
  () => pool.getConnected('http://server.test/mcp', knownProtocol, firstSignal),
  (error) => error?.code === 'TRANSPORT_FAILED',
  'dispose 后不得重新取得连接',
);

const toolDefinition = {
  serverId: 'server-1',
  serverName: '测试 Server',
  serverDescription: '测试服务',
  serverUrl: 'http://192.168.1.2:3000/mcp',
  protocolEra: 'legacy',
  protocolVersion: '2025-11-25',
  remoteToolName: 'lookup',
  localToolName: 'mcp_server_1_lookup',
  description: '查询',
  inputSchema: { type: 'object' },
  schemaFingerprint: 'fingerprint',
};

const {
  createMcpMetaTools,
} = loadTypeScriptModule(
  'src/host/composition/agent/McpAgentTool.ts',
  {
    '@shared/aiTools': agentToolSchemaModule,
    '@platform/mcp': {
      isMcpClientError: () => false,
    },
  },
);
const metaDefinition = {
  ...toolDefinition,
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
};
const metaCalls = [];
const metaPool = {
  getConnected: async (_url, _knownProtocol, signal) => {
    metaCalls.push({ phase: 'connect', signal });
    return {
      callTool: async (name, input, callSignal, options) => {
        metaCalls.push({ name, input, signal: callSignal, options });
        return { content: [{ type: 'text', text: 'meta-ok' }], isError: false };
      },
    };
  },
};
const [listMetaTool, callMetaTool] = createMcpMetaTools({
  frozen: [metaDefinition],
  clients: metaPool,
});
const metaContext = { abortSignal: new AbortController().signal };
const serviceSummary = await listMetaTool.execute({}, metaContext);
assert.equal(serviceSummary.status, 'success');
assert.match(serviceSummary.modelContent, /测试 Server/u);
assert.doesNotMatch(serviceSummary.modelContent, /lookup/u, '不指定服务时只返回服务摘要，不泄漏工具目录');
const toolDirectory = await listMetaTool.execute({ serverName: '测试 Server' }, metaContext);
assert.equal(toolDirectory.status, 'success');
assert.match(toolDirectory.modelContent, /lookup/u);
assert.match(toolDirectory.modelContent, /参数 schema/u);
const invalidMetaCall = await callMetaTool.execute({
  serverName: '测试 Server',
  remoteToolName: 'lookup',
  arguments: { query: 1 },
}, metaContext);
assert.equal(invalidMetaCall.status, 'error');
assert.equal(metaCalls.length, 0, '具体 schema 校验失败时不得触网');
const validMetaCall = await callMetaTool.execute({
  serverName: '测试 Server',
  remoteToolName: 'lookup',
  arguments: { query: 'hello' },
}, metaContext);
assert.equal(validMetaCall.status, 'success');
assert.equal(metaCalls[1].name, 'lookup');
assert.deepEqual(
  metaCalls.slice(-2).map(({ signal }) => signal),
  [metaContext.abortSignal, metaContext.abortSignal],
  'MCP meta-tool 必须把同一个 abort signal 传给 connect/callTool',
);
assert.deepEqual(metaCalls[1].options, { inputSchema: metaDefinition.inputSchema });
const duplicateMetaTool = createMcpMetaTools({
  frozen: [metaDefinition, { ...metaDefinition, serverId: 'server-2' }],
  clients: metaPool,
})[1];
const duplicateResult = await duplicateMetaTool.execute({
  serverName: '测试 Server',
  remoteToolName: 'lookup',
  arguments: { query: 'hello' },
}, metaContext);
assert.equal(duplicateResult.status, 'error');
assert.equal(duplicateResult.code, 'MCP_SERVER_AMBIGUOUS');
const throwingMetaTool = createMcpMetaTools({
  frozen: [metaDefinition],
  clients: { getConnected: async () => { throw new Error('programming bug'); } },
})[1];
await assert.rejects(
  () => throwingMetaTool.execute({
    serverName: '测试 Server',
    remoteToolName: 'lookup',
    arguments: { query: 'hello' },
  }, metaContext),
  /programming bug/u,
  '未知编程错误不得被 meta-tool 静默转换',
);

const mcpClientErrorModule = loadTypeScriptModule(
  'src/platform/mcp/McpClientError.ts',
);
const mcpHttpModule = loadTypeScriptModule(
  'src/platform/mcp/internal/httpJsonRpc.ts',
  { '../McpClientError': mcpClientErrorModule },
);
const {
  buildMcpParameterHeaders,
  encodeMcpHeaderValue,
  listAllMcpTools,
  McpHttpJsonRpcTransport,
} = mcpHttpModule;
const mcpProtocolTypesModule = loadTypeScriptModule(
  'src/platform/mcp/McpProtocolTypes.ts',
);
const mcpServerInfoModule = loadTypeScriptModule(
  'src/platform/mcp/McpServerInfo.ts',
);
const mcpToolStandardizationModule = loadTypeScriptModule(
  'src/platform/mcp/McpToolStandardization.ts',
  {
    '@shared/aiTools': agentToolSchemaModule, './McpClientError': mcpClientErrorModule },
);
const { parseMcpDiscoverySnapshot } = loadTypeScriptModule(
  'src/features/mcpTools/application/McpDiscoverySnapshot.ts',
  {
    '@platform/mcp': {
      assertValidToolInputSchema: mcpToolStandardizationModule.assertValidToolInputSchema,
      isSupportedMcpProtocolCombination: mcpProtocolTypesModule.isSupportedMcpProtocolCombination,
      normalizeMcpServerInfo: mcpServerInfoModule.normalizeMcpServerInfo,
    },
    './McpConfigError': configErrorModule,
  },
);
const snapshotTool = mcpToolStandardizationModule.standardizeMcpTool(
  'snapshot-server',
  { name: 'memory_list', inputSchema: { type: 'object' } },
);
const snapshotBase = {
  discoveredAt: '2026-08-24T00:32:35.241Z',
  protocolVersion: '2026-07-28',
  protocolEra: 'modern',
  tools: [snapshotTool],
};
const emptyVersionSnapshot = parseMcpDiscoverySnapshot(JSON.stringify({
  ...snapshotBase,
  serverInfo: { name: 'memory-vault-2026', version: '' },
}));
assert.deepEqual(
  emptyVersionSnapshot?.serverInfo,
  { name: 'memory-vault-2026', version: '' },
  'serverInfo 的字符串值包括空字符串都必须与实时协议层采用相同接收语义',
);
const malformedServerInfoSnapshot = parseMcpDiscoverySnapshot(JSON.stringify({
  ...snapshotBase,
  serverInfo: { name: 123, version: false },
}));
assert.equal(
  malformedServerInfoSnapshot?.serverInfo,
  null,
  '损坏的展示元数据不得毒死已经严格验证的工具快照',
);
assert.equal(malformedServerInfoSnapshot?.tools.length, 1);
assert.throws(
  () => parseMcpDiscoverySnapshot(JSON.stringify({
    ...snapshotBase,
    protocolVersion: '2025-03-26',
  })),
  (error) => error?.code === 'DISCOVERY_SNAPSHOT_INVALID',
  '本地快照运行字段损坏必须与 live discovery failure 使用不同错误码',
);

const nestedHeaderSchema = {
  type: 'object',
  properties: {
    request: {
      type: 'object',
      properties: {
        token: { type: 'string', 'x-mcp-header': 'Token' },
      },
    },
  },
};
assert.deepEqual(
  buildMcpParameterHeaders(nestedHeaderSchema, { request: { token: 'abc' } }),
  { 'Mcp-Param-Token': 'abc' },
  '静态 properties 嵌套路径必须生成 Mcp-Param-*',
);
assert.equal(
  encodeMcpHeaderValue('工具'),
  '=?base64?5bel5YW3?=',
  '非 ASCII Mcp-Name/Mcp-Param 值必须使用 UTF-8 Base64 sentinel',
);
const instanceDataWithSchemaLikeKeys = {
  type: 'object',
  default: {
    properties: 'literal default value',
    'x-mcp-header': 'not-a-schema-annotation',
  },
  examples: [{ properties: { 'x-mcp-header': 'example value' } }],
  'x-vendor-data': { properties: { token: { 'x-mcp-header': 'extension value' } } },
  properties: {
    token: { type: 'string', 'x-mcp-header': 'Token' },
  },
};
assert.deepEqual(
  buildMcpParameterHeaders(instanceDataWithSchemaLikeKeys, { token: 'abc' }),
  { 'Mcp-Param-Token': 'abc' },
  'default/examples/未知扩展中的实例对象不得被当成 schema 扫描',
);

const sseBody = [
  'data: {"jsonrpc":"2.0","id":999,"result":{"resultType":"complete"}}',
  '',
  'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
  '',
  'data: {"jsonrpc":',
  'data: "2.0", "id": 7, "result": {"resultType":"complete"}}',
  '',
].join('\n');
const sseResponse = mcpHttpModule.parseJsonRpcResponseBody(
  'text/event-stream',
  sseBody,
  7,
  (error) => new mcpClientErrorModule.McpClientError('PROTOCOL_ERROR', error.message),
);
assert.equal(sseResponse.id, 7, 'SSE 必须跳过 notification/其他 id 并匹配最终 response');

await assert.rejects(
  () => listAllMcpTools({
    maxListPages: 1,
    maxListTools: 10,
    signal: new AbortController().signal,
    requireCompleteResult: true,
    requestPage: async () => ({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [] },
    }),
  }),
  (error) => error?.code === 'PROTOCOL_ERROR' && /缺少 resultType/.test(error.message),
  '2026 tools/list 缺少 resultType 必须被拒绝',
);

const invalidHeaderSchemas = [
  {
    label: 'items 直接标注',
    schema: {
      type: 'object',
      properties: {
        values: { type: 'array', items: { type: 'string', 'x-mcp-header': 'Token' } },
      },
    },
  },
  {
    label: 'items 下 properties 间接标注',
    schema: {
      type: 'object',
      properties: {
        values: {
          type: 'array',
          items: {
            type: 'object',
            properties: { token: { type: 'string', 'x-mcp-header': 'Token' } },
          },
        },
      },
    },
  },
  {
    label: 'oneOf 下 properties 标注',
    schema: {
      type: 'object',
      oneOf: [{ properties: { token: { type: 'string', 'x-mcp-header': 'Token' } } }],
    },
  },
  {
    label: 'allOf 下 properties 标注',
    schema: {
      type: 'object',
      allOf: [{ properties: { token: { type: 'string', 'x-mcp-header': 'Token' } } }],
    },
  },
  {
    label: '$ref 定义下标注',
    schema: {
      type: 'object',
      properties: { token: { $ref: '#/$defs/token' } },
      $defs: { token: { type: 'string', 'x-mcp-header': 'Token' } },
    },
  },
  {
    label: '重复 header 名称',
    schema: {
      type: 'object',
      properties: {
        first: { type: 'string', 'x-mcp-header': 'Token' },
        second: { type: 'string', 'x-mcp-header': 'token' },
      },
    },
  },
  {
    label: 'header 参数类型非法',
    schema: {
      type: 'object',
      properties: { amount: { type: 'number', 'x-mcp-header': 'Amount' } },
    },
  },
];
for (const { label, schema } of invalidHeaderSchemas) {
  assert.throws(
    () => buildMcpParameterHeaders(schema, undefined),
    (error) => error?.code === 'PROTOCOL_ERROR',
    `${label} 必须在 tools/list 阶段被识别为非法 x-mcp-header`,
  );
}

const validDiscoveredTool = {
  name: 'valid_tool',
  description: 'valid',
  inputSchema: nestedHeaderSchema,
};
const invalidDiscoveredTool = {
  name: 'invalid_tool',
  description: 'invalid header extension',
  inputSchema: invalidHeaderSchemas[1].schema,
};
const requestPage = (includeResultType) => async () => ({
  jsonrpc: '2.0',
  id: 1,
  result: {
    ...(includeResultType ? { resultType: 'complete' } : {}),
    tools: [validDiscoveredTool, invalidDiscoveredTool],
  },
});
const originalWarn = console.warn;
const warnings = [];
console.warn = (...args) => warnings.push(args);
let modernTools;
try {
  modernTools = await listAllMcpTools({
    maxListPages: 1,
    maxListTools: 10,
    signal: new AbortController().signal,
    requireCompleteResult: true,
    validateTool: (tool) => buildMcpParameterHeaders(tool.inputSchema, undefined),
    requestPage: requestPage(true),
  });
} finally {
  console.warn = originalWarn;
}
assert.deepEqual(
  modernTools.tools.map(({ name }) => name),
  ['valid_tool'],
  '2026 tools/list 必须只排除非法 x-mcp-header 工具，不得废掉同页合法工具',
);
assert.equal(warnings.length, 1, '每个被排除的非法工具必须产生一次 warning');
assert.match(String(warnings[0][0]), /invalid_tool/);

const probeClassifierModule = loadTypeScriptModule(
  'src/platform/mcp/ProbeClassifier.ts',
  { './McpClientError': mcpClientErrorModule },
);
const { classifyProbeOutcome } = probeClassifierModule;
const probeContext = {
  clientModernVersions: ['2026-07-28'],
  requestedVersion: '2026-07-28',
  fallbackAvailable: true,
};

// classifier 是 era negotiation 的唯一分类 owner：四种 verdict 必须由行为覆盖。
assert.equal(
  classifyProbeOutcome({
    kind: 'result',
    result: { supportedVersions: ['2026-07-28'], capabilities: {} },
  }, probeContext).kind,
  'modern',
  'probe 返回共同 modern revision 必须分类为 modern',
);
const correctiveVerdict = classifyProbeOutcome({
  kind: 'rpc-error',
  code: -32022,
  message: 'UnsupportedProtocolVersion',
  data: { requested: '2026-07-27', supported: ['2026-07-28'] },
}, probeContext);
assert.equal(correctiveVerdict.kind, 'corrective');
assert.equal(correctiveVerdict.version, '2026-07-28');
for (const [revision, expectedKind] of [
  ['2026-07-27', 'legacy'],
  ['2026-12-31', 'error'],
  ['2027-01-01', 'error'],
]) {
  const verdict = classifyProbeOutcome({
    kind: 'rpc-error',
    code: -32022,
    message: 'UnsupportedProtocolVersion',
    data: { requested: '2026-07-28', supported: [revision] },
  }, probeContext);
  assert.equal(
    verdict.kind,
    expectedKind,
    `${revision} 必须按 2026-07-28 cutoff 判断 era，而不是按年份或当前 allowlist 判断`,
  );
  if (expectedKind === 'error') {
    assert.equal(verdict.error?.code, 'PROTOCOL_VERSION_UNSUPPORTED');
  }
}
assert.equal(
  classifyProbeOutcome({
    kind: 'rpc-error',
    code: -32022,
    message: 'UnsupportedProtocolVersion',
    data: { requested: '2026-07-28', supported: ['2026-01-01'] },
  }, probeContext).kind,
  'legacy',
  'cutoff 前的 2026 revision 不属于 modern era evidence',
);
assert.equal(
  classifyProbeOutcome({
    kind: 'result',
    result: {
      supportedVersions: ['2026-07-28'],
      capabilities: {},
      instructions: 123,
    },
  }, probeContext).kind,
  'legacy',
  '已知字段类型非法的 DiscoverResult 不得成为 modern evidence',
);
assert.equal(
  classifyProbeOutcome({
    kind: 'result',
    result: {
      supportedVersions: ['2026-07-28'],
      capabilities: {},
      resultType: 123,
    },
  }, probeContext).kind,
  'legacy',
  '非字符串 resultType 不得成为 modern evidence',
);
assert.equal(
  classifyProbeOutcome({
    kind: 'result',
    result: {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: { listChanged: 'yes' } },
    },
  }, probeContext).kind,
  'legacy',
  '已知 ServerCapabilities 字段类型非法时不得成为 modern evidence',
);
assert.equal(
  classifyProbeOutcome({
    kind: 'result',
    result: {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: { listChanged: true } },
      resultType: 'complete',
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: 123, version: false },
      },
    },
  }, probeContext).kind,
  'modern',
  'malformed serverInfo 只应由展示读取降为 null，不得使 DiscoverResult 失效',
);
assert.equal(
  classifyProbeOutcome({
    kind: 'result',
    result: {
      supportedVersions: ['2026-07-28'],
      capabilities: {},
      instructions: '使用说明',
      extensionField: { future: true },
    },
  }, probeContext).kind,
  'modern',
  '合法未知扩展字段不得破坏 DiscoverResult 的 forward compatibility',
);
for (const code of [-32020, -32021, -32600, -32601, -32602]) {
  assert.equal(
    classifyProbeOutcome({ kind: 'rpc-error', code, message: 'legacy response' }, probeContext).kind,
    'legacy',
    `probe JSON-RPC ${code} 不是 modern evidence，必须归入 legacy`,
  );
}
assert.equal(
  classifyProbeOutcome({ kind: 'http-error', status: 503, body: JSON.stringify({ error: { code: -32600 } }) }, probeContext).kind,
  'error',
  '5xx 即使 body 看起来像 legacy 拒绝也不得作为 era 证据',
);
assert.equal(
  classifyProbeOutcome({ kind: 'auth-required', error: new mcpClientErrorModule.McpClientError('AUTH_REQUIRED', 'auth') }, probeContext).kind,
  'error',
  '认证失败不是 era 证据',
);
for (const status of [400, 404, 405]) {
  assert.equal(
    classifyProbeOutcome({ kind: 'http-error', status }, probeContext).kind,
    'legacy',
    `无 body 的 HTTP ${status} probe 必须作为 legacy 证据`,
  );
}

const modernMcpModule = loadTypeScriptModule(
  'src/platform/mcp/modern/ModernMcpClientAdapter.ts',
  {
    '../McpClientError': mcpClientErrorModule,
    '../McpServerInfo': mcpServerInfoModule,
    '../internal/httpJsonRpc': mcpHttpModule,
    '../ProbeClassifier': probeClassifierModule,
  },
);
const { ModernMcpClientAdapter, isModernProbeLegacyError } = modernMcpModule;
const { LegacyMcpClientAdapter } = loadTypeScriptModule(
  'src/platform/mcp/legacy/LegacyMcpClientAdapter.ts',
  {
    '../McpClientError': mcpClientErrorModule,
    '../McpServerInfo': mcpServerInfoModule,
    '../internal/httpJsonRpc': mcpHttpModule,
  },
);
const originalFetch = globalThis.fetch;
const adapterWarnings = [];
const previousWarn = console.warn;

function captureRequest(requests, init) {
  const body = init.body === undefined ? null : JSON.parse(init.body);
  const headers = new Headers(init.headers);
  const request = { body, headers, init };
  requests.push(request);
  return request;
}

function jsonRpcResponse(body, result, status = 200, extraHeaders = {}) {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
    {
      status,
      headers: { 'content-type': 'application/json', ...extraHeaders },
    },
  );
}

function jsonRpcErrorResponse(status, code, message, data, id = 1, extraHeaders = {}) {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    }),
    {
      status,
      headers: { 'content-type': 'application/json', ...extraHeaders },
    },
  );
}

function createSseResponse(events, status = 200) {
  return new Response(
    events.map((event) => {
      if (Array.isArray(event)) {
        return event.map((line) => `data: ${line}\n`).join('');
      }
      return `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n`;
    }).join('\n'),
    { status, headers: { 'content-type': 'text/event-stream' } },
  );
}

function assertModernWire(request) {
  assert.ok(request.body, 'Modern request 必须带 JSON-RPC body');
  const meta = request.body.params?._meta;
  assert.equal(request.headers.get('mcp-protocol-version'), '2026-07-28');
  assert.equal(meta?.['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
  assert.deepEqual(meta?.['io.modelcontextprotocol/clientCapabilities'], {});
  assert.equal(typeof meta?.['io.modelcontextprotocol/clientInfo']?.name, 'string');
  assert.equal(typeof meta?.['io.modelcontextprotocol/clientInfo']?.version, 'string');
  assert.equal(request.headers.get('mcp-method'), request.body.method);
  assert.equal(request.headers.get('mcp-session-id'), null, 'Modern 不得携带 legacy session');
}

const modernRequests = [];
globalThis.fetch = async (_url, init) => {
  const request = captureRequest(modernRequests, init);
  const body = request.body;
  if (body.method === 'server/discover') {
    return jsonRpcResponse(body, {
      resultType: 'complete',
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
    });
  }
  if (body.method === 'tools/list') {
    return jsonRpcResponse(body, {
      resultType: 'complete',
      tools: [validDiscoveredTool, invalidDiscoveredTool],
    });
  }
  if (body.method === 'tools/call') {
    return jsonRpcResponse(body, {
      resultType: 'complete',
      content: [{ type: 'text', text: 'ok' }],
    });
  }
  throw new Error(`Unexpected Modern MCP method: ${body.method}`);
};
console.warn = (...args) => adapterWarnings.push(args);
try {
  const adapter = new ModernMcpClientAdapter({ url: 'https://mcp.test/' });
  const signal = new AbortController().signal;
  const info = await adapter.connect(signal);
  assert.deepEqual(
    { protocolEra: info.protocolEra, protocolVersion: info.protocolVersion },
    { protocolEra: 'modern', protocolVersion: '2026-07-28' },
  );
  const adapterTools = await adapter.listAllTools(signal);
  assert.deepEqual(
    adapterTools.tools.map(({ name }) => name),
    ['valid_tool'],
    'Modern adapter 必须在真实 tools/list 链路过滤非法工具',
  );
  await adapter.callTool(
    '工具',
    { request: { token: '世界' } },
    signal,
    { inputSchema: nestedHeaderSchema },
  );
} finally {
  console.warn = previousWarn;
  globalThis.fetch = originalFetch;
}
assert.equal(adapterWarnings.length, 1, 'Modern adapter 过滤非法工具时必须 warning');
assert.deepEqual(
  modernRequests.map(({ body }) => body.method),
  ['server/discover', 'tools/list', 'tools/call'],
  'Modern 连接与工具调用不得引入 initialize/session 请求',
);
for (const request of modernRequests) {
  assertModernWire(request);
}
const callRequest = modernRequests.find(({ body }) => body.method === 'tools/call');
assert.ok(callRequest, 'Modern adapter 必须发出 tools/call 请求');
assert.equal(callRequest.body.params.name, '工具', 'Mcp-Name 必须镜像 tools/call 的 params.name');
assert.equal(callRequest.headers.get('mcp-name'), '=?base64?5bel5YW3?=');
assert.equal(callRequest.headers.get('mcp-param-token'), '=?base64?5LiW55WM?=');

// 非 SSE fallback 仍需按 UTF-8 字节限制多字节响应体。
const fallbackFetch = globalThis.fetch;
globalThis.fetch = async () => ({
  type: 'basic',
  status: 200,
  ok: true,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: null,
  text: async () => '😀',
});
try {
  const fallbackTransport = new McpHttpJsonRpcTransport({
    url: 'https://mcp.test/',
    timeoutMs: 1_000,
    maxResponseBytes: 3,
  });
  await assert.rejects(
    () => fallbackTransport.postJson(
      { jsonrpc: '2.0', id: 1, method: 'test' },
      { headers: {}, signal: new AbortController().signal },
    ),
    (error) => error?.code === 'PAYLOAD_TOO_LARGE',
    '无 ReadableStream fallback 必须按 UTF-8 字节限制多字节响应体',
  );
} finally {
  globalThis.fetch = fallbackFetch;
}

// SSE 只验收同一次 POST 内完成并结束的 compatibility subset；不发送 GET/resume。
const sseRequests = [];
globalThis.fetch = async (_url, init) => {
  const request = captureRequest(sseRequests, init);
  assert.equal(init.method, 'POST');
  assert.equal(request.headers.get('last-event-id'), null);
  if (request.body.method === 'tools/list') {
    return createSseResponse([
      { jsonrpc: '2.0', method: 'notifications/progress', params: {} },
      `{"jsonrpc":"2.0","id":${request.body.id},"result":{"resultType":"complete","tools":[{"name":"sse_tool","inputSchema":{"type":"object"}}]}}`,
    ]);
  }
  if (request.body.method === 'tools/call') {
    const target = JSON.stringify({
      jsonrpc: '2.0',
      id: request.body.id,
      result: { resultType: 'complete', content: [{ type: 'text', text: 'sse-ok' }] },
    });
    return createSseResponse([
      { jsonrpc: '2.0', id: 999, result: { resultType: 'complete' } },
      [target.slice(0, 17), target.slice(17)],
    ]);
  }
  throw new Error(`Unexpected SSE method: ${request.body.method}`);
};
try {
  const adapter = new ModernMcpClientAdapter({
    url: 'https://mcp.test/',
    assumeConnected: true,
  });
  const signal = new AbortController().signal;
  await adapter.connect(signal);
  assert.deepEqual((await adapter.listAllTools(signal)).tools.map(({ name }) => name), ['sse_tool']);
  const result = await adapter.callTool('sse_tool', {}, signal, { inputSchema: { type: 'object' } });
  assert.equal(result.content[0].text, 'sse-ok');
} finally {
  globalThis.fetch = originalFetch;
}
assert.deepEqual(
  sseRequests.map(({ body }) => body.method),
  ['tools/list', 'tools/call'],
  'SSE compatibility subset 必须只在同一次 POST 内消费 list/call response',
);

const { NegotiatingMcpClient } = loadTypeScriptModule(
  'src/platform/mcp/NegotiatingMcpClient.ts',
  {
    './McpClientError': mcpClientErrorModule,
    './legacy/LegacyMcpClientAdapter': { LegacyMcpClientAdapter },
    './modern/ModernMcpClientAdapter': { ModernMcpClientAdapter, isModernProbeLegacyError },
  },
);

// 同一服务对新版探测返回 500 时，用户显式传统握手仍可独立验证并保存真实版本。
let explicitHandshakeRuntime;
let explicitHandshakeCommit;
const explicitHandshakeRequests = [];
let explicitProbeResponse = '500';
const { configureMcpToolsRuntime } = loadTypeScriptModule('src/host/composition/configureMcpToolsRuntime.ts', {
  '@features/mcpTools': {
    configureMcpToolsRuntimeDependencies: (runtime) => { explicitHandshakeRuntime = runtime; },
    sqliteMcpServerConfigRepository: {
      ...successfulConnectionRuntime.serverConfigRepository,
      commitConnectionSuccess: async (input) => {
        explicitHandshakeCommit = input;
        return { id: input.id, enabled: true };
      },
    },
    sqliteMcpToolGrantRepository: successfulConnectionRuntime.toolGrantRepository,
  },
  '@platform/mcp': { LegacyMcpClientAdapter, ModernMcpClientAdapter },
  '@features/mcpTools/composition': { secureStoreMcpCredentialStore: {} },
});
configureMcpToolsRuntime();
const explicitHandshakeTest = loadTypeScriptModule('src/features/mcpTools/application/TestMcpServerConnection.ts', {
  './ResolveMcpBearerToken': { resolveMcpBearerToken: async () => 'saved-token' },
  '@platform/mcp': {
    assertNoMcpInternalNameCollision: () => undefined,
    findMcpNamespaceConflict: () => null,
    isMcpClientError: mcpClientErrorModule.isMcpClientError,
    standardizeMcpTool: () => { throw new Error('此服务未发现工具'); },
  },
  './McpToolsRuntimeDependencies': { getMcpToolsRuntimeDependencies: () => explicitHandshakeRuntime },
  './McpConfigError': configErrorModule,
  './McpEndpointValidator': { validateMcpServerEndpoint },
});
globalThis.fetch = async (_url, init) => {
  const request = captureRequest(explicitHandshakeRequests, init);
  if (init.method === 'DELETE') return new Response('', { status: 200 });
  switch (request.body.method) {
    case 'server/discover':
      if (explicitProbeResponse === '500') return new Response('internal error', { status: 500 });
      if (explicitProbeResponse === 'legacy') return jsonRpcErrorResponse(400, -32601, 'Method not found', undefined, request.body.id);
      return jsonRpcResponse(request.body, {
        resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} },
      });
    case 'initialize': return jsonRpcResponse(request.body, {
      protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'coffee', version: '1' },
    }, 200, { 'mcp-session-id': 'coffee-session' });
    case 'notifications/initialized': return new Response('', { status: 202 });
    case 'tools/list': return jsonRpcResponse(request.body, { resultType: 'complete', tools: [] });
    default: throw new Error(`Unexpected test method: ${request.body.method}`);
  }
};
try {
  await assert.rejects(() => explicitHandshakeTest.testMcpServerConnection('server-connection', 'modern'), /HTTP 500/u);
  assert.deepEqual(explicitHandshakeRequests.map(({ body }) => body?.method), ['server/discover']);
  assert.equal(explicitHandshakeCommit, undefined, '探测 500 不能发布成功快照或自动降级');
  explicitHandshakeRequests.length = 0;
  const result = await explicitHandshakeTest.testMcpServerConnection('server-connection', 'legacy');
  assert.equal(result.protocolVersion, '2025-06-18');
  assert.deepEqual(explicitHandshakeRequests.map(({ body }) => body?.method),
    ['initialize', 'notifications/initialized', 'tools/list', undefined]);
  assert.ok(explicitHandshakeRequests.every(({ headers }) => headers.get('authorization') === 'Bearer saved-token'));
  const snapshot = JSON.parse(explicitHandshakeCommit.toolSnapshotJson);
  assert.equal(snapshot.protocolEra, 'legacy');
  assert.equal(snapshot.protocolVersion, result.protocolVersion);
  assert.equal(explicitHandshakeCommit.lastNegotiatedProtocolVersion, result.protocolVersion);
  assert.equal(explicitHandshakeCommit.lastProtocolEra, 'legacy');
  explicitProbeResponse = 'legacy';
  explicitHandshakeRequests.length = 0;
  await assert.rejects(() => explicitHandshakeTest.testMcpServerConnection('server-connection', 'modern'),
    (error) => error.code === 'PROTOCOL_VERSION_UNSUPPORTED');
  assert.deepEqual(explicitHandshakeRequests.map(({ body }) => body?.method), ['server/discover'],
    '新版测试即使明确遇到旧服务，也不能自动执行传统握手');
  explicitProbeResponse = 'modern';
  explicitHandshakeRequests.length = 0;
  const modernResult = await explicitHandshakeTest.testMcpServerConnection('server-connection', 'modern');
  assert.equal(modernResult.protocolVersion, '2026-07-28');
  assert.equal(explicitHandshakeCommit.lastProtocolEra, 'modern');
  assert.equal(JSON.parse(explicitHandshakeCommit.toolSnapshotJson).protocolEra, 'modern');
  assert.deepEqual(explicitHandshakeRequests.map(({ body }) => body?.method), ['server/discover', 'tools/list'],
    '新版测试成功只发布新版协议，不执行 initialize');
} finally { globalThis.fetch = originalFetch; }

async function runLegacyNegotiation(probeResponse, protocolVersion = '2025-11-25') {
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const request = captureRequest(requests, init);
    const body = request.body;
    if (init.method === 'DELETE') {
      return new Response('', { status: 200 });
    }
    if (body.method === 'server/discover') {
      return typeof probeResponse === 'function'
        ? probeResponse(body)
        : probeResponse;
    }
    if (body.method === 'initialize') {
      return jsonRpcResponse(
        body,
        {
          protocolVersion,
          serverInfo: { name: 'legacy', version: '1.0.0' },
          capabilities: {},
        },
        200,
        { 'mcp-session-id': 'session-1' },
      );
    }
    if (body.method === 'notifications/initialized') {
      return new Response('', { status: 202 });
    }
    if (body.method === 'tools/list') {
      return jsonRpcResponse(body, { tools: [{ name: 'legacy_tool', inputSchema: { type: 'object' } }] });
    }
    if (body.method === 'tools/call') {
      return jsonRpcResponse(body, { content: [{ type: 'text', text: 'legacy-ok' }] });
    }
    throw new Error(`Unexpected legacy MCP method: ${body.method}`);
  };
  try {
    const client = new NegotiatingMcpClient({ url: 'https://mcp.test/' });
    const signal = new AbortController().signal;
    const info = await client.connect(signal);
    const tools = await client.listAllTools(signal);
    const call = await client.callTool('legacy_tool', {}, signal, { inputSchema: { type: 'object' } });
    await client.close();
    return { requests, info, tools, call };
  } finally {
    globalThis.fetch = negotiationFetch;
  }
}

const negotiationFetch = globalThis.fetch;

const fastMcp = (body) => jsonRpcErrorResponse(
  400,
  -32600,
  'Unsupported protocol version',
  undefined,
  body.id,
);
for (const [probeName, probeFactory] of [
  ['FastMCP -32600', fastMcp],
  ['HeaderMismatch -32020', (body) => jsonRpcErrorResponse(400, -32020, 'HeaderMismatch', undefined, body.id)],
  ['Missing capability -32021', (body) => jsonRpcErrorResponse(400, -32021, 'MissingRequiredClientCapability', undefined, body.id)],
  ['cutoff 前 -32022', (body) => jsonRpcErrorResponse(
    400,
    -32022,
    'UnsupportedProtocolVersion',
    { requested: '2026-07-28', supported: ['2026-01-01'] },
    body.id,
  )],
  ['2025-only discover result', (body) => jsonRpcResponse(body, {
    resultType: 'complete',
    supportedVersions: ['2025-11-25'],
    capabilities: {},
  })],
  ['malformed discover result', (body) => jsonRpcResponse(body, {
    supportedVersions: ['2026-07-28'],
    capabilities: {},
    instructions: 123,
  })],
]) {
  const { requests, info, tools, call } = await runLegacyNegotiation(probeFactory);
  assert.deepEqual(
    { protocolEra: info.protocolEra, protocolVersion: info.protocolVersion },
    { protocolEra: 'legacy', protocolVersion: '2025-11-25' },
    `${probeName} 必须进入 legacy 并由 initialize 协商 revision`,
  );
  assert.deepEqual(tools.tools.map(({ name }) => name), ['legacy_tool']);
  assert.equal(call.content[0].text, 'legacy-ok');
  assert.deepEqual(
    requests.filter(({ body }) => body).map(({ body }) => body.method),
    ['server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call'],
    `${probeName} 只能执行一次 legacy initialize，不得按错误码继续猜测`,
  );
  for (const request of requests.filter(({ body }) => (
    body && ['notifications/initialized', 'tools/list', 'tools/call'].includes(body.method)
  ))) {
    assert.equal(
      request.headers.get('mcp-protocol-version'),
      '2025-11-25',
      `${probeName} 的 initialized/list/call 必须携带实际协商的 protocol header`,
    );
    assert.equal(request.headers.get('mcp-session-id'), 'session-1');
  }
}

const statefulProtocolErrorRequests = [];
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  statefulProtocolErrorRequests.push(body.method);
  return jsonRpcErrorResponse(400, -32020, 'HeaderMismatch', undefined, body.id);
};
try {
  const client = new LegacyMcpClientAdapter({ url: 'https://mcp.test/' });
  await assert.rejects(
    () => client.connect(new AbortController().signal),
    (error) => error?.code === 'PROTOCOL_ERROR',
    'legacy initialize 内部的 HeaderMismatch 仍必须保留为 protocol error',
  );
} finally {
  globalThis.fetch = negotiationFetch;
}
assert.deepEqual(statefulProtocolErrorRequests, ['initialize']);

async function runCorrectiveProbe(secondResponse) {
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const request = captureRequest(requests, init);
    if (request.body.method !== 'server/discover') {
      throw new Error(`Corrective probe 不得发送 ${request.body.method}`);
    }
    if (requests.length === 1) {
      return jsonRpcErrorResponse(
        400,
        -32022,
        'UnsupportedProtocolVersion',
        { requested: '2026-07-28', supported: ['2026-07-28'] },
        request.body.id,
      );
    }
    return secondResponse(request.body);
  };
  try {
    const adapter = new ModernMcpClientAdapter({ url: 'https://mcp.test/' });
    try {
      const result = await adapter.connect(new AbortController().signal);
      return { requests, result, error: null };
    } catch (error) {
      return { requests, result: null, error };
    }
  } finally {
    globalThis.fetch = negotiationFetch;
  }
}
const correctiveSuccess = await runCorrectiveProbe((body) => jsonRpcResponse(body, {
  resultType: 'complete',
  supportedVersions: ['2026-07-28'],
  capabilities: { tools: {} },
}));
assert.equal(correctiveSuccess.error, null);
assert.equal(correctiveSuccess.result.protocolEra, 'modern');
assert.equal(correctiveSuccess.result.protocolVersion, '2026-07-28');
assert.deepEqual(
  correctiveSuccess.requests.map(({ body }) => body.method),
  ['server/discover', 'server/discover'],
  'corrective 只允许一次 re-probe，不得进入 legacy',
);
for (const request of correctiveSuccess.requests) {
  assertModernWire(request);
}
const correctiveFailed = await runCorrectiveProbe((body) => jsonRpcErrorResponse(
  400,
  -32022,
  'UnsupportedProtocolVersion',
  { requested: '2026-07-28', supported: ['2026-07-28'] },
  body.id,
));
assert.equal(correctiveFailed.result, null);
assert.equal(correctiveFailed.error?.code, 'PROTOCOL_VERSION_UNSUPPORTED');
assert.deepEqual(
  correctiveFailed.requests.map(({ body }) => body.method),
  ['server/discover', 'server/discover'],
  'corrective 第二次仍拒绝时必须终止，不能进入 legacy',
);

async function assertAutoProbeDoesNotFallback(label, fetchImpl, expectedCode) {
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const request = captureRequest(requests, init);
    return fetchImpl(request);
  };
  try {
    const client = new NegotiatingMcpClient({ url: 'https://mcp.test/', timeoutMs: 5 });
    await assert.rejects(
      () => client.connect(new AbortController().signal),
      (error) => error?.code === expectedCode,
      `${label} 必须保留 typed error，不得触发 legacy initialize`,
    );
  } finally {
    globalThis.fetch = negotiationFetch;
  }
  assert.deepEqual(requests.map(({ body }) => body?.method), ['server/discover'], `${label} 不得发送 initialize`);
}
for (const status of [401, 403]) {
  await assertAutoProbeDoesNotFallback(
    `HTTP ${status}`,
    () => new Response('', { status }),
    'AUTH_REQUIRED',
  );
}
await assertAutoProbeDoesNotFallback(
  'HTTP 503',
  ({ body }) => jsonRpcErrorResponse(503, -32600, 'legacy-looking server error', undefined, body.id),
  'HTTP_ERROR',
);
await assertAutoProbeDoesNotFallback(
  '双方无共同 revision 的未来 modern server',
  ({ body }) => jsonRpcErrorResponse(
    400,
    -32022,
    'UnsupportedProtocolVersion',
    { requested: '2026-07-28', supported: ['2027-01-01'] },
    body.id,
  ),
  'PROTOCOL_VERSION_UNSUPPORTED',
);
await assertAutoProbeDoesNotFallback(
  '网络失败',
  () => { throw new TypeError('socket closed'); },
  'TRANSPORT_FAILED',
);
await assertAutoProbeDoesNotFallback(
  '超时',
  ({ init }) => new Promise((_resolve, reject) => {
    const abort = () => reject(new Error('aborted by timeout'));
    if (init.signal.aborted) {
      abort();
    } else {
      init.signal.addEventListener('abort', abort, { once: true });
    }
  }),
  'TIMEOUT',
);
const cancelledRequests = [];
globalThis.fetch = async (_url, init) => {
  captureRequest(cancelledRequests, init);
  throw new Error('fetch should not be reached after cancellation');
};
try {
  const controller = new AbortController();
  controller.abort();
  const client = new NegotiatingMcpClient({ url: 'https://mcp.test/' });
  await assert.rejects(
    () => client.connect(controller.signal),
    (error) => error?.code === 'CANCELLED',
    '取消必须保留 CANCELLED，不得进入 legacy',
  );
} finally {
  globalThis.fetch = negotiationFetch;
}
assert.deepEqual(
  cancelledRequests.map(({ body }) => body?.method),
  ['server/discover'],
  '取消即使已进入 transport 也不得继续发送 legacy initialize',
);

for (const protocolVersion of ['2025-11-25', '2025-06-18']) {
  const { requests, info } = await runLegacyNegotiation(
    (body) => new Response('', { status: 400 }),
    protocolVersion,
  );
  assert.deepEqual(
    { protocolEra: info.protocolEra, protocolVersion: info.protocolVersion },
    { protocolEra: 'legacy', protocolVersion },
    `legacy initialize 必须接受 ${protocolVersion}`,
  );
  const initialized = requests.find(({ body }) => body?.method === 'notifications/initialized');
  assert.equal(initialized.headers.get('mcp-protocol-version'), protocolVersion);
}

const unsupportedRevisionRequests = [];
globalThis.fetch = async (_url, init) => {
  const request = captureRequest(unsupportedRevisionRequests, init);
  if (request.body.method === 'server/discover') {
    return new Response('', { status: 400 });
  }
  if (request.body.method === 'initialize') {
    return jsonRpcResponse(request.body, {
      protocolVersion: '2025-03-26',
      serverInfo: { name: 'old', version: '1.0.0' },
      capabilities: {},
    });
  }
  throw new Error(`未支持 revision 不得继续发送 ${request.body.method}`);
};
try {
  const client = new NegotiatingMcpClient({ url: 'https://mcp.test/' });
  await assert.rejects(
    () => client.connect(new AbortController().signal),
    (error) => error?.code === 'PROTOCOL_VERSION_UNSUPPORTED',
    '未支持 legacy revision 必须显式拒绝',
  );
} finally {
  globalThis.fetch = negotiationFetch;
}
assert.deepEqual(
  unsupportedRevisionRequests.map(({ body }) => body.method),
  ['server/discover', 'initialize'],
  '未支持 revision 不得继续寻找更早实现，也不得 initialized/list/call',
);

// cached protocol 只选择既有 adapter；adapter 失败时当前调用直接失败，不重新 probe/跨 era。
const cachedLegacyRequests = [];
globalThis.fetch = async (_url, init) => {
  const request = captureRequest(cachedLegacyRequests, init);
  if (request.body.method === 'initialize') {
    return jsonRpcErrorResponse(400, -32601, 'modern server has no legacy initialize', undefined, request.body.id);
  }
  throw new Error(`cached legacy 不得发送 ${request.body?.method ?? init.method}`);
};
try {
  const client = new NegotiatingMcpClient({
    url: 'https://mcp.test/',
    knownProtocol: { protocolEra: 'legacy', protocolVersion: '2025-11-25' },
  });
  await assert.rejects(
    () => client.connect(new AbortController().signal),
    (error) => error?.code === 'PROTOCOL_VERSION_UNSUPPORTED',
    'cached legacy 失败必须显式失败，不得自动切换 modern',
  );
} finally {
  globalThis.fetch = negotiationFetch;
}
assert.deepEqual(cachedLegacyRequests.map(({ body }) => body?.method), ['initialize']);
assert.equal(
  cachedLegacyRequests[0].body.params.protocolVersion,
  '2025-11-25',
  'cached legacy 必须按精确 selection 发起 initialize，不得重新猜 revision',
);

const cachedLegacyMismatchRequests = [];
globalThis.fetch = async (_url, init) => {
  const request = captureRequest(cachedLegacyMismatchRequests, init);
  if (request.body.method === 'initialize') {
    return jsonRpcResponse(request.body, {
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'legacy', version: '1.0.0' },
      capabilities: {},
    });
  }
  throw new Error(`cached legacy revision mismatch 不得发送 ${request.body?.method ?? init.method}`);
};
try {
  const client = new NegotiatingMcpClient({
    url: 'https://mcp.test/',
    knownProtocol: { protocolEra: 'legacy', protocolVersion: '2025-11-25' },
  });
  await assert.rejects(
    () => client.connect(new AbortController().signal),
    (error) => error?.code === 'PROTOCOL_VERSION_UNSUPPORTED',
    'cached legacy 协商到不同 revision 时必须显式失效，不得静默接受',
  );
} finally {
  globalThis.fetch = negotiationFetch;
}
assert.deepEqual(cachedLegacyMismatchRequests.map(({ body }) => body?.method), ['initialize']);

const cachedModernRequests = [];
globalThis.fetch = async (_url, init) => {
  const request = captureRequest(cachedModernRequests, init);
  if (request.body.method === 'tools/list') {
    return jsonRpcErrorResponse(400, -32600, 'legacy-looking response', undefined, request.body.id);
  }
  throw new Error(`cached modern 不得发送 ${request.body?.method ?? init.method}`);
};
try {
  const client = new NegotiatingMcpClient({
    url: 'https://mcp.test/',
    knownProtocol: { protocolEra: 'modern', protocolVersion: '2026-07-28' },
  });
  await client.connect(new AbortController().signal);
  await assert.rejects(
    () => client.listAllTools(new AbortController().signal),
    (error) => error?.code === 'PROTOCOL_ERROR',
    'cached modern 的 matching-id HTTP 400 JSON-RPC error 必须保留协议错误且不得切换 legacy',
  );
} finally {
  globalThis.fetch = negotiationFetch;
}
assert.deepEqual(cachedModernRequests.map(({ body }) => body?.method), ['tools/list']);
assertModernWire(cachedModernRequests[0]);

async function assertEstablishedModernFailure(label, operation, responseFactory, expectedCode) {
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const request = captureRequest(requests, init);
    return responseFactory(request);
  };
  try {
    const adapter = new ModernMcpClientAdapter({
      url: 'https://mcp.test/',
      assumeConnected: true,
    });
    const signal = new AbortController().signal;
    await adapter.connect(signal);
    await assert.rejects(
      () => operation(adapter, signal),
      (error) => error?.code === expectedCode,
      label,
    );
  } finally {
    globalThis.fetch = negotiationFetch;
  }
  assert.equal(requests.length, 1, `${label} 不得 retry、re-probe 或跨 era`);
  assertModernWire(requests[0]);
}

for (const [method, operation] of [
  ['tools/list', (adapter, signal) => adapter.listAllTools(signal)],
  ['tools/call', (adapter, signal) => adapter.callTool(
    'modern_tool',
    {},
    signal,
    { inputSchema: { type: 'object' } },
  )],
]) {
  await assertEstablishedModernFailure(
    `${method} 的 matching-id HTTP 400 JSON-RPC error 必须映射为 PROTOCOL_ERROR`,
    operation,
    ({ body }) => jsonRpcErrorResponse(400, -32020, 'HeaderMismatch', undefined, body.id),
    'PROTOCOL_ERROR',
  );
}
await assertEstablishedModernFailure(
  'HTTP 400 非 JSON body 必须保持 HTTP_ERROR',
  (adapter, signal) => adapter.listAllTools(signal),
  () => new Response('bad request', {
    status: 400,
    headers: { 'content-type': 'text/plain' },
  }),
  'HTTP_ERROR',
);
await assertEstablishedModernFailure(
  'HTTP 400 mismatched-id JSON-RPC error 不属于当前请求，必须保持 HTTP_ERROR',
  (adapter, signal) => adapter.listAllTools(signal),
  ({ body }) => jsonRpcErrorResponse(400, -32020, 'HeaderMismatch', undefined, body.id + 1),
  'HTTP_ERROR',
);
for (const status of [401, 403]) {
  await assertEstablishedModernFailure(
    `established Modern HTTP ${status} 必须保持 AUTH_REQUIRED`,
    (adapter, signal) => adapter.listAllTools(signal),
    () => new Response('', { status }),
    'AUTH_REQUIRED',
  );
}
await assertEstablishedModernFailure(
  'established Modern 5xx 即使 body 是 matching JSON-RPC error 也必须保持 HTTP_ERROR',
  (adapter, signal) => adapter.listAllTools(signal),
  ({ body }) => jsonRpcErrorResponse(503, -32020, 'HeaderMismatch', undefined, body.id),
  'HTTP_ERROR',
);

const legacyTools = await listAllMcpTools({
  maxListPages: 1,
  maxListTools: 10,
  signal: new AbortController().signal,
  requireCompleteResult: false,
  requestPage: requestPage(false),
});
assert.deepEqual(
  legacyTools.tools.map(({ name }) => name),
  ['valid_tool', 'invalid_tool'],
  '2025 tools/list 必须忽略 x-mcp-header 扩展并保留工具',
);

// 官方配置形状进入原有编辑/保存流程，不能默默丢弃认证或本地进程字段。
const { parseMcpServerImport } = loadTypeScriptModule(
  'src/features/mcpTools/application/ParseMcpServerImport.ts',
  { './McpConfigError': configErrorModule },
);
const officialDrafts = parseMcpServerImport(JSON.stringify({ mcpServers: {
  'amap': { url: 'https://mcp.amap.com/mcp?key=example-key' },
  'mcd': { type: 'streamablehttp', url: 'https://mcp.mcd.cn', headers: { Authorization: 'Bearer test-token' } },
  'my-coffee': { type: 'http', url: 'https://gwmcp.lkcoffee.com/order/user/mcp', headers: { authorization: 'Bearer coffee-token' } },
} }));
assert.equal(officialDrafts.length, 3);
assert.equal(officialDrafts[0].url, 'https://mcp.amap.com/mcp?key=example-key');
assert.equal(officialDrafts[0].authMode, 'none');
assert.equal(officialDrafts[1].bearerToken, 'test-token');
assert.equal(officialDrafts[2].authMode, 'bearer_token');
for (const config of [
  {}, { mcpServers: {} },
  { mcpServers: { local: { command: 'npx', args: ['server'] } } },
  { mcpServers: { sse: { type: 'sse', url: 'https://example.com/sse' } } },
  { mcpServers: { auth: { url: 'https://example.com', headers: { 'X-Api-Key': 'test' } } } },
]) {
  assert.throws(() => parseMcpServerImport(JSON.stringify(config)), (error) => error.code === 'CONFIG_IMPORT_INVALID');
}

const tokens = new Map();
let tokenSequence = 0;
let authServer = null;
let authSaveInput;
const authRuntime = {
  credentialStore: {
    save: async (token) => { const ref = `ref-${++tokenSequence}`; tokens.set(ref, token); return ref; },
    read: async (ref) => tokens.get(ref) ?? null,
    delete: async (ref) => { tokens.delete(ref); },
  },
  serverConfigRepository: {
    list: async () => authServer ? [authServer] : [],
    getById: async () => authServer,
    save: async (input) => {
      authSaveInput = input;
      authServer = { connectionStatus: 'unverified', ...input, id: 'auth-server' };
      return authServer;
    },
    invalidateAndUpdateEndpoint: async (input) => {
      authSaveInput = input;
      authServer = { ...authServer, ...input, connectionStatus: 'unverified', enabled: false, toolSnapshotJson: '{}' };
      return authServer;
    },
  },
};
const authDependencies = { getMcpToolsRuntimeDependencies: () => authRuntime };
const authSave = loadTypeScriptModule('src/features/mcpTools/application/SaveMcpServer.ts', {
  './McpToolsRuntimeDependencies': authDependencies,
  './McpConfigError': configErrorModule,
  './McpEndpointValidator': { validateMcpServerEndpoint },
}).saveMcpServer;
const authInput = { assistantIds: ['assistant-1'], id: null, name: '认证服务', url: 'https://mcp.example/mcp', description: '', enabled: true, authMode: 'bearer_token' };
await assert.rejects(() => authSave(authInput), (error) => error.code === 'TOKEN_REQUIRED');
await authSave({ ...authInput, bearerToken: 'first-token' });
assert.equal(authServer.enabled, true, '带认证的新增服务同样默认启用');
assert.equal(tokens.get(authServer.credentialRef), 'first-token');
assert.equal(JSON.stringify(authSaveInput).includes('first-token'), false, 'SQLite 只能收到引用，不能收到 Token');
const firstRef = authServer.credentialRef;
authServer = { ...authServer, enabled: true, connectionStatus: 'available' };
await authSave({ ...authInput, id: authServer.id });
assert.equal(authServer.credentialRef, firstRef);
assert.equal(authServer.enabled, true, '只编辑元数据不改变已有连接身份');
await authSave({ ...authInput, id: authServer.id, enabled: false });
assert.equal(authServer.enabled, false, '编辑保存保留用户关闭服务的选择');
await authSave({ ...authInput, id: authServer.id, bearerToken: 'second-token' });
assert.equal(authServer.enabled, false, '认证身份改变必须重新测试授权');
assert.equal(authServer.connectionStatus, 'unverified');
assert.equal(tokens.has(firstRef), false);
await assert.rejects(
  () => authSave({ ...authInput, id: authServer.id, url: 'https://other.example/mcp' }),
  (error) => error.code === 'TOKEN_REQUIRED',
  '不能把旧服务 Token 静默发送到新地址',
);
const { resolveMcpBearerToken } = loadTypeScriptModule('src/features/mcpTools/application/ResolveMcpBearerToken.ts', {
  '@platform/mcp': mcpClientErrorModule,
  './McpToolsRuntimeDependencies': authDependencies,
});
assert.equal(await resolveMcpBearerToken(authServer.credentialRef), 'second-token');
await assert.rejects(() => resolveMcpBearerToken('missing-ref'), (error) => error.code === 'AUTH_REQUIRED');
const oldAuthRef = authServer.credentialRef;
await authSave({ ...authInput, id: authServer.id, authMode: 'none' });
assert.equal(authServer.credentialRef, null);
assert.equal(tokens.has(oldAuthRef), false);
authRuntime.serverConfigRepository.save = async () => { throw new Error('database write failed'); };
authServer = null;
await assert.rejects(() => authSave({ ...authInput, bearerToken: 'unpublished-token' }), /database write failed/);
assert.equal(tokens.size, 0, '数据库保存失败时回收未发布凭据');

// 已改配置的连接测试不能重新发布旧快照或授权，即使网络最终成功。
const stateBeforeStaleCommit = cloneSqliteState(sqliteState);
assert.equal(await sqliteRepository.commitConnectionSuccess({
  id: 'server-sqlite', expectedUrl: 'https://old.example/mcp', expectedCredentialRef: null,
  toolSnapshotJson: '{}', lastNegotiatedProtocolVersion: '2026-07-28', lastProtocolEra: 'modern',
  endpointClass: 'remote_https', nowIso: '2026-10-07T00:00:00Z', tools: sqliteTools,
}), null);
assert.deepEqual(sqliteState, stateBeforeStaleCommit);
assert.equal(await sqliteRepository.commitConnectionSuccess({
  id: 'server-sqlite', expectedUrl: sqliteState.server.url, expectedCredentialRef: 'old-account',
  toolSnapshotJson: '{}', lastNegotiatedProtocolVersion: '2026-07-28', lastProtocolEra: 'modern',
  endpointClass: 'remote_https', nowIso: '2026-10-07T00:00:00Z', tools: sqliteTools,
}), null);
assert.deepEqual(sqliteState, stateBeforeStaleCommit);

let pooledConnectCount = 0;
let pooledCreateCount = 0;
const accountPool = new McpRunClientPool(async () => {
  pooledCreateCount += 1;
  return { connect: async () => { pooledConnectCount += 1; }, close: async () => undefined };
});
const [accountA1, accountA2, accountB] = await Promise.all([
  accountPool.getConnected('https://shared.example/mcp', knownProtocol, firstSignal, 'account-a'),
  accountPool.getConnected('https://shared.example/mcp', knownProtocol, firstSignal, 'account-a'),
  accountPool.getConnected('https://shared.example/mcp', knownProtocol, firstSignal, 'account-b'),
]);
assert.equal(accountA1, accountA2);
assert.notEqual(accountA1, accountB);
assert.equal(pooledCreateCount, 2);
assert.equal(pooledConnectCount, 2, '并行调用共享一次连接握手');
await accountPool.dispose();

for (const era of ['legacy', 'modern']) {
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const request = captureRequest(requests, init);
    assert.equal(request.headers.get('authorization'), 'Bearer official-token');
    if (init.method === 'DELETE' || request.body.method === 'notifications/initialized') return new Response(null, { status: 204 });
    const result = request.body.method === 'initialize'
      ? { protocolVersion: '2025-11-25', serverInfo: { name: 'official', version: '1' }, capabilities: {} }
      : request.body.method === 'tools/list' ? { resultType: 'complete', tools: [] }
      : { resultType: 'complete', content: [{ type: 'text', text: 'ok' }] };
    const response = jsonRpcResponse(request.body, result);
    if (request.body.method === 'initialize') response.headers.set('mcp-session-id', 'authenticated-session');
    return response;
  };
  try {
    const client = new NegotiatingMcpClient({ url: 'https://official.example/mcp', bearerToken: 'official-token',
      knownProtocol: { protocolEra: era, protocolVersion: era === 'legacy' ? '2025-11-25' : '2026-07-28' } });
    const signal = new AbortController().signal;
    await client.connect(signal);
    await client.listAllTools(signal);
    await client.callTool('query', {}, signal, { inputSchema: { type: 'object' } });
    await client.close();
  } finally { globalThis.fetch = originalFetch; }
  assert.ok(requests.some((request) => request.body?.method === 'tools/call'));
}

// 用真实 SQLite 验证 SQL、凭据引用与事务结果，避免只验证内存 mock。
const nativeTokens = new Map();
const nativeStore = loadTypeScriptModule('src/features/mcpTools/infrastructure/SecureStoreMcpCredentialStore.ts', {
  'expo-crypto': { randomUUID: () => 'test-uuid' },
  'expo-secure-store': {
    setItemAsync: async (reference, token) => { nativeTokens.set(reference, token); },
    getItemAsync: async (reference) => nativeTokens.get(reference) ?? null,
    deleteItemAsync: async (reference) => { nativeTokens.delete(reference); },
  },
}).secureStoreMcpCredentialStore;
const nativeReference = await nativeStore.save('native-token');
assert.equal(await nativeStore.read(nativeReference), 'native-token');
await nativeStore.delete(nativeReference);
assert.equal(await nativeStore.read(nativeReference), null);

// 真实 meta-tool → 连接池 → 安全存储解析 → 协议 HTTP，模型只持有业务参数。
tokens.set('live-reference', 'service-token');
const authenticatedPool = new McpRunClientPool(async (url, selection, reference) => new NegotiatingMcpClient({
  url, knownProtocol: selection, bearerToken: await resolveMcpBearerToken(reference),
}));
const [authenticatedList, authenticatedCall] = createMcpMetaTools({
  frozen: [{ ...toolDefinition, credentialRef: 'live-reference', inputSchema: {
    type: 'object', properties: { qty: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] } }, required: ['qty'],
  } }], clients: authenticatedPool,
});
let authenticatedRequests = 0;
globalThis.fetch = async (_url, init) => {
  authenticatedRequests += 1;
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer service-token');
  const body = JSON.parse(init.body);
  if (body.method === 'notifications/initialized') return new Response(null, { status: 204 });
  if (body.method === 'initialize') return jsonRpcResponse(body, {
    protocolVersion: '2025-11-25', serverInfo: { name: 'authenticated', version: '1' }, capabilities: {},
  });
  assert.deepEqual(body.params.arguments, { qty: 2 });
  return jsonRpcResponse(body, { content: [{ type: 'text', text: '授权查询成功' }] });
};
try {
  const listing = await authenticatedList.execute({ serverName: '测试 Server' }, metaContext);
  assert.equal(listing.modelContent.includes('service-token'), false);
  const rejected = await authenticatedCall.execute({ serverName: '测试 Server', remoteToolName: 'lookup', arguments: { qty: '2' } }, metaContext);
  assert.equal(rejected.code, 'MCP_TOOL_INPUT_INVALID');
  assert.equal(authenticatedRequests, 0, '复杂参数不符合 schema 时不能读取凭据或触网');
  const called = await authenticatedCall.execute({ serverName: '测试 Server', remoteToolName: 'lookup', arguments: { qty: 2 } }, metaContext);
  assert.equal(called.status, 'success');
  assert.equal(called.modelContent, '授权查询成功');
} finally {
  await authenticatedPool.dispose();
  globalThis.fetch = originalFetch;
  tokens.delete('live-reference');
}

const realSqlite = new DatabaseSync(':memory:');
const mcpSchema = loadTypeScriptModule('src/platform/persistence/sqlite/mcpSchema.ts');
realSqlite.exec(`PRAGMA foreign_keys = ON; CREATE TABLE ai_assistants (id TEXT PRIMARY KEY);
  INSERT INTO ai_assistants VALUES ('assistant-1'), ('assistant-2');
  ${mcpSchema.MCP_SERVERS_SCHEMA} ${mcpSchema.MCP_TOOL_GRANTS_SCHEMA} ${mcpSchema.MCP_SERVER_ASSISTANTS_SCHEMA}`);
const sqlExecutor = {
  runAsync: async (sql, params = []) => realSqlite.prepare(sql).run(...params),
  getFirstAsync: async (sql, params = []) => realSqlite.prepare(sql).get(...params) ?? null,
  getAllAsync: async (sql, params = []) => realSqlite.prepare(sql).all(...params),
  withExclusiveTransactionAsync: async (work) => {
    realSqlite.exec('BEGIN');
    try { const result = await work(sqlExecutor); realSqlite.exec('COMMIT'); return result; }
    catch (error) { realSqlite.exec('ROLLBACK'); throw error; }
  },
};
const realMapper = loadTypeScriptModule('src/features/mcpTools/domain/McpServerConfig.ts');
const realRepositoryModule = loadTypeScriptModule('src/features/mcpTools/infrastructure/SQLiteMcpServerConfigRepository.ts', {
  '@platform/persistence': { databaseCoordinator: { openTaskExecutor: () => sqlExecutor } },
  '../domain/McpServerConfig': realMapper,
  '../application/McpConfigError': configErrorModule,
});
const realRepository = new realRepositoryModule.SQLiteMcpServerConfigRepository();
const realSaveInput = { assistantIds: ['assistant-1'], id: null, name: '真实 SQL 服务', url: 'https://sql.example/mcp', description: '',
  authMode: 'bearer_token', credentialRef: 'ref-a', endpointClass: 'remote_https', enabled: false,
  nowIso: '2026-10-07T00:00:00Z', expectedConnection: null };
try {
  const created = await realRepository.save(realSaveInput);
  assert.deepEqual(created.assistantIds, ['assistant-1']);
  assert.deepEqual((await realRepository.list())[0].assistantIds, ['assistant-1']);
  await realRepository.updateAssistantEnabled(created.id, 'assistant-2', true, realSaveInput.nowIso);
  await realRepository.updateAssistantEnabled(created.id, 'assistant-1', false, realSaveInput.nowIso);
  assert.deepEqual((await realRepository.getById(created.id)).assistantIds, ['assistant-2'], '单对象勾选不覆盖其他授权');
  const replaced = await realRepository.save({ ...realSaveInput, id: created.id,
    expectedConnection: { url: created.url, credentialRef: 'ref-a' }, assistantIds: ['assistant-1', 'assistant-2'] });
  assert.deepEqual(replaced.assistantIds, ['assistant-1', 'assistant-2']);
  await assert.rejects(() => realRepository.save({ ...realSaveInput, id: created.id,
    expectedConnection: { url: created.url, credentialRef: 'ref-a' }, assistantIds: ['missing-assistant'] }), /FOREIGN KEY/);
  assert.deepEqual((await realRepository.getById(created.id)).assistantIds, ['assistant-1', 'assistant-2'], '非法 AI 导致整个配置事务回滚');
  realSqlite.exec("DELETE FROM ai_assistants WHERE id = 'assistant-2'");
  assert.deepEqual((await realRepository.getById(created.id)).assistantIds, ['assistant-1'], '删除 AI 必须级联清理服务授权');
  assert.equal(created.authMode, 'bearer_token');
  assert.equal(created.credentialRef, 'ref-a');
  const failureInput = { id: created.id, expectedUrl: created.url, expectedCredentialRef: 'ref-a',
    connectionStatus: 'unavailable', lastErrorCode: 'CONNECTION_FAILED', nowIso: realSaveInput.nowIso };
  await realRepository.recordConnectionFailure(failureInput);
  assert.equal((await realRepository.getById(created.id)).connectionStatus, 'unavailable', '尚未成功的连接记录失败状态');
  const persistedTool = mcpToolStandardizationModule.standardizeMcpTool(created.id,
    { name: 'persisted_query', inputSchema: { type: 'object' } });
  for (const [protocolEra, protocolVersion] of [['legacy', '2025-06-18'], ['modern', '2026-07-28']]) {
    await realRepository.commitConnectionSuccess({
      id: created.id, expectedUrl: created.url, expectedCredentialRef: 'ref-a',
      toolSnapshotJson: JSON.stringify({ discoveredAt: realSaveInput.nowIso, serverInfo: null,
        protocolEra, protocolVersion, tools: [persistedTool] }),
      lastNegotiatedProtocolVersion: protocolVersion, lastProtocolEra: protocolEra, endpointClass: 'remote_https',
      nowIso: '2026-10-09T00:01:00Z', tools: [{ remoteToolName: persistedTool.remoteName,
        localToolName: persistedTool.localName, schemaFingerprint: persistedTool.schemaFingerprint }],
    });
    const successfulServer = await realRepository.getById(created.id);
    const successfulGrants = realSqlite.prepare('SELECT * FROM mcp_tool_grants').all();
    // 失败请求可以在成功请求之前开始、在它之后结束；写入不能按请求前读到的旧状态裁决。
    await realRepository.recordConnectionFailure(failureInput);
    assert.deepEqual(await realRepository.getById(created.id), successfulServer, '较晚结束的失败保留全部成功连接事实');
    assert.deepEqual(realSqlite.prepare('SELECT * FROM mcp_tool_grants').all(), successfulGrants);
    const reopenedRepository = new realRepositoryModule.SQLiteMcpServerConfigRepository();
    const restored = await reopenedRepository.getById(created.id);
    const restoredSnapshot = parseMcpDiscoverySnapshot(restored.toolSnapshotJson);
    assert.equal(restoredSnapshot.protocolEra, protocolEra, '重新读取仍使用最后成功提交的链路');
    const restoredRequests = [];
    globalThis.fetch = async (_url, init) => {
      const request = captureRequest(restoredRequests, init);
      if (init.method === 'DELETE') return new Response('', { status: 200 });
      if (request.body.method === 'initialize') return jsonRpcResponse(request.body,
        { protocolVersion, capabilities: {}, serverInfo: null }, 200, { 'mcp-session-id': 'restored-session' });
      if (request.body.method === 'notifications/initialized') return new Response('', { status: 202 });
      if (request.body.method === 'tools/call') return jsonRpcResponse(request.body,
        { resultType: 'complete', content: [{ type: 'text', text: 'restored-ok' }] });
      throw new Error(`固定成功链路不应发送 ${request.body.method}`);
    };
    try {
      const client = new NegotiatingMcpClient({ url: restored.url, bearerToken: 'saved-token',
        knownProtocol: { protocolEra: restoredSnapshot.protocolEra, protocolVersion: restoredSnapshot.protocolVersion } });
      const signal = new AbortController().signal;
      await client.connect(signal);
      const called = await client.callTool(persistedTool.remoteName, {}, signal, { inputSchema: persistedTool.inputSchema });
      assert.equal(called.content[0].text, 'restored-ok');
      await client.close();
      assert.deepEqual(restoredRequests.map(({ body }) => body?.method), protocolEra === 'legacy'
        ? ['initialize', 'notifications/initialized', 'tools/call', undefined] : ['tools/call']);
      if (protocolEra === 'modern') assertModernWire(restoredRequests[0]);
      else assert.equal(restoredRequests[0].body.params.protocolVersion, protocolVersion);
    } finally { globalThis.fetch = originalFetch; }
  }
  await realRepository.updateEnabled(created.id, false, realSaveInput.nowIso);
  await realRepository.recordConnectionFailure(failureInput);
  assert.equal((await realRepository.getById(created.id)).enabled, false, '失败也不能改变用户关闭已验证服务的意图');
  const expectedConnection = { url: created.url, credentialRef: 'ref-a' };
  const changed = await realRepository.invalidateAndUpdateEndpoint({ ...realSaveInput, id: created.id,
    credentialRef: 'ref-b', expectedConnection });
  assert.equal(changed.credentialRef, 'ref-b');
  assert.equal(changed.connectionStatus, 'unverified');
  assert.deepEqual(changed.assistantIds, ['assistant-1'], '修改连接仍保存明确选择的生效对象');
  await assert.rejects(() => realRepository.save({ ...realSaveInput, id: created.id, expectedConnection }),
    (error) => error.code === 'CONFIG_CHANGED');
  assert.equal((await realRepository.getById(created.id)).credentialRef, 'ref-b', '旧表单不能覆盖新账号凭据');
  const originalRead = sqlExecutor.getFirstAsync;
  sqlExecutor.getFirstAsync = async () => { throw new Error('row read failed'); };
  await assert.rejects(() => realRepository.save({ ...realSaveInput, name: '回滚记录' }), /row read failed/);
  sqlExecutor.getFirstAsync = originalRead;
  assert.equal((await realRepository.list()).length, 1, '事务内返回记录失败必须回滚未发布凭据');
  await realRepository.recordConnectionFailure({ id: created.id, expectedUrl: created.url, expectedCredentialRef: 'ref-a',
    connectionStatus: 'unavailable', lastErrorCode: 'OLD_ERROR', nowIso: realSaveInput.nowIso });
  assert.equal((await realRepository.getById(created.id)).connectionStatus, 'unverified');
  assert.equal((await realRepository.delete(created.id)).credentialRef, 'ref-b', '回收引用必须来自实际删除的账号');
  assert.equal(await realRepository.getById(created.id), null);
  assert.equal(realSqlite.prepare('SELECT COUNT(*) AS count FROM mcp_server_assistants').get().count, 0);
} finally { realSqlite.close(); }

// 新建页导入后直接测试，之后再次测试必须复用已保存 ID / 凭据，不重读旧表单。
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const uiSaves = [];
const uiTests = [];
const uiToggleWrites = [];
const uiAlerts = [];
let uiServerLoads = 0;
let uiTestFailure = null;
let uiSavedServer = { assistantIds: ['assistant-1'], id: 'ui-server', name: '测试服务', url: 'https://ui.example/mcp',
  description: '', authMode: 'none', enabled: false, connectionStatus: 'unverified', credentialRef: 'ui-reference',
  lastProtocolEra: null, lastNegotiatedProtocolVersion: null };
const uiScreenMocks = {
  react: { ...React, default: React },
  'react-native': { ...Object.fromEntries(['ActivityIndicator', 'ScrollView', 'Switch', 'Text', 'TextInput', 'TouchableOpacity', 'View'].map((name) => [name, name])),
    StyleSheet: { create: (styles) => styles, hairlineWidth: 1 } },
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  '@shared/theme': { ThemedSurface: 'ThemedSurface', useTheme: () => ({ radius: { md: 12 }, colors: { text: { tertiary: '#888' } } }), useThemedStyles: () => ({}) },
  '@shared/ui/NavigationHeader': { default: 'NavigationHeader' },
  '@shared/ui': { Toggle: 'Toggle', showAppDialog: (dialog) => { uiAlerts.push(dialog); } },
  './McpConnectionFields': { default: 'McpConnectionFields' },
  './McpAssistantSelection': { default: 'McpAssistantSelection' },
  '@features/assistants': { listAIAssistantSummaries: async () => [{ id: 'assistant-1', name: '测试 AI' }] },
  '../application/McpConfigError': configErrorModule,
  '../application/GetMcpServer': { getMcpServer: async () => { uiServerLoads += 1; return uiSavedServer; } },
  '../application/SaveMcpServer': { saveMcpServer: async (input) => { uiSaves.push(input); return uiSavedServer; } },
  '../application/DeleteMcpServer': { deleteMcpServer: async () => undefined },
  '../application/SetMcpServerEnabled': { setMcpServerEnabled: async (id, enabled) => {
    uiToggleWrites.push({ id, enabled });
    uiSavedServer = { ...uiSavedServer, enabled };
    return uiSavedServer;
  } },
  '../application/TestMcpServerConnection': { testMcpServerConnection: async (id, protocolEra) => {
    uiTests.push({ id, protocolEra });
    if (uiTestFailure) throw new Error(uiTestFailure);
    const protocolVersion = protocolEra === 'legacy' ? '2025-06-18' : '2026-07-28';
    uiSavedServer = { ...uiSavedServer, enabled: true, connectionStatus: 'available',
      lastProtocolEra: protocolEra, lastNegotiatedProtocolVersion: protocolVersion };
    return { server: uiSavedServer, serverInfo: null, tools: [], durationMs: 1, protocolVersion };
  } },
  '../application/SetMcpToolGrant': { listMcpDiscoveredToolGrants: async () => [
    { remoteToolName: 'ui_tool', localToolName: 'mcp.ui-server.ui_tool', description: '', stale: false, canAuthorize: true, enabled: true },
  ] },
};
uiScreenMocks['@shared/ui'].ToggleField = loadTypeScriptModule('src/shared/ui/ToggleField.tsx', {
  react: { ...React, default: React }, 'react-native': uiScreenMocks['react-native'],
  '@shared/theme': uiScreenMocks['@shared/theme'], './Toggle': { default: 'Toggle' },
}).default;
uiScreenMocks['@shared/ui'].ToggleDetailRow = loadTypeScriptModule('src/shared/ui/ToggleDetailRow.tsx', {
  react: { ...React, default: React }, 'react-native': uiScreenMocks['react-native'],
  '@shared/theme': uiScreenMocks['@shared/theme'], '@expo/vector-icons': { Ionicons: 'Ionicons' },
  './ToggleField': { default: uiScreenMocks['@shared/ui'].ToggleField },
}).default;
const uiScreenModule = loadTypeScriptModule('src/features/mcpTools/presentation/McpServerConfigScreen.tsx', uiScreenMocks);
let ui;
await act(async () => { ui = create(React.createElement(uiScreenModule.default, { serverId: null, onBack: () => undefined })); });
await act(async () => { ui.root.findByType('McpConnectionFields').props.onImport({ name: '官方服务', url: 'https://ui.example/mcp', authMode: 'bearer_token', bearerToken: 'ui-token' }); });
const pressTest = async (label = '传统握手测试') => {
  const button = ui.root.findAllByType('TouchableOpacity').find((node) => node.findAllByType('Text').some((text) => text.props.children === label));
  await act(async () => { button.props.onPress(); });
};
assert.equal(ui.root.findByType('McpAssistantSelection').props.required, true);
assert.deepEqual(ui.root.findByType('McpAssistantSelection').props.selectedIds, []);
const testButton = ui.root.findAllByType('TouchableOpacity').find((node) => node.findAllByType('Text').some((label) => label.props.children === '新版协议测试'));
assert.equal(testButton.props.disabled, true, '未选择 AI 时不能测试并自动创建服务');
const legacyTestButton = ui.root.findAllByType('TouchableOpacity').find((node) => node.findAllByType('Text').some((label) => label.props.children === '传统握手测试'));
assert.equal(legacyTestButton.props.disabled, true, '传统握手同样需要先选择生效 AI');
await act(async () => { ui.root.findByType('McpAssistantSelection').props.onToggle('assistant-1', true); });
await pressTest();
await pressTest();
assert.equal(uiSaves[0].enabled, true, '新增页测试保存时默认启用服务');
assert.deepEqual(uiSaves[0].assistantIds, ['assistant-1']);
assert.deepEqual(uiSaves[1].assistantIds, ['assistant-1']);
assert.equal(uiSaves[0].id, null);
assert.equal(uiSaves[0].bearerToken, 'ui-token');
assert.equal(uiSaves[1].id, 'ui-server');
assert.equal(uiSaves[1].bearerToken, undefined);
assert.equal(uiServerLoads, 0, '新建页不能再启动编辑页加载并覆盖刚完成的测试结果');
uiTestFailure = '新版 HTTP 500';
await pressTest('新版协议测试');
assert.deepEqual(uiTests.map(({ protocolEra }) => protocolEra), ['legacy', 'legacy', 'modern']);
assert.equal(uiTests.at(-1).id, 'ui-server');
assert.equal(uiSaves.at(-1).bearerToken, undefined, '再次测试保留已保存的凭据');
assert.ok(ui.root.findAllByType('Text').some((node) => Array.isArray(node.props.children)
  && node.props.children.join('') === '传统握手 · 2025-06-18'), '新版失败后仍显示已验证的传统链路');
assert.equal(uiAlerts.at(-1).title, 'MCP 操作失败');
assert.equal(uiAlerts.at(-1).message, '新版 HTTP 500', '测试失败直接弹出原因，不依赖页面滚动位置');
assert.ok(ui.root.findAllByType('Text').some((node) => node.props.children === 'ui_tool'), '失败后保留已有工具授权列表');
const toolGrantToggle = () => ui.root.findAllByType('Toggle')
  .find((node) => node.props.accessibilityLabel === '允许 AI 请求：ui_tool');
assert.ok(toolGrantToggle(), '工具授权行把开关放在工具名右侧');
assert.equal(toolGrantToggle().props.value, true);
await act(async () => { uiAlerts.at(-1).buttons[0].onPress(); });
const alertsBeforeRetry = uiAlerts.length;
await pressTest('新版协议测试');
assert.equal(uiAlerts.length, alertsBeforeRetry + 1, '关闭弹窗后，同样的错误再次发生仍须弹出');
assert.equal(uiAlerts.at(-1).message, '新版 HTTP 500');
await act(async () => { uiAlerts.at(-1).onDismiss(); });
await act(async () => { ui.unmount(); });

let uiSaveBacks = 0;
await act(async () => { ui = create(React.createElement(uiScreenModule.default,
  { serverId: null, onBack: () => { uiSaveBacks += 1; } })); });
await act(async () => {
  ui.root.findByType('McpConnectionFields').props.onImport({ name: '直接保存', url: 'https://ui.example/mcp', authMode: 'none' });
  ui.root.findByType('McpAssistantSelection').props.onToggle('assistant-1', true);
});
await pressTest('保存');
assert.equal(uiSaves.at(-1).id, null);
assert.equal(uiSaves.at(-1).enabled, true, '新增页直接保存默认启用');
assert.equal(uiSaveBacks, 1, '保存后返回服务列表');
await act(async () => { ui.unmount(); });

uiSavedServer = { ...uiSavedServer, enabled: false };
await act(async () => { ui = create(React.createElement(uiScreenModule.default, { serverId: 'ui-server', onBack: () => undefined })); });
assert.equal(ui.root.findAllByType('Toggle')
  .filter((node) => node.props.accessibilityLabel === '启用 Server').length, 0, '服务启停开关只在工具列表，不在配置页');
assert.ok(ui.root.findAllByType('Text').some((node) => Array.isArray(node.props.children)
  && node.props.children.join('') === '传统握手 · 2025-06-18'), '重开页面仍显示保存的成功链路');
uiTestFailure = null;
await pressTest('新版协议测试');
assert.ok(ui.root.findAllByType('Text').some((node) => Array.isArray(node.props.children)
  && node.props.children.join('') === '新版协议 · 2026-07-28'), '两条都成功时显示最后成功测试的链路');
assert.ok(ui.root.findAllByType('Text').some((node) => Array.isArray(node.props.children)
  && node.props.children.join('') === '协议版本：2026-07-28'), '成功结果显示实际协议版本');
assert.deepEqual(ui.root.findByType('McpAssistantSelection').props.selectedIds, ['assistant-1'], '编辑页恢复已保存的选择');
await act(async () => { ui.root.findByType('McpAssistantSelection').props.onToggle('assistant-1', false); });
const saveButton = ui.root.findAllByType('TouchableOpacity').find((node) => node.findAllByType('Text').some((label) => label.props.children === '保存'));
assert.equal(saveButton.props.disabled, false, '已有服务允许清空生效对象');
await act(async () => { saveButton.props.onPress(); });
assert.deepEqual(uiSaves.at(-1).assistantIds, []);
assert.equal(uiSaves.at(-1).enabled, true, '配置页保存沿用当前启停状态；服务开关只在工具列表');
await act(async () => { ui.unmount(); });

let centerServer = { ...uiSavedServer, enabled: false, enabledToolCount: 2 };
let centerNavigations = 0;
const selectionWrites = [];
const { canCommitPresentationLoad } = loadTypeScriptModule('src/shared/utils/presentationLoadRevision.ts');
const centerModule = loadTypeScriptModule('src/features/mcpTools/presentation/McpToolsCenterScreen.tsx', {
  ...uiScreenMocks,
  '@expo/vector-icons': { Ionicons: 'Ionicons' },
  '@shared/ui': { EmptyState: 'EmptyState', HeaderAddButton: 'HeaderAddButton',
    ToggleDetailRow: uiScreenMocks['@shared/ui'].ToggleDetailRow },
  '@shared/utils/presentationLoadRevision': { canCommitPresentationLoad },
  '../application/ListMcpServers': { listMcpServersWithEnabledToolCounts: async () => [centerServer] },
  '../application/SetMcpServerEnabled': { setMcpServerEnabled: async (id, enabled) => {
    uiToggleWrites.push({ id, enabled });
    centerServer = { ...centerServer, enabled };
    return centerServer;
  } },
  '../application/SetMcpServerAssistantEnabled': { setMcpServerAssistantEnabled: async (id, assistantId, enabled) => {
    selectionWrites.push({ id, assistantId, enabled });
    centerServer = { ...centerServer, assistantIds: enabled ? [assistantId] : [] };
    return centerServer;
  } },
});
const centerProps = { onBack: () => undefined, onAddServer: () => undefined,
  onOpenServer: () => { centerNavigations += 1; } };
await act(async () => { ui = create(React.createElement(centerModule.default, centerProps)); });
assert.deepEqual(ui.root.findByType('McpAssistantSelection').props.selectedIds, ['assistant-1']);
await act(async () => { ui.root.findByType('McpAssistantSelection').props.onToggle('assistant-1', false); });
assert.deepEqual(selectionWrites, [{ id: 'ui-server', assistantId: 'assistant-1', enabled: false }]);
assert.deepEqual(ui.root.findByType('McpAssistantSelection').props.selectedIds, [], '列表勾选即时保存并更新展示');
assert.equal(centerNavigations, 0, '勾选对象不能触发进入服务配置');
assert.equal(centerServer.enabled, false, '对象修改不应修改连接或服务开关');
const centerToggle = () => ui.root.findAllByType('Toggle')
  .find((node) => node.props.accessibilityLabel === '启用测试服务');
assert.ok(centerToggle(), '服务列表逐项提供启停开关');
assert.equal(centerToggle().props.value, false);
await act(async () => { centerToggle().props.onValueChange(true); });
assert.deepEqual(uiToggleWrites.at(-1), { id: 'ui-server', enabled: true }, '服务开关在列表页即时保存');
assert.equal(centerToggle().props.value, true, '列表开关保存后更新展示');
await act(async () => { ui.update(React.createElement(centerModule.default, { ...centerProps, refreshRevision: 1 })); });
assert.deepEqual(ui.root.findByType('McpAssistantSelection').props.selectedIds, [], '列表重新读取保留修改');
assert.equal(centerToggle().props.value, true, '列表重读保留服务开关');
await act(async () => { ui.unmount(); });
// 收起只控制展示：展开后仍可多选，保存后的摘要随授权更新。
const selectionModule = loadTypeScriptModule('src/features/mcpTools/presentation/McpAssistantSelection.tsx', {
  '@features/assistants': { getAssistantDisplayName: (assistant) => assistant.nickname ?? assistant.name },
  react: uiScreenMocks.react,
  'react-native': uiScreenMocks['react-native'],
  'lucide-react-native': { Check: 'Check', ChevronDown: 'ChevronDown', ChevronUp: 'ChevronUp', Square: 'Square' },
  '@shared/ui': { AIAvatar: 'AIAvatar' },
  '@shared/theme': { useTheme: () => ({ colors: { brand: { primary: '#6688ff', onPrimary: '#fff' }, text: { tertiary: '#888' } } }),
    useThemedStyles: () => ({}) },
});
const selectionProps = { assistants: [{ id: 'assistant-1', name: '测试 AI', avatar: null }],
  selectedIds: ['assistant-1'], disabled: false, collapsible: true,
  onToggle: (assistantId, enabled) => { selectionWrites.push({ assistantId, enabled }); } };
await act(async () => { ui = create(React.createElement(selectionModule.default, selectionProps)); });
const checkboxRows = () => ui.root.findAllByProps({ accessibilityRole: 'checkbox' });
const selectionHeader = () => ui.root.findByProps({ accessibilityRole: 'button' });
assert.equal(checkboxRows().length, 0, '默认收起，列表不铺开所有 AI');
assert.equal(selectionHeader().props.accessibilityLabel, '生效 AI：测试 AI');
await act(async () => { selectionHeader().props.onPress(); });
assert.equal(checkboxRows().length, 1);
assert.equal(checkboxRows()[0].props.accessibilityState.checked, true);
await act(async () => { checkboxRows()[0].props.onPress(); });
assert.deepEqual(selectionWrites.at(-1), { assistantId: 'assistant-1', enabled: false });
await act(async () => { ui.update(React.createElement(selectionModule.default, { ...selectionProps, selectedIds: [] })); });
assert.equal(selectionHeader().props.accessibilityLabel, '生效 AI：未选择');
await act(async () => { selectionHeader().props.onPress(); });
assert.equal(checkboxRows().length, 0, '可再次收起多选');
await act(async () => { ui.unmount(); });
await act(async () => { ui = create(React.createElement(selectionModule.default, { ...selectionProps, collapsible: false, required: true })); });
assert.equal(checkboxRows().length, 1, '新增服务直接展示必选对象');
await act(async () => { ui.unmount(); });
delete globalThis.IS_REACT_ACT_ENVIRONMENT;

console.log('MCP boundary 行为验证通过：官方 JSON 导入、新建页测试流程、安全凭据、真实 SQLite 事务、账号隔离、配置变更 fence、meta-tool、协议与取消边界符合契约。');
