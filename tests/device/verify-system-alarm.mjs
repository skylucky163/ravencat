import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { loadTypeScriptModule } from '../helpers/load-typescript-module.mjs';

const nativeCalls = [];
let nativeResult = { status: 'alarm_request_dispatched' };
let nativeError;
let nextSnapshot = { status: 'not_scheduled' };
const platform = loadTypeScriptModule('src/platform/device/SystemAlarm.ts', {
  '../../../modules/device-control': { default: {
    ...Object.fromEntries(['showSystemAlarms', 'dismissSystemAlarm', 'snoozeSystemAlarm', 'getNextSystemAlarm'].map(name => [name, async (...args) => {
      nativeCalls.push([name, ...args]);
      if (nativeError) throw nativeError;
      return name === 'getNextSystemAlarm' ? nextSnapshot : nativeResult;
    }])),
    setSystemAlarm: async (...args) => {
      nativeCalls.push(args);
      if (nativeError) throw nativeError;
      return nativeResult;
    },
  } },
});
let currentHost = 'host-ai';
const tool = loadTypeScriptModule('src/features/deviceControl/aiTools/SetAlarmTool.ts', {
  '@features/assistants': {
    runAsCurrentHostAuthority: async (actor, action) => actor === currentHost
      ? { status: 'authorized', value: await action() }
      : { status: 'not_current_host' },
  },
  '@platform/device': platform,
  '@shared/runtime/abortSignal': loadTypeScriptModule('src/shared/runtime/abortSignal.ts'),
});
const context = (actor = 'host-ai', abortSignal = new AbortController().signal) => ({
  getAIId: () => actor, abortSignal,
});

// 参数契约在 Runtime 同样使用的 JSON Schema 边界校验，不在工具和原生桥重复校验。
const validate = new Ajv({ strict: false, coerceTypes: false }).compile(tool.definition.parameters);
for (const args of [
  { hour: 0, minute: 0 },
  { hour: 23, minute: 59, label: '起床', days_of_week: [1, 2, 3, 4, 5] },
  { hour: 7, minute: 30, days_of_week: [] },
  { hour: 9, minute: 0, days_of_week: [6, 7] },
]) assert.equal(validate(args), true, JSON.stringify(args));
for (const args of [
  {}, { hour: 7 }, { hour: -1, minute: 0 }, { hour: 24, minute: 0 },
  { hour: 7.5, minute: 0 }, { hour: '7', minute: 0 },
  { hour: 7, minute: -1 }, { hour: 7, minute: 60 }, { hour: 7, minute: 0.5 },
  { hour: 7, minute: 0, days_of_week: [0] }, { hour: 7, minute: 0, days_of_week: [8] },
  { hour: 7, minute: 0, days_of_week: [1, 1] }, { hour: 7, minute: 0, days_of_week: [1.5] },
  { hour: 7, minute: 0, days_of_week: ['1'] }, { hour: 7, minute: 0, days_of_week: null },
  { hour: 7, minute: 0, label: '' }, { hour: 7, minute: 0, label: '字'.repeat(121) },
  { hour: 7, minute: 0, date: '2026-12-01' },
]) assert.equal(validate(args), false, JSON.stringify(args));

const oneShot = await tool.execute({ hour: 7, minute: 30 }, context());
assert.equal(oneShot.success, true);
assert.deepEqual(nativeCalls.splice(0), [[7, 30, null, []]]);
assert.equal(oneShot.data.status, 'alarm_request_dispatched');
assert.equal(Object.hasOwn(oneShot.data, 'alarmId'), false);

const repeat = { hour: 8, minute: 5, label: '吃药', days_of_week: [1, 3, 7] };
const repeating = await tool.execute(repeat, context());
assert.equal(repeating.success, true);
assert.deepEqual(nativeCalls.splice(0), [[8, 5, '吃药', [1, 3, 7]]]);
assert.deepEqual(repeating.data.days_of_week, [1, 3, 7]);

// 身份变化、缺失身份及已取消的调用都不得提交设备动作。
currentHost = 'replacement-host';
assert.equal((await tool.execute(repeat, context())).success, false);
assert.equal(nativeCalls.length, 0);
currentHost = 'host-ai';
assert.equal((await tool.execute(repeat, context(''))).success, false);
assert.equal(nativeCalls.length, 0);
const cancelled = new AbortController();
cancelled.abort(new Error('闹钟调用已取消'));
await assert.rejects(() => tool.execute(repeat, context('host-ai', cancelled.signal)), /闹钟调用已取消/u);
assert.equal(nativeCalls.length, 0);

// 系统结果原样成为明确失败；每次仅派发一次，未知错误保留诊断。
for (const status of ['app_not_focused', 'clock_app_unavailable', 'alarm_request_rejected']) {
  nativeResult = { status };
  const result = await tool.execute(repeat, context());
  assert.equal(result.success, false);
  assert.ok(result.error.startsWith(`${status}:`));
  assert.equal(nativeCalls.splice(0).length, 1);
}
nativeError = new Error('原生桥异常');
await assert.rejects(() => tool.execute(repeat, context()), /原生桥异常/u);
assert.equal(nativeCalls.splice(0).length, 1);

nativeError = undefined;
nativeResult = { status: 'alarm_request_dispatched' };
const addedTools = [tool.ShowAlarmsTool, tool.DismissAlarmTool, tool.SnoozeAlarmTool, tool.GetNextAlarmTool];
const inputs = [{}, { mode: 'next' }, {}, {}];
for (const [i, entry] of addedTools.entries()) {
  currentHost = 'other-ai';
  assert.equal((await entry.execute(inputs[i], context())).success, false);
  currentHost = 'host-ai';
  assert.equal((await entry.execute(inputs[i], context(''))).success, false);
  await assert.rejects(() => entry.execute(inputs[i], context('host-ai', cancelled.signal)), /闹钟调用已取消/u);
  assert.equal(nativeCalls.length, 0);
  const schema = new Ajv({ strict: false }).compile(entry.definition.parameters);
  assert.equal(schema(inputs[i]), true);
  assert.equal(schema({ unexpected: true }), false);
}
const dismissSchema = new Ajv({ strict: false }).compile(tool.DismissAlarmTool.definition.parameters);
for (const target of [{ mode: 'next' }, { mode: 'all' }, { mode: 'time', hour: 23, minute: 59 }, { mode: 'label', label: '起床' }]) {
  assert.equal(dismissSchema(target), true);
  assert.equal((await tool.DismissAlarmTool.execute(target, context())).success, true);
  assert.deepEqual(nativeCalls.splice(0), [['dismissSystemAlarm', target.mode, target.hour ?? null, target.minute ?? null, target.label ?? null]]);
}
for (const target of [{}, { mode: 'time' }, { mode: 'time', hour: 24, minute: 0 }, { mode: 'label', label: '' }, { mode: 'next', label: '起床' }, { mode: 'delete' }]) {
  assert.equal(dismissSchema(target), false);
}
await tool.ShowAlarmsTool.execute({}, context());
assert.deepEqual(nativeCalls.splice(0), [['showSystemAlarms']]);
await tool.SnoozeAlarmTool.execute({}, context());
assert.deepEqual(nativeCalls.splice(0), [['snoozeSystemAlarm', null]]);
await tool.SnoozeAlarmTool.execute({ minutes: 5 }, context());
assert.deepEqual(nativeCalls.splice(0), [['snoozeSystemAlarm', 5]]);
const snoozeSchema = new Ajv({ strict: false }).compile(tool.SnoozeAlarmTool.definition.parameters);
for (const minutes of [0, -1, 1.5, '5', 2147483648]) assert.equal(snoozeSchema({ minutes }), false);
assert.equal((await tool.GetNextAlarmTool.execute({}, context())).data.status, 'not_scheduled');
nextSnapshot = { status: 'available', triggerAtEpochMs: 1800000000000 };
assert.deepEqual((await tool.GetNextAlarmTool.execute({}, context())).data, nextSnapshot);
assert.deepEqual(nativeCalls.splice(0), [['getNextSystemAlarm'], ['getNextSystemAlarm']]);
for (const [i, entry] of addedTools.slice(0, 3).entries()) {
  for (const status of ['app_not_focused', 'clock_app_unavailable', 'alarm_request_rejected']) {
    nativeResult = { status };
    assert.equal((await entry.execute(inputs[i], context())).success, false);
    assert.equal(nativeCalls.splice(0).length, 1);
  }
}
console.log('系统闹钟设置、展示、取消下一次、稍后再响及下一条查询契约验证通过。');
