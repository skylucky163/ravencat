import assert from 'node:assert/strict';
import { loadTypeScriptModule as loadModule } from './helpers/load-typescript-module.mjs';

const callback = { eventId: 'wake-old', deliveryEventId: 'wake-old', triggerKind: 'ai_schedule', source: 'work-manager' };
const runnerCompletions = [];
const routedSelfWakes = [];
const routedSignals = [];
// 取消事实的 native 侧替身：mark 过就被 runner 消费一次（一次性，与 SharedPreferences 语义一致）。
const cancellationMarkers = new Set();
// native consume 的可控闸门：用来把 runner 停在「已 register、consume 未返回」的窗口上。
let consumeGate = null;
let consumeThrows = false;
const consumeCalls = [];
let releaseSelfWakeRun = null;
// 每个用例共用的 delivery identity（与上面的 callback 一致）。
const deliveryEventId = 'wake-old';
const cancellationRegistryModule = loadModule(
  'src/features/companion/application/CompanionExecutionCancellation.ts',
  {},
);
const companionWakeTask = loadModule(
  'src/features/companion/application/ExecuteCompanionWake.ts',
  {
    './CompanionExecutionCancellation': cancellationRegistryModule,
    './CompanionRuntimeDependencies': {
      getCompanionRuntimeDependencies: () => ({
        native: {
          companion: {
            recordRunnerCompletion: async (completion) => {
              runnerCompletions.push(completion);
            },
            consumeExecutionCancellation: async (deliveryEventId) => {
              consumeCalls.push(deliveryEventId);
              if (consumeGate) await consumeGate;
              if (consumeThrows) throw new Error('native consume 不可用');
              if (!cancellationMarkers.has(deliveryEventId)) return false;
              cancellationMarkers.delete(deliveryEventId);
              return true;
            },
          },
        },
      }),
    },
    './RunHeadlessAISchedule': {
      runHeadlessAISchedule: async (data, signal) => {
        routedSelfWakes.push(data);
        routedSignals.push(signal ?? null);
        if (releaseSelfWakeRun) await releaseSelfWakeRun;
        return {
          status: 'ignored',
          reason: 'not_current_host',
        };
      },
    },

  },
);
await companionWakeTask.runCompanionWake(callback);
assert.deepEqual(runnerCompletions, [{
  deliveryEventId: 'wake-old',
  succeeded: true,
  error: 'ai_schedule_ignored:not_current_host',
}], '过期 Host callback 必须作为 handled completion，不得抛错触发 WorkManager 重试');

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

// ---- 取消可达性：跑真实模块，而不是断言源码形状 ----
// 取消可能落在 runner initialization 的三个不同位置，任何一处都不能静默丢失。

// 1) 取消早于 runner 初始化：事件叫不到任何 controller，只能靠 native 标记追平。
runnerCompletions.length = 0;
routedSignals.length = 0;
cancellationMarkers.add(deliveryEventId);
await companionWakeTask.runCompanionWake(callback);
assert.equal(
  routedSignals.at(-1)?.aborted,
  true,
  '取消早于 runner 注册时，runner 启动后消费 native 标记必须立刻追平 abort',
);
assert.equal(
  cancellationMarkers.has(deliveryEventId),
  false,
  '取消标记必须是一次性的：消费后不得再次生效',
);

// 2) 取消晚于注册：事件到达正在跑的 runner，AbortSignal 必须被 abort，
//    且 runner 到达终态后注册表必须释放，不再被取消入口命中。
runnerCompletions.length = 0;
routedSignals.length = 0;
let resolveSelfWakeRun;
releaseSelfWakeRun = new Promise((resolve) => {
  resolveSelfWakeRun = resolve;
});
const inFlightTask = companionWakeTask.runCompanionWake(callback);
await waitUntil(() => routedSignals.length === 1, 'in-flight runner 必须已经在跑');
assert.equal(routedSignals[0].aborted, false, '未收到取消前 autonomous run 不得被 abort');
assert.equal(
  companionWakeTask.cancelCompanionWakeExecution(deliveryEventId),
  true,
  '在跑的 runner 必须能通过取消入口被叫醒',
);
assert.equal(routedSignals[0].aborted, true, '取消入口必须 abort 当前 autonomous run 的 signal');
resolveSelfWakeRun();
await inFlightTask;
releaseSelfWakeRun = null;
assert.equal(
  companionWakeTask.cancelCompanionWakeExecution(deliveryEventId),
  false,
  'runner 到达终态后必须已释放注册，不能留下 stale controller',
);

// 3) 关键竞态：runner 已 register，native consume 尚未返回时取消到达。
//    这就是「先 consume 再 register」会漏掉的那段夹缝：
//    consume 返回 false → 取消到达（此时无人注册）→ register。
runnerCompletions.length = 0;
routedSignals.length = 0;
consumeCalls.length = 0;
let releaseConsume;
consumeGate = new Promise((resolve) => {
  releaseConsume = resolve;
});
const racingTask = companionWakeTask.runCompanionWake(callback);
await waitUntil(() => consumeCalls.length === 1, 'runner 必须已经进入 native consume');
assert.equal(routedSignals.length, 0, 'native consume 未返回前 runner 不得开始执行');
assert.equal(
  companionWakeTask.cancelCompanionWakeExecution(deliveryEventId),
  true,
  'register 已完成时，取消必须命中 controller（不能因为 native consume 未返回而丢失）',
);
releaseConsume();
consumeGate = null;
await racingTask;
assert.equal(routedSignals.length, 1, 'runner 仍会启动一次，但必须带着已经 abort 的 signal');
assert.equal(
  routedSignals[0].aborted,
  true,
  '取消落在 register 与 native consume 之间时不得静默丢失',
);
assert.equal(runnerCompletions.at(-1)?.succeeded, true);

// 4) 取消事实读不到（native consume 抛异常）：不得当作「没有被取消」继续跑，
//    且 registry 必须释放，不留下 stale controller。
routedSignals.length = 0;
runnerCompletions.length = 0;
consumeThrows = true;
await assert.rejects(
  companionWakeTask.runCompanionWake(callback),
  /native consume 不可用/,
);
consumeThrows = false;
assert.equal(routedSignals.length, 0, '无法确认取消状态时不得启动 autonomous run');
assert.deepEqual(
  runnerCompletions.map((completion) => completion.succeeded),
  [false],
  '无法确认取消状态必须以失败回执收口',
);
assert.equal(
  companionWakeTask.cancelCompanionWakeExecution(deliveryEventId),
  false,
  'consume 抛异常后 registry 必须已释放',
);

// 5) 取消事件到达但没有任何 runner 注册：不得抛错，也不得谎称已送达。
assert.equal(
  companionWakeTask.cancelCompanionWakeExecution('no-such-delivery'),
  false,
  '没有注册项时取消入口必须如实返回 false（取消事实仍由 native 标记持有）',
);

// 6) 注册表的语义本身：注册只登记引用，取消幂等，释放后不再命中。
const registry = cancellationRegistryModule.createCompanionExecutionCancellationRegistry();
const liveController = new AbortController();
registry.register('live', liveController);
assert.equal(liveController.signal.aborted, false, '注册本身不得 abort controller');
assert.equal(registry.cancel('live'), true);
assert.equal(liveController.signal.aborted, true);
assert.equal(registry.cancel('live'), true, '重复取消必须幂等');
assert.equal(registry.cancel('absent'), false);
registry.release('live');
assert.equal(registry.cancel('live'), false, '释放后不得再被取消入口命中');

console.log("Companion Headless cancellation and completion verified.");
