/** 原帖编辑的真实 SQLite 行为：权限、patch、事务、媒体、并发、模型可见状态与迁移。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import Ajv from 'ajv';
import React from 'react';
import { act, create as render } from 'react-test-renderer';
import * as jsxRuntime from 'react/jsx-runtime';
import { createCoordinatedSqliteFixture } from '../helpers/coordinated-sqlite-fixture.mjs';
import { bootstrapSqlite, createSqliteExecutor, restoreLegacyModelServicesFixture } from '../helpers/sqlite-bootstrap-fixture.mjs';

const db = new DatabaseSync(':memory:');
const raw = createSqliteExecutor(db);
const fixture = createCoordinatedSqliteFixture(raw);
const profile = { id: 'self', name: '用户', avatar: null, avatarMediaAssetId: null };
const assistants = ['a', 'b', 'c'].map(id => ({ id, agentId: `agent-${id}`, name: `AI ${id}`, avatar: null, avatarMediaAssetId: null }));
const directory = { listAgentIds: async () => assistants.map(item => item.agentId) };
const analyses = [];
const released = [];
const lifecycle = [];
class MediaAssetNotFoundError extends Error {}
class MediaAssetMissingError extends Error {}
const mocks = {
  '@platform/persistence': fixture,
  '@features/profile': { SELF_USER_PROFILE_ID: 'self', getCurrentUserProfile: async () => profile },
  '@features/assistants': { listAIAssistants: async () => assistants, getAssistantDisplayName: item => item.name },
  '@features/media': {
    MEDIA_ASSET_STORAGE_BACKEND: { persistentImage: 'persistent-image' },
    MediaAssetNotFoundError, MediaAssetMissingError,
    resolveMediaAsset: async id => {
      const asset = db.prepare('SELECT id, mime_type AS mimeType FROM media_assets WHERE id=?').get(id);
      if (!asset) throw new MediaAssetNotFoundError(id);
      return { asset, localUri: `file:///${id}` };
    },
    releaseMediaAssetCandidates: async ids => released.push(...ids),
  },
};
const cache = new Map();
function load(relative) {
  const absolute = path.resolve(relative);
  if (cache.has(absolute)) return cache.get(absolute);
  if (absolute.endsWith(`${path.sep}MomentMediaAnalysis.ts`)) return {
    startNewMomentMediaAnalysis: (momentId, ids) => analyses.push({ momentId, ids }),
  };
  const module = { exports: {} };
  cache.set(absolute, module.exports);
  const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: absolute,
  });
  new Function('exports', 'require', 'module', compiled.outputText)(module.exports, specifier => {
    if (!specifier.startsWith('.')) {
      if (specifier.startsWith('@shared/')) return load(`src/shared/${specifier.slice('@shared/'.length)}.ts`);
      assert.ok(Object.hasOwn(mocks, specifier), `${relative} 未声明依赖 ${specifier}`);
      return mocks[specifier];
    }
    const base = path.resolve(path.dirname(absolute), specifier);
    return load(fs.existsSync(`${base}.ts`) ? `${base}.ts` : `${base}/index.ts`);
  }, module);
  cache.set(absolute, module.exports);
  return module.exports;
}

const schema = load('src/platform/persistence/sqlite/momentsSchema.ts');
db.exec('PRAGMA foreign_keys=ON; CREATE TABLE ai_assistants(agent_id TEXT PRIMARY KEY, deleted_at TEXT); CREATE TABLE media_assets(id TEXT PRIMARY KEY,mime_type TEXT NOT NULL);');
for (const name of ['MOMENTS_SCHEMA', 'MOMENT_AUDIENCE_AI_SCHEMA', 'MOMENT_COMMENTS_SCHEMA', 'MOMENT_LIKES_SCHEMA', 'MOMENT_MEDIA_SCHEMA', 'MOMENT_SOCIAL_INBOX_DELIVERIES_SCHEMA']) db.exec(schema[name]);
for (const item of assistants) db.prepare('INSERT INTO ai_assistants(agent_id) VALUES (?)').run(item.agentId);
for (const id of ['img-a', 'img-b', 'img-c']) db.prepare('INSERT INTO media_assets VALUES (?,?)').run(id, 'image/jpeg');
db.prepare('INSERT INTO media_assets VALUES (?,?)').run('audio', 'audio/mpeg');
const repository = new (load('src/features/moments/infrastructure/SQLiteMomentRepository.ts').SQLiteMomentRepository)();
const create = load('src/features/moments/application/CreateMoment.ts');
const editing = load('src/features/moments/application/EditMoment.ts');
const detail = load('src/features/moments/application/ReadMomentDetail.ts');
const search = load('src/features/moments/aiTools/SearchMomentsTool.ts');
const tool = load('src/features/moments/aiTools/AIEditOwnMomentTool.ts').AIEditOwnMomentTool;
const sharing = load('src/features/moments/application/ShareMoment.ts');
const sharedText = load('src/features/chat/messages/domain/SharedMoment.ts');
let preparedIndex = 0;
load('src/features/moments/application/MomentMediaRuntime.ts').configureMomentMediaRuntime({
  repository, database: fixture.executor,
  prepareMedia: async inputs => {
    const ids = inputs.map(() => `prepared-${++preparedIndex}`);
    return {
      commitInTransaction: async transaction => {
        lifecycle.push('commit');
        for (const id of ids) await transaction.runAsync('INSERT INTO media_assets VALUES (?,?)', [id, 'image/jpeg']);
        return { assets: ids.map(id => ({ id })) };
      },
      discard: async () => lifecycle.push('discard'),
      discardAfterRollback: async () => lifecycle.push('rollback'),
      finalizeAfterCommit: async () => lifecycle.push('finalize'),
    };
  },
});
const context = { repositories: { moment: repository }, sharedState: {}, getAgentId: () => 'agent-a', getAIName: () => 'AI a', isBlocked: () => false };
const validate = new Ajv({ strict: false }).compile(tool.definition.parameters);
assert.equal(validate({ momentId: 'x' }), false);
assert.equal(validate({ momentId: 'x', mediaAssetIds: [] }), true);
assert.equal(validate({ momentId: 'x', content: '正文', authorId: 'agent-b' }), false);

const original = await create.createAgentMoment(repository, directory, { agentId: 'agent-a', nameSnapshot: 'AI a', content: '原正文', mediaAssetIds: ['img-a', 'img-b'] });
const id = original.id;
await repository.insertLike({ momentId: id, actorType: 'ai', actorId: 'agent-b', actorNameSnapshot: 'AI b' });
await repository.insertComments([{ id: 'comment', momentId: id, authorType: 'ai', authorId: 'agent-b', authorNameSnapshot: 'AI b', content: '评论保留', parentCommentId: null }]);
const mediaBefore = await repository.listMedia(id);
await repository.editMediaAnalysis({ mediaId: mediaBefore[0].id, text: '保留的图片描述', analyzedAt: '2026-11-01T00:00:00.000Z' });
const inboxBefore = db.prepare('SELECT COUNT(*) AS count FROM moment_social_inbox_deliveries').get().count;
let events = 0;
const unsubscribe = editing.subscribeMomentEdited(() => events++);
const oldShare = await sharing.createMomentShareSnapshot(repository, id);
const saved = await tool.execute({ momentId: id, content: '修正正文' }, context);
assert.equal(saved.success, true);
assert.equal(saved.data.createdAt, original.createdAt);
assert.equal(saved.data.editRevision, 1);
assert.ok(saved.data.editedAt);
assert.deepEqual((await repository.listMedia(id)).map(item => item.id), mediaBefore.map(item => item.id));
assert.equal((await repository.listComments(id)).length, 1);
assert.equal((await repository.listLikes(id)).length, 1);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM moment_social_inbox_deliveries').get().count, inboxBefore);
assert.equal((await tool.execute({ momentId: id, content: '修正正文' }, context)).data.editRevision, 1, '相同内容不制造编辑事实');
assert.equal(events, 1);
assert.equal((await tool.execute({ momentId: id }, context)).success, false);
assert.equal((await tool.execute({ momentId: id, content: '   ' }, context)).success, false);
assert.equal((await tool.execute({ momentId: id, content: '越权' }, { ...context, getAgentId: () => 'agent-b' })).success, false);
assert.equal((await tool.execute({ momentId: id, content: '禁止' }, { ...context, isBlocked: () => true })).success, false);
const abort = new AbortController(); abort.abort();
await assert.rejects(tool.execute({ momentId: id, content: '取消' }, { ...context, abortSignal: abort.signal }), error => error.name === 'AbortError');

const beforeImages = analyses.length;
assert.equal((await tool.execute({ momentId: id, mediaAssetIds: ['img-b', 'img-a'] }, context)).success, true);
assert.deepEqual((await repository.listMedia(id)).map(item => item.id), [mediaBefore[1].id, mediaBefore[0].id]);
assert.equal(analyses.length, beforeImages, '换序不重新识别保留图片');
await tool.execute({ momentId: id, mediaAssetIds: ['img-a', 'img-c'] }, context);
const mediaAfter = await repository.listMedia(id);
assert.equal(mediaAfter[0].id, mediaBefore[0].id);
assert.equal(mediaAfter[0].analysisText, '保留的图片描述');
assert.deepEqual(analyses.at(-1).ids, [mediaAfter[1].id]);
assert.ok(released.includes('img-b'));
for (const ids of [['img-a', 'img-a'], ['missing'], ['audio'], Array(10).fill('img-a')]) {
  assert.equal((await tool.execute({ momentId: id, mediaAssetIds: ids }, context)).success, false);
}

const read = await detail.readMomentDetail(repository, 'agent-a', id);
assert.match(read.message, /已编辑.*最后编辑时间/);
assert.equal(read.data.media[0].mediaAssetId, 'img-a');
assert.match((await search.execute({ author: 'self' }, context)).message, /已编辑/);
const newShare = await sharing.createMomentShareSnapshot(repository, id);
assert.equal(oldShare.editedAt, null);
assert.ok(newShare.editedAt);
assert.match(sharedText.buildSharedMomentText(newShare, 'agent-b'), /已编辑/);
assert.equal(oldShare.content, '原正文', '编辑不改写已生成的分享快照');
assert.equal(sharedText.isSharedMoment(newShare), true);
const legacyShare = { ...oldShare }; delete legacyShare.editedAt;
assert.equal(sharedText.isSharedMoment(legacyShare), true, '已持久化的旧卡片仍可读取');

await tool.execute({ momentId: id, audience: { mode: 'selected', agentIds: ['agent-b'] } }, context);
assert.equal(await repository.getVisibleMomentForAgent('agent-c', id), null);
assert.equal((await repository.listUnreadSocialDeliveries('agent-c')).length, 0, '缩小可见范围一并清除事件侧漏');
assert.ok(await repository.getVisibleMomentForAgent('agent-a', id), '作者自己始终可见');
const narrowedCount = db.prepare('SELECT COUNT(*) AS count FROM moment_social_inbox_deliveries').get().count;
await tool.execute({ momentId: id, audience: { mode: 'all' }, mediaAssetIds: [] }, context);
assert.ok(await repository.getVisibleMomentForAgent('agent-c', id));
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM moment_social_inbox_deliveries').get().count, narrowedCount, '扩大可见范围不补投新帖事件');
assert.deepEqual(await repository.listMedia(id), []);

// 失败必须整笔回滚，不能留下半套正文、图片、可见范围与编辑时间。
const beforeRollback = await repository.getMomentEditSnapshotForUser(id);
db.exec("CREATE TRIGGER reject_edit BEFORE UPDATE ON moments BEGIN SELECT RAISE(ABORT, '拒绝编辑'); END;");
await assert.rejects(editing.editOwnMomentAsAgent(repository, directory, { momentId: id, agentId: 'agent-a', content: '回滚', mediaAssetIds: ['img-a'], audience: { mode: 'all_except', viewerAgentIds: ['agent-b'] } }));
db.exec('DROP TRIGGER reject_edit;');
assert.deepEqual(await repository.getMomentEditSnapshotForUser(id), beforeRollback);

const user = await create.createUserMoment(repository, directory, { content: '用户原帖', locationLabel: '原地点' });
assert.equal((await tool.execute({ momentId: user.id, content: '越权修改用户' }, context)).success, false);
await assert.rejects(editing.loadUserMomentEditDraft(repository, id), error => error.code === 'not_moment_owner');
const initial = await editing.loadUserMomentEditDraft(repository, user.id);
const file = { uri: 'file:///picked.jpg', fileName: 'picked.jpg', mimeType: 'image/jpeg', width: 10, height: 10 };
await editing.editOwnMomentAsUser(repository, directory, { ...initial.draft, momentId: user.id, expectedRevision: initial.expectedRevision, content: '用户修正', locationLabel: null, media: [file] });
assert.deepEqual(lifecycle.slice(-2), ['commit', 'finalize']);
const userSaved = await repository.getMomentForUser(user.id);
assert.equal(userSaved.locationLabel, null);
assert.equal(userSaved.content, '用户修正');
await assert.rejects(editing.editOwnMomentAsUser(repository, directory, { ...initial.draft, momentId: user.id, expectedRevision: initial.expectedRevision }), error => error.code === 'edit_conflict');
const current = await editing.loadUserMomentEditDraft(repository, user.id);
await assert.rejects(editing.editOwnMomentAsUser(repository, directory, { ...current.draft, momentId: user.id, expectedRevision: 0, media: [file] }), error => error.code === 'edit_conflict');
assert.deepEqual(lifecycle.slice(-2), ['commit', 'rollback']);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM media_assets WHERE id='prepared-2'").get().count, 0);
// 同一表单版本只能有一个成功保存者；调度器串行不能代替业务版本检查。
const concurrent = await Promise.allSettled(['甲', '乙'].map(content => editing.editOwnMomentAsUser(repository, directory, { ...current.draft, content, momentId: user.id, expectedRevision: current.expectedRevision })));
assert.equal(concurrent.filter(item => item.status === 'fulfilled').length, 1);
assert.equal(concurrent.find(item => item.status === 'rejected').reason.code, 'edit_conflict');
const parallelPatch = await Promise.all([
  editing.editOwnMomentAsAgent(repository, directory, { momentId: id, agentId: 'agent-a', content: '独立正文修改' }),
  editing.editOwnMomentAsAgent(repository, directory, { momentId: id, agentId: 'agent-a', audience: { mode: 'all_except', viewerAgentIds: ['agent-c'] } }),
]);
assert.equal(parallelPatch.length, 2);
assert.equal((await repository.getMomentForUser(id)).content, '独立正文修改');
assert.equal((await repository.getMomentForUser(id)).audienceMode, 'all_except', '不同字段的 patch 在事务内保留其他最新字段');
assert.equal(await repository.getVisibleMomentForAgent('agent-c', id), null);
const invisible = { ...context, getAgentId: () => 'agent-c' };
assert.equal((await tool.execute({ momentId: id, content: '探测' }, invisible)).error,
  (await tool.execute({ momentId: 'missing', content: '探测' }, invisible)).error, '不可见与不存在使用相同错误');
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
unsubscribe();

// 真实 174 → 175 升级：不把历史帖子标成编辑过，失败时结构和版本一起回滚。
const upgrade = new DatabaseSync(':memory:');
await bootstrapSqlite(createSqliteExecutor(upgrade));
restoreLegacyModelServicesFixture(upgrade);
upgrade.exec('ALTER TABLE ai_assistants DROP COLUMN deleted_at;');
upgrade.exec("INSERT INTO moments(id,author_type,author_id,author_name_snapshot,content,created_at) VALUES ('history','user','self','用户','历史正文','2026-11-01'); ALTER TABLE moments DROP COLUMN edited_at; ALTER TABLE moments DROP COLUMN edit_revision; PRAGMA user_version=174;");
const upgradeRaw = createSqliteExecutor(upgrade);
await assert.rejects(bootstrapSqlite({ ...upgradeRaw, execAsync: async sql => {
  if (sql.includes('PRAGMA user_version =')) throw new Error('升级提交失败');
  return upgradeRaw.execAsync(sql);
} }), /升级提交失败/);
assert.equal(upgrade.prepare('PRAGMA user_version').get().user_version, 174);
assert.equal(upgrade.prepare('PRAGMA table_info(moments)').all().some(row => row.name === 'edited_at'), false);
await bootstrapSqlite(upgradeRaw);
const historical = upgrade.prepare("SELECT content,edited_at,edit_revision FROM moments WHERE id='history'").get();
assert.deepEqual({ ...historical }, { content: '历史正文', edited_at: null, edit_revision: 0 });
upgrade.close(); db.close();

// 用户复用发布表单：原帖预填、已有图片、失败保留草稿、成功提交完整修改。
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const theme = { colors: { background: {}, border: {}, brand: {}, text: {}, surface: {}, icon: {} }, spacing: {}, radius: {}, effects: { glass: { enabled: false } } };
const dialogs = [];
const submissions = [];
let failSave = true;
let backHandler;
function loadUI(relative, uiMocks) {
  const compiled = ts.transpileModule(fs.readFileSync(relative, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: relative,
  });
  const module = { exports: {} };
  new Function('exports', 'require', 'module', compiled.outputText)(module.exports, specifier => {
    assert.ok(Object.hasOwn(uiMocks, specifier), `${relative} 未声明依赖 ${specifier}`);
    return uiMocks[specifier];
  }, module);
  return module.exports;
}
const ui = loadUI('src/features/moments/presentation/PublishView.tsx', {
  'react/jsx-runtime': jsxRuntime,
  react: React,
  'react-native': { ActivityIndicator: 'Spinner', BackHandler: { addEventListener: (_event, callback) => { backHandler = callback; return { remove() {} }; } }, Image: 'Image', ScrollView: 'Scroll', StyleSheet: { create: value => value }, Text: 'Text', TouchableOpacity: 'Button', View: 'View' },
  'react-native-safe-area-context': { SafeAreaView: 'SafeArea' },
  '@shared/ui': { AppTextInput: 'Input', KeyboardAvoidingContainer: 'Keyboard', showAppDialog: dialog => dialogs.push(dialog) },
  '@shared/theme': { useTheme: () => theme },
  '@features/media': { MediaAssetImage: 'AssetImage' },
  'expo-image-picker': { requestMediaLibraryPermissionsAsync: async () => ({ granted: true }), launchImageLibraryAsync: async () => ({ canceled: false, assets: [file] }) },
  'lucide-react-native': { ChevronRight: 'Icon', ImagePlus: 'Icon', MapPin: 'Icon', X: 'Icon' },
  '../application/CreateUserMomentWithMedia': { MAX_MOMENT_MEDIA_COUNT: 9 },
  '../domain/MomentLocation': load('src/features/moments/domain/MomentLocation.ts'),
  '../presentationFacade': { listMomentAudienceCandidates: async () => [] },
  './MomentAudienceSelectorModal': { default: () => null },
  './momentActionFeedback': { describeMomentEditFailure: () => '保存失败，请重试', describeMomentPublishFailure: () => '发布失败' },
  './MomentAudienceDraft': load('src/features/moments/presentation/MomentAudienceDraft.ts'),
}).default;
let cancelled = 0;
const initialDraft = { content: '预填正文', locationLabel: '预填地点', media: [{ mediaAssetId: 'existing' }], audience: { mode: 'all' } };
let renderer;
await act(async () => { renderer = render(React.createElement(ui, { mode: 'edit', initialDraft, onCancel: () => cancelled++, onPublish: async draft => {
  submissions.push(draft); if (failSave) throw new Error('save failed');
} })); });
assert.equal(renderer.root.findAllByType('Input')[0].props.value, '预填正文');
assert.equal(renderer.root.findAllByType('Input')[1].props.value, '预填地点');
assert.equal(renderer.root.findByType('AssetImage').props.mediaAssetId, 'existing');
await act(async () => renderer.root.findAllByType('Input')[0].props.onChangeText('编辑后正文'));
const saveButton = () => renderer.root.findAllByType('Button').find(node => node.findAllByType('Text').some(text => text.props.children === '保存'));
await act(async () => { await saveButton().props.onPress(); });
assert.equal(dialogs.at(-1).title, '保存失败');
assert.equal(renderer.root.findAllByType('Input')[0].props.value, '编辑后正文', '保存失败保留草稿');
assert.deepEqual(submissions.at(-1).media, initialDraft.media);
failSave = false;
await act(async () => { await saveButton().props.onPress(); });
assert.equal(submissions.at(-1).content, '编辑后正文');
assert.equal(submissions.at(-1).locationLabel, '预填地点');
await act(async () => { backHandler(); });
assert.equal(cancelled, 1);
await act(async () => renderer.unmount());
console.log('Moments 原帖编辑权限 / patch / 媒体保留 / CAS / 事务回滚 / AI 编辑状态 / 数据库升级验证通过。');
