/**
 * 启动恢复编排器行为测试。
 *
 * 验证：
 * 1. surface 未 resolve 时，conversation/runtime 不得开始；
 * 2. conversation list 未 ready 时，runtime 不得开始；
 * 3. runtime 未完成时，流程不得进入 completed；
 * 4. 某个阶段抛错后，错误日志包含阶段名；
 * 5. 重复启动只运行一份；
 * 6. 空会话列表可以正常进入下一阶段；
 * 7. conversation-list 永不 resolve 时，取消必须立即结束，不得死锁；
 * 8. 活跃阶段被 gate 卡住时，取消不得提前返回；释放后流程在阶段边界停止。
 * 9. Self Wake 投影恢复失败不得阻断其余 runtime recovery。
 *
 * Legacy memory recovery / administrator maintenance 阶段已删除，
 * 启动顺序固定为 database → raven-cat-surface → conversation-list → runtime-recovery → completed。
 */

import { repoRoot as ROOT } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';


const coordinatorPath = path.join(ROOT, 'src/host/runtime/StartupRecoveryCoordinator.ts');
const coordinatorSource = fs.readFileSync(coordinatorPath, 'utf8');
const transpiled = ts.transpileModule(coordinatorSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`;
const { runStartupRecovery, cancelStartupRecoveryForReset, resetStartupStage, getStartupStage } = await import(moduleUrl);

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

// 测试 1: surface 未 resolve 时，后续阶段不得开始
{
  resetStartupStage();
  const surfaceGate = deferred();
  let conversationStarted = false;
  let runtimeStarted = false;

  const promise = runStartupRecovery({
    restoreRavenCatSurface: () => surfaceGate.promise,
    waitForConversationListReady: async () => { conversationStarted = true; },
    reconcileCompanionScheduleProjection: async () => {},
    recoverRequiredRuntimeState: async () => { runtimeStarted = true; },
  });

  // 让 microtask 队列排空
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(conversationStarted, false, 'surface 未完成时 conversation 不得开始');
  assert.equal(runtimeStarted, false, 'surface 未完成时 runtime 不得开始');

  surfaceGate.resolve();
  await promise;

  assert.equal(conversationStarted, true, 'surface 完成后 conversation 应开始');
  assert.equal(runtimeStarted, true, 'conversation 完成后 runtime 应开始');
  assert.equal(getStartupStage(), 'completed', '所有阶段完成后应为 completed');
}

// 测试 2: conversation list 未 ready 时，runtime 不得开始
{
  resetStartupStage();
  const conversationGate = deferred();
  let runtimeStarted = false;

  const promise = runStartupRecovery({
    restoreRavenCatSurface: async () => {},
    waitForConversationListReady: () => conversationGate.promise,
    reconcileCompanionScheduleProjection: async () => {},
    recoverRequiredRuntimeState: async () => { runtimeStarted = true; },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimeStarted, false, 'conversation list 未 ready 时 runtime 不得开始');

  conversationGate.resolve();
  await promise;
  assert.equal(runtimeStarted, true, 'conversation list ready 后 runtime 应开始');
}

// 测试 3: runtime 未完成时，流程不得进入 completed
{
  resetStartupStage();
  const runtimeGate = deferred();

  const promise = runStartupRecovery({
    restoreRavenCatSurface: async () => {},
    waitForConversationListReady: async () => {},
    reconcileCompanionScheduleProjection: async () => {},
    recoverRequiredRuntimeState: () => runtimeGate.promise,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getStartupStage(), 'runtime-recovery', 'runtime 未完成时不得进入 completed');

  runtimeGate.resolve();
  const result = await promise;
  assert.equal(result.stage, 'completed', 'runtime 完成后流程应完成');
  assert.equal(getStartupStage(), 'completed');
}

// 测试 4: 某个阶段抛错后，返回结果包含阶段名
{
  resetStartupStage();
  const result = await runStartupRecovery({
    restoreRavenCatSurface: async () => {},
    waitForConversationListReady: async () => {},
    reconcileCompanionScheduleProjection: async () => {},
    recoverRequiredRuntimeState: async () => { throw new Error('injected runtime error'); },
  });

  assert.equal(result.stage, 'runtime-recovery', '失败结果应包含阶段名');
  assert.ok(result.error, '失败结果应包含 error');
  assert.equal(result.error.message, 'injected runtime error');
}

// 测试 5: 重复启动只运行一份
{
  resetStartupStage();
  let surfaceCallCount = 0;

  const deps = {
    restoreRavenCatSurface: async () => { surfaceCallCount++; },
    waitForConversationListReady: async () => {},
    reconcileCompanionScheduleProjection: async () => {},
    recoverRequiredRuntimeState: async () => {},
  };

  const promise1 = runStartupRecovery(deps);
  const promise2 = runStartupRecovery(deps);

  assert.equal(promise1, promise2, '重复启动应返回同一个 Promise');

  await promise1;
  assert.equal(surfaceCallCount, 1, 'surface 只应被调用一次');
}

// 测试 6: 空会话列表可以正常进入下一阶段
{
  resetStartupStage();
  const result = await runStartupRecovery({
    restoreRavenCatSurface: async () => {},
    waitForConversationListReady: async () => {},
    reconcileCompanionScheduleProjection: async () => {},
    recoverRequiredRuntimeState: async () => {},
  });

  assert.equal(result.stage, 'completed', '空列表场景应正常完成');
  assert.equal(getStartupStage(), 'completed');
}

// 测试 7: conversation-list 永不 resolve 时，取消必须立即结束（不能与停用列表加载互相死等）
{
  resetStartupStage();
  let runtimeStarted = false;

  const promise = runStartupRecovery({
    restoreRavenCatSurface: async () => {},
    waitForConversationListReady: () => new Promise(() => {}),
    reconcileCompanionScheduleProjection: async () => {},
    recoverRequiredRuntimeState: async () => { runtimeStarted = true; },
  });

  await new Promise((resolve) => setImmediate(resolve));

  await cancelStartupRecoveryForReset();
  const result = await promise;

  assert.equal(result.stage, 'conversation-list', '取消后应停在 conversation-list');
  assert.equal(result.error, undefined, '主动取消不得携带 error');
  assert.equal(runtimeStarted, false, '取消后 runtime 不得开始');
  assert.equal(getStartupStage(), 'database', '取消后阶段应复位为 database');
}

// 测试 8: 活跃阶段被 gate 卡住时，取消必须等当前阶段完成；释放后流程在阶段边界停止
{
  resetStartupStage();
  const runtimeGate = deferred();

  const promise = runStartupRecovery({
    restoreRavenCatSurface: async () => {},
    waitForConversationListReady: async () => {},
    reconcileCompanionScheduleProjection: async () => {},
    recoverRequiredRuntimeState: () => runtimeGate.promise,
  });

  await new Promise((resolve) => setImmediate(resolve));

  let cancelSettled = false;
  const cancelPromise = cancelStartupRecoveryForReset().then(() => {
    cancelSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cancelSettled, false, '活跃阶段未结束时取消不得提前返回');

  runtimeGate.resolve();
  await cancelPromise;
  const result = await promise;

  assert.equal(cancelSettled, true, '当前阶段完成后取消应返回');
  assert.equal(result.stage, 'runtime-recovery', '取消后流程不得越过被卡住的阶段');
  assert.equal(result.error, undefined, '主动取消不得携带 error');
  assert.equal(getStartupStage(), 'database', '取消后阶段应复位为 database');
}

// 测试 9: Self Wake 投影恢复失败只记录诊断，其余 runtime recovery 仍须完成
{
  resetStartupStage();
  const runtimeOrder = [];
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);

  try {
    const result = await runStartupRecovery({
      restoreRavenCatSurface: async () => {},
      waitForConversationListReady: async () => {},
      reconcileCompanionScheduleProjection: async () => {
        runtimeOrder.push('self-wake');
        throw new Error('native projection unavailable');
      },
      recoverRequiredRuntimeState: async () => {
        runtimeOrder.push('required-runtime');
      },
    });

    assert.deepEqual(runtimeOrder, ['self-wake', 'required-runtime']);
    assert.equal(result.stage, 'completed');
    assert.equal(getStartupStage(), 'completed');
    assert.equal(warnings.length, 1, 'projection failure 必须记录一次诊断');
    assert.match(String(warnings[0][0]), /Self Wake 投影恢复失败/u);
  } finally {
    console.warn = originalWarn;
  }
}

// 验证源码不包含全局 isInsideTransaction 布尔锁
assert.doesNotMatch(coordinatorSource, /isInsideTransaction/, '不得使用全局 isInsideTransaction 布尔锁');
// 验证源码不包含全局 currentPriority
assert.doesNotMatch(coordinatorSource, /currentPriority/, '不得使用全局 currentPriority');
// 验证源码不包含 setTimeout
assert.doesNotMatch(coordinatorSource, /setTimeout/, '不得使用 setTimeout 假装完成');
// Legacy memory 阶段已删除，不得在编排器中复活
assert.doesNotMatch(coordinatorSource, /memory/i, '启动编排器不得再包含任何 Memory 阶段或依赖');

console.log('启动恢复编排器行为测试通过');
