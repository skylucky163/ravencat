/** 验证账单与快捷记账工具、真实 SQLite 写入和用户编辑行为，不读取用户数据库。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { agentToolSchemaDependencies } from './helpers/agent-tool-schema-dependencies.mjs';
import { createCoordinatedSqliteFixture, databaseErrors } from './helpers/coordinated-sqlite-fixture.mjs';

const require = createRequire(import.meta.url);
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE ledger_records (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, category TEXT NOT NULL, detail TEXT,
  amount REAL NOT NULL, record_date TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE ledger_quick_actions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL, detail TEXT,
  amount REAL NOT NULL, sort_order INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)`);
const executor = {
  execAsync: async (sql) => db.exec(sql),
  runAsync: async (sql, params = []) => db.prepare(sql).run(...params),
  getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
  getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
};
const fixture = createCoordinatedSqliteFixture(executor);
const dialogs = [];
const theme = { spacing: { lg: 16 }, colors: { text: { tertiary: '#888' }, brand: { primary: '#333' } } };
const mocks = {
  '@platform/persistence': { databaseCoordinator: fixture.databaseCoordinator },
  '@shared/ui': { ModalSheet: 'ModalSheet', showAppDialog: (options) => dialogs.push(options) },
  '@shared/theme': { useTheme: () => theme, useThemedStyles: () => ({}) },
  'react-native': Object.fromEntries(['View', 'Text', 'TextInput', 'TouchableOpacity', 'ScrollView'].map((name) => [name, name])),
};
const cache = new Map();
function load(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const code = ts.transpileModule(fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: relative,
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)((id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (Object.hasOwn(agentToolSchemaDependencies, id)) return agentToolSchemaDependencies[id];
    if (id === '@shared/runtime/abortSignal') return load('src/shared/runtime/abortSignal.ts');
    if (id === '@shared/theme/constants') return load('src/shared/theme/constants.ts');
    if (id.startsWith('.')) {
      const base = path.posix.join(path.posix.dirname(relative), id);
      const extension = fs.existsSync(new URL(`../${base}.tsx`, import.meta.url)) ? '.tsx' : '.ts';
      return load(base + extension);
    }
    return require(id);
  }, module, module.exports);
  cache.set(relative, module.exports);
  return module.exports;
}
const wallet = 'src/features/wallet/';
const { SQLiteLedgerRepository } = load(`${wallet}infrastructure/SQLiteLedgerRepository.ts`);
const repository = new SQLiteLedgerRepository();
const { AddLedgerRecordTool: add, UpdateLedgerRecordTool: update, DeleteLedgerRecordTool: remove } = load(`${wallet}aiTools/LedgerRecordTools.ts`);
const {
  CreateLedgerQuickActionTool: createQuick,
  UpdateLedgerQuickActionTool: updateQuick,
  DeleteLedgerQuickActionTool: deleteQuick,
  UseLedgerQuickActionTool: useQuick,
} = load(`${wallet}aiTools/LedgerQuickActionTools.ts`);
const { GetLedgerContextTool: query } = load(`${wallet}aiTools/GetLedgerContextTool.ts`);
const { LegacyAgentToolAdapter } = load('src/host/composition/agent/LegacyAgentToolAdapter.ts');
const { matchesAgentToolInputSchema } = load('src/shared/aiTools/AgentToolInputSchema.ts');
const { getWalletRecordDate, createWalletRecord, DEFAULT_WALLET_CATEGORIES } = load(`${wallet}domain/WalletRecord.ts`);
const { getWalletCategories, getWalletScreenData } = load(`${wallet}application/WalletPresentation.ts`);
const context = { repositories: { ledger: repository } };
// 真实查询故障保留诊断，但 observation 不包含 SQL、task 名或原始存储错误。
const brokenFixture = createCoordinatedSqliteFixture(executor);
const brokenLedger = { getRecords: () => brokenFixture.databaseCoordinator.read(
  { feature: 'wallet', name: 'wallet.private-query-name', priority: 'interactive' },
  tx => tx.getAllAsync('SELECT * FROM missing_private_wallet_table'),
) };
const oldErrorLog = console.error, walletErrors = [];
console.error = (...args) => walletErrors.push(args);
try {
  const result = await query.execute({ mode: 'recent' }, { repositories: { ledger: brokenLedger } });
  assert.deepEqual(result, { success: false, error: '账本查询失败，请稍后再试。' });
  assert.equal(walletErrors.length, 1);
  assert.ok(walletErrors.every(([, error]) => error instanceof databaseErrors.CoordinatedDatabaseError));
} finally { console.error = oldErrorLog; }
function adapter(tool) {
  return new LegacyAgentToolAdapter(tool, { owner: 'wallet', risk: 'reversible_write', idempotency: 'not_idempotent' }, () => context);
}
async function invoke(tool, input) {
  const adapted = adapter(tool);
  assert.equal(matchesAgentToolInputSchema(input, adapted.descriptor.inputSchema), true);
  return adapted.execute(input, {});
}
// 新工具沿用现有工具包的授权与按需展开能力。
const { AgentToolRegistry } = load('src/platform/agentRuntime/AgentToolRegistry.ts');
const { registerToolPackagesForHostRun } = load('src/host/composition/agent/ToolPackageExposure.ts');
const registry = new AgentToolRegistry();
const walletTools = [add, update, remove, query, createQuick, updateQuick, deleteQuick, useQuick];
const bindings = walletTools.map((tool) => {
  const adapted = adapter(tool);
  registry.register(adapted);
  return { packageId: 'wallet', tool: adapted };
});
const exposure = registerToolPackagesForHostRun({
  registry, bindings, allowedToolNames: bindings.map(({ tool }) => tool.descriptor.name), openPackageIds: [],
});
assert.deepEqual(exposure.visibleToolNames(), []);
await registry.get('open_tool_package').execute({ package_id: 'wallet' }, {});
assert.deepEqual(new Set(exposure.visibleToolNames()), new Set(walletTools.map((tool) => tool.name)));
const lunch = { type: 'expense', category: '餐饮', amount: 25, detail: '午餐牛肉面', recordDate: '2026-10-09' };
const added = await invoke(add, lunch);
assert.equal(added.status, 'success');
const record = added.data.record;
assert.ok(added.modelContent.includes(record.id), '模型必须能拿到新增账单 ID');
assert.equal((await repository.getRecords()).length, 1);

for (const input of [{ mode: 'recent' }, { mode: 'keyword', keyword: '牛肉面' }]) {
  const result = await invoke(query, input);
  assert.ok(result.modelContent.includes(record.id), '适配后的模型 observation 必须包含真实 ID');
}
const edited = await invoke(update, { recordId: record.id, amount: 28, detail: '' });
assert.equal(edited.status, 'success');
const afterEdit = (await repository.getRecords())[0];
assert.equal(afterEdit.amount, 28);
assert.equal(afterEdit.detail, '');
assert.equal(afterEdit.id, record.id);
assert.equal(afterEdit.createdAt, record.createdAt);
assert.equal(afterEdit.recordDate, record.recordDate);
assert.equal(afterEdit.category, record.category);
assert.equal((await repository.getMonthlyStats(2026, 10)).totalExpense, 28);
assert.equal((await invoke(update, { recordId: record.id, type: 'income', category: '退款', recordDate: '2026-09-30' })).status, 'success');
assert.equal((await repository.getMonthlyStats(2026, 10)).count, 0);
assert.equal((await repository.getMonthlyStats(2026, 9)).totalIncome, 28);
assert.equal((await invoke(remove, { recordId: record.id })).status, 'success');
assert.equal((await repository.getRecords()).length, 0);
assert.equal((await invoke(remove, { recordId: record.id })).status, 'error');
assert.equal((await invoke(update, { recordId: record.id, amount: 50 })).status, 'error');
assert.equal(await repository.deleteRecord('missing'), false);
assert.equal(await repository.updateRecord('missing', { amount: 1 }), false);

for (const [id, recordDate] of [['range-old', '2026-08-15'], ['range-middle', '2026-09-15'], ['range-new', '2026-10-15']]) {
  await repository.insertRecord({ ...lunch, id, recordDate });
}
const ranged = await invoke(query, { mode: 'keyword', keyword: '餐饮',
  startDate: '2026-09-01', endDate: '2026-09-30', limit: 1 });
assert.equal(ranged.data.records.length, 1);
assert.equal(ranged.data.records[0].id, 'range-middle');
assert.equal(ranged.data.stats.count, 1, '数量限制只裁剪返回记录，不改变命中统计');
assert.ok(ranged.modelContent.includes('范围：2026-09-01 至 2026-09-30'));
const capped = await invoke(query, { mode: 'keyword', keyword: '餐饮', limit: 2 });
assert.deepEqual(capped.data.records.map(item => item.id), ['range-new', 'range-middle']);
assert.equal(capped.data.stats.count, 3);
for (const input of [
  { mode: 'keyword', keyword: '餐饮', startDate: '2026-02-30' },
  { mode: 'keyword', keyword: '餐饮', limit: 0 },
  { mode: 'keyword', keyword: '餐饮', limit: 51 },
]) assert.equal(matchesAgentToolInputSchema(input, adapter(query).descriptor.inputSchema), false);
for (const id of ['range-old', 'range-middle', 'range-new']) await repository.deleteRecord(id);

// 模型边界拒绝非法金额、日期、空分类、空修改和未声明字段。
for (const invalid of [
  { ...lunch, amount: 0 }, { ...lunch, amount: -1 }, { ...lunch, amount: '25' },
  { ...lunch, amount: Infinity }, { ...lunch, category: '  ' },
  { ...lunch, recordDate: '2026-02-30' }, { ...lunch, id: 'invented' },
]) assert.equal(matchesAgentToolInputSchema(invalid, adapter(add).descriptor.inputSchema), false);
assert.equal(matchesAgentToolInputSchema({ recordId: 'id' }, adapter(update).descriptor.inputSchema), false);
assert.equal(matchesAgentToolInputSchema({ recordId: ' ' }, adapter(remove).descriptor.inputSchema), false);
const controller = new AbortController();
controller.abort();
await assert.rejects(() => add.execute(lunch, { ...context, abortSignal: controller.signal }));
assert.equal((await repository.getRecords()).length, 0);
const today = (await invoke(add, { type: 'expense', category: '交通', amount: 2 })).data.record;
assert.equal(today.recordDate, getWalletRecordDate());
const oldTimezone = process.env.TZ;
process.env.TZ = 'Asia/Shanghai';
assert.equal(getWalletRecordDate(new Date('2026-10-08T16:15:00Z')), '2026-10-09');
if (oldTimezone === undefined) delete process.env.TZ;
else process.env.TZ = oldTimezone;

// 手动新增仍可安排自动回复；AI 新增没有这一副作用。
const { addWalletRecord } = load(`${wallet}application/AddRecord.ts`);
let queued = 0;
const manual = await addWalletRecord(lunch, {}, { repository, queueAIReply: async () => { queued += 1; return { queued: true }; } });
assert.equal(manual.queuedAIReply, true);
assert.equal(queued, 1);

// 两个命令共用同一收尾：排队失败只回调错误、不撤销已写入账单；写入失败仍返回失败。
const { applyQuickActionAndReply } = load(`${wallet}application/UseQuickAction.ts`);
const quickForReply = await repository.insertQuickAction({ name: '地铁', type: 'expense', category: '交通', amount: 5 });
let callbackError;
const applied = await applyQuickActionAndReply({ quickActionId: quickForReply.id }, { onError: (error) => { callbackError = error.message; } }, {
  repository, queueAIReply: async () => { throw new Error('队列不可用'); },
});
assert.equal(applied.success, true);
assert.equal(applied.record.detail, '地铁');
assert.equal((await repository.getRecords({ ids: [applied.record.id] }))[0].detail, '地铁');
assert.equal((await repository.getQuickActions()).find((item) => item.id === quickForReply.id).detail, '');
assert.equal(applied.queuedAIReply, false);
assert.equal(callbackError, '队列不可用');
assert.ok((await repository.getRecords()).some((item) => item.id === applied.record.id), '排队失败不能撤销已写入账单');
assert.equal((await applyQuickActionAndReply({ quickActionId: 'missing' }, {}, { repository, queueAIReply: async () => ({ queued: true }) })).success, false);
await repository.deleteRecord(applied.record.id);
await repository.deleteQuickAction(quickForReply.id);

// 快捷工具只管理模板；使用时才新增账单，修改或删除模板不回写已有账单。
const beforeQuickRecords = (await repository.getRecords()).length;
const templateInput = { name: '早餐', type: 'expense', category: '餐饮', amount: 12, detail: '豆浆包子', sortOrder: 3 };
const createdQuick = await invoke(createQuick, templateInput);
assert.equal(createdQuick.status, 'success');
const template = createdQuick.data.quickAction;
assert.ok(createdQuick.modelContent.includes(template.id));
assert.equal((await repository.getRecords()).length, beforeQuickRecords);
assert.deepEqual((await invoke(query, { mode: 'quickActions' })).data.quickActions, [template]);
for (const keyword of ['早餐', '餐饮', '豆浆']) {
  const found = await invoke(query, { mode: 'quickActions', keyword, type: 'expense', category: '餐饮', timeDescription: '去年' });
  assert.deepEqual(found.data.quickActions, [template]);
  assert.ok(found.modelContent.includes(template.id), '查询必须给模型返回真实模板 ID');
}
assert.deepEqual((await invoke(query, { mode: 'quickActions', type: 'income' })).data.quickActions, []);
assert.deepEqual((await invoke(query, { mode: 'quickActions', category: '交通' })).data.quickActions, []);
assert.deepEqual((await invoke(query, { mode: 'quickActions', keyword: '不存在' })).data.quickActions, []);
const usedQuick = await invoke(useQuick, { quickActionId: template.id, recordDate: '2026-10-02' });
assert.equal(usedQuick.status, 'success');
const templateRecord = usedQuick.data.record;
assert.notEqual(templateRecord.id, template.id);
assert.ok(usedQuick.modelContent.includes(templateRecord.id));
assert.equal(templateRecord.recordDate, '2026-10-02');
assert.equal(templateRecord.amount, 12);
assert.equal(templateRecord.detail, '豆浆包子');
assert.equal(templateRecord.category, '餐饮');
assert.equal(templateRecord.type, 'expense');
assert.equal((await repository.getRecords()).length, beforeQuickRecords + 1);
assert.equal((await invoke(updateQuick, { quickActionId: template.id, name: '早饭', amount: 15, detail: '', sortOrder: 0 })).status, 'success');
const partialTemplate = (await repository.getQuickActions())[0];
assert.equal(partialTemplate.name, '早饭');
assert.equal(partialTemplate.amount, 15);
assert.equal(partialTemplate.detail, '');
assert.equal(partialTemplate.sortOrder, 0);
assert.equal(partialTemplate.id, template.id);
assert.equal(partialTemplate.createdAt, template.createdAt);
assert.equal(partialTemplate.type, template.type);
assert.equal(partialTemplate.category, template.category);
assert.deepEqual((await repository.getRecords()).find((item) => item.id === templateRecord.id), templateRecord);
assert.equal((await invoke(updateQuick, { quickActionId: template.id, type: 'income', category: '退款' })).status, 'success');
const reusedQuick = await invoke(useQuick, { quickActionId: template.id });
assert.equal(reusedQuick.status, 'success');
assert.equal(reusedQuick.data.record.recordDate, getWalletRecordDate());
assert.equal(reusedQuick.data.record.type, 'income');
assert.equal(reusedQuick.data.record.category, '退款');
assert.equal(reusedQuick.data.record.amount, 15);
assert.equal(reusedQuick.data.record.detail, '早饭');
assert.notEqual(reusedQuick.data.record.id, templateRecord.id);
const noReply = await applyQuickActionAndReply({ quickActionId: template.id }, {}, { repository });
assert.equal(noReply.success, true);
assert.equal(noReply.record.detail, '早饭');
assert.equal(noReply.queuedAIReply, false);
assert.equal(queued, 1, 'AI 使用快捷记账不应安排额外自动回复');
assert.equal((await invoke(deleteQuick, { quickActionId: template.id })).status, 'success');
assert.deepEqual((await repository.getRecords()).find((item) => item.id === templateRecord.id), templateRecord);
assert.equal((await invoke(deleteQuick, { quickActionId: template.id })).status, 'error');
assert.equal((await invoke(updateQuick, { quickActionId: template.id, amount: 20 })).status, 'error');
const missingQuick = await invoke(useQuick, { quickActionId: template.id });
assert.equal(missingQuick.status, 'error');
assert.ok(missingQuick.modelContent.includes('快捷记账不存在'));
assert.equal((await repository.getRecords()).length, beforeQuickRecords + 3);
assert.equal(await repository.deleteQuickAction('missing'), false);
assert.equal(await repository.updateQuickAction('missing', { amount: 1 }), false);
for (const item of [templateRecord, reusedQuick.data.record, noReply.record]) await repository.deleteRecord(item.id);

// 金额、名称、空修改、模板 ID、日期和内部字段都在模型 schema 边界拦截。
for (const invalid of [
  { ...templateInput, amount: 0 }, { ...templateInput, amount: -1 }, { ...templateInput, amount: Infinity },
  { ...templateInput, amount: '12' }, { ...templateInput, name: ' ' }, { ...templateInput, category: ' ' },
  { ...templateInput, type: 'transfer' }, { ...templateInput, sortOrder: -1 }, { ...templateInput, sortOrder: 0.5 },
  { ...templateInput, id: 'invented' }, { ...templateInput, recordDate: '2026-10-02' },
  { name: '缺少金额', type: 'expense', category: '餐饮' },
]) assert.equal(matchesAgentToolInputSchema(invalid, adapter(createQuick).descriptor.inputSchema), false);
for (const invalid of [{ quickActionId: 'id' }, { quickActionId: 'id', amount: 0 }, { quickActionId: 'id', createdAt: 'invented' }]) {
  assert.equal(matchesAgentToolInputSchema(invalid, adapter(updateQuick).descriptor.inputSchema), false);
}
for (const tool of [deleteQuick, useQuick]) {
  assert.equal(matchesAgentToolInputSchema({ quickActionId: ' ' }, adapter(tool).descriptor.inputSchema), false);
}
assert.equal(matchesAgentToolInputSchema({ quickActionId: 'id', recordDate: '2026-02-30' }, adapter(useQuick).descriptor.inputSchema), false);
for (const [tool, args] of [
  [createQuick, templateInput], [updateQuick, { quickActionId: 'id', amount: 20 }],
  [deleteQuick, { quickActionId: 'id' }], [useQuick, { quickActionId: 'id' }],
]) {
  await assert.rejects(() => tool.execute(args, { ...context, abortSignal: controller.signal }));
  assert.equal((await tool.execute(args, { repositories: { ledger: null } })).success, false);
}

// 同一毫秒创建多个模板仍有独立 ID，并按排序字段展示。
const originalNow = Date.now;
let simultaneous;
try {
  Date.now = () => 1793404800000;
  simultaneous = await Promise.all([1, 0].map((sortOrder) => invoke(createQuick, { ...templateInput, sortOrder })));
} finally { Date.now = originalNow; }
assert.ok(simultaneous.every((result) => result.status === 'success'));
assert.equal(new Set(simultaneous.map((result) => result.data.quickAction.id)).size, 2);
assert.deepEqual((await repository.getQuickActions()).map((action) => action.sortOrder), [0, 1]);
for (const result of simultaneous) await repository.deleteQuickAction(result.data.quickAction.id);

// 默认创建排到末尾：删除产生空缺后仍追加，并发创建不拿到相同的默认排位。
const appendInput = { name: '默认末尾', type: 'expense', category: '餐饮', amount: 10 };
const firstAppend = await invoke(createQuick, appendInput);
assert.equal(firstAppend.data.quickAction.sortOrder, 0);
await repository.deleteQuickAction(firstAppend.data.quickAction.id);
const tiedTemplates = await Promise.all(['quick-z', 'quick-a'].map((id) => repository.insertQuickAction({
  ...templateInput, id, sortOrder: 6, createdAt: '2026-10-01T00:00:00.000Z',
})));
const deletedMiddle = await repository.insertQuickAction({ ...templateInput, sortOrder: 4 });
await repository.deleteQuickAction(deletedMiddle.id);
const appendedTemplates = await Promise.all(Array.from({ length: 3 }, () => invoke(createQuick, appendInput)));
assert.ok(appendedTemplates.every((result) => result.status === 'success'));
assert.deepEqual(appendedTemplates.map((result) => result.data.quickAction.sortOrder).sort((a, b) => a - b), [7, 8, 9]);
const sortedTemplates = await repository.getQuickActions();
assert.deepEqual(sortedTemplates.slice(0, 2).map((action) => action.id), ['quick-a', 'quick-z']);
assert.deepEqual(sortedTemplates.map((action) => action.sortOrder), [6, 6, 7, 8, 9]);
assert.deepEqual(sortedTemplates.slice(0, 2), [...tiedTemplates].sort((a, b) => a.id.localeCompare(b.id)), '新增不能重编号旧模板');
for (const action of sortedTemplates) await repository.deleteQuickAction(action.id);

// 记账使用与编辑、删除共享协调器事务；账单只能保存一个完整的模板快照。
const atomicTemplate = await repository.insertQuickAction(templateInput);
const [atomicRecord] = await Promise.all([
  repository.useQuickAction(atomicTemplate.id),
  repository.updateQuickAction(atomicTemplate.id, { category: '购物', amount: 30 }),
  repository.deleteQuickAction(atomicTemplate.id),
]);
assert.equal(atomicRecord.category, '餐饮');
assert.equal(atomicRecord.amount, 12);
assert.equal((await repository.getQuickActions()).length, 0);
await repository.deleteRecord(atomicRecord.id);

// 分类查询包含预设、历史自定义和仅在快捷记账中使用的分类，并按收支类型去重。
assert.deepEqual(await repository.getCategories('income'), DEFAULT_WALLET_CATEGORIES.income);
const custom = (await invoke(add, { ...lunch, category: '宠物', recordDate: '2020-01-01' })).data.record;
const refund = (await invoke(add, { type: 'income', category: '退款', amount: 15 })).data.record;
const quick = await repository.insertQuickAction({ id: 'quick-pet', name: '猫粮', type: 'expense', category: '宠物', amount: 20 });
const quickOnly = await repository.insertQuickAction({ id: 'quick-garden', name: '养花', type: 'expense', category: '园艺', amount: 10 });
const expenseCategories = await invoke(query, { mode: 'categories', type: 'expense', timeDescription: '本月' });
assert.equal(expenseCategories.status, 'success');
assert.ok(DEFAULT_WALLET_CATEGORIES.expense.every((category) => expenseCategories.data.categories.includes(category)));
assert.equal(expenseCategories.data.categories.filter((category) => category === '宠物').length, 1);
assert.ok(expenseCategories.data.categories.includes('园艺'));
assert.equal(expenseCategories.data.categories.includes('退款'), false);
assert.ok(expenseCategories.modelContent.includes('宠物'), 'AI 必须能看到旧账单中的自定义分类');
assert.ok(expenseCategories.modelContent.includes('园艺'), 'AI 必须能看到仅存在于快捷记账的分类');
const incomeCategories = await invoke(query, { mode: 'categories', type: 'income' });
assert.ok(incomeCategories.data.categories.includes('退款'));
assert.equal(incomeCategories.data.categories.includes('宠物'), false);
const allCategories = await invoke(query, { mode: 'categories' });
assert.ok(allCategories.data.categories.includes('宠物') && allCategories.data.categories.includes('退款'));
assert.equal(allCategories.data.categories.filter((category) => category === '其他').length, 1);
const presentationDeps = {
  ledgerRepository: repository,
  assistantRepository: { getAll: async () => [], getLedgerAI: async () => null },
};
const availableCategories = await getWalletCategories(presentationDeps);
assert.deepEqual((await getWalletScreenData(new Date(), presentationDeps)).categories, availableCategories);
assert.equal((await repository.getRangeSummary('2020-01-01', '2020-01-01')).categoryStats[0].category, '宠物');
await repository.deleteRecord(custom.id);
await repository.deleteRecord(refund.id);
await repository.deleteQuickAction(quick.id);
await repository.deleteQuickAction(quickOnly.id);

// 用户编辑保留原数据，支持自定义分类和日期，保存失败时保留表单。
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { act, create } = require('react-test-renderer');
mocks['react-native'].StyleSheet = { create: (styles) => styles };
const Modal = load(`${wallet}presentation/AddRecordModal.tsx`).default;
const initialRecord = createWalletRecord({ ...lunch, category: '小吃', recordDate: '2026-09-28' });
let saved;
let closed = 0;
let succeeds = false;
let renderer;
await act(async () => { renderer = create(React.createElement(Modal, {
  visible: true, initialRecord, availableCategories, onSave: async (draft) => { saved = draft; return succeeds; }, onClose: () => { closed += 1; },
})); });
function saveButton() {
  return renderer.root.findAllByType('TouchableOpacity').find((node) => node.findAllByType('Text').some((text) => text.props.children === '保存'));
}
assert.equal(saveButton().props.disabled, false);
await act(async () => { await saveButton().props.onPress(); });
assert.equal(saved.category, '小吃');
assert.equal(saved.recordDate, '2026-09-28');
assert.equal(saved.amount, 25);
assert.equal('id' in saved, false);
assert.equal('createdAt' in saved, false);
assert.equal(closed, 0);
const dateInput = renderer.root.findAllByType('TextInput').find((node) => node.props.placeholder === 'YYYY-MM-DD');
await act(async () => { dateInput.props.onChangeText('2026-02-30'); });
assert.equal(saveButton().props.disabled, true);
await act(async () => { dateInput.props.onChangeText('2026-09-29'); });
succeeds = true;
await act(async () => { await saveButton().props.onPress(); });
assert.equal(saved.recordDate, '2026-09-29');
assert.equal(closed, 1);
await act(async () => { renderer.unmount(); });

// 手动新增可复用历史分类，也可输入新分类；空白不能保存，首尾空格在用户输入边界清除。
await act(async () => { renderer = create(React.createElement(Modal, {
  visible: true, availableCategories,
  onSave: async (draft) => { saved = await repository.insertRecord(draft); return true; },
  onClose: () => {},
})); });
const categoryButton = renderer.root.findAllByType('TouchableOpacity').find((node) => node.findAllByType('Text').some((text) => text.props.children === '宠物'));
await act(async () => { categoryButton.props.onPress(); });
const categoryInput = renderer.root.findAllByType('TextInput').find((node) => node.props.placeholder === '输入自定义分类');
assert.equal(categoryInput.props.value, '宠物');
await act(async () => {
  renderer.root.findAllByType('TextInput').find((node) => node.props.placeholder === '0.00').props.onChangeText('30');
  categoryInput.props.onChangeText('   ');
});
assert.equal(saveButton().props.disabled, true);
await act(async () => { categoryInput.props.onChangeText('  健身  '); });
assert.equal(saveButton().props.disabled, false);
await act(async () => { await saveButton().props.onPress(); });
assert.equal(saved.category, '健身');
assert.ok((await repository.getCategories('expense')).includes('健身'));
await repository.deleteRecord(saved.id);
await act(async () => { renderer.unmount(); });

// 快捷记账支持同一份已有分类和自定义输入，切换收支类型清除旧选择。
const QuickModal = load(`${wallet}presentation/QuickActionModal.tsx`).default;
let quickDraft;
await act(async () => { renderer = create(React.createElement(QuickModal, {
  visible: true, availableCategories, quickActions: [], onClose: () => {},
  onAdd: (draft) => { quickDraft = draft; }, onDelete: () => {},
})); });
function buttonWithText(text) {
  return renderer.root.findAllByType('TouchableOpacity').find((node) => node.findAllByType('Text').some((item) => item.props.children === text));
}
await act(async () => { buttonWithText('添加').props.onPress(); });
await act(async () => { buttonWithText('园艺').props.onPress(); });
function quickCategoryInput() {
  return renderer.root.findAllByType('TextInput').find((node) => node.props.placeholder === '输入自定义分类');
}
assert.equal(quickCategoryInput().props.value, '园艺');
await act(async () => { buttonWithText('收入').props.onPress(); });
assert.equal(quickCategoryInput().props.value, '');
await act(async () => { buttonWithText('支出').props.onPress(); });
await act(async () => {
  renderer.root.findAllByType('TextInput').find((node) => node.props.placeholder === '名称').props.onChangeText('健身课');
  renderer.root.findAllByType('TextInput').find((node) => node.props.placeholder === '金额').props.onChangeText('30');
  quickCategoryInput().props.onChangeText('   ');
});
await act(async () => { buttonWithText('添加').props.onPress(); });
assert.equal(quickDraft, undefined);
await act(async () => { quickCategoryInput().props.onChangeText('  健身  '); });
await act(async () => { buttonWithText('添加').props.onPress(); });
assert.equal(quickDraft.category, '健身');
assert.equal(quickDraft.sortOrder, undefined, '表单不根据可见条数分配排序号');
const customQuick = await repository.insertQuickAction(quickDraft);
assert.ok((await repository.getCategories('expense')).includes('健身'));
await repository.deleteQuickAction(customQuick.id);
await act(async () => { renderer.unmount(); });

// 长按只展示菜单，选择编辑或确认删除后才写入；取消不会删除。
mocks['../composition'] = {
  updateWalletRecord: (id, updates) => repository.updateRecord(id, updates),
  deleteWalletRecord: (id) => repository.deleteRecord(id),
};
const { useWalletRecordActions } = load(`${wallet}presentation/useWalletRecordActions.ts`);
let actions;
let reloaded = 0;
function Harness() { actions = useWalletRecordActions(async () => { reloaded += 1; }); return null; }
await act(async () => { renderer = create(React.createElement(Harness)); });
await act(async () => { actions.showRecordActions(today); });
const menu = dialogs.at(-1);
assert.deepEqual(menu.buttons.map((button) => button.text), ['取消', '编辑', '删除']);
await act(async () => { menu.buttons.find((button) => button.text === '编辑').onPress(); });
assert.equal(actions.editingRecord.id, today.id);
await act(async () => { assert.equal(await actions.saveRecord({ amount: 3 }), true); });
assert.equal((await repository.getRecords()).find((item) => item.id === today.id).amount, 3);
assert.equal(reloaded, 1);
await act(async () => { menu.buttons.find((button) => button.text === '删除').onPress(); });
const confirm = dialogs.at(-1);
assert.equal(confirm.buttons.find((button) => button.text === '取消').onPress, undefined);
assert.equal((await repository.getRecords()).some((item) => item.id === today.id), true);
await act(async () => { await confirm.buttons.find((button) => button.text === '删除').onPress(); });
assert.equal((await repository.getRecords()).some((item) => item.id === today.id), false);
assert.equal(reloaded, 2);
await act(async () => { renderer.unmount(); });

// 超过五条的历史记录可以展开，并对末尾记录发出长按操作。
const { CategoryGroup } = load(`${wallet}presentation/HistoryDetailScreen/components/CategoryGroup.tsx`);
const groupedRecords = Array.from({ length: 6 }, (_, index) => createWalletRecord({ ...lunch, id: `history-${index}` }));
let selected;
await act(async () => { renderer = create(React.createElement(CategoryGroup, {
  category: '餐饮', type: 'expense', total: 150, percentage: 100, count: 6,
  color: '#333', records: groupedRecords, mutatingRecordId: null, onRecordLongPress: (item) => { selected = item; },
})); });
assert.equal(renderer.root.findAllByType('TouchableOpacity').filter((node) => node.props.onLongPress).length, 5);
const expand = renderer.root.findAllByType('TouchableOpacity').find((node) => !node.props.onLongPress);
await act(async () => { expand.props.onPress(); });
const rows = renderer.root.findAllByType('TouchableOpacity').filter((node) => node.props.onLongPress);
assert.equal(rows.length, 6);
await act(async () => { rows.at(-1).props.onLongPress(); });
assert.equal(selected.id, 'history-5');
await act(async () => { renderer.unmount(); });

// 初始详情快照不能阻止修改后重新读取真实统计。
// 焦点回调登记下来，后面用它模拟“从详情编辑返回”。
const focusCallbacks = [];
const blurCallbacks = [];
mocks['@react-navigation/native'] = {
  useFocusEffect: (callback) => React.useEffect(() => {
    let cleanup;
    const focus = () => { cleanup = callback(); };
    const blur = () => { cleanup?.(); cleanup = undefined; };
    focusCallbacks.push(focus);
    blurCallbacks.push(blur);
    focus();
    return () => {
      blur();
      focusCallbacks.splice(focusCallbacks.indexOf(focus), 1);
      blurCallbacks.splice(blurCallbacks.indexOf(blur), 1);
    };
  }, [callback]),
};
mocks['../../composition'] = {
  getLedgerRangeSummary: (start, end) => repository.getRangeSummary(start, end),
  getWalletCategories: () => getWalletCategories(presentationDeps),
};
const { useHistoryDetail } = load(`${wallet}presentation/HistoryDetailScreen/useHistoryDetail.ts`);
const historic = await repository.insertRecord({ ...lunch, recordDate: '2026-09-28' });
const timeRange = { startDate: '2026-09-28', endDate: '2026-09-28', label: '历史账单' };
const initialData = { timeRange, ...await repository.getRangeSummary(timeRange.startDate, timeRange.endDate) };
let history;
function HistoryHarness() { history = useHistoryDetail({ timeRange, initialData }); return null; }
await act(async () => { renderer = create(React.createElement(HistoryHarness)); });
assert.equal(history.summary.totalExpense, 25);
assert.deepEqual(history.categories, await getWalletCategories(presentationDeps));
await repository.updateRecord(historic.id, { amount: 30 });
await act(async () => { await history.reload(); });
assert.equal(history.summary.totalExpense, 30);
assert.equal(history.summary.records[0].amount, 30);
await repository.deleteRecord(historic.id);
await act(async () => { await history.reload(); });
assert.equal(history.summary.totalExpense, 0);
assert.deepEqual(history.summary.records, []);
await act(async () => { renderer.unmount(); });

// 历史列表分页：首屏补齐、正常触底、重复触发、空库停止、旧请求迟到、编辑返回刷新。
// 真实 FlatList 在测试环境不渲染行；这里用同名宿主元素加 renderItem 结果，保留尺寸与触底回调。
mocks['react-native'].FlatList = function FlatListMock(props) {
  return React.createElement(
    'FlatList',
    props,
    props.data.map((item, index) => React.createElement(React.Fragment, { key: `${index}` }, props.renderItem({ item, index }))),
  );
};
mocks['react-native'].ActivityIndicator = 'ActivityIndicator';
mocks['react-native'].BackHandler = { addEventListener: () => ({ remove: () => {} }) };
mocks['react-native-safe-area-context'] = { SafeAreaView: 'SafeAreaView' };
mocks['@shared/ui/NavigationHeader'] = { __esModule: true, default: 'NavigationHeader' };
mocks['@shared/theme'].ThemedSurface = 'ThemedSurface';

const rangeQueries = [];
let rangeGate = null;
const historyRecords = new Map();
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
mocks['../../composition'] = {
  getLedgerRangeSummary: async (start, end) => {
    rangeQueries.push(`${start}_${end}`);
    if (rangeGate) await rangeGate.promise;
    const records = historyRecords.get(`${start}_${end}`) || [];
    const totalExpense = records.filter((item) => item.type === 'expense').reduce((sum, item) => sum + item.amount, 0);
    const totalIncome = records.filter((item) => item.type === 'income').reduce((sum, item) => sum + item.amount, 0);
    return { totalExpense, totalIncome, balance: totalIncome - totalExpense, categoryStats: [], records };
  },
  getWalletCategories: () => getWalletCategories(presentationDeps),
};

const dayKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const todayDate = new Date();
todayDate.setHours(0, 0, 0, 0);
const weekStart = new Date(todayDate);
weekStart.setDate(todayDate.getDate() - ((todayDate.getDay() + 6) % 7));
const firstWeekKeys = [];
for (const cursor = new Date(todayDate); cursor >= weekStart; cursor.setDate(cursor.getDate() - 1)) {
  firstWeekKeys.push(`${dayKey(cursor)}_${dayKey(cursor)}`);
}
const flatListOf = () => renderer.root.findAllByType('FlatList')[0];
const renderedTexts = () => renderer.root
  .findAllByType('Text')
  .map((node) => [node.props.children].flat(Infinity).join(''));
const mountHistory = async (props) => {
  const HistoryScreen = load(`${wallet}presentation/HistoryScreen/index.tsx`).default;
  await act(async () => {
    renderer = create(React.createElement(HistoryScreen, { onBack: () => {}, onSelectTimeRange: () => {}, ...props }));
  });
  // 首屏查询是焦点副作用发起的，等它落地后再断言渲染结果。
  await act(async () => {});
};
// 模拟真实布局：先量内容再量视口，之后内容高度随卡片数量增长，直到不再请求新范围。
const pumpLayout = async (viewport, cardHeight = 100) => {
  await act(async () => {
    flatListOf().props.onContentSizeChange(0, flatListOf().props.data.length * cardHeight);
  });
  await act(async () => { flatListOf().props.onLayout({ nativeEvent: { layout: { height: viewport } } }); });
  for (let step = 0; step < 40; step += 1) {
    const before = rangeQueries.length;
    const cards = flatListOf().props.data.length;
    await act(async () => { flatListOf().props.onContentSizeChange(0, cards * cardHeight); });
    if (rangeQueries.length === before) return { stopped: true, cards, queries: rangeQueries.length };
  }
  return { stopped: false, cards: flatListOf().props.data.length, queries: rangeQueries.length };
};

// 首屏不足一屏时自动追加，只查新增范围，重复触底不重复追加。
await mountHistory({ initialView: 'week' });
assert.deepEqual([...rangeQueries], firstWeekKeys, '首屏先查当前周');
const filled = await pumpLayout(1200);
assert.equal(filled.stopped, true, '填满视口后停止自动追加');
assert.ok(filled.cards * 100 >= 1200, '自动补齐后内容不再短于视口');
assert.equal(new Set(rangeQueries).size, rangeQueries.length, '自动补齐不重复查询同一范围');
const afterFill = rangeQueries.length;

// 内容已满时，接近底部即追加一页；同一次拖动只追加一次。
await act(async () => { flatListOf().props.onContentSizeChange(0, filled.cards * 100); });
await act(async () => { flatListOf().props.onLayout({ nativeEvent: { layout: { height: 200 } } }); });
const beforeEndReached = rangeQueries.length;
await act(async () => { flatListOf().props.onScrollBeginDrag(); flatListOf().props.onEndReached(); });
assert.equal(rangeQueries.length, beforeEndReached + 7, '触底追加下一周');
await act(async () => { flatListOf().props.onEndReached(); });
assert.equal(rangeQueries.length, beforeEndReached + 7, '没有新的拖动不重复追加');
await act(async () => { flatListOf().props.onScrollBeginDrag(); flatListOf().props.onEndReached(); });
assert.equal(rangeQueries.length, beforeEndReached + 14, '再次拖动才追加');

// 同一时刻只有一个请求：请求未完成前的重复触发被丢弃。
const gate = deferred();
rangeGate = gate;
await act(async () => { flatListOf().props.onScrollBeginDrag(); flatListOf().props.onEndReached(); });
await act(async () => { flatListOf().props.onScrollBeginDrag(); flatListOf().props.onEndReached(); });
gate.resolve();
rangeGate = null;
await act(async () => {});
assert.equal(rangeQueries.length, afterFill + 21, '进行中的请求不因重复触底变成两页');
assert.equal(new Set(rangeQueries).size, rangeQueries.length, '触底追加也不重复查询');
await act(async () => { renderer.unmount(); });

// 空库时自动补齐可以停止，不会无限查询。
rangeQueries.length = 0;
historyRecords.clear();
await mountHistory({ initialView: 'week' });
const emptyFill = await pumpLayout(900);
assert.equal(emptyFill.stopped, true, '空库自动补齐必须停止');
assert.ok(emptyFill.queries < 40, `空库补齐次数有界：${emptyFill.queries}`);
await act(async () => { renderer.unmount(); });

// 切换视图后迟到的旧响应不能覆盖新页面。
rangeQueries.length = 0;
const staleRecords = createWalletRecord({ ...lunch, id: 'stale', amount: 999 });
historyRecords.set(firstWeekKeys[0], [staleRecords]);
await mountHistory({ initialView: 'week' });
await act(async () => { flatListOf().props.onContentSizeChange(0, firstWeekKeys.length * 100); });
await act(async () => { flatListOf().props.onLayout({ nativeEvent: { layout: { height: 200 } } }); });
const switchGate = deferred();
rangeGate = switchGate;
await act(async () => { flatListOf().props.onScrollBeginDrag(); flatListOf().props.onEndReached(); });
rangeGate = null;
await act(async () => {
  const yearTab = renderer.root.findAllByType('TouchableOpacity').find(
    (node) => node.findAllByType('Text').some((text) => text.props.children === '年'),
  );
  yearTab.props.onPress();
});
switchGate.resolve();
await act(async () => {});
const yearData = flatListOf().props.data;
assert.equal(yearData.length, new Date().getMonth() + 1, '迟到响应没有把旧分页写进新视图');
assert.ok(yearData.every((item) => typeof item.monthName === 'string'), '切换后展示年视图的月卡');
assert.equal(renderedTexts().includes('-¥999.00'), false, '旧视图统计没有覆盖新视图');
await act(async () => { renderer.unmount(); });

// 从详情编辑返回时刷新已展示范围，不重新查询更早的范围。
rangeQueries.length = 0;
historyRecords.set(firstWeekKeys[0], [createWalletRecord({ ...lunch, id: 'edited', amount: 25 })]);
await mountHistory({ initialView: 'week' });
await act(async () => { flatListOf().props.onContentSizeChange(0, firstWeekKeys.length * 100); });
await act(async () => { flatListOf().props.onLayout({ nativeEvent: { layout: { height: 200 } } }); });
assert.deepEqual([...rangeQueries], firstWeekKeys);
assert.ok(renderedTexts().includes('-¥25.00'));
await act(async () => { for (const callback of [...blurCallbacks]) callback(); });
historyRecords.set(firstWeekKeys[0], [createWalletRecord({ ...lunch, id: 'edited', amount: 40 })]);
rangeQueries.length = 0;
await act(async () => { for (const callback of [...focusCallbacks]) await callback(); });
await act(async () => {});
assert.deepEqual([...rangeQueries], firstWeekKeys, '只刷新已展示范围');
assert.ok(renderedTexts().includes('-¥40.00'), '返回后使用最新统计');
assert.equal(renderedTexts().includes('-¥25.00'), false, '旧统计不残留');
await act(async () => { renderer.unmount(); });

// 详情返回不能被离开前尚未结束的分页查询挡住，也不能接纳那页迟到的结果。
rangeQueries.length = 0;
historyRecords.set(firstWeekKeys[0], [createWalletRecord({ ...lunch, id: 'edited', amount: 25 })]);
await mountHistory({ initialView: 'week' });
const backgroundPage = deferred();
rangeGate = backgroundPage;
await act(async () => { flatListOf().props.onScrollBeginDrag(); flatListOf().props.onEndReached(); });
await act(async () => { for (const callback of [...blurCallbacks]) callback(); });
historyRecords.set(firstWeekKeys[0], [createWalletRecord({ ...lunch, id: 'edited', amount: 40 })]);
rangeGate = null;
const beforeReturn = rangeQueries.length;
await act(async () => { for (const callback of [...focusCallbacks]) callback(); });
assert.deepEqual(rangeQueries.slice(beforeReturn), firstWeekKeys, '返回立即刷新已展示范围，不等待旧分页');
assert.ok(renderedTexts().includes('-¥40.00'), '旧查询未结束也能展示编辑后的统计');
backgroundPage.resolve();
await act(async () => {});
assert.equal(flatListOf().props.data.length, firstWeekKeys.length, '离开前未完成的分页不能在返回后追加');
await act(async () => { renderer.unmount(); });

// 视口测量可能先于内容测量；尚不知道内容高度时不能把默认零当成首屏不足。
rangeQueries.length = 0;
await mountHistory({ initialView: 'year' });
const beforeContentMeasure = rangeQueries.length;
await act(async () => { flatListOf().props.onLayout({ nativeEvent: { layout: { height: 50 } } }); });
assert.equal(rangeQueries.length, beforeContentMeasure, '内容尚未测量时不提前请求下一页');
await act(async () => { flatListOf().props.onContentSizeChange(0, flatListOf().props.data.length * 100); });
assert.equal(rangeQueries.length, beforeContentMeasure, '首屏已满不额外查询');
await act(async () => { renderer.unmount(); });

const historyReadErrors = [];
const originalConsoleError = console.error;
console.error = (...args) => {
  if (args.some((value) => value instanceof Error)) historyReadErrors.push(args);
};
try {
  // 首次读取失败时停住自动补齐；用户再触底先重试当前范围，不能跳过它去读更早的一页。
  rangeQueries.length = 0;
  historyRecords.clear();
  const initialFailure = deferred();
  rangeGate = initialFailure;
  await mountHistory({ initialView: 'week' });
  await act(async () => { initialFailure.reject(new Error('汇总读取失败')); });
  rangeGate = null;
  await pumpLayout(1200);
  assert.deepEqual(rangeQueries, firstWeekKeys, '读取失败后不继续自动向前查询');
  await act(async () => { flatListOf().props.onScrollBeginDrag(); flatListOf().props.onEndReached(); });
  assert.deepEqual(rangeQueries, [...firstWeekKeys, ...firstWeekKeys], '显式重试补齐首批汇总，不跳过失败范围');
  assert.equal(historyReadErrors.length, 1);
  await act(async () => { renderer.unmount(); });

  // 切换视图后旧请求的失败也必须失效，不能把新视图的自动补齐关掉。
  rangeQueries.length = 0;
  await mountHistory({ initialView: 'week' });
  const staleFailure = deferred();
  rangeGate = staleFailure;
  await act(async () => { flatListOf().props.onScrollBeginDrag(); flatListOf().props.onEndReached(); });
  rangeGate = null;
  await act(async () => {
    const yearTab = renderer.root.findAllByType('TouchableOpacity').find(
      (node) => node.findAllByType('Text').some((text) => text.props.children === '年'),
    );
    yearTab.props.onPress();
  });
  await act(async () => { staleFailure.reject(new Error('旧视图读取失败')); });
  const initialMonths = flatListOf().props.data.length;
  const yearFill = await pumpLayout((initialMonths + 1) * 100);
  assert.equal(yearFill.stopped, true);
  assert.equal(yearFill.cards, initialMonths + 1, '旧请求失败后新视图仍能补齐视口');
  assert.equal(historyReadErrors.length, 1, '撤销的旧查询不再产生当前页面错误');
  await act(async () => { renderer.unmount(); });
} finally {
  console.error = originalConsoleError;
  rangeGate = null;
}

db.close();
console.log('Wallet 账单与快捷记账增改删用、ID observation、并发提交、统计、自定义分类、表单与历史分页行为验证通过');
