import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(relative, dependencies) {
  const filename = path.join(root, relative);
  const module = new Module(filename);
  module.filename = filename;
  module.require = id => {
    if (!Object.hasOwn(dependencies, id)) throw new Error(`未注入的测试边界 ${id}`);
    return dependencies[id];
  };
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return module.exports;
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function flush() { await new Promise(resolve => setImmediate(resolve)); }

let order = [];
const gate = load('src/host/composition/ensureHostDatabaseReady.ts', {
  '@platform/persistence': { async initDatabase() { order.push('database'); } },
  './completePendingBackupRestore': { async completePendingBackupRestore() { order.push('restore'); } },
});
await gate.ensureHostDatabaseReady();
assert.deepEqual(order, ['restore', 'database'], '没有备份恢复任务时也必须等待普通 bootstrap');
const rejectTask = load('src/host/notifications/CallNotificationAction.ts', {
  '../composition/ensureHostDatabaseReady': gate,
  '@features/calls': {
    async getCallSession(id) { order.push('query'); return { id, aiAssistantId: 'ai', chatSessionId: 'chat' }; },
    async rejectCall() { order.push('reject'); },
  },
});
order = [];
await rejectTask.executeCallNotificationAction({ callId: 'call', aiId: 'ai', sessionId: 'chat', notificationAction: 'reject' });
assert.deepEqual(order, ['restore', 'database', 'query', 'reject']);

const leaveTask = load('src/host/notifications/TogetherListeningNotificationAction.ts', {
  '../composition/ensureHostDatabaseReady': gate,
  '@features/togetherListening': {
    async getTogetherListeningActivityById(id) { order.push('query'); return { id, hostAiId: 'ai', chatSessionId: 'chat' }; },
    async leaveTogetherListeningByUser() { order.push('leave'); },
  },
});
order = [];
await leaveTask.executeTogetherListeningNotificationAction({ activityId: 'activity', hostAiId: 'ai', chatSessionId: 'chat', notificationAction: 'leave' });
assert.deepEqual(order, ['restore', 'database', 'query', 'leave']);

function harness({ alive = true, pending = [], deferInitialize = false, failInitialize = false, deferDrain = false } = {}) {
  const terminal = deferred();
  const initialization = deferred();
  const drained = deferred();
  const calls = [];
  const acknowledgements = [];
  let commandListener, cancellationListener, finished = false;
  const runtime = {
    terminal: terminal.promise,
    async stopMedia() {},
    async drain() { if (deferDrain) await drained.promise; },
    complete() { terminal.resolve(); },
    async initialize() {
      calls.push('initialize');
      if (deferInitialize) await initialization.promise;
      if (failInitialize) throw new Error('初始化失败');
    },
    getSnapshot: () => ({ isListening: true, async stopRealtimeSpeech() { calls.push('mute'); }, async startRealtimeSpeech() { calls.push('unmute'); } }),
  };
  const entry = load('src/host/runtime/ExecuteCall.ts', {
    '../composition/ensureHostDatabaseReady': { async ensureHostDatabaseReady() { calls.push('bootstrap'); } },
    '@features/calls': {
      async getCallSession(id) { return { id, state: 'active' }; },
      async endCall(id, reason) { calls.push(reason); terminal.resolve(); return { call: { id, state: 'ended' } }; },
    },
    '@features/calls/composition': {
      createCallMediaRuntime: () => runtime,
      registerHostedCallMediaRuntime(id) { calls.push(`owner:${id}`); },
    },
    '../../../modules/call-runtime': {
      nativeCallRuntime: {
        async isAlive() { return alive; },
        async ready() { calls.push('ready'); },
        async finish() { finished = true; calls.push('finish'); },
        async acknowledge(id, error) { acknowledgements.push([id, error]); },
      },
      async pendingNativeCallCommands() { return pending; },
      subscribeNativeCallCommand(listener) { commandListener = listener; return { remove() { commandListener = null; } }; },
      subscribeNativeCallCancellation(listener) { cancellationListener = listener; return { remove() { cancellationListener = null; } }; },
    },
  });
  return {
    calls, acknowledgements, terminal, initialization, drained,
    get finished() { return finished; },
    command(data) { commandListener?.(data); },
    cancel() { alive = false; cancellationListener?.({ callId: 'call' }); },
    run: () => entry.executeCall({ callId: 'call' }),
  };
}
const command = { callId: 'call', requestId: 'command', action: 'hangup', muted: false };
{
  const host = harness();
  const task = host.run();
  await flush();
  assert.equal(host.finished, false, '媒体就绪不是任务终态');
  host.command({ ...command, callId: 'old-call' });
  assert.equal(host.finished, false, '旧电话命令不能取消当前宿主');
  host.command(command);
  await task;
  assert.deepEqual(host.calls, ['bootstrap', 'owner:call', 'initialize', 'ready', 'userEnded', 'finish']);
  assert.deepEqual(host.acknowledgements, [['command', null]]);
  assert.equal(host.calls.filter(value => value === 'userEnded').length, 1, '无需挂载 React 页面即可处理悬浮窗/通知的直接挂断命令');
}
{
  const host = harness({ pending: [command] });
  const task = host.run();
  await flush();
  host.command(command);
  await task;
  assert.equal(host.calls.filter(value => value === 'userEnded').length, 1, '事件与 pending 追平只提交一次动作');
}
{
  const host = harness({ alive: false });
  await host.run();
  assert.deepEqual(host.calls, ['bootstrap', 'runtimeError', 'finish'], '晚注册任务不能恢复已取消宿主');
}
{
  const host = harness({ deferInitialize: true });
  const task = host.run();
  await flush();
  host.cancel();
  host.initialization.resolve();
  await task;
  assert.equal(host.calls.includes('ready'), false, '初始化中的取消不能晚到就绪');
  assert.equal(host.finished, true);
}
{
  const host = harness();
  const task = host.run();
  await flush();
  host.cancel();
  await task;
  assert.equal(host.calls.includes('runtimeError'), true);
  assert.equal(host.finished, true);
}
{
  const host = harness({ failInitialize: true });
  await assert.rejects(host.run(), /初始化失败/);
  assert.equal(host.calls.includes('runtimeError'), true);
  assert.equal(host.finished, true);
}
{
  const host = harness({ deferDrain: true });
  const task = host.run();
  await flush();
  host.command(command);
  await flush();
  assert.equal(host.finished, false, '业务终态后仍等待本通输入任务退场');
  assert.deepEqual(host.acknowledgements, [['command', null]], '后台挂断先回执结束动作，不等待整轮输入退场');
  host.drained.resolve();
  await task;
  assert.equal(host.finished, true);
}
console.log('通话执行宿主检查通过：bootstrap、整通等待、动作回执、身份隔离、晚注册取消、初始化失败与输入退场。');
