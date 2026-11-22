/** 验证定位的身份边界、真实结果输出、取消，以及用户触发的权限申请。 */
import assert from 'node:assert/strict';
import { loadTypeScriptModule } from '../helpers/load-typescript-module.mjs';

const abortRuntime = loadTypeScriptModule('src/shared/runtime/abortSignal.ts');
let hostId = 'host';
let reads = 0;
let snapshot = { status: 'permission_not_granted' };
let duringRead = () => {};
const { GetCurrentLocationTool: tool } = loadTypeScriptModule('src/features/phoneTools/aiTools/GetCurrentLocationTool.ts', {
  '@features/assistants': { runAsCurrentHostAuthority: async (actor, action) => actor === hostId
    ? { status: 'authorized', value: await action() } : { status: 'not_current_host' } },
  '@platform/device': { getCurrentDeviceLocation: async () => { reads++; duringRead(); return snapshot; } },
  '@shared/runtime/abortSignal': abortRuntime,
});
const { LegacyAgentToolAdapter } = loadTypeScriptModule('src/host/composition/agent/LegacyAgentToolAdapter.ts');
let controller = new AbortController();
let actor = 'host';
const context = { getAIId: () => actor, get abortSignal() { return controller.signal; } };
const adapter = new LegacyAgentToolAdapter(tool,
  { owner: 'phoneTools', risk: 'private_read', idempotency: 'idempotent' }, () => context);

actor = '';
assert.match((await tool.execute({}, context)).error, /^missing_actor_ai_id:/u);
actor = 'ordinary-ai';
assert.match((await tool.execute({}, context)).error, /^not_current_host:/u);
actor = 'host';
hostId = 'new-host';
assert.match((await tool.execute({}, context)).error, /^not_current_host:/u);
assert.equal(reads, 0, '无身份、普通 AI 和过期主理不得采样位置');
hostId = 'host';

for (const status of ['permission_not_granted', 'location_services_disabled', 'location_provider_unavailable', 'location_unavailable']) {
  snapshot = { status };
  const result = await adapter.execute({}, {});
  assert.equal(result.status, 'error');
  assert.ok(result.modelContent.startsWith(`${status}:`));
  assert.equal(Object.hasOwn(result, 'data'), false, '失败不得伪造坐标');
}
for (const permission of ['approximate', 'precise']) {
  snapshot = { status: 'available', latitude: 31.23, longitude: 121.47, accuracyMeters: 1200,
    measuredAtEpochMs: 1_700_000_000_000, ageMs: 3456, permission, isMock: true };
  const result = await adapter.execute({}, {});
  assert.equal(result.status, 'success');
  assert.deepEqual(result.data, { latitude: 31.23, longitude: 121.47, coordinateSystem: 'WGS84',
    accuracyMeters: 1200, measuredAt: new Date(snapshot.measuredAtEpochMs).toISOString(), ageMs: 3456,
    permission, isMock: true });
  assert.deepEqual(JSON.parse(result.modelContent.split('\n')[1]), result.data, '模型 observation 必须包含真实位置与精度/时间');
}
controller.abort();
const beforeAbortedCall = reads;
await assert.rejects(() => tool.execute({}, context), { name: 'AbortError' });
assert.equal(reads, beforeAbortedCall);
controller = new AbortController();
duringRead = () => controller.abort();
await assert.rejects(() => tool.execute({}, context), { name: 'AbortError' });

const permissions = { ACCESS_COARSE_LOCATION: 'coarse', ACCESS_FINE_LOCATION: 'fine' };
const statuses = { NEVER_ASK_AGAIN: 'never_ask_again' };
let access = { permission: 'not_granted', servicesEnabled: true };
let permissionResult = { coarse: 'denied', fine: 'denied' };
const requests = [];
let settingsOpened = 0;
const { manageDeviceLocationPermission } = loadTypeScriptModule('src/platform/device/DeviceLocation.ts', {
  'react-native': {
    Linking: { openSettings: async () => { settingsOpened++; } },
    PermissionsAndroid: { PERMISSIONS: permissions, RESULTS: statuses,
      requestMultiple: async (names) => { requests.push(names); return permissionResult; } },
  },
  '../../../modules/device-observer': { getDeviceLocationAccessState: async () => access },
});
assert.equal(requests.length, 0, '加载能力不应索取权限');
await manageDeviceLocationPermission();
assert.deepEqual(requests, [['coarse', 'fine']], '用户一次选择大致/精确，不申请后台权限');
assert.equal(settingsOpened, 0, '拒绝后不擅自打开设置');
permissionResult = { coarse: 'granted', fine: 'denied' };
await manageDeviceLocationPermission();
assert.equal(settingsOpened, 0, '大致位置属于有效授权');
permissionResult = { coarse: 'never_ask_again', fine: 'never_ask_again' };
await manageDeviceLocationPermission();
assert.equal(settingsOpened, 1, '系统不再弹授权时进入应用设置');
for (const permission of ['approximate', 'precise']) {
  access = { ...access, permission };
  await manageDeviceLocationPermission();
}
assert.equal(requests.length, 3, '已授权时管理现有授权，不重复申请');
assert.equal(settingsOpened, 3);
console.log('Phone location authority, observation and permission behavior verified.');
