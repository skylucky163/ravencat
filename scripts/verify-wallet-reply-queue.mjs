/** 验证记账批次的数据换代、当前输入和恢复出厂关闭边界。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { SCHEMAS, createSqliteExecutor } from './helpers/sqlite-bootstrap-fixture.mjs';

function load(file, mocks = {}, globals = {}) {
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file,
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', ...Object.keys(globals), source)(id => {
    assert.ok(Object.hasOwn(mocks, id), `未提供依赖 ${id}`);
    return mocks[id];
  }, module, module.exports, ...Object.values(globals));
  return module.exports;
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const db = new DatabaseSync(':memory:');
db.exec(SCHEMAS.ledgerRecords);
const { SQLiteLedgerRepository } = load('src/features/wallet/infrastructure/SQLiteLedgerRepository.ts', {
  '@platform/persistence': { databaseCoordinator: { openTaskExecutor: () => createSqliteExecutor(db) } },
  '../domain/WalletRecord': load('src/features/wallet/domain/WalletRecord.ts'),
});
const repository = new SQLiteLedgerRepository();
const record = await repository.insertRecord({ id: 'one', type: 'expense', category: '餐饮', amount: 10 });
const deleted = await repository.insertRecord({ id: 'two', type: 'expense', category: '交通', amount: 20 });
await repository.insertRecord({ id: 'unrelated', category: '历史餐饮', detail: '历史午餐', amount: 30 });
const timers = new Map();
let sequence = 0;
const queue = load('src/features/wallet/application/QueueLedgerAIReply.ts', {}, {
  setTimeout: callback => { const id = ++sequence; timers.set(id, callback); return id; },
  clearTimeout: id => timers.delete(id),
});
const fire = () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } };
let ai = { id: 'ai', apiKey: 'test-key', model: 'old' };
const calls = [];
const deps = { getLedgerAI: async () => ai,
  getRecords: ids => repository.getRecords({ ids, limit: ids.length }),
  triggerReply: async params => { calls.push(params); return { success: true, error: null }; } };
const enqueue = (value = record, callbacks = {}, dependencies = deps) => queue.queueLedgerAIReply({ record: value }, callbacks, dependencies);

await enqueue(); await enqueue(deleted); await enqueue();
await repository.updateRecord(record.id, { amount: 42 });
await repository.deleteRecord(deleted.id);
ai = { ...ai, model: 'new' };
fire(); await setImmediate();
assert.equal(calls.length, 1);
assert.equal(calls[0].aiProfile.model, 'new');
assert.deepEqual(calls[0].newRecords.map(item => [item.id, item.amount]), [['one', 42]]);

const { triggerLedgerAIReply } = load('src/features/wallet/application/TriggerLedgerAIReply.ts', {
  '../domain/WalletRecord': load('src/features/wallet/domain/WalletRecord.ts'),
});
const currentRecord = (await repository.getRecords({ ids: [record.id], limit: 1 }))[0];
let triggerRequest;
const triggered = await triggerLedgerAIReply({ aiProfile: ai, newRecords: [currentRecord] }, {
  hostRepository: { cleanupExpiredBlocks: async () => {}, isAIBlocked: async () => ({ isBlocked: false }) },
  ledgerRepository: repository,
  chatReplyGateway: { generateReply: async request => {
    triggerRequest = request;
    return { sessionId: 'session', text: '已收到账目', error: null };
  } },
});
assert.equal(triggered.success, true);
assert.equal((triggerRequest.triggerData.match(/历史餐饮[(（]历史午餐[)）]/g) ?? []).length, 1,
  '同一笔历史账目在回复资料中只能出现一次');
assert.ok(triggerRequest.triggerData.includes('1. 支出 餐饮 ¥42.00'), '本批次账目保持原有详细投影');

await enqueue(deleted);
fire(); await setImmediate(); assert.equal(calls.length, 1, '全部账目已删除时不启动回复');

await enqueue(); ai = { ...ai, id: 'replacement' };
fire(); await setImmediate(); assert.equal(calls.length, 1);
await enqueue(); ai = null;
fire(); await setImmediate(); assert.equal(calls.length, 1);
ai = { id: 'ai', apiKey: 'test-key', model: 'new' };
await enqueue(); await queue.stopLedgerAIReplyQueueForReset();
fire(); await setImmediate(); assert.equal(calls.length, 1);
assert.equal((await enqueue()).queued, false);
queue.resumeLedgerAIReplyQueueAfterReset();

// 旧入队查询即使在新 Host 开放后才返回，也不能把旧账目重新加入队列。
const lookup = deferred();
const enqueuePending = enqueue(record, {}, { ...deps, getLedgerAI: () => lookup.promise });
await queue.stopLedgerAIReplyQueueForReset(); queue.resumeLedgerAIReplyQueueAfterReset();
lookup.resolve(ai); assert.equal((await enqueuePending).queued, false);

// 派发准备阶段由队列等待；关闭后读到的资料不能启动回复。
const recordsGate = deferred();
await enqueue(record, {}, { ...deps, getRecords: () => recordsGate.promise });
fire(); await setImmediate();
let drained = false;
const preparationStop = queue.stopLedgerAIReplyQueueForReset().then(() => { drained = true; });
await setImmediate(); assert.equal(drained, false);
recordsGate.resolve([record]); await preparationStop; assert.equal(calls.length, 1);
queue.resumeLedgerAIReplyQueueAfterReset();

// Host 同时取消 Agent；队列等待其终态，关闭后不回传迟到的失败。
const replyGate = deferred(); const lateErrors = [];
await enqueue(record, { onError: error => lateErrors.push(error.message) }, { ...deps, triggerReply: () => replyGate.promise });
fire(); await setImmediate();
drained = false;
const runningStop = queue.stopLedgerAIReplyQueueForReset().then(() => { drained = true; });
await setImmediate(); assert.equal(drained, false);
replyGate.resolve({ success: false, error: '迟到失败' });
await runningStop; assert.deepEqual(lateErrors, []);
queue.resumeLedgerAIReplyQueueAfterReset();

const errors = [];
await enqueue(record, { onError: error => errors.push(error.message) }, {
  ...deps, triggerReply: async () => { throw new Error('预备查询失败'); },
});
fire(); await setImmediate(); assert.deepEqual(errors, ['预备查询失败']);
await enqueue(record, { onError: error => errors.push(error.message) }, {
  ...deps, triggerReply: async () => ({ success: false, error: '回复失败' }),
});
fire(); await setImmediate(); assert.deepEqual(errors, ['预备查询失败', '回复失败']);
await queue.stopLedgerAIReplyQueueForReset();
db.close();
console.log('记账批次：当前配置/账目、角色撤销、准备与执行关闭、迟到入队和失败反馈通过。');
