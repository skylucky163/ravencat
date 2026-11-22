import { agentToolSchemaDependencies } from '../helpers/agent-tool-schema-dependencies.mjs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteExecutor } from '../helpers/sqlite-bootstrap-fixture.mjs';
import { createCoordinatedSqliteFixture } from '../helpers/coordinated-sqlite-fixture.mjs';
import { loadTypeScriptModule } from '../helpers/load-typescript-module.mjs';

const runStateModule = loadTypeScriptModule('src/platform/agentRuntime/AgentRunState.ts');
const guardsModule = loadTypeScriptModule(
  'src/platform/agentRuntime/AgentRuntimeGuards.ts',
  { './AgentRunState': runStateModule },
);
const agentToolSchemaModule = loadTypeScriptModule('src/shared/aiTools/AgentToolInputSchema.ts', agentToolSchemaDependencies);
const abortSignalModule = loadTypeScriptModule('src/shared/runtime/abortSignal.ts');
const toolExecutorModule = loadTypeScriptModule('src/platform/agentRuntime/AgentToolExecutor.ts', {
  '@shared/aiTools': agentToolSchemaModule,
  './AgentRunState': runStateModule,
});
const runLoopModule = loadTypeScriptModule('src/platform/agentRuntime/AgentRunLoop.ts', {
  './AgentRuntimeGuards': guardsModule,
  './AgentRunState': runStateModule,
  './AgentToolExecutor': toolExecutorModule,
});
const runtimeControlModule = loadTypeScriptModule(
  'src/platform/agentRuntime/AgentRuntimeControl.ts',
  { './AgentRunState': runStateModule },
);
const runtimeModule = loadTypeScriptModule('src/platform/agentRuntime/AgentRuntime.ts', {
  './AgentRuntimeGuards': guardsModule,
  './AgentRunState': runStateModule,
  './AgentRuntimeControl': runtimeControlModule,
  './AgentRunLoop': runLoopModule,
  './AgentToolExecutor': toolExecutorModule,
});
const registryModule = loadTypeScriptModule('src/platform/agentRuntime/AgentToolRegistry.ts');
const { LegacyAgentToolAdapter } = loadTypeScriptModule(
  'src/host/composition/agent/LegacyAgentToolAdapter.ts',
);

const { AgentRuntime } = runtimeModule;
const { AgentToolRegistry } = registryModule;
const { AGENT_TOOL_BATCH_TIMEOUT_MS } = guardsModule;
const { CHAT_AGENT_TASK_BUDGET_PRESET } = loadTypeScriptModule('src/features/chat/reply/agent/ChatAgentTask.ts');

function createClock() {
  let timestamp = 0;
  return {
    clock: { now: () => timestamp },
    advance(milliseconds) {
      timestamp += milliseconds;
    },
  };
}

function createTask(overrides = {}) {
  return {
    id: 'task-1',
    type: 'manual_test',
    source: 'manual_test',
    goal: '验证 Agent Runtime',
    assistantId: 'assistant-1',
    sessionId: null,
    allowedToolNames: [],
    modelTransport: 'complete',
    maxSteps: 5,
    maxToolCalls: 8,
    maxToolCallsPerStep: 3,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function createTool(name, execute, schema = { type: 'object' }) {
  return {
    descriptor: {
      name,
      description: `${name} 测试工具`,
      inputSchema: schema,
      owner: 'test',
      source: 'local',
      risk: 'safe_read',
      idempotency: 'idempotent',
    },
    execute,
  };
}

function createLegacyTool(name, execute, createContext) {
  return new LegacyAgentToolAdapter(
    {
      name,
      definition: {
        name,
        description: `${name} Legacy 测试工具`,
        parameters: { type: 'object' },
      },
      execute,
    },
    {
      owner: 'test',
      risk: 'sensitive_action',
      idempotency: 'not_idempotent',
    },
    createContext,
  );
}

function createToolCall(id, name, args = {}) {
  return {
    index: 0,
    id,
    name,
    arguments: JSON.stringify(args),
  };
}

function createTurn({ text = '', toolCalls = [], reasoningText = '' } = {}) {
  return {
    historyItems: [{
      role: 'assistant',
      content: text,
      reasoningText,
      toolCalls,
    }],
    assistantText: text,
    reasoningText,
    toolCalls,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
  };
}

class ScriptedGateway {
  constructor(turnFactory) {
    this.turnFactory = turnFactory;
    this.requests = [];
  }

  async runTurn(request, emitModelEvent) {
    this.requests.push({
      ...request,
      history: request.history.map((item) => ({
        ...item,
        toolCalls: item.toolCalls?.map((toolCall) => ({ ...toolCall })),
      })),
      tools: request.tools.map((tool) => ({ ...tool })),
    });
    return this.turnFactory(this.requests.length, request, emitModelEvent);
  }
}

async function runCase({
  turns,
  task = {},
  tools = [],
  clock = createClock(),
  signal,
  collectEvents = true,
  beforeComplete,
  resolveVisibleToolNames,
  onRuntimeCreated,
}) {
  const registry = new AgentToolRegistry();
  const executions = [];
  for (const tool of tools) {
    registry.register({
      ...tool,
      execute: async (input, context) => {
        executions.push({ name: tool.descriptor.name, input, context });
        return tool.execute(input, context);
      },
    });
  }
  const gateway = new ScriptedGateway((turnNumber, request, emitModelEvent) => {
    const turn = typeof turns === 'function'
      ? turns(turnNumber, request, emitModelEvent)
      : turns[turnNumber - 1];
    assert.ok(turn, `脚本没有为第 ${turnNumber} 个模型 turn 提供结果`);
    return turn;
  });
  const events = [];
  const runtime = new AgentRuntime({
    modelGateway: gateway,
    registry,
    clock: clock.clock,
  });
  onRuntimeCreated?.(runtime);
  const result = await runtime.run({
    runId: 'run-1',
    task: createTask({ ...task, allowedToolNames: task.allowedToolNames ?? tools.map((tool) => tool.descriptor.name) }),
    initialHistory: [],
    signal,
    eventSink: collectEvents ? (event) => events.push(event) : undefined,
    beforeComplete,
    resolveVisibleToolNames,
  });
  return { result, gateway, executions, events, clock };
}

const direct = await runCase({ turns: [createTurn({ text: '完成了' })] });
assert.equal(direct.result.terminalCode, 'COMPLETED', 'AR-01 应直接完成');
assert.equal(direct.result.toolCallCount, 0);
assert.deepEqual(direct.events.map((event) => event.type), [
  'run_started',
  'model_turn_started',
  'model_turn_completed',
  'step_completed',
  'run_completed',
]);

// 工具附图必须穿过真实执行循环，到达 complete / stream 共用的下一轮模型输入。
for (const modelTransport of ['complete', 'stream']) {
  const modelImages = [{ url: 'data:image/png;base64,AAA' }];
  const view = await runCase({
    task: { modelTransport },
    tools: [createTool('view_image', async () => ({ status: 'success', data: {}, modelContent: '原图', modelImages }))],
    turns: [createTurn({ toolCalls: [{ id: 'view-1', name: 'view_image', arguments: '{}' }] }), createTurn({ text: '看到了' })],
  });
  assert.deepEqual(view.gateway.requests[1].history.find(item => item.role === 'tool').images, modelImages);
  assert.equal(view.result.terminalCode, 'COMPLETED');
}

for (const modelTransport of ['complete', 'stream']) {
  for (const text of ['', '部分正文']) {
    let completionChecks = 0;
    const truncated = await runCase({
      task: { modelTransport },
      turns: [{ ...createTurn({ text, reasoningText: '部分思考' }), finishReason: 'length' }],
      beforeComplete: async () => {
        completionChecks++;
        return { action: 'continue', instruction: '补充生成', allowedToolNames: [] };
      },
    });
    assert.equal(truncated.result.terminalCode, 'COMPLETED');
    assert.equal(truncated.gateway.requests.length, 1, '输出额度耗尽后不能追加补充请求');
    assert.equal(completionChecks, 0, '截断不是正常回答完成，不能触发完成后的派生决策');
    assert.equal(truncated.result.steps[0].modelTurn.reasoningText, '部分思考');
    assert.equal(truncated.result.finalText, text);
  }
}

const continuationDecisions = [];
const completionContinuation = await runCase({
  task: { allowedToolNames: ['schedule_self_wake'] },
  tools: [createTool('schedule_self_wake', async () => ({
    status: 'success',
    data: {},
    modelContent: 'scheduled',
  }))],
  turns: [
    createTurn({ text: '主阶段完成' }),
    createTurn({ text: '决定不安排' }),
  ],
  beforeComplete: async (context) => {
    continuationDecisions.push(context);
    return context.completionContinuationUsed
      ? { action: 'complete' }
      : {
          action: 'continue',
          instruction: '只考虑下一次 Self Wake。',
          allowedToolNames: ['schedule_self_wake'],
        };
  },
});
assert.equal(completionContinuation.result.terminalCode, 'COMPLETED');
assert.equal(completionContinuation.result.runId, 'run-1');
assert.equal(continuationDecisions.length, 2, '正常完成前后应各读取一次调用方 completion policy');
assert.deepEqual(
  completionContinuation.gateway.requests[1].tools.map((tool) => tool.name),
  ['schedule_self_wake'],
  'completion continuation 只能看到调用方给定的受限工具',
);
assert.equal(
  completionContinuation.gateway.requests[1].completionContinuationInstruction,
  '只考虑下一次 Self Wake。',
);

const exhaustedBudgetContinuation = await runCase({
  task: {
    maxToolCalls: 1,
    allowedToolNames: ['ordinary_action', 'schedule_self_wake'],
  },
  tools: [
    createTool('ordinary_action', async () => ({
      status: 'success', data: {}, modelContent: 'ordinary done',
    })),
    createTool('schedule_self_wake', async () => ({
      status: 'success', data: {}, modelContent: 'scheduled',
    })),
  ],
  turns: [
    createTurn({ toolCalls: [createToolCall('ordinary-1', 'ordinary_action')] }),
    createTurn({ text: '普通预算已关闭' }),
    createTurn({ toolCalls: [createToolCall('schedule-1', 'schedule_self_wake')] }),
    createTurn({ text: '补充阶段完成' }),
  ],
  beforeComplete: async (context) => context.completionContinuationUsed
    ? { action: 'complete' }
    : {
        action: 'continue',
        instruction: '只考虑下一次 Self Wake。',
        allowedToolNames: ['schedule_self_wake'],
      },
});
assert.deepEqual(
  exhaustedBudgetContinuation.executions.map((execution) => execution.name),
  ['ordinary_action', 'schedule_self_wake'],
  '普通工具预算耗尽后仍应保留一次独立的 completion continuation 工具额度',
);
assert.equal(exhaustedBudgetContinuation.gateway.requests[2].toolBudget.remainingToolCalls, 1);
assert.equal(exhaustedBudgetContinuation.gateway.requests[3].tools.length, 0);

const streamedEvents = await runCase({
  task: { modelTransport: 'stream' },
  turns: async (_turnNumber, _request, emitModelEvent) => {
    await emitModelEvent({ type: 'reasoning_delta', text: '思考' });
    await emitModelEvent({ type: 'assistant_text_delta', text: '完成' });
    return createTurn({ text: '完成' });
  },
});
assert.deepEqual(streamedEvents.events.map((event) => event.type), [
  'run_started',
  'model_turn_started',
  'reasoning_delta',
  'assistant_text_delta',
  'model_turn_completed',
  'step_completed',
  'run_completed',
], '模型增量和 Runtime 生命周期事件必须保持顺序');

const oneTool = await runCase({
  turns: [createTurn({ toolCalls: [createToolCall('call-1', 'lookup', { q: 'a' })] }), createTurn({ text: '找到结果' })],
  tools: [createTool('lookup', async () => ({ status: 'success', data: { value: 1 }, modelContent: '结果 1' }))],
});
assert.equal(oneTool.result.terminalCode, 'COMPLETED', 'AR-02 应在工具后完成');
assert.deepEqual(oneTool.result.history.map((item) => item.role), ['assistant', 'tool', 'assistant']);
assert.deepEqual(oneTool.events.map((event) => event.type), [
  'run_started',
  'model_turn_started',
  'model_turn_completed',
  'tool_call_proposed',
  'tool_call_started',
  'tool_call_completed',
  'step_completed',
  'model_turn_started',
  'model_turn_completed',
  'step_completed',
  'run_completed',
], '工具批次事件必须严格按状态机顺序发布');

const twoRounds = await runCase({
  turns: [
    createTurn({ toolCalls: [createToolCall('call-1', 'first')] }),
    createTurn({ toolCalls: [createToolCall('call-2', 'second')] }),
    createTurn({ text: '两轮完成' }),
  ],
  tools: [
    createTool('first', async () => ({ status: 'success', data: 1, modelContent: '第一轮 observation' })),
    createTool('second', async () => ({ status: 'success', data: 2, modelContent: '第二轮 observation' })),
  ],
});
assert.equal(twoRounds.result.terminalCode, 'COMPLETED', 'AR-03 应保留连续两轮 observation');
assert.deepEqual(twoRounds.result.history.map((item) => item.role), ['assistant', 'tool', 'assistant', 'tool', 'assistant']);
assert.equal(twoRounds.gateway.requests[2].history.length, 4, '下一轮请求快照必须携带此前两轮的 append-only history');

const serialOrder = [];
const sameBatch = await runCase({
  turns: [createTurn({ toolCalls: [createToolCall('call-1', 'first'), { ...createToolCall('call-2', 'second'), index: 1 }] }), createTurn({ text: '串行完成' })],
  tools: [
    createTool('first', async () => { serialOrder.push('first'); return { status: 'success', data: 1, modelContent: '1' }; }),
    createTool('second', async () => { serialOrder.push('second'); return { status: 'success', data: 2, modelContent: '2' }; }),
  ],
});
assert.equal(sameBatch.result.terminalCode, 'COMPLETED', 'AR-04 应完成同轮工具批次');
assert.deepEqual(serialOrder, ['first', 'second'], 'AR-04 工具必须按模型返回顺序串行执行');

const rnLikeRegistry = new AgentToolRegistry();
rnLikeRegistry.register(createTool('rn_like_abort', async (_input, context) => {
  abortSignalModule.throwIfAbortSignalAborted(context.abortSignal);
  return { status: 'success', data: null, modelContent: 'ok' };
}));
const rnLikeExecutor = new toolExecutorModule.AgentToolExecutor(rnLikeRegistry);
const rnLikeTask = createTask({ allowedToolNames: ['rn_like_abort'] });
const rnLikePreparation = rnLikeExecutor.prepare(
  createToolCall('rn-like-call', 'rn_like_abort'),
  rnLikeTask,
);
assert.equal(rnLikePreparation.status, 'ready');
const rnLikeActiveOutcome = await rnLikeExecutor.execute(rnLikePreparation, {
  runId: 'rn-like-active-run',
  task: rnLikeTask,
  toolCallId: 'rn-like-call',
  abortSignal: { aborted: false },
});
assert.equal(rnLikeActiveOutcome.status, 'success');
await assert.rejects(
  () => rnLikeExecutor.execute(rnLikePreparation, {
    runId: 'rn-like-aborted-run',
    task: rnLikeTask,
    toolCallId: 'rn-like-call',
    abortSignal: { aborted: true },
  }),
  /Operation aborted/u,
  'RN-like cancellation 必须由 executor 重新抛回 Runtime，不得折叠为 TOOL_EXECUTION_FAILED',
);

const recoverableToolError = await runCase({
  turns: [createTurn({ toolCalls: [createToolCall('call-1', 'unstable')] }), createTurn({ text: '我已调整方案' })],
  tools: [createTool('unstable', async () => ({ status: 'error', code: 'UPSTREAM_FAILED', retryable: true, modelContent: '上游暂时失败' }))],
});
assert.equal(recoverableToolError.result.terminalCode, 'COMPLETED', 'AR-05 工具错误应作为 observation 继续');
assert.equal(recoverableToolError.result.history[1].content, '上游暂时失败');
assert.equal(recoverableToolError.executions.length, 1, 'retryable 结果不得触发 Runtime 自动重试');

const originalConsoleError = console.error;
const unexpectedToolLogs = [];
console.error = (...args) => unexpectedToolLogs.push(args);
let thrownToolError;
try {
  const fenceDb = new DatabaseSync(':memory:');
  const fixture = createCoordinatedSqliteFixture(createSqliteExecutor(fenceDb));
  try {
    const superseded = await runCase({
      turns: [createTurn({ toolCalls: [createToolCall('fence-call', 'fenced'), createToolCall('later-call', 'later')] })],
      tools: [
        createTool('fenced', async () => fixture.databaseCoordinator.transaction(
          { name: 'test.fence', feature: 'test', priority: 'interactive' },
          async tx => { await tx.runAsync('CREATE TABLE rejected_write (id INTEGER)'); throw new runStateModule.AgentRuntimeTerminalError('SUPERSEDED'); },
        )),
        createTool('later', async () => { assert.fail('失效 run 不得执行同批后续工具'); }),
      ],
    });
    assert.equal(superseded.result.terminalCode, 'SUPERSEDED', '持久 fence 先失效、signal 尚未取消时仍结束 run');
    assert.equal(superseded.gateway.requests.length, 1, '失效运行不得请求下一轮模型');
    assert.equal(superseded.executions.length, 1);
    assert.equal(unexpectedToolLogs.length, 0, '显式运行终态不记工具异常');
    assert.equal(fenceDb.prepare("SELECT name FROM sqlite_master WHERE name='rejected_write'").get(), undefined, '运行失效时事务回滚');
  } finally { fenceDb.close(); }
  thrownToolError = await runCase({
    turns: [
      createTurn({ toolCalls: [createToolCall('call-1', 'throws')] }),
      createTurn({ text: '我已根据失败 observation 收口' }),
    ],
    tools: [createTool('throws', async () => {
      throw new Error('synthetic internal failure');
    })],
  });
} finally {
  console.error = originalConsoleError;
}
assert.equal(thrownToolError.result.terminalCode, 'COMPLETED', '工具实现异常应作为 observation 继续');
assert.equal(thrownToolError.result.steps[0].toolCalls[0].outcome.status, 'error');
assert.equal(thrownToolError.result.steps[0].toolCalls[0].outcome.code, 'TOOL_EXECUTION_FAILED');
assert.equal(thrownToolError.result.history[1].content, '工具执行失败。');
assert.doesNotMatch(thrownToolError.result.history[1].content, /synthetic internal failure/);
assert.equal(unexpectedToolLogs.length, 1, '未预期工具异常只能在统一 executor 边界记录一次');
assert.equal(unexpectedToolLogs[0][0], '[AgentToolExecutor] tool execution failed');
assert.equal(unexpectedToolLogs[0][1].toolName, 'throws');
assert.equal(unexpectedToolLogs[0][1].runId, 'run-1');
assert.equal(unexpectedToolLogs[0][1].taskId, 'task-1');
assert.equal(unexpectedToolLogs[0][1].assistantId, 'assistant-1');
assert.equal(unexpectedToolLogs[0][1].error.message, 'synthetic internal failure');

const unknownTool = await runCase({
  turns: [
    createTurn({ toolCalls: [createToolCall('call-1', 'missing')] }),
    createTurn({ text: '这个工具当前不存在，我无法使用它。' }),
  ],
  tools: [createTool('lookup', async () => ({ status: 'success', data: 1, modelContent: '不应执行' }))],
  task: { allowedToolNames: ['lookup'] },
});
assert.equal(unknownTool.result.terminalCode, 'COMPLETED', 'AR-06 未知工具应作为 observation 后正常回复');
assert.equal(unknownTool.executions.length, 0);
assert.equal(unknownTool.result.steps[0].toolCalls[0].outcome.code, 'TOOL_NOT_FOUND');
assert.match(unknownTool.result.history[1].content, /未注册.*没有执行/u);
assert.equal(unknownTool.gateway.requests[1].tools.length, 0, '未知工具后必须关闭工具能力');
assert.equal(unknownTool.gateway.requests[1].toolBudget.forceFinalResponse, true);

const forbiddenTool = await runCase({
  turns: [
    createTurn({ toolCalls: [
      createToolCall('call-1', 'private'),
      createToolCall('call-2', 'lookup'),
    ] }),
    createTurn({ text: '这个工具未获授权，因此我没有执行。' }),
  ],
  tools: [
    createTool('private', async () => ({ status: 'success', data: 1, modelContent: '不应执行' })),
    createTool('lookup', async () => ({ status: 'success', data: 1, modelContent: '不应执行' })),
  ],
  task: { allowedToolNames: ['lookup'] },
});
assert.equal(forbiddenTool.result.terminalCode, 'COMPLETED', 'AR-07 未授权工具应拒绝执行后正常回复');
assert.equal(forbiddenTool.executions.length, 0);
assert.equal(forbiddenTool.result.steps[0].toolCalls[0].outcome.code, 'TOOL_NOT_ALLOWED');
assert.equal(
  forbiddenTool.result.steps[0].toolCalls[1].outcome.code,
  'TOOL_NOT_EXECUTED',
  '策略拒绝关闭工具后，同批次剩余调用必须补齐未执行 observation',
);
assert.match(forbiddenTool.result.history[1].content, /未授权.*没有执行/u);
assert.equal(forbiddenTool.gateway.requests[1].tools.length, 0, '未授权工具后必须关闭工具能力');
assert.equal(forbiddenTool.gateway.requests[1].toolBudget.forceFinalResponse, true);
assert.equal(
  forbiddenTool.events.some((event) => event.type === 'tool_call_started'),
  false,
  '未授权工具绝不能进入 started / execute 边界',
);

const disabledUnexpectedTool = await runCase({
  turns: [createTurn({ toolCalls: [createToolCall('call-disabled', 'lookup')] })],
  tools: [createTool('lookup', async () => ({
    status: 'success',
    data: 1,
    modelContent: '不应执行',
  }))],
  task: { allowedToolNames: [] },
});
assert.equal(
  disabledUnexpectedTool.result.terminalCode,
  'MODEL_PROTOCOL_ERROR',
  '无工具能力时模型意外 tool call 必须是协议错误',
);
assert.equal(disabledUnexpectedTool.executions.length, 0, '无工具能力时绝不执行意外 tool call');
assert.equal(disabledUnexpectedTool.result.steps[0].modelTurn.toolCalls[0].name, 'lookup',
  '协议拒绝必须保留模型请求的工具名，供 owner 在失败后诊断');
assert.equal(disabledUnexpectedTool.result.steps[0].toolCalls.length, 0, '记录模型请求不能伪造已执行工具结果');
const hiddenSchemaRequest = await runCase({
  turns: [createTurn({ toolCalls: [createToolCall('closed-moments', 'getMomentDetail', { momentId: 'private-moment' })] })],
  tools: [createTool('getMomentDetail', async () => ({ status: 'success', data: {}, modelContent: '不应执行' }))],
  resolveVisibleToolNames: () => [],
});
assert.equal(hiddenSchemaRequest.result.terminalCode, 'MODEL_PROTOCOL_ERROR');
assert.equal(hiddenSchemaRequest.executions.length, 0, '已授权但未暴露的工具仍禁止执行');
assert.equal(hiddenSchemaRequest.result.steps[0].modelTurn.toolCalls[0].name, 'getMomentDetail',
  '工具包未展开导致的协议拒绝也必须留下请求名称');
assert.equal(hiddenSchemaRequest.events.some((event) => event.type === 'tool_call_proposed'), false,
  '诊断记录不能把协议拒绝变成工具提案');
assert.equal(
  disabledUnexpectedTool.events.some((event) => event.type === 'tool_call_proposed'),
  false,
  '协议错误必须在 tool proposal 前终止',
);

const invalidInput = await runCase({
  turns: [
    createTurn({ toolCalls: [createToolCall('call-1', 'typed', { value: 1 })] }),
    createTurn({ toolCalls: [createToolCall('call-2', 'typed', { value: '已修正' })] }),
    createTurn({ text: '参数修正后，工具已经执行完成。' }),
  ],
  tools: [createTool('typed', async () => ({ status: 'success', data: 1, modelContent: '不应执行' }), {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  })],
});
assert.equal(invalidInput.result.terminalCode, 'COMPLETED', 'AR-08 参数无效后应允许模型修正并完成');
assert.equal(invalidInput.result.steps[0].toolCalls[0].outcome.code, 'TOOL_INPUT_INVALID');
assert.match(invalidInput.result.history[1].content, /不符合 schema.*没有执行/u);
assert.equal(invalidInput.executions.length, 1, '无效参数不得执行，修正后的下一次调用可以执行');
assert.deepEqual(invalidInput.executions[0].input, { value: '已修正' });
assert.equal(invalidInput.gateway.requests[1].tools.length, 1, '参数无效后应继续暴露已授权工具');
assert.equal(invalidInput.gateway.requests[1].toolBudget.forceFinalResponse, false);

const malformedInput = await runCase({
  turns: [
    createTurn({
      toolCalls: [{ ...createToolCall('call-json', 'typed'), arguments: '{' }],
    }),
    createTurn({ text: '工具参数不是有效 JSON，因此没有执行。' }),
  ],
  tools: [createTool('typed', async () => ({ status: 'success', data: 1, modelContent: '不应执行' }))],
});
assert.equal(malformedInput.result.terminalCode, 'COMPLETED');
assert.equal(malformedInput.executions.length, 0);
assert.match(malformedInput.result.history[1].content, /不是有效 JSON.*没有执行/u);

const invalidThenValidBatch = await runCase({
  turns: [
    createTurn({ toolCalls: [
      createToolCall('call-invalid', 'typed', { value: 1 }),
      createToolCall('call-valid', 'typed', { value: '有效' }),
    ] }),
    createTurn({ text: '同批次中的有效调用已经完成。' }),
  ],
  tools: [createTool('typed', async () => ({ status: 'success', data: 1, modelContent: '已完成' }), {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  })],
});
assert.equal(invalidThenValidBatch.result.terminalCode, 'COMPLETED');
assert.equal(invalidThenValidBatch.executions.length, 1, '可修正参数错误不得阻断同批次后续有效调用');
assert.deepEqual(
  invalidThenValidBatch.result.steps[0].toolCalls.map(({ outcome }) => outcome.status),
  ['error', 'success'],
  '同一 assistant tool-call 批次中的每个调用都必须产生 observation',
);

const schemaConstraintCases = await Promise.all([
  runCase({
    turns: [
      createTurn({ toolCalls: [createToolCall('call-enum', 'typed', { mode: 'invalid' })] }),
      createTurn({ text: '参数不符合约束，工具没有执行。' }),
    ],
    tools: [createTool('typed', async () => ({ status: 'success', data: 1, modelContent: '不应执行' }), {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['safe'] } },
      required: ['mode'],
      additionalProperties: false,
    })],
  }),
  runCase({
    turns: [
      createTurn({ toolCalls: [createToolCall('call-minimum', 'typed', { count: 0 })] }),
      createTurn({ text: '参数不符合约束，工具没有执行。' }),
    ],
    tools: [createTool('typed', async () => ({ status: 'success', data: 1, modelContent: '不应执行' }), {
      type: 'object',
      properties: { count: { type: 'integer', minimum: 1 } },
      required: ['count'],
      additionalProperties: false,
    })],
  }),
  runCase({
    turns: [
      createTurn({ toolCalls: [createToolCall('call-items', 'typed', { tags: [1] })] }),
      createTurn({ text: '参数不符合约束，工具没有执行。' }),
    ],
    tools: [createTool('typed', async () => ({ status: 'success', data: 1, modelContent: '不应执行' }), {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
      required: ['tags'],
      additionalProperties: false,
    })],
  }),
  runCase({
    turns: [
      createTurn({ toolCalls: [createToolCall('call-extra', 'typed', { unexpected: true })] }),
      createTurn({ text: '参数不符合约束，工具没有执行。' }),
    ],
    tools: [createTool(
      'typed',
      async () => ({ status: 'success', data: 1, modelContent: '不应执行' }),
      { type: 'object', additionalProperties: false },
    )],
  }),
]);
assert.deepEqual(
  schemaConstraintCases.map(({ result, executions }) => [result.terminalCode, executions.length]),
  Array.from({ length: 4 }, () => ['COMPLETED', 0]),
  'enum、数值边界、数组 items 与 additionalProperties 必须在 execute 前拒绝，并允许模型回复',
);

const maxSteps = await runCase({
  turns: [
    createTurn({ toolCalls: [createToolCall('call-1', 'lookup')] }),
    createTurn({ text: '已根据现有结果完成回答' }),
  ],
  tools: [createTool('lookup', async () => ({ status: 'success', data: 1, modelContent: '1' }))],
  task: { maxSteps: 1 },
});
assert.equal(maxSteps.result.terminalCode, 'COMPLETED', 'AR-09 达到工具回合预算后应正常收尾');
assert.equal(maxSteps.gateway.requests.length, 2, '工具回合预算用尽后必须保留最终回答轮次');
assert.equal(maxSteps.gateway.requests[1].tools.length, 0, '最终回答轮次不得继续暴露工具');
assert.equal(maxSteps.gateway.requests[1].toolBudget.forceFinalResponse, true);

// 普通 Chat 可以让模型观察每一步结果后继续，达到三十次上限后仍保留无工具最终回答。
for (const modelTransport of ['complete', 'stream']) {
  const sequential = await runCase({
    task: { ...CHAT_AGENT_TASK_BUDGET_PRESET, modelTransport },
    turns: [
      ...Array.from({ length: 30 }, (_, index) => createTurn({ toolCalls: [createToolCall(`step-${index}`, 'step_tool', { index })] })),
      createTurn({ text: '三十个步骤已逐一完成' }),
    ],
    tools: [createTool('step_tool', async input => ({ status: 'success', data: input, modelContent: JSON.stringify(input) }))],
  });
  assert.equal(sequential.result.terminalCode, 'COMPLETED');
  assert.equal(sequential.executions.length, 30, '分步观察不能在第十轮提前关闭工具');
  assert.equal(sequential.gateway.requests[10].history.filter(item => item.role === 'tool').length, 10, '后续模型请求必须包含之前步骤的结果');
  assert.equal(sequential.gateway.requests[30].tools.length, 0, '三十次调用后仍须收口，不扩大工具总额度');
  assert.equal(sequential.gateway.requests[30].toolBudget.forceFinalResponse, true);
  assert.equal(sequential.result.finalText, '三十个步骤已逐一完成');
}

const maxToolCalls = await runCase({
  turns: [
    createTurn({ toolCalls: [createToolCall('call-1', 'lookup')] }),
    createTurn({ text: '工具额度用完后正常回答' }),
  ],
  tools: [createTool('lookup', async () => ({ status: 'success', data: 1, modelContent: '1' }))],
  task: { maxToolCalls: 1 },
});
assert.equal(maxToolCalls.result.terminalCode, 'COMPLETED', 'AR-10 工具额度用完后应正常收尾');
assert.equal(maxToolCalls.executions.length, 1);
assert.equal(maxToolCalls.gateway.requests[1].tools.length, 0);

const perStepLimit = await runCase({
  turns: [
    createTurn({ toolCalls: [createToolCall('call-1', 'lookup'), { ...createToolCall('call-2', 'lookup'), index: 1 }] }),
    createTurn({ toolCalls: [createToolCall('call-3', 'lookup')] }),
    createTurn({ text: '修正批次后完成' }),
  ],
  tools: [createTool('lookup', async () => ({ status: 'success', data: 1, modelContent: '已执行修正调用' }))],
  task: { maxToolCallsPerStep: 1 },
});
assert.equal(perStepLimit.result.terminalCode, 'COMPLETED', 'AR-10a 超量批次应允许模型修正');
assert.equal(perStepLimit.executions.length, 1, '超量批次不得执行，修正后的单个调用可以执行');
assert.deepEqual(
  perStepLimit.result.steps[0].toolCalls.map((record) => record.outcome.code),
  ['TOOL_BATCH_LIMIT_EXCEEDED', 'TOOL_BATCH_LIMIT_EXCEEDED'],
);

const remainingLimit = await runCase({
  turns: [
    createTurn({ toolCalls: [createToolCall('call-1', 'lookup'), { ...createToolCall('call-2', 'lookup'), index: 1 }] }),
    createTurn({ text: '剩余额度不足后直接回答' }),
  ],
  tools: [createTool('lookup', async () => ({ status: 'success', data: 1, modelContent: '不应执行' }))],
  task: { maxToolCalls: 1 },
});
assert.equal(remainingLimit.result.terminalCode, 'COMPLETED', 'AR-10b 剩余额度不足时应整批拒绝并正常收尾');
assert.equal(remainingLimit.executions.length, 0);
assert.equal(remainingLimit.gateway.requests[1].tools.length, 0);
assert.equal(remainingLimit.gateway.requests[1].toolBudget.forceFinalResponse, true);

await assert.rejects(
  () => runCase({ turns: [createTurn({ text: '不应启动' })], task: { maxSteps: 31 } }),
  /maxSteps/,
  'AR-10c 超过 Runtime hard limits 的 task 必须创建失败',
);

const largeToolCatalog = await runCase({
  tools: Array.from({ length: 64 }, (_, index) => createTool(`catalog_tool_${index}`, async () => ({ status: 'success', data: null, modelContent: 'ok' }))),
  turns: [
    createTurn({ toolCalls: [createToolCall('large-catalog-call', 'catalog_tool_63')] }),
    createTurn({ text: '完整工具目录可用' }),
  ],
});
assert.equal(largeToolCatalog.result.terminalCode, 'COMPLETED', '已授权的完整工具目录不能受旧 48 种上限拦截');
assert.equal(largeToolCatalog.gateway.requests[0].tools.length, 64);
assert.equal(largeToolCatalog.executions[0].name, 'catalog_tool_63');

const repeatedEquivalent = await runCase({
  turns: [
    createTurn({ toolCalls: [createToolCall('call-repeated-1', 'lookup', { q: 'same' })] }),
    createTurn({ toolCalls: [createToolCall('call-repeated-2', 'lookup', { q: 'same' })] }),
    createTurn({ text: '同名同参调用在预算内完成' }),
  ],
  tools: [createTool('lookup', async () => ({ status: 'success', data: { raw: 'private' }, modelContent: 'same' }))],
});
assert.equal(repeatedEquivalent.result.terminalCode, 'COMPLETED', 'AR-11 同名同参工具在预算内可跨 step 再执行');
assert.equal(repeatedEquivalent.executions.length, 2, 'Runtime 不得以 args 指纹拦截等价调用');
assert.equal(repeatedEquivalent.gateway.requests.length, 3, '相同 modelContent 的两次 observation 后仍必须进入下一轮模型');
assert.deepEqual(
  repeatedEquivalent.gateway.requests[2].history.filter((item) => item.role === 'tool').map((item) => item.content),
  ['same', 'same'],
  '第三轮模型请求的快照必须包含两条重复 observation',
);
assert.deepEqual(
  repeatedEquivalent.result.history.filter((item) => item.role === 'tool').map((item) => item.content),
  ['same', 'same'],
  'tool history 只追加 modelContent，不得写入 raw data',
);

const cancelledController = new AbortController();
let cancelledBeforeCompleteCalls = 0;
const cancelled = await runCase({
  signal: cancelledController.signal,
  turns: () => {
    cancelledController.abort();
    return new Promise(() => {});
  },
  beforeComplete: async () => {
    cancelledBeforeCompleteCalls += 1;
    return { action: 'complete' };
  },
});
assert.equal(cancelled.result.terminalCode, 'CANCELLED_BY_USER', 'AR-12 模型请求中取消必须主动停止');
assert.equal(cancelled.gateway.requests.length, 1);
assert.equal(cancelled.gateway.requests[0].signal.aborted, true, '模型必须收到派生取消信号');
assert.equal(cancelledBeforeCompleteCalls, 0, '取消终态不得进入 completion continuation policy');

let completionRaceRuntime;
let markCompletionHookStarted;
const completionHookStarted = new Promise((resolve) => {
  markCompletionHookStarted = resolve;
});
let releaseCompletionHook;
const completionHookReleased = new Promise((resolve) => {
  releaseCompletionHook = resolve;
});
const completionRaceExecution = runCase({
  turns: [
    createTurn({ text: '模型已经自然完成' }),
    createTurn({ text: '不应启动 completion continuation' }),
  ],
  onRuntimeCreated: (runtime) => {
    completionRaceRuntime = runtime;
  },
  beforeComplete: async () => {
    markCompletionHookStarted();
    await completionHookReleased;
    return { action: 'complete' };
  },
});
await completionHookStarted;
const completionRaceCancellation = completionRaceRuntime.cancel({ runId: 'run-1' });
releaseCompletionHook();
const completionRace = await completionRaceExecution;
const completionRaceCancellationResult = await completionRaceCancellation;
assert.equal(
  completionRace.result.terminalCode,
  'CANCELLED_BY_USER',
  'AR-12b completion hook 执行期间取消必须优先于 COMPLETED',
);
assert.equal(completionRaceCancellationResult.terminalCode, 'CANCELLED_BY_USER');
assert.equal(
  completionRace.gateway.requests.length,
  1,
  'completion hook 执行期间取消不得启动 completion continuation model turn',
);

let failedBeforeCompleteCalls = 0;
const modelFailed = await runCase({
  turns: () => { throw new Error('synthetic model failure'); },
  beforeComplete: async () => {
    failedBeforeCompleteCalls += 1;
    return { action: 'complete' };
  },
});
assert.equal(modelFailed.result.terminalCode, 'MODEL_REQUEST_FAILED');
assert.equal(failedBeforeCompleteCalls, 0, '模型失败不得进入 completion continuation policy');

const toolCancellationController = new AbortController();
const toolCancelled = await runCase({
  turns: [createTurn({ toolCalls: [createToolCall('call-1', 'cancel')] }), createTurn({ text: '不应开始' })],
  signal: toolCancellationController.signal,
  tools: [createTool('cancel', async () => {
    toolCancellationController.abort();
    return new Promise(() => {});
  })],
});
assert.equal(toolCancelled.result.terminalCode, 'CANCELLED_BY_USER', 'AR-13 挂起工具中取消后必须主动停止');
assert.equal(toolCancelled.gateway.requests.length, 1);
assert.equal(toolCancelled.executions[0].context.abortSignal.aborted, true, '工具必须收到派生取消信号');

let cancellableRuntime;
let legacyUserCancelSignal;
const legacyUserCancelled = await runCase({
  turns: [
    createTurn({ toolCalls: [createToolCall('call-legacy-cancel', 'legacy_cancel')] }),
    createTurn({ text: '不应开始' }),
  ],
  onRuntimeCreated: (runtime) => {
    cancellableRuntime = runtime;
  },
  tools: [createLegacyTool(
    'legacy_cancel',
    async (_input, context) => {
      legacyUserCancelSignal = context.abortSignal;
      void cancellableRuntime.cancel({ runId: 'run-1' });
      return new Promise(() => {});
    },
    (context) => ({ abortSignal: context.abortSignal }),
  )],
});
assert.equal(legacyUserCancelled.result.terminalCode, 'CANCELLED_BY_USER');
assert.equal(
  legacyUserCancelSignal.aborted,
  true,
  'AgentRuntime.cancel 必须中止 Legacy ToolContext 上的同一条 execution signal',
);

const legacySupersedeController = new AbortController();
let legacySupersedeSignal;
const legacySuperseded = await runCase({
  turns: [
    createTurn({ toolCalls: [createToolCall('call-legacy-supersede', 'legacy_supersede')] }),
    createTurn({ text: '不应开始' }),
  ],
  signal: legacySupersedeController.signal,
  tools: [createLegacyTool(
    'legacy_supersede',
    async (_input, context) => {
      legacySupersedeSignal = context.abortSignal;
      legacySupersedeController.abort('SUPERSEDED');
      return new Promise(() => {});
    },
    (context) => ({ abortSignal: context.abortSignal }),
  )],
});
assert.equal(legacySuperseded.result.terminalCode, 'SUPERSEDED');
assert.equal(
  legacySupersedeSignal.aborted,
  true,
  'supersede 必须通过同一条 Legacy execution signal 下发',
);

assert.equal(AGENT_TOOL_BATCH_TIMEOUT_MS, 10 * 60 * 1000, '单批工具执行总时限必须为 10 分钟');

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let nextTimerId = 1;
const pendingTimers = new Map();
globalThis.setTimeout = (callback, delay) => {
  const timerId = nextTimerId;
  nextTimerId += 1;
  pendingTimers.set(timerId, { callback, delay });
  return timerId;
};
globalThis.clearTimeout = (timerId) => {
  pendingTimers.delete(timerId);
};
try {
  let notifyToolStarted;
  const toolStarted = new Promise((resolve) => {
    notifyToolStarted = resolve;
  });
  let timedOutToolSignal;
  const toolTimeoutRun = runCase({
    turns: [
      createTurn({ toolCalls: [createToolCall('call-timeout', 'slow')] }),
      createTurn({ text: '工具没有及时返回，我先说明情况。' }),
    ],
    tools: [createTool('slow', async (_input, context) => {
      timedOutToolSignal = context.abortSignal;
      notifyToolStarted();
      return new Promise(() => {});
    })],
  });
  await toolStarted;
  assert.equal(pendingTimers.size, 1, '工具执行期间只应存在当前批次共享的 deadline timer');
  const [[toolTimerId, toolTimer]] = pendingTimers.entries();
  assert.equal(toolTimer.delay, 10 * 60 * 1000);
  pendingTimers.delete(toolTimerId);
  toolTimer.callback();
  const toolTimeout = await toolTimeoutRun;
  assert.equal(toolTimeout.result.terminalCode, 'COMPLETED', 'AR-14 工具超时后仍必须允许 AI 最终回复');
  assert.equal(timedOutToolSignal.aborted, true, '工作 deadline 必须中止对挂起工具的等待');
  assert.equal(toolTimeout.result.steps[0].toolCalls[0].outcome.code, 'TOOL_EXECUTION_TIMEOUT');
  assert.equal(
    toolTimeout.result.history.find((item) => item.role === 'tool').content,
    '工具 slow 运行超时，结果未知，请勿自动重试。',
    '工具超时 observation 必须简短说明结果未知且不可自动重试',
  );
  assert.equal(toolTimeout.gateway.requests[1].tools.length, 0, '工具超时后最终回合不得再暴露工具');
  assert.equal(toolTimeout.gateway.requests[1].toolBudget.forceFinalResponse, true);

  let notifyLegacyToolStarted;
  const legacyToolStarted = new Promise((resolve) => {
    notifyLegacyToolStarted = resolve;
  });
  let timedOutLegacySignal;
  const legacyTimeoutRun = runCase({
    turns: [
      createTurn({ toolCalls: [createToolCall('call-legacy-timeout', 'legacy_slow')] }),
      createTurn({ text: 'Legacy 工具结果未知，不自动重试。' }),
    ],
    tools: [createLegacyTool(
      'legacy_slow',
      async (_input, context) => {
        timedOutLegacySignal = context.abortSignal;
        notifyLegacyToolStarted();
        return new Promise(() => {});
      },
      (context) => ({ abortSignal: context.abortSignal }),
    )],
  });
  await legacyToolStarted;
  const [[legacyTimerId, legacyTimer]] = pendingTimers.entries();
  pendingTimers.delete(legacyTimerId);
  legacyTimer.callback();
  const legacyTimeout = await legacyTimeoutRun;
  assert.equal(legacyTimeout.result.terminalCode, 'COMPLETED');
  assert.equal(timedOutLegacySignal.aborted, true);
  assert.equal(
    legacyTimeout.result.steps[0].toolCalls[0].outcome.code,
    'TOOL_EXECUTION_TIMEOUT',
    'Legacy timeout 必须保留 unknown-outcome recovery 语义',
  );

  const sharedBatchClock = createClock();
  let notifySecondToolStarted;
  const secondToolStarted = new Promise((resolve) => {
    notifySecondToolStarted = resolve;
  });
  let secondToolSignal;
  const sharedBatchRun = runCase({
    clock: sharedBatchClock,
    turns: [
      createTurn({ toolCalls: [
        createToolCall('call-shared-1', 'shared', { sequence: 1 }),
        createToolCall('call-shared-2', 'shared', { sequence: 2 }),
      ] }),
      createTurn({ text: '这一批工具共用同一个超时时间。' }),
    ],
    tools: [createTool('shared', async (input, context) => {
      if (input.sequence === 1) {
        sharedBatchClock.advance(6 * 60 * 1000);
        return { status: 'success', data: 1, modelContent: '第一个工具已完成' };
      }
      secondToolSignal = context.abortSignal;
      notifySecondToolStarted();
      return new Promise(() => {});
    })],
  });
  await secondToolStarted;
  assert.equal(pendingTimers.size, 1);
  const [[secondTimerId, secondTimer]] = pendingTimers.entries();
  assert.equal(
    secondTimer.delay,
    4 * 60 * 1000,
    '同批第二个工具只能使用整批 10 分钟中的剩余时间，不能重新获得 10 分钟',
  );
  pendingTimers.delete(secondTimerId);
  secondTimer.callback();
  const sharedBatch = await sharedBatchRun;
  assert.equal(sharedBatch.result.terminalCode, 'COMPLETED');
  assert.equal(secondToolSignal.aborted, true);
  assert.deepEqual(
    sharedBatch.result.steps[0].toolCalls.map(({ outcome }) => (
      outcome.status === 'success' ? 'success' : outcome.code
    )),
    ['success', 'TOOL_EXECUTION_TIMEOUT'],
    '同批多个工具共享一个 10 分钟 wall-clock deadline',
  );
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

const protocolError = await runCase({ turns: [createTurn()] });
assert.equal(protocolError.result.terminalCode, 'MODEL_PROTOCOL_ERROR', 'AR-15 空文本无工具必须是协议错误');

const toolOwnedVisibleOutput = await runCase({
  turns: [
    createTurn({ toolCalls: [createToolCall('call-visible-output', 'visible_output')] }),
    createTurn(),
  ],
  tools: [createTool('visible_output', async () => ({
    status: 'success',
    data: { intent: 'canonical-output' },
    metadata: { fulfillsUserVisibleOutput: true },
    modelContent: '用户可见输出意图已生成',
  }))],
});
assert.equal(
  toolOwnedVisibleOutput.result.terminalCode,
  'COMPLETED',
  '已有 canonical 用户可见输出意图时允许模型以空正文完成',
);
assert.equal(toolOwnedVisibleOutput.result.finalText, '');

// 发送工具的意图属于模型参数；Runtime 只消费成功结果，不重新解析参数或业务 data。
const outputTool = createTool('visible_output', async (input) => ({
  status: 'success', data: { intent: 'canonical-output' }, modelContent: '输出已准备',
  metadata: { fulfillsUserVisibleOutput: true, completionIntent: input.on_success },
}), {
  type: 'object', properties: { on_success: { type: 'string', enum: ['finish', 'continue'] } },
  required: ['on_success'], additionalProperties: false,
});
const finishCall = (id) => createToolCall(id, 'visible_output', { on_success: 'finish' });
const continueCall = (id) => createToolCall(id, 'visible_output', { on_success: 'continue' });
for (const modelTransport of ['complete', 'stream']) {
  const finishOutput = await runCase({
    task: { modelTransport, maxSteps: 1, maxToolCalls: 1 }, tools: [outputTool],
    turns: [createTurn({ toolCalls: [finishCall('finish')] })],
  });
  assert.equal(finishOutput.result.terminalCode, 'COMPLETED');
  assert.equal(finishOutput.gateway.requests.length, 1, 'finish 成功后不补空模型回合，预算耗尽也不追加正文');
  assert.equal(finishOutput.result.finalText, '');
  assert.equal(finishOutput.result.history.at(-1).role, 'tool', '结束仍记录完整 observation');
  assert.deepEqual(finishOutput.events.slice(-2).map(({ type }) => type), ['step_completed', 'run_completed']);

  const consecutiveOutput = await runCase({
    task: { modelTransport }, tools: [outputTool],
    turns: [
      createTurn({ toolCalls: [continueCall('first')] }),
      createTurn({ toolCalls: [finishCall('second')] }),
    ],
  });
  assert.equal(consecutiveOutput.result.terminalCode, 'COMPLETED');
  assert.equal(consecutiveOutput.gateway.requests.length, 2, 'continue 保留下一条输出，最后 finish 不再续轮');
  assert.equal(consecutiveOutput.executions.length, 2);

  const batchOutput = await runCase({
    task: { modelTransport }, tools: [outputTool],
    turns: [createTurn({ toolCalls: [finishCall('first'), finishCall('last')] })],
  });
  assert.equal(batchOutput.result.terminalCode, 'COMPLETED');
  assert.equal(batchOutput.executions.length, 2, '前一个 finish 不得截断已提出的批次');
  assert.equal(batchOutput.gateway.requests.length, 1);
}

const unfinishedBatch = await runCase({
  tools: [outputTool],
  turns: [
    createTurn({ toolCalls: [finishCall('first'), continueCall('last')] }),
    createTurn({ text: '继续补充' }),
  ],
});
assert.equal(unfinishedBatch.gateway.requests.length, 2, '只认最后一个工具的结束意图');
assert.equal(unfinishedBatch.result.finalText, '继续补充');

const failedReadTool = createTool('failed_read', async () => ({
  status: 'error', code: 'READ_FAILED', retryable: false, modelContent: '读取失败',
}));
for (const toolCalls of [
  [createToolCall('failed', 'failed_read'), finishCall('last')],
  [finishCall('first'), createToolCall('failed', 'failed_read')],
]) {
  const failedBatch = await runCase({
    tools: [outputTool, failedReadTool],
    turns: [createTurn({ toolCalls }), createTurn({ text: '处理工具失败' })],
  });
  assert.equal(failedBatch.result.terminalCode, 'COMPLETED');
  assert.equal(failedBatch.gateway.requests.length, 2, '同批前后任一工具失败都必须回灌模型');
  assert.ok(failedBatch.gateway.requests[1].history.some((item) => item.content === '读取失败'));
}

for (const input of [{}, { on_success: 'unknown' }]) {
  const invalidIntent = await runCase({
    tools: [outputTool], turns: [
      createTurn({ toolCalls: [createToolCall('invalid', 'visible_output', input)] }),
      createTurn({ toolCalls: [finishCall('corrected')] }),
    ],
  });
  assert.equal(invalidIntent.result.terminalCode, 'COMPLETED');
  assert.equal(invalidIntent.result.steps[0].toolCalls[0].outcome.code, 'TOOL_INPUT_INVALID');
  assert.equal(invalidIntent.executions.length, 1, '缺失或非法意图在 schema 边界拒绝，不执行发送');
  assert.equal(invalidIntent.gateway.requests.length, 2);
}

const finishDecisions = [];
const finishContinuation = await runCase({
  tools: [outputTool],
  turns: [
    createTurn({ text: '语音前言', toolCalls: [finishCall('main')] }),
    createTurn({ toolCalls: [finishCall('supplement')] }),
  ],
  beforeComplete: async (context) => {
    finishDecisions.push(context);
    return context.completionContinuationUsed ? { action: 'complete' } : {
      action: 'continue', instruction: '补充一个可见输出', allowedToolNames: ['visible_output'],
    };
  },
});
assert.equal(finishContinuation.result.terminalCode, 'COMPLETED');
assert.equal(finishContinuation.gateway.requests.length, 2, '工具 finish 仍经过既有完成前检查');
assert.deepEqual(finishDecisions.map(({ completionContinuationUsed }) => completionContinuationUsed), [false, true]);
assert.equal(finishDecisions[0].finalText, '语音前言', '模型已有正文不因工具结束而丢失');

const { SelectStickerTool } = loadTypeScriptModule('src/features/stickers/aiTools/StickerAgentTools.ts', {
  '@features/media': { mediaImageFailure: () => null },
  '../application/StickerRuntime': { getStickersRuntimeDependencies: () => ({ media: { resolveMediaAsset: async () => ({}) } }) },
  '../application/AIStickerCommands': { getStickerVectorState: async () => ({ status: 'missing_or_stale', reminder: '缺向量仍可发送' }) },
  '@shared/aiTools': loadTypeScriptModule('src/shared/aiTools/ToolCompletionIntent.ts'),
  '@shared/runtime/abortSignal': abortSignalModule,
  '../application/StickerQueries': {
    getStickerById: async (id) => ({
      id, mediaAssetId: 'sticker-asset', name: '猫猫', tags: [],
      annotationStatus: id === 'pending' ? 'pending' : 'ready',
    }),
  },
  '../application/StickerSearch': {},
  '../domain/StickerSearch': {},
  '../domain/Sticker': {},
});
const stickerTool = createTool(SelectStickerTool.name, SelectStickerTool.execute, SelectStickerTool.definition.parameters);
for (const on_success of ['finish', 'continue']) {
  const stickerReply = await runCase({
    tools: [stickerTool], turns: [
      createTurn({ toolCalls: [createToolCall('sticker', 'select_sticker', { sticker_id: 'ready', on_success })] }),
      ...(on_success === 'continue' ? [createTurn({ text: '再补一句' })] : []),
    ],
  });
  assert.equal(stickerReply.result.terminalCode, 'COMPLETED');
  assert.equal(stickerReply.gateway.requests.length, on_success === 'finish' ? 1 : 2);
  const outcome = stickerReply.result.steps[0].toolCalls[0].outcome;
  assert.equal(outcome.metadata.completionIntent, on_success, '真实表情包工具转交模型意图');
  assert.equal(outcome.data.sticker.stickerId, 'ready');
}
const pendingSticker = await runCase({
  tools: [stickerTool], turns: [
    createTurn({ toolCalls: [createToolCall('sticker', 'select_sticker', { sticker_id: 'pending', on_success: 'finish' })] }),
    createTurn({ text: '换一个可用表情包' }),
  ],
});
assert.equal(pendingSticker.result.steps[0].toolCalls[0].outcome.code, 'STICKER_NOT_READY');
assert.equal(pendingSticker.gateway.requests.length, 2, '真实表情包业务失败仍交回模型');

const { SendImageTool } = loadTypeScriptModule('src/features/chat/reply/agent/SendImageTool.ts', {
  '@features/media': {
    resolveMediaAsset: async id => ({ asset: { id, mimeType: 'image/png', byteSize: 100, width: 100, height: 100 } }),
    mediaImageFailure: () => null,
  },
  '@shared/aiTools': loadTypeScriptModule('src/shared/aiTools/ToolCompletionIntent.ts'),
  '@shared/runtime/abortSignal': abortSignalModule,
});
const imageSendTool = createTool(SendImageTool.name, SendImageTool.execute, SendImageTool.definition.parameters);
for (const on_success of ['finish', 'continue']) {
  const imageReply = await runCase({
    tools: [imageSendTool], turns: [
      createTurn({ toolCalls: [createToolCall('image', 'send_image', { media_asset_id: 'downloaded-image', on_success })] }),
      ...(on_success === 'continue' ? [createTurn({ text: '补充图片说明' })] : []),
    ],
  });
  assert.equal(imageReply.result.terminalCode, 'COMPLETED');
  assert.equal(imageReply.gateway.requests.length, on_success === 'finish' ? 1 : 2, '图片可独立结束回复，也可继续补充内容');
  assert.equal(imageReply.result.steps[0].toolCalls[0].outcome.data.attachment.mediaAssetId, 'downloaded-image');
}

const completeAndStream = await Promise.all([
  runCase({ turns: [createTurn({ text: '同一状态机' })], task: { modelTransport: 'complete' } }),
  runCase({ turns: [createTurn({ text: '同一状态机' })], task: { modelTransport: 'stream' } }),
]);
assert.deepEqual(
  completeAndStream[0].result,
  completeAndStream[1].result,
  'complete/stream 必须共用同一 Runtime 状态机',
);
assert.deepEqual(
  completeAndStream.map(({ gateway }) => gateway.requests[0].transport),
  ['complete', 'stream'],
  'Runtime 必须把 transport 交给同一个 gateway 契约',
);

console.log('Agent Runtime 行为验证通过：AR-01～AR-15、append-only history、预算/策略/超时 observation、强制最终回答、跨 step 等价调用、取消与 complete/stream 共用状态机。');
