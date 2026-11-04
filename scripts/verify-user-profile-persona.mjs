/** 验证真实个人资料迁移、字段提交、自动保存与模型可见人设。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(relative, mocks = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => {
    if (name === '@shared/errors/SettingChangeConflictError') return load('src/shared/errors/SettingChangeConflictError.ts');
    assert.ok(Object.hasOwn(mocks, name), `${relative} 缺少依赖 ${name}`);
    return mocks[name];
  }, module, module.exports);
  return module.exports;
}
const domain = load('src/features/profile/domain/UserProfile.ts', { '@shared': { DEFAULT_SELF_NAME: '用户', SELF_USER_ID: 'self' } });
const fields = load('src/features/profile/domain/UserProfileField.ts');
const { parseProfileFieldDraft, profileFieldValue } = load('src/features/profile/presentation/profileFieldDraft.ts');
const parse = (field, draft, changed = ['value']) => parseProfileFieldDraft(field, draft, changed);
const { AutoSaveDraftEditor } = load('src/shared/ui/AutoSaveDraftEditor.ts');
assert.ok(fields.isUserProfileField('gender'));
assert.ok(!fields.isUserProfileField('avatar'));
assert.ok(!fields.isUserProfileField(['age']));
assert.deepEqual(parse('gender', { value: '霸王龙' }).patch, { gender: '霸王龙' });
for (const value of ['外星人', '@#', '-1', '18.5', '18岁', '1e2', '9007199254740992']) {
  assert.equal(parse('age', { value }).accepted.length, 0, `拒绝无效年龄：${value}`);
}
assert.deepEqual(parse('age', { value: '' }).patch, { age: null });
assert.deepEqual(parse('age', { value: '0' }).patch, { age: 0 });
assert.deepEqual(parse('age', { value: '3000' }).patch, { age: 3000 }, '不限制虚构角色的整数年龄');
assert.equal(parse('name', { value: '  ' }).accepted.length, 0);
assert.equal(parse('name', { value: '名'.repeat(21) }).accepted.length, 0);
const other = '\n家里有四口人。\n' + '完整设定。'.repeat(100) + '\n最后一行不能丢。\n';
assert.deepEqual(parse('other', { value: other }).patch, { other });
assert.deepEqual(parse('other', { value: '   ' }).patch, { other: '' });

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE user_profile (id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT, avatar_media_asset_id TEXT,
  moments_cover TEXT, moments_cover_media_asset_id TEXT, moments_cover_revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
  INSERT INTO user_profile VALUES ('self', '原名', 'avatar.jpg', NULL, 'cover.jpg', NULL, 0, '2026-10-07');`);
let transactionTail = Promise.resolve();
const executor = {
  execAsync: async (sql) => db.exec(sql),
  getAllAsync: async (sql, args = []) => db.prepare(sql).all(...args),
  getFirstAsync: async (sql, args = []) => db.prepare(sql).get(...args) ?? null,
  runAsync: async (sql, args = []) => db.prepare(sql).run(...args),
  withExclusiveTransactionAsync(action) {
    const result = transactionTail.then(async () => {
      db.exec('BEGIN IMMEDIATE');
      try { const value = await action(executor); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    transactionTail = result.catch(() => undefined);
    return result;
  },
};
const { migrateUserProfilePersona } = load('src/platform/persistence/sqlite/userProfileSchema.ts');
await migrateUserProfilePersona(executor);
await migrateUserProfilePersona(executor);
const { SQLiteUserProfileRepository } = load('src/features/profile/infrastructure/SQLiteUserProfileRepository.ts', {
  '@platform/persistence': { databaseCoordinator: { openTaskExecutor: () => executor } },
  '@features/media': { resolveMediaAssetReferenceUri: async ({ legacyUri }) => legacyUri },
  '../domain/UserProfile': domain,
});
const repository = new SQLiteUserProfileRepository();
const original = await repository.get();
assert.equal(original.name, '原名');
assert.equal(original.avatar, 'avatar.jpg');
assert.equal(original.momentsCover, 'cover.jpg');
assert.equal(original.gender, '');
assert.equal(original.age, null);
assert.equal(profileFieldValue(original, 'age'), '');
await Promise.all([
  repository.update({ name: '枫渡', gender: '霸王龙', age: 0 }),
  repository.update({ identity: '设计师', region: '杭州', other, signature: '自由而有趣' }),
  repository.update({ avatar: 'new-avatar.jpg' }),
]);
const persisted = await repository.get();
assert.equal(persisted.name, '枫渡');
assert.equal(persisted.age, 0);
assert.equal(persisted.gender, '霸王龙');
assert.equal(persisted.other, other);
assert.equal(persisted.avatar, 'new-avatar.jpg');
await repository.update(parse('age', { value: '' }).patch);
assert.equal((await repository.get()).age, null, '清空年龄不伪造零岁');
await repository.update({ age: 0 });

const { PromptPackBlockFactory } = load('src/host/prompt/PromptPackBlockFactory.ts', {
  '@shared': { DEFAULT_SELF_NAME: '用户' }, '@features/memory': {}, '@features/assistants': {}, '@features/moments': {},
  '@shared/prompt': {}, './PromptBuiltInContent': load('src/host/prompt/PromptBuiltInContent.ts'),
});
const factory = new PromptPackBlockFactory();
const identity = await factory.resolveUserIdentity({ repositories: { profile: repository } });
const block = factory.createUserIdentityBlock(identity);
for (const value of ['枫渡', '霸王龙', '年龄：0', '设计师', '杭州', other, '自由而有趣']) {
  assert.ok(block.content.includes(value), `模型可见完整资料：${value.slice(0, 20)}`);
}
assert.ok(!block.content.includes('new-avatar.jpg'), '头像本机 URI 不进入人设正文');
const groupBlock = factory.createUserIdentityBlock({ ...identity, displayName: '群聊快照名' });
assert.ok(groupBlock.content.includes('群聊快照名'));
assert.ok(!groupBlock.content.includes('枫渡'), '群聊展示名与 mention 使用同一快照');
assert.ok(groupBlock.content.includes(other));
const empty = factory.createUserIdentityBlock({ displayName: '用户', source: 'test', profile: domain.createDefaultUserProfile() });
assert.ok(!empty.content.includes('性别：'));
assert.ok(!empty.content.includes('年龄：'));
assert.ok(!empty.content.includes('其他设定：'));
const expectedProfileWarning = mock.method(console, 'warn', () => undefined);
const failedIdentity = await factory.resolveUserIdentity({ repositories: { profile: { get: async () => { throw new Error('资料读取失败'); } } } });
expectedProfileWarning.mock.restore();
assert.equal(failedIdentity.displayName, '用户', '资料读取失败时 Prompt 保留默认身份');
assert.equal(failedIdentity.profile, null);

// 宿主重放原来的 Stack action；按钮、硬件返回和手势没有第二套提交路径。
let guard;
let canLeave = false;
const actions = [];
const pendingLeave = { current: false };
const { default: ProfileRouteContent } = load('src/host/navigation/ProfileRouteContent.tsx', {
  react: { useRef: () => pendingLeave, useState: () => [{ dirty: true, flush: async () => canLeave }, () => undefined] },
  'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
  'expo-router': { useNavigation: () => ({ dispatch: (action) => actions.push(action) }), useRouter: () => ({ back() {}, push() {} }) },
  '@react-navigation/native': { usePreventRemove: (dirty, callback) => { assert.equal(dirty, true); guard = callback; } },
  '@features/profile': { ProfileDetailsScreen() {}, ProfileFieldScreen() {} },
});
ProfileRouteContent({ field: 'age' });
const action = { type: 'GO_BACK', source: 'profile-age' };
guard({ data: { action } });
await Promise.resolve(); await Promise.resolve();
assert.equal(actions.length, 0, '无效输入或提交失败保留当前 Stack 页面');
canLeave = true;
guard({ data: { action } });
guard({ data: { action } });
await Promise.resolve(); await Promise.resolve();
assert.deepEqual(actions, [action], '完成提交后只重放一次原始返回动作');

const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
mock.timers.enable({ apis: ['setTimeout'] });
try {
  const writes = [];
  const editor = new AutoSaveDraftEditor({ value: '' }, (draft, changed) => parse('other', draft, changed), async (patch) => { writes.push(patch); });
  editor.change({ value: '第一版' });
  mock.timers.tick(500); await tick();
  assert.equal(writes.length, 0);
  editor.change({ value: other });
  mock.timers.tick(10000); await tick();
  assert.deepEqual(writes, [], '停输不提交尚未失焦的设定');
  await editor.commit();
  assert.deepEqual(writes, [{ other }], '失焦保存最新完整设定');
  editor.change({ value: '立刻返回' });
  assert.equal(await editor.flush(), true);
  assert.deepEqual(writes.at(-1), { other: '立刻返回' }, '返回等待尚未失焦的输入提交');

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowWrites = [];
  const slow = new AutoSaveDraftEditor({ value: '' }, (draft, changed) => parse('gender', draft, changed), async (patch) => { slowWrites.push(patch); await gate; });
  slow.change({ value: '霸王龙' });
  const firstSave = slow.flush(); await tick();
  slow.change({ value: '翼龙' });
  const backSave = slow.flush();
  release();
  assert.equal(await firstSave, true);
  assert.equal(await backSave, true);
  assert.deepEqual(slowWrites, [{ gender: '霸王龙' }, { gender: '翼龙' }], '旧写入确认不覆盖新输入，返回排空最新草稿');

  const age = new AutoSaveDraftEditor({ value: '18' }, (draft, changed) => parse('age', draft, changed), async () => assert.fail('无效年龄不写库'));
  age.change({ value: '外星人' });
  assert.equal(await age.flush(), false, '无效输入阻止返回');
  assert.equal(age.getSnapshot().draft.value, '外星人');
  await age.restore();
  assert.equal(age.getSnapshot().draft.value, '18');
  assert.equal(await age.flush(), true);

  let failSave = true;
  const failure = new AutoSaveDraftEditor({ value: '原身份' }, (draft, changed) => parse('identity', draft, changed), async () => {
    if (failSave) throw new Error('模拟写入失败');
  });
  const expectedLog = mock.method(console, 'error', () => undefined);
  failure.change({ value: '新身份' });
  assert.equal(await failure.flush(), false, '写入失败时不允许丢弃草稿返回');
  assert.equal(failure.getSnapshot().draft.value, '新身份');
  assert.ok(failure.getSnapshot().saveError);
  expectedLog.mock.restore();
  failSave = false;
  assert.equal(await failure.flush(), true, '重试成功后允许返回');

  // null 只表示缺行；读取故障不能触发默认资料，也不能被插入后的重读 fallback 吞掉。
  db.prepare('DELETE FROM user_profile WHERE id = ?').run('self');
  assert.equal((await repository.ensureDefault()).name, '用户');
  assert.equal(db.prepare('SELECT name FROM user_profile WHERE id = ?').get('self').name, '用户');
  const originalGetFirst = executor.getFirstAsync;
  const originalRun = executor.runAsync;
  let profileWrites = 0;
  try {
    executor.runAsync = async (...args) => { profileWrites += 1; return originalRun(...args); };
    executor.getFirstAsync = async () => { throw new Error('资料读取故障'); };
    await assert.rejects(repository.get(), /资料读取故障/);
    await assert.rejects(repository.ensureDefault(), /资料读取故障/);
    assert.equal(profileWrites, 0, '读取故障不能进入默认资料插入流程');

    db.prepare('DELETE FROM user_profile WHERE id = ?').run('self');
    let reads = 0;
    executor.getFirstAsync = async (...args) => {
      reads += 1;
      if (reads === 2) throw new Error('插入后的读取故障');
      return originalGetFirst(...args);
    };
    await assert.rejects(repository.ensureDefault(), /插入后的读取故障/);
    assert.equal(profileWrites, 1);
  } finally {
    executor.getFirstAsync = originalGetFirst;
    executor.runAsync = originalRun;
  }
  assert.equal((await repository.ensureDefault()).name, '用户', '故障恢复后读取已持久化的默认资料');
} finally { mock.timers.reset(); db.close(); }
console.log('个人资料迁移、独立字段提交、自动保存、读取故障与完整人设注入验证通过。');
