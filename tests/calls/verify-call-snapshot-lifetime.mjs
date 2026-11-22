/** Calls 快照真实 SQLite 行为：晚到写入拒绝、清理重试、历史保留及备份副本裁剪。 */
import { repoRoot as root } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

function load(relative, mocks = {}) {
  const source = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)((name) => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.startsWith('.')) return load(path.posix.join(path.posix.dirname(relative), name + '.ts'), mocks);
    assert.ok(Object.hasOwn(mocks, name), `缺少依赖：${name}`);
    return mocks[name];
  }, module, module.exports);
  return module.exports;
}
const { SCHEMAS } = load('src/platform/persistence/sqlite/schema.ts');
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = OFF');
for (const key of ['callSessions', 'callEvents', 'callAttachments', 'callHistory']) db.exec(SCHEMAS[key]);
function executorFor(database) {
  return {
    getFirstAsync: async (sql, params = []) => database.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql, params = []) => database.prepare(sql).all(...params),
    runAsync: async (sql, params = []) => database.prepare(sql).run(...params),
  };
}
const executor = executorFor(db);
const coordinator = {
  openTaskExecutor: () => executor,
  read: (_meta, work) => work(executor), write: (_meta, work) => work(executor),
  async transaction(_meta, work) {
    db.exec('BEGIN');
    try { const result = await work(executor); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  },
};
const { SQLiteCallRepository } = load('src/features/calls/infrastructure/SQLiteCallRepository.ts', { '@platform/persistence': { databaseCoordinator: coordinator } });
const repository = new SQLiteCallRepository();
const call = await repository.createSession({ id: 'call', chatSessionId: 'conversation', aiAssistantId: 'ai', agentId: 'agent', direction: 'outgoing', state: 'active', requestedMode: 'video', source: 'user' });
const files = new Set();
let failDeletion = false;
const warnings = [];
const device = {
  createRandomUUID: () => 'current-runtime',
  getPersistentMediaCategoryPrefix: () => 'calls/snapshots/', PERSISTENT_MEDIA_CATEGORY: { callSnapshot: 'callSnapshot' },
  persistentMediaStore: {
    async persistMedia({ originalFileName }) { const uri = `file:///current/persistent-media/calls/snapshots/${originalFileName}`; files.add(uri); return uri; },
    async getInfo() { return { size: 123 }; },
    async deleteIfExists(uri) { files.delete(uri); },
    async deleteCategoryFileIfExists(uri) { if (failDeletion) throw new Error('文件删除失败'); files.delete(uri); },
    async deleteCategoryFilesExceptPrefix(_category, prefix) {
      if (failDeletion) throw new Error('目录清理失败');
      for (const uri of files) if (!uri.slice(uri.lastIndexOf('/') + 1).startsWith(prefix)) files.delete(uri);
    },
  },
};
const runtime = { getCallRuntimeDependencies: () => ({ repositories: { calls: repository } }) };
const lifetime = load('src/features/calls/application/snapshots/CallSnapshotLifetime.ts', { '@platform/device': device, '../runtime/CallRuntimeDependencies': runtime });
const { attachCallSnapshot } = load('src/features/calls/application/snapshots/AttachCallSnapshot.ts', { '@platform/device': device, '../runtime/CallRuntimeDependencies': runtime, './CallSnapshotLifetime': lifetime,
  '../CallHistory': { async saveCallHistorySnapshot() {} } });
// 生命周期依赖显式注入，工具模型和原生音频不参与本次 SQL/file 行为验证。
const originalWarn = console.warn;
console.warn = (...values) => { warnings.push(values); };
async function append(id) {
  const uri = `file:///current/persistent-media/calls/snapshots/${id}.jpg`; files.add(uri);
  return repository.appendSnapshot({ callId: call.id, chatSessionId: call.chatSessionId, event: { id: `event-${id}`, kind: 'snapshotAttached', actorType: 'system', text: '已截取当前帧', includeInAIContext: true }, attachment: { id, kind: 'snapshot', localUri: uri } });
}
try {
  const first = await append('first');
  await repository.appendEvent({ id: 'ocr', callId: call.id, chatSessionId: call.chatSessionId, kind: 'ocrText', actorType: 'model', text: '画面文字', attachmentId: first.attachment.id, includeInAIContext: true });
  const second = await append('second');
  await lifetime.discardCallSnapshots(call.id, ['first']);
  assert.equal(files.has(first.attachment.localUri), false);
  assert.equal(files.has(second.attachment.localUri), true, '只清理本轮实际取得的帧');
  assert.equal((await repository.listAttachments(call.id)).find((row) => row.id === 'first').localUri, null);
  assert.equal((await repository.listEvents({ callId: call.id })).find((row) => row.id === 'ocr').text, '画面文字', '文本事实仍保留');
  failDeletion = true;
  await lifetime.discardCallSnapshots(call.id);
  assert.equal((await repository.listSnapshotFiles()).length, 1, '删除失败保留重试定位');
  assert.ok(warnings.length > 0);
  failDeletion = false;
  await lifetime.discardCallSnapshots();
  assert.equal((await repository.listSnapshotFiles()).length, 0);
  assert.equal(files.size, 0);

  const previous = await append('previous');
  const current = await attachCallSnapshot({ callId: call.id, sourceUri: 'content://camera/current-frame' });
  const orphan = 'file:///current/persistent-media/calls/snapshots/uncommitted.jpg';
  files.add(orphan);
  failDeletion = true;
  await lifetime.discardPreviousProcessCallSnapshots();
  assert.ok(files.has(orphan));
  assert.equal((await repository.listSnapshotFiles()).length, 2, '目录清理失败保留引用');
  failDeletion = false;
  await lifetime.discardPreviousProcessCallSnapshots();
  assert.equal(files.has(orphan), false, '冷启动回收没有事实记录的残留');
  assert.equal(files.has(previous.attachment.localUri), false);
  assert.ok(files.has(current.attachment.localUri), '保护本实例正在处理的帧');
  assert.deepEqual((await repository.listSnapshotFiles()).map((row) => row.id), [current.attachment.id]);
  await lifetime.discardCallSnapshots(call.id);

  const active = await append('active');
  const snapshot = new DatabaseSync(':memory:');
  snapshot.exec('PRAGMA foreign_keys = OFF');
  snapshot.exec(SCHEMAS.callAttachments);
  const attachment = db.prepare('SELECT * FROM call_attachments WHERE id = ?').get('active');
  const columns = Object.keys(attachment);
  snapshot.prepare(`INSERT INTO call_attachments (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(attachment));
  await assert.rejects(repository.assertBackupSnapshotHasNoFiles(executorFor(snapshot)), /临时快照地址/);
  await repository.clearSnapshotReferencesInTransaction(executorFor(snapshot));
  await repository.assertBackupSnapshotHasNoFiles(executorFor(snapshot));
  assert.equal(snapshot.prepare('SELECT local_uri FROM call_attachments').get().local_uri, null);
  assert.equal(db.prepare("SELECT local_uri FROM call_attachments WHERE id = 'active'").get().local_uri, active.attachment.localUri, '备份裁剪不改变活动通话');
  assert.ok(files.has(active.attachment.localUri));
  snapshot.close();
  await repository.updateSessionIfState(call.id, ['active'], { state: 'ended' });
  await assert.rejects(append('late'), /通话已结束/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM call_events WHERE id = 'event-late'").get().n, 0, '晚到快照整体回滚');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM call_attachments WHERE id = 'late'").get().n, 0);
  assert.deepEqual(lifetime.CALL_SNAPSHOT_BACKUP_EXCLUSIONS, ['calls/snapshots/']);
} finally { console.warn = originalWarn; db.close(); }
console.log('PASS Calls 快照生命周期：指定帧销毁、失败重试、OCR 保留、备份裁剪与晚到提交拒绝');
