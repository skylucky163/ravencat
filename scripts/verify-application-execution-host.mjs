/** 常驻应用宿主分发与请求资源归还；不检查源码形状或内部 helper。 */
import assert from 'node:assert/strict';
import { loadTypeScriptModule } from './helpers/load-typescript-module.mjs';

const completed = [];
const received = [];
let handler = async (kind, data, context) => { received.push({ kind, data, context }); };
let listener;
const pending = [];
const invoke = kind => (data, context) => handler(kind, data, context);
const owner = loadTypeScriptModule('src/host/runtime/ApplicationExecutionHost.ts', {
  '@platform/device': {
    completeApplicationExecution: async id => completed.push(id),
    subscribeApplicationExecutions: callback => { listener = callback; },
    connectApplicationExecutionHost: async () => {
      assert.ok(listener, '桥接握手前必须已经订阅请求，避免初始化夹缝丢失通知');
      pending.push({ id: 'bridge-ready', kind: 'conversation', data: {}, remainingMs: 60_000 });
      listener();
    },
    takeApplicationExecutions: async () => pending.splice(0),
  },
  '@features/companion': { runCompanionWake: invoke('companion') },
  '@features/companion/composition': { executeFloatingMessage: invoke('floating') },
  './ExecuteConversationTurns': { executeConversationTurns: invoke('conversation') },
  './ExecuteHostRelationshipReply': { executeHostRelationshipReply: invoke('relationship') },
  './ExecuteCall': { executeCall: invoke('call') },
  '../notifications/CallNotificationAction': { executeCallNotificationAction: invoke('call_action') },
  '../notifications/TogetherListeningNotificationAction': { executeTogetherListeningNotificationAction: invoke('together_action') },
});
for (const kind of ['conversation', 'relationship', 'companion', 'floating', 'call', 'call_action', 'together_action']) {
  await owner.executeApplicationRequest({ id: kind, kind, data: { identity: kind }, remainingMs: 60_000 });
  assert.equal(received.at(-1).kind, kind);
  assert.deepEqual(received.at(-1).data, { identity: kind });
}
assert.equal(completed.length, 7);
let release;
handler = async (_kind, _data, execution) => {
  assert.equal(execution.signal.aborted, false);
  await new Promise(resolve => { release = resolve; });
};
const running = owner.executeApplicationRequest({ id: 'waiting', kind: 'conversation', data: {}, remainingMs: 60_000 });
await Promise.resolve();
assert.equal(completed.includes('waiting'), false, '模型尚未结束时请求仍由常驻宿主持有');
release(); await running;
assert.equal(completed.at(-1), 'waiting');
handler = async (_kind, _data, execution) => {
  assert.equal(execution.signal.aborted, true);
  assert.ok(execution.executionDeadlineAt <= performance.now());
};
await owner.executeApplicationRequest({ id: 'expired', kind: 'conversation', data: {}, remainingMs: 0 });
handler = async () => { throw new Error('model failed'); };
await assert.rejects(owner.executeApplicationRequest({ id: 'failed', kind: 'conversation', data: {}, remainingMs: 60_000 }), /model failed/);
assert.equal(completed.at(-1), 'failed', '失败只归还本次请求，不结束应用宿主');
handler = async (_kind, _data, execution) => {
  await new Promise(resolve => execution.signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(execution.signal.aborted, true, '剩余预算耗尽必须传递业务取消');
};
await owner.executeApplicationRequest({ id: 'deadline', kind: 'conversation', data: {}, remainingMs: 10 });
assert.equal(completed.at(-1), 'deadline');
handler = async (kind, data, context) => { received.push({ kind, data, context }); };
owner.configureApplicationExecutionHost();
await new Promise(resolve => setImmediate(resolve));
assert.equal(completed.filter(id => id === 'bridge-ready').length, 1, '握手时到达的请求只消费一次');
console.log('应用宿主验证通过：七种业务入口、等待终态、预算与失败归还。');
