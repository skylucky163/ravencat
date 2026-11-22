import { agentToolSchemaDependencies } from '../helpers/agent-tool-schema-dependencies.mjs';
/** PHONE-8D3B：网易云播放状态与控制 Tool 的行为契约。 */

import assert from 'node:assert/strict';
import { loadTypeScriptModule } from '../helpers/load-typescript-module.mjs';

class NetEasePlaybackError extends Error {
  constructor(reason, message = reason) {
    super(message);
    this.reason = reason;
    this.name = 'NetEasePlaybackError';
  }
}

class NetEasePlaybackContractError extends Error {
  constructor(reason, message = reason) {
    super(message);
    this.reason = reason;
    this.name = 'NetEasePlaybackContractError';
  }
}

const playbackApplication = {
  NetEasePlaybackError,
  NetEasePlaybackContractError,
  getNetEasePlaybackSnapshot: async () => {
    throw new Error('测试必须显式注入 get playback capability');
  },
  controlNetEasePlayback: async () => {
    throw new Error('测试必须显式注入 control playback capability');
  },
};
const execution = {
  runNetEaseToolAsCurrentHost: async (_context, capability) => capability(),
  netEaseToolSuccess: (summary, data) => ({
    success: true,
    message: `${summary}\n结构化结果：${JSON.stringify(data)}`,
    data,
  }),
  netEaseToolFailure: ({ code, message }) => ({
    success: false,
    error: `${code}: ${message}`,
    errorCode: code,
  }),
};
const mocks = {
  '../application/NetEasePlayback': playbackApplication,
  './NetEaseToolExecution': execution,
};
const getModule = loadTypeScriptModule(
  'src/features/phoneTools/aiTools/NetEaseGetPlaybackStateTool.ts',
  mocks,
);
const controlModule = loadTypeScriptModule(
  'src/features/phoneTools/aiTools/NetEaseControlPlaybackTool.ts',
  mocks,
);
const { matchesAgentToolInputSchema } = loadTypeScriptModule(
  'src/shared/aiTools/AgentToolInputSchema.ts', agentToolSchemaDependencies);

const getSchema = getModule.netEaseGetPlaybackStateDefinition.parameters;
assert.deepEqual(getSchema, {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
});
assert.equal(matchesAgentToolInputSchema({}, getSchema), true);
for (const invalid of [{ packageName: 'com.netease.cloudmusic' }, { songId: 1 }, { query: 'x' }]) {
  assert.equal(matchesAgentToolInputSchema(invalid, getSchema), false);
}

const controlSchema = controlModule.netEaseControlPlaybackDefinition.parameters;
assert.deepEqual(controlSchema.required, ['command']);
assert.deepEqual(controlSchema.properties.command.enum, ['pause', 'resume', 'next', 'previous']);
assert.equal(controlSchema.additionalProperties, false);
for (const command of ['pause', 'resume', 'next', 'previous']) {
  assert.equal(matchesAgentToolInputSchema({ command }, controlSchema), true);
}
for (const command of ['play', 'stop', 'seek', 'PAUSE', '']) {
  assert.equal(matchesAgentToolInputSchema({ command }, controlSchema), false);
}

const snapshot = {
  status: 'playback_snapshot_available',
  targetPackage: 'com.netease.cloudmusic',
  snapshot: {
    playback: { state: 'playing', positionMs: 1200, speed: 1, updatedAtEpochMs: 10 },
    metadata: { mediaId: '1', title: '晴天', artist: '周杰伦', album: '叶惠美', durationMs: 269000 },
    actions: { play: true, pause: true, next: true, previous: true },
  },
};
let getCalls = 0;
const getTool = getModule.createNetEaseGetPlaybackStateTool(async () => {
  getCalls += 1;
  return snapshot;
});
const getResult = await getTool.execute({}, {});
assert.equal(getResult.success, true);
assert.strictEqual(getResult.data, snapshot);
assert.match(getResult.message, /playback_snapshot_available/u);
assert.match(getResult.message, /"playback"/u);
assert.match(getResult.message, /"metadata"/u);
assert.match(getResult.message, /"actions"/u);
assert.equal(getCalls, 1);

for (const reason of [
  'protected_app',
  'permission_not_granted',
  'no_active_session',
  'snapshot_failed',
]) {
  const tool = getModule.createNetEaseGetPlaybackStateTool(async () => {
    throw new NetEasePlaybackError(reason, `${reason} message`);
  });
  const result = await tool.execute({}, {});
  assert.equal(result.success, false);
  assert.equal(result.errorCode, reason);
}

for (const error of [
  new NetEasePlaybackContractError('invalid_package_name'),
  new Error('unknown get failure'),
]) {
  const tool = getModule.createNetEaseGetPlaybackStateTool(async () => { throw error; });
  await assert.rejects(() => tool.execute({}, {}), (actual) => actual === error);
}

const controlCalls = [];
const controlTool = controlModule.createNetEaseControlPlaybackTool(async (command) => {
  controlCalls.push(command);
  return {
    status: 'playback_command_dispatched',
    targetPackage: 'com.netease.cloudmusic',
    command,
  };
});
for (const command of ['pause', 'resume', 'next', 'previous']) {
  const result = await controlTool.execute({ command }, {});
  assert.equal(result.success, true);
  assert.equal(result.data.command, command);
  assert.match(result.message, /playback_command_dispatched/u);
  assert.match(result.message, /最终播放状态尚未重新确认/u);
  assert.doesNotMatch(result.message, /已暂停|已恢复播放|已切到下一首|已经返回上一首/u);
}
assert.deepEqual(controlCalls, ['pause', 'resume', 'next', 'previous']);

for (const reason of [
  'protected_app',
  'permission_not_granted',
  'no_active_session',
  'action_not_supported',
  'dispatch_failed',
]) {
  const tool = controlModule.createNetEaseControlPlaybackTool(async () => {
    throw new NetEasePlaybackError(reason, `${reason} message`);
  });
  const result = await tool.execute({ command: 'pause' }, {});
  assert.equal(result.success, false);
  assert.equal(result.errorCode, reason);
}

for (const error of [
  new NetEasePlaybackContractError('invalid_command'),
  new Error('unknown control failure'),
]) {
  const tool = controlModule.createNetEaseControlPlaybackTool(async () => { throw error; });
  await assert.rejects(() => tool.execute({ command: 'pause' }, {}), (actual) => actual === error);
}

console.log('PHONE-8D3B NetEase playback Tool 行为契约检查通过。');
