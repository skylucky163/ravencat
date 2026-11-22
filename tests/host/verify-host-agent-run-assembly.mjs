import assert from 'node:assert/strict';
import ts from 'typescript';
import { loadTypeScriptModule, readRepoFile } from '../helpers/load-typescript-module.mjs';

function parse(relativePath) {
  return ts.createSourceFile(
    relativePath,
    readRepoFile(relativePath),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

const assemblyPath = 'src/host/composition/agent/HostAgentRunAssembly.ts';
const assemblyAst = parse(assemblyPath);
const assemblyImports = assemblyAst.statements
  .filter(ts.isImportDeclaration)
  .map((statement) => statement.moduleSpecifier.text);
assert.equal(
  assemblyImports.some((specifier) => specifier.startsWith('@features/')),
  false,
  'Host Agent Run assembly 不得依赖任何 Feature',
);

let registryCreations = 0;
let registeredAllowedNames = null;
let registeredPackageAllowedNames = null;
let registeredDirectToolNames = null;
let disposeCount = 0;
const releasedToolRuns = [];
let capturedRuntimeRequest = null;
let capturedModelInstructions = null;
let pendingRuntime = null;
let preparationGate = null;
let directGate = null;
let mcpGate = null;
let disposeGate = null;
let disposeFailure = null;
let modelCalls = 0;
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const flush = () => new Promise(done => setImmediate(done));

class TestAgentRuntime {
  constructor(dependencies) {
    this.dependencies = dependencies;
  }

  async run(request) {
    capturedRuntimeRequest = request;
    modelCalls += 1;
    await this.dependencies.modelGateway.runTurn({});
    if (request.task.goal === 'fail') {
      throw new Error('synthetic failure');
    }
    if (request.task.goal === 'pending') {
      pendingRuntime = this;
      return await new Promise((resolve) => {
        this.resolvePending = resolve;
        const cancel = () => resolve({ terminalCode: 'CANCELLED_BY_USER', runId: request.runId });
        if (request.signal.aborted) cancel();
        else request.signal.addEventListener('abort', cancel, { once: true });
      });
    }
    return { terminalCode: 'COMPLETED', runId: request.runId };
  }

  async cancel(request) {
    const result = { terminalCode: 'CANCELLED_BY_USER', runId: request.runId };
    this.resolvePending(result);
    return result;
  }
}

const assembly = loadTypeScriptModule(assemblyPath, {
  '@platform/agentRuntime': { AgentRuntime: TestAgentRuntime },
  './createAgentToolRegistry': {
    readDirectToolNamesForHostRun: async (id) => {
      assert.equal(id, 'test-assistant');
      if (directGate) { directGate.started.resolve(); await directGate.release.promise; }
      return ['package_child'];
    },
    releaseAgentToolRunScope: (runId) => { releasedToolRuns.push(runId); },
    prepareAgentToolRegistry: async (createLegacyContext) => {
      registryCreations += 1;
      assert.equal(typeof createLegacyContext, 'function');
      if (preparationGate) { preparationGate.started.resolve(); await preparationGate.release.promise; }
      return { registryId: registryCreations };
    },
    getToolPackageRuntimeBindings: (registry) => [{
      packageId: 'packageA',
      tool: { descriptor: { name: 'package_child' }, registryId: registry.registryId },
    }],
  },
  './ToolPackageExposure': {
    registerToolPackagesForHostRun: ({ registry, allowedToolNames, bindings, directToolNames }) => {
      registeredDirectToolNames = directToolNames;
      assert.equal(registry.registryId, registryCreations);
      assert.equal(bindings[0].tool.registryId, registry.registryId);
      registeredPackageAllowedNames = [...allowedToolNames];
      const selected = allowedToolNames.filter((name) => name === 'package_child');
      return {
        packageToolNames: selected,
        visibleToolNames: () => [],
        instructions: () => ({ catalog: '固定工具目录' }),
        metaToolNames: selected.length > 0
          ? ['open_tool_package']
          : [],
      };
    },
  },
  './registerMcpToolsForHostRun': {
    registerMcpToolsForHostRun: async ({ registry, allowedToolNames, assistantId }) => {
      assert.equal(assistantId, 'test-assistant', 'Host 执行冻结必须传入 task 的 Assistant 实体 ID');
      assert.equal(registry.registryId, registryCreations, 'MCP 必须注册到本次唯一 Built-in Registry');
      registeredAllowedNames = [...allowedToolNames];
      if (mcpGate) { mcpGate.started.resolve(); await mcpGate.release.promise; }
      return {
        allowlistMcpToolNames: allowedToolNames.filter((name) => name.startsWith('mcp.')),
        metaToolNames: allowedToolNames.some((name) => name.startsWith('mcp.'))
          ? ['mcp_list_tools', 'mcp_call_tool']
          : [],
        dispose: async () => {
          disposeCount += 1;
          if (disposeGate) { disposeGate.started.resolve(); await disposeGate.release.promise; }
          if (disposeFailure) throw disposeFailure;
        },
      };
    },
  },
});

function createSyntheticRequest(runId, goal = 'success') {
  return {
    runId,
    task: {
      assistantId: 'test-assistant',
      id: `task-${runId}`,
      goal,
      allowedToolNames: ['built_in', 'package_child', 'mcp.server.lookup'],
    },
    initialHistory: [],
    modelGateway: { runTurn: async (request) => { capturedModelInstructions = request.toolInstructions; return {}; } },
    createLegacyContext: () => ({ synthetic: true }),
  };
}

await assembly.runHostAgent(createSyntheticRequest('success'));
assert.deepEqual(registeredDirectToolNames, ['package_child'], 'Host 必须读取本次 AI 的特批偏好');
assert.deepEqual(registeredAllowedNames, ['built_in', 'package_child', 'mcp.server.lookup']);
assert.deepEqual(registeredPackageAllowedNames, ['built_in', 'package_child', 'mcp.server.lookup']);
assert.deepEqual(
  capturedRuntimeRequest.task.allowedToolNames,
  [
    'built_in',
    'package_child',
    'open_tool_package',
    'mcp_list_tools',
    'mcp_call_tool',
  ],
  'Host 保留内置授权，工具包仅收窄暴露，MCP 仍走固定 meta-tools',
);
assert.deepEqual(capturedRuntimeRequest.resolveVisibleToolNames(), ['built_in', 'open_tool_package', 'mcp_list_tools', 'mcp_call_tool']);
assert.deepEqual(capturedModelInstructions, { catalog: '固定工具目录' });
assert.equal(disposeCount, 1, '成功后必须释放 MCP lifecycle');
await assert.rejects(
  assembly.cancelHostAgentRun({ runId: 'success' }),
  /not active/,
  '成功后不得残留 active runtime',
);

await assert.rejects(
  assembly.runHostAgent(createSyntheticRequest('failure', 'fail')),
  /synthetic failure/,
);
assert.equal(disposeCount, 2, '失败后必须释放 MCP lifecycle');
await assert.rejects(
  assembly.cancelHostAgentRun({ runId: 'failure' }),
  /not active/,
  '失败后不得残留 active runtime',
);

const pendingExecution = assembly.runHostAgent(createSyntheticRequest('cancelled', 'pending'));
while (pendingRuntime === null) {
  await Promise.resolve();
}
const cancelled = await assembly.cancelHostAgentRun({ runId: 'cancelled' });
assert.equal(cancelled.terminalCode, 'CANCELLED_BY_USER');
assert.equal((await pendingExecution).terminalCode, 'CANCELLED_BY_USER');
assert.equal(disposeCount, 3, '取消后必须释放 MCP lifecycle');
assert.equal(releasedToolRuns.length, 3, '成功、失败、取消都必须释放 Tool 的临时查询队列');
await assert.rejects(
  assembly.cancelHostAgentRun({ runId: 'cancelled' }),
  /not active/,
  '取消后不得残留 active runtime',
);

assert.equal(registryCreations, 3, '每次 Host run 必须且只能创建一个 Built-in Registry');
for (const stage of ['registry', 'direct', 'mcp']) {
  const gate = { started: deferred(), release: deferred() };
  preparationGate = stage === 'registry' ? gate : null;
  directGate = stage === 'direct' ? gate : null;
  mcpGate = stage === 'mcp' ? gate : null;
  const modelCallsBefore = modelCalls;
  const runId = `reset-${stage}`;
  const execution = assembly.runHostAgent(createSyntheticRequest(runId));
  await gate.started.promise;
  await assert.rejects(assembly.runHostAgent(createSyntheticRequest(runId)), /already registered/);
  let resetFinished = false;
  const reset = assembly.cancelActiveHostAgentRunsForReset().then(() => { resetFinished = true; });
  await flush();
  assert.equal(resetFinished, false, 'reset 必须等待尚未完成的准备阶段');
  const declined = await assembly.runHostAgent(createSyntheticRequest(`late-${stage}`));
  assert.equal(declined.terminalCode, 'CANCELLED_BY_USER', 'reset 期间不接纳迟到请求');
  gate.release.resolve();
  assert.equal((await execution).terminalCode, 'CANCELLED_BY_USER');
  await reset;
  assert.equal(modelCalls, modelCallsBefore, '取消后的准备结果不得启动模型');
  preparationGate = null; directGate = null; mcpGate = null;
  assembly.resumeHostAgentRunsAfterReset();
}
disposeGate = { started: deferred(), release: deferred() };
const disposing = assembly.runHostAgent(createSyntheticRequest('disposing'));
await disposeGate.started.promise;
let disposedResetFinished = false;
const disposedReset = assembly.cancelActiveHostAgentRunsForReset().then(() => { disposedResetFinished = true; });
await flush();
assert.equal(disposedResetFinished, false, 'reset 必须等待连接释放');
disposeGate.release.resolve();
await Promise.all([disposing, disposedReset]);
disposeGate = null;
assembly.resumeHostAgentRunsAfterReset();
assert.equal((await assembly.runHostAgent(createSyntheticRequest('after-reset'))).terminalCode, 'COMPLETED');
pendingRuntime = null;
disposeFailure = new Error('cleanup failed');
const cleanupFailureRun = assembly.runHostAgent(createSyntheticRequest('cleanup-failure', 'pending'));
const observedFailure = assert.rejects(cleanupFailureRun, /cleanup failed/);
while (pendingRuntime === null) await Promise.resolve();
await assert.rejects(assembly.cancelActiveHostAgentRunsForReset(), error => error instanceof AggregateError
  && error.errors[0].cause.message === 'cleanup failed');
await observedFailure;
disposeFailure = null;
assembly.resumeHostAgentRunsAfterReset();
console.log('Host Agent Run assembly 的 Feature 边界、Package/MCP 冻结及 lifecycle 已验证。');
