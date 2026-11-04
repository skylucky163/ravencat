/** 验证日程诊断按投递分组、只读刷新、复制与读取失败反馈。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';

const require = createRequire(import.meta.url);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function load(file, mocks) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', code)(id => {
    if (id === 'react' || id === 'react/jsx-runtime') return require(id);
    assert.ok(Object.hasOwn(mocks, id), `${file}: 缺少依赖 ${id}`);
    return mocks[id];
  }, module, module.exports);
  return module.exports;
}

const reportModule = load('src/features/companion/presentation/CompanionDiagnosticsReport.ts', {});
const health = {
  companionSchedulerActive: true, nextCompanionWakeAtEpochMs: 1793028000000,
  applicationBackgroundRunning: false, overlayForegroundServiceRunning: true,
  lastCompanionExecutionOutcome: 'COMPLETED', lastCompanionExecutionAtEpochMs: 1793028000000,
  lastCompanionExecutionDeliveryEventId: 'second@v1', lastCompanionExecutionForegroundRunning: false,
};
const event = (id, stage, at, planned = null) => ({
  deliveryEventId: id, stage, recordedAtEpochMs: at, expectedRemindAtEpochMs: planned,
  outcome: null, deviceIdleMode: true, powerSaveMode: false, batteryOptimizationExempt: true,
});
const diagnostics = {
  device: { manufacturer: 'vivo', model: 'test-device', apiLevel: 34, packageName: 'com.example.test',
    versionName: '2.1.6', versionCode: 123, deviceIdleMode: false, powerSaveMode: false, batteryOptimizationExempt: true },
  companionSchedulingEnabled: true,
  events: [event('first@v1', 'ALARM_RECEIVED', 10000, 1000), event('second@v1', 'ALARM_RECEIVED', 20000, 2000),
    event('first@v1', 'WORKER_STARTED', 31000, 1000), event('first@v2', 'PROJECTION_ARMED', 40000, 50000)],
};
const report = reportModule.buildCompanionDiagnosticsReport(health, diagnostics, new Date(50000));
assert.equal((report.match(/投递：first@v1/g) ?? []).length, 1, '交错到达的同一投递必须分在一起');
assert.match(report, /投递：first@v2/, '修改后的日程仍有独立身份');
assert.match(report, /后台任务延迟：30 秒/);
assert.match(report, /Doze=是/);
assert.match(report, /悬浮窗前台服务：是（独立于日程执行）/);
assert.match(reportModule.buildCompanionDiagnosticsReport(health, { ...diagnostics, events: [] }, new Date()), /尚无阶段记录/);

let reads = 0;
let failure = false;
let copied = null;
const { CompanionDiagnosticsSheet } = load('src/features/companion/presentation/CompanionDiagnosticsSheet.tsx', {
  'react-native': { ActivityIndicator: 'ActivityIndicator', ScrollView: 'ScrollView', Text: 'Text', View: 'View' },
  '@platform/device': { copyTextToClipboard: text => { copied = text; } },
  '@shared/theme': { useTheme: () => ({ colors: { brand: {} } }), useThemedStyles: () => ({}) },
  '@shared/ui': { Button: 'Button', ModalSheet: 'ModalSheet' },
  '../application/CompanionNativeFacade': {
    getNativeHealth: async () => health,
    getAIScheduleDiagnostics: async () => { reads += 1; if (failure) throw new Error('读取诊断失败'); return diagnostics; },
  },
  './CompanionDiagnosticsReport': reportModule,
  './CompanionDiagnosticsSheet.styles': { createStyles: () => ({}) },
});
let screen;
await act(async () => { screen = create(React.createElement(CompanionDiagnosticsSheet, { onClose() {} })); });
const buttons = () => screen.root.findAllByType('Button');
const text = () => screen.root.findAllByType('Text').map(node => node.props.children).join('\n');
assert.equal(reads, 1);
await act(async () => { buttons()[1].props.onPress(); });
assert.match(copied, /RavenCat 日程运行诊断/);
assert.equal(buttons()[1].props.title, '已复制');
assert.equal(reads, 1, '复制不能重调度或重新读取');
failure = true;
await act(async () => { buttons()[0].props.onPress(); });
assert.equal(reads, 2);
assert.match(text(), /读取诊断失败/);
assert.equal(buttons()[1].props.disabled, true, '读取失败不复制上一轮旧记录');
failure = false;
await act(async () => { buttons()[0].props.onPress(); });
assert.equal(reads, 3);
assert.doesNotMatch(text(), /读取诊断失败/);
assert.equal(buttons()[1].props.disabled, false);
await act(async () => { screen.unmount(); });
console.log('通过：日程诊断分组、版本身份、延迟、独立服务状态、复制、手动刷新与读取失败反馈。');
