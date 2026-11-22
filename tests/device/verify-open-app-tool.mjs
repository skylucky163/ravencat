import assert from 'node:assert/strict';
import { loadTypeScriptModule, readRepoFile as read } from '../helpers/load-typescript-module.mjs';

const abortSignalRuntime = loadTypeScriptModule('src/shared/runtime/abortSignal.ts');

class OpenAppError extends Error {
  constructor(reason, message = reason) {
    super(message);
    this.reason = reason;
    this.name = 'OpenAppError';
  }
}

let currentHostAiId = 'host-ai';
let foundationCalls = 0;
let foundationResult = {
  status: 'launch_dispatched',
  targetPackage: 'com.example.app',
};
let foundationError = null;

const toolModule = loadTypeScriptModule(
  'src/features/deviceControl/aiTools/OpenAppTool.ts',
  {
    '@features/assistants': {
      runAsCurrentHostAuthority: async (actorAiId, action) => {
        if (actorAiId !== currentHostAiId) return { status: 'not_current_host' };
        return { status: 'authorized', value: await action() };
      },
    },
    '@shared/runtime/abortSignal': abortSignalRuntime,
    '../application/OpenApp': {
      OpenAppError,
      openAppByPackage: async () => {
        foundationCalls += 1;
        if (foundationError) throw foundationError;
        return foundationResult;
      },
    },
  },
);

const { definition, execute } = toolModule;
assert.equal(definition.name, 'open_app');
assert.deepEqual(definition.parameters.required, ['package_name']);
assert.deepEqual(Object.keys(definition.parameters.properties), ['package_name']);
assert.equal(definition.parameters.properties.package_name.type, 'string');
assert.equal(definition.parameters.properties.package_name.minLength, 1);
assert.equal(definition.parameters.properties.package_name.pattern, '^\\S+$');
assert.equal(definition.parameters.additionalProperties, false);

const contextFor = (
  actorAiId = 'host-ai',
  abortSignal = new AbortController().signal,
) => ({ getAIId: () => actorAiId, abortSignal });

// Case 1 / 2 / 11：成功只调用一次 foundation，并保持 execution truth。
foundationCalls = 0;
foundationError = null;
foundationResult = { status: 'launch_dispatched', targetPackage: 'com.example.app' };
const success = await execute({ package_name: 'com.example.app' }, contextFor());
assert.equal(success.success, true);
assert.equal(foundationCalls, 1);
assert.deepEqual(success.data, foundationResult);
assert.match(success.message, /launch_dispatched/u);
assert.match(success.message, /启动请求/u);
assert.match(success.message, /派发/u);
for (const forbiddenPromise of ['已成功打开', '已经打开', '已进入前台', '已切换成功']) {
  assert.doesNotMatch(success.message, new RegExp(forbiddenPromise, 'u'));
}

// Case 3：missing actor 不得进入 authority 或 foundation。
foundationCalls = 0;
const missingActor = await execute(
  { package_name: 'com.example.app' },
  {
    getAIId: () => undefined,
    abortSignal: new AbortController().signal,
  },
);
assert.equal(missingActor.success, false);
assert.equal(missingActor.errorCode, 'missing_actor_ai_id');
assert.equal(foundationCalls, 0);

// Case 4：旧 Host 不得触发设备动作。
currentHostAiId = 'new-host-ai';
foundationCalls = 0;
const staleHost = await execute(
  { package_name: 'com.example.app' },
  contextFor('host-ai'),
);
assert.equal(staleHost.success, false);
assert.equal(staleHost.errorCode, 'not_current_host');
assert.equal(foundationCalls, 0);

// Case 5：authority callback 内先检查 abort。
currentHostAiId = 'host-ai';
const abortController = new AbortController();
abortController.abort(new Error('open app cancelled'));
foundationCalls = 0;
await assert.rejects(
  () => execute(
    { package_name: 'com.example.app' },
    contextFor('host-ai', abortController.signal),
  ),
  /open app cancelled/u,
);
assert.equal(foundationCalls, 0);

// Case 6—9 / 11：正式 foundation error reason 原样映射，且每次至多调用一次。
for (const reason of [
  'invalid_target_package',
  'protected_app',
  'app_not_launchable',
  'launch_failed',
]) {
  foundationCalls = 0;
  foundationError = new OpenAppError(reason);
  const result = await execute({ package_name: 'com.example.app' }, contextFor());
  assert.equal(result.success, false);
  assert.equal(result.errorCode, reason);
  assert.match(result.error, new RegExp(`^${reason}:`, 'u'));
  assert.equal(foundationCalls, 1, `${reason} 不得 retry`);
  if (reason === 'invalid_target_package') {
    assert.match(result.error, /search_installed_apps/u);
  }
  if (reason === 'app_not_launchable') {
    assert.doesNotMatch(result.error, /未安装/u);
  }
}

// Case 10：未知异常必须暴露为 programmer failure。
foundationCalls = 0;
foundationError = new Error('boom');
await assert.rejects(
  () => execute({ package_name: 'com.example.app' }, contextFor()),
  /boom/u,
);
assert.equal(foundationCalls, 1);

// Case 12 / 13：Tool 不做 hidden search、foreground verification、等待或 retry。
const toolSource = read('src/features/deviceControl/aiTools/OpenAppTool.ts');
for (const forbidden of [
  'searchInstalledApps',
  'getInstalledLaunchableApps',
  'getCurrentWindowState',
  'setTimeout',
  'sleep',
  'poll',
  'retry',
]) {
  assert.doesNotMatch(toolSource, new RegExp(forbidden, 'u'), `OpenAppTool 不得包含 ${forbidden}`);
}

console.log('PHONE-6B open_app Tool contracts verified.');
