/** 保护分步执行、失败页面交付、主理准入和禁止自动重发，不锁定页面实现。 */
import assert from 'node:assert/strict';
import { loadTypeScriptModule as load } from '../helpers/load-typescript-module.mjs';

const abort = load('src/shared/runtime/abortSignal.ts');
const policy = load('src/features/phoneTools/application/ProtectedAppsPolicy.ts');
let protectedPackages = [];
let actor = 'host';
const controller = new AbortController();
const calls = [];
const page = { kind: 'text_entry', label: '写想法 / 写长文分叉页', packageName: 'com.xingin.xhs',
  windowId: 12, reliable: true, keyboardVisible: false, issue: null, fields: [], visibleLabels: ['写想法', '写长文'], availableActions: ['start_text_note', 'back'] };
let result = { status: 'completed', page, step: 'open_text_entry', actionAttempted: true, publishAttempted: false };
const tools = load('src/features/phoneTools/aiTools/XiaohongshuNoteTools.ts', {
  '@features/assistants': { runAsCurrentHostAuthority: async (id, run) => id === 'host'
    ? { status: 'authorized', value: await run() } : { status: 'not_current_host' } },
  '@platform/device': { executeXiaohongshuNote: async (...args) => { calls.push(args); return result; } },
  '@shared/runtime/abortSignal': abort,
  '../application/CurrentProtectedAppsPolicy': { loadCurrentProtectedPackages: async () => protectedPackages },
  '../application/ProtectedAppsPolicy': policy,
});
const context = { getAIId: () => actor, abortSignal: controller.signal };
const cases = [
  [tools.XiaohongshuGetPageTool, {}, { operation: 'get_page' }],
  [tools.XiaohongshuEnterPublishingTool, {}, { operation: 'enter_publishing' }],
  [tools.XiaohongshuOpenTextEntryTool, {}, { operation: 'open_text_entry' }],
  [tools.XiaohongshuStartTextNoteTool, {}, { operation: 'start_text_note' }],
  [tools.XiaohongshuSetCardTextTool, { text: '中文 AbC 20261028\n第二行' }, { operation: 'set_card_text', text: '中文 AbC 20261028\n第二行' }],
  [tools.XiaohongshuSetTitleTool, { text: '标题' }, { operation: 'set_title', text: '标题' }],
  [tools.XiaohongshuSetBodyTool, { text: '正文\n换行' }, { operation: 'set_body', text: '正文\n换行' }],
  [tools.XiaohongshuAddTopicTool, { tag: 'RavenCat' }, { operation: 'add_topic', tag: 'RavenCat' }],
  [tools.XiaohongshuSelectStyleTool, { slot: 2 }, { operation: 'select_style', slot: 2 }],
  [tools.XiaohongshuSetVisibilityTool, { visibility: 'private' }, { operation: 'set_visibility', visibility: 'private' }],
  [tools.XiaohongshuNextTool, {}, { operation: 'next' }],
  [tools.XiaohongshuGoBackTool, {}, { operation: 'back' }],
  [tools.XiaohongshuPreparePublishTool, {}, { operation: 'prepare_publish' }],
  [tools.XiaohongshuPublishPreparedNoteTool, { draft_id: 'receipt-1' }, { operation: 'publish', draft_id: 'receipt-1' }],
];
for (const [tool, args, command] of cases) {
  const before = calls.length;
  for (actor of ['', 'ordinary']) assert.equal((await tool.execute(args, context)).success, false);
  actor = 'host'; protectedPackages = ['com.xingin.xhs'];
  assert.match((await tool.execute(args, context)).error, /^protected_app:/u);
  assert.equal(calls.length, before);
  protectedPackages = [];
  assert.deepEqual((await tool.execute(args, context)).data, result);
  assert.equal(calls.length, before + 1, '每次语义调用只交给原生一个步骤');
  assert.deepEqual(calls.at(-1), ['host', command, controller.signal]);
}
const { LegacyAgentToolAdapter } = load('src/host/composition/agent/LegacyAgentToolAdapter.ts');
const adapter = new LegacyAgentToolAdapter(tools.XiaohongshuStartTextNoteTool,
  { owner: 'phoneTools', risk: 'reversible_write', idempotency: 'not_idempotent' }, () => context);
result = { status: 'not_completed', page, step: 'start_text_note', reason: '窗口切换后未完成', actionAttempted: true, publishAttempted: false };
let before = calls.length;
const failure = await adapter.execute({}, {});
assert.equal(failure.status, 'error');
assert.match(failure.modelContent, /text_entry|写想法.*写长文/u, '真实 adapter 失败文字必须让模型读到现场页面');
assert.match(failure.modelContent, /availableActions/u);
assert.match(failure.modelContent, /确认现场后重新调用/u, '非发布失败允许 AI 看清现场后重新决策');
assert.equal(calls.length, before + 1, '失败时不自动重试');
result = { ...result, status: 'publish_outcome_unknown', publishAttempted: true };
const unknown = await tools.XiaohongshuPublishPreparedNoteTool.execute({ draft_id: 'receipt-1' }, context);
assert.equal(unknown.success, false);
assert.match(unknown.error, /禁止自动重试或重新准备发布/u);
assert.ok(unknown.error.includes(JSON.stringify(page)));
before = calls.length;
controller.abort();
await assert.rejects(() => tools.XiaohongshuGetPageTool.execute({}, context), { name: 'AbortError' });
assert.equal(calls.length, before);
console.log('小红书分步工具、权限、失败页面交付和禁止自动重发验证通过。');
