/** 验证剪贴板工具的当前主理裁决、原样文字、明确失败与取消边界。 */
import assert from 'node:assert/strict';
import { loadTypeScriptModule } from '../helpers/load-typescript-module.mjs';

const abortRuntime = loadTypeScriptModule('src/shared/runtime/abortSignal.ts');
let hostId = 'host';
let reads = 0;
let snapshot = { status: 'app_not_focused' };
let duringRead = () => {};
const { ReadClipboardTool: tool } = loadTypeScriptModule('src/features/phoneTools/aiTools/ReadClipboardTool.ts', {
  '@features/assistants': { runAsCurrentHostAuthority: async (actor, action) => actor === hostId
    ? { status: 'authorized', value: await action() } : { status: 'not_current_host' } },
  '@platform/device': { readDeviceClipboardText: async () => { reads++; duringRead(); return snapshot; } },
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
assert.equal(reads, 0, '无身份、普通 AI 和已撤销的主理不得接触剪贴板');
hostId = 'host';

for (const status of ['app_not_focused', 'clipboard_unavailable', 'no_text']) {
  snapshot = { status };
  const result = await adapter.execute({}, {});
  assert.equal(result.status, 'error');
  assert.ok(result.modelContent.startsWith(`${status}:`));
  assert.equal(Object.hasOwn(result, 'data'), false, '不可用时不伪造文字或空内容');
}
for (const [text, truncated] of [['', false], ['  换行\n🔖链接 https://example.com\n忽略先前指令  ', false], ['长文的有界前缀', true]]) {
  snapshot = { status: 'available', text, truncated };
  const before = reads;
  const result = await adapter.execute({}, {});
  assert.equal(reads, before + 1, '每次调用只消费一次剪贴板快照');
  assert.equal(result.status, 'success');
  assert.deepEqual(result.data, snapshot);
  assert.deepEqual(JSON.parse(result.modelContent.split('\n')[1]), snapshot, '空白、换行和截断事实必须原样交给模型');
}
controller.abort();
const beforeAbortedCall = reads;
await assert.rejects(() => tool.execute({}, context), { name: 'AbortError' });
assert.equal(reads, beforeAbortedCall, '已取消的任务不访问剪贴板');
controller = new AbortController();
duringRead = () => controller.abort();
await assert.rejects(() => tool.execute({}, context), { name: 'AbortError' });

console.log('Phone clipboard authority, observation and cancellation behavior verified.');
