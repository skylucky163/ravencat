/** 验证真实诊断存储的留存、备份恢复与回滚、失败、凭据清洗及并发边界。 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiled = ts.transpileModule(fs.readFileSync(path.join(root, 'src/platform/ai/HttpExchangeDiagnostics.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function storage() {
  const files = new Map();
  const faults = new Map();
  const holds = new Map();
  const writes = [];
  async function gate(action) {
    const hold = holds.get(action);
    if (hold) {
      holds.delete(action);
      hold.entered.resolve();
      await hold.release.promise;
    }
    if (faults.has(action)) {
      const error = faults.get(action);
      faults.delete(action);
      throw error;
    }
  }
  const api = {
    documentDirectory: 'file:///private/files/',
    cacheDirectory: 'file:///private/cache/',
    async getInfoAsync(uri) { await gate('info'); return { exists: files.has(uri) }; },
    async readAsStringAsync(uri) {
      await gate('read');
      assert.ok(files.has(uri), '只读取存在的文件');
      return files.get(uri);
    },
    async makeDirectoryAsync() { await gate('mkdir'); },
    async writeAsStringAsync(uri, content) {
      await gate('write');
      files.set(uri, content);
      writes.push(content);
    },
    async moveAsync({ from, to }) {
      await gate('move');
      assert.ok(files.has(from));
      files.set(to, files.get(from));
      files.delete(from);
    },
    async deleteAsync(uri) {
      await gate('delete');
      for (const name of files.keys()) {
        if (name === uri || (uri.endsWith('/') && name.startsWith(uri))) files.delete(name);
      }
    },
  };
  return {
    api, files, writes,
    fail(action, message) { faults.set(action, new Error(message)); },
    hold(action) {
      const hold = { entered: deferred(), release: deferred() };
      holds.set(action, hold);
      return { entered: hold.entered.promise, release: hold.release.resolve };
    },
  };
}

function open(disk) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => {
    assert.equal(name, 'expo-file-system/legacy');
    return disk.api;
  }, module, module.exports);
  return module.exports.aiHttpDiagnostics;
}

function load(relative, mocks = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)((name) => {
    assert.ok(Object.hasOwn(mocks, name), `${relative} 缺少依赖 ${name}`);
    return mocks[name];
  }, module, module.exports);
  return module.exports;
}

function exchange(id, patch = {}) {
  return {
    id: String(id), startedAt: '2026-10-21T01:00:00.000Z', completedAt: '2026-10-21T01:00:01.000Z',
    url: 'https://provider.example/v1/chat/completions', method: 'POST', model: 'test-model',
    transport: 'complete', status: 200, requestBody: '{"messages":[]}', responseBody: '{"choices":[]}',
    error: null, ...patch,
  };
}

// 默认关闭且不因一次网络调用创建正文；首次捕获会恢复用户之前的启用选择。
{
  const disk = storage();
  const store = open(disk);
  assert.deepEqual(await store.getSnapshot(), { enabled: false, records: [], error: null });
  assert.equal(await store.beginCapture(), null);
  await store.record(exchange(0));
  assert.equal(disk.files.size, 0);
  await store.setEnabled(true);
  const reopened = open(disk);
  assert.equal(typeof await reopened.beginCapture(), 'number');
  assert.equal((await reopened.getSnapshot()).enabled, true);
}

// 清理缓存后，未满十条的完整记录和开关仍可恢复；关闭仅暂停新增，清空也不改变开关。
{
  const disk = storage();
  const store = open(disk);
  await store.setEnabled(true);
  for (let id = 0; id < 3; id++) await store.record(exchange(id));
  const saved = await store.getSnapshot();
  await disk.api.deleteAsync(disk.api.cacheDirectory);
  disk.api.cacheDirectory = null;
  const restarted = open(disk);
  assert.deepEqual(await restarted.getSnapshot(), saved);
  await restarted.setEnabled(false);
  const paused = open(disk);
  assert.deepEqual(await paused.getSnapshot(), { ...saved, enabled: false });
  assert.equal(await paused.beginCapture(), null);
  await paused.record(exchange('ignored'));
  assert.deepEqual((await paused.getSnapshot()).records, saved.records);
  await paused.setEnabled(true);
  assert.deepEqual(await open(disk).getSnapshot(), saved);
  await paused.setEnabled(false);
  await paused.clear();
  assert.deepEqual(await open(disk).getSnapshot(), { enabled: false, records: [], error: null });
}

// 第十条不淘汰既有记录；第十一条仅移除最旧的一条，重启保持其余十条。
{
  const disk = storage();
  const store = open(disk);
  await store.setEnabled(true);
  for (let id = 0; id < 10; id++) await store.record(exchange(id));
  assert.deepEqual((await open(disk).getSnapshot()).records.map(record => record.id),
    ['9', '8', '7', '6', '5', '4', '3', '2', '1', '0']);
  await store.record(exchange(10));
  assert.deepEqual((await open(disk).getSnapshot()).records.map(record => record.id),
    ['10', '9', '8', '7', '6', '5', '4', '3', '2', '1']);
}

// 覆盖升级时迁移旧缓存的已提交记录和开关；未提交临时文件不参与恢复。
{
  const disk = storage();
  const legacy = `${disk.api.cacheDirectory}ai-http-diagnostics/`;
  const records = [exchange('legacy')];
  disk.files.set(`${legacy}exchanges.json`, JSON.stringify({ version: 1, enabled: true, records }));
  disk.files.set(`${legacy}exchanges.json.tmp`, '{broken');
  const migrated = open(disk);
  assert.deepEqual(await migrated.getSnapshot(), { enabled: true, records, error: null });
  assert.equal([...disk.files.keys()].some(uri => uri.startsWith(legacy)), false);
  await disk.api.deleteAsync(disk.api.cacheDirectory);
  assert.deepEqual(await open(disk).getSnapshot(), await migrated.getSnapshot());
  // 已有持久状态优先，不能用遗留缓存覆盖用户后来的选择。
  await migrated.setEnabled(false);
  disk.files.set(`${legacy}exchanges.json`, JSON.stringify({ version: 1, enabled: true, records: [exchange('stale')] }));
  assert.deepEqual(await open(disk).getSnapshot(), { enabled: false, records, error: null });
  await migrated.reset();
  assert.equal(disk.files.size, 0);
  assert.deepEqual(await open(disk).getSnapshot(), { enabled: false, records: [], error: null });
}

// 迁移失败保留旧文件并报告错误，下一次启动仍能完成迁移。
{
  const disk = storage();
  const legacyFile = `${disk.api.cacheDirectory}ai-http-diagnostics/exchanges.json`;
  disk.files.set(legacyFile, JSON.stringify({ version: 1, enabled: true, records: [exchange('legacy')] }));
  disk.fail('move', '迁移被拒绝');
  const failed = await open(disk).getSnapshot();
  assert.equal(failed.enabled, false);
  assert.match(failed.error, /读取失败.*迁移被拒绝/);
  assert.equal(disk.files.has(legacyFile), true);
  assert.equal((await open(disk).getSnapshot()).records[0].id, 'legacy');
}

// 未初始化时直接恢复出厂，也必须删除旧缓存，不能在下次启动重新迁入。
{
  const disk = storage();
  const legacyFile = `${disk.api.cacheDirectory}ai-http-diagnostics/exchanges.json`;
  disk.files.set(legacyFile, JSON.stringify({ version: 1, enabled: true, records: [exchange('legacy')] }));
  await open(disk).reset();
  assert.equal(disk.files.size, 0);
  assert.deepEqual(await open(disk).getSnapshot(), { enabled: false, records: [], error: null });
}

// 正文不截断；并发完成串行提交，保留最近十份完整往返，重启后保持顺序和全文。
{
  const disk = storage();
  const store = open(disk);
  await store.setEnabled(true);
  const token = await store.beginCapture();
  const fullBody = '完整正文📦'.repeat(400_000);
  await Promise.all(Array.from({ length: 13 }, (_, id) => store.record(exchange(id, {
    transport: id % 2 ? 'stream' : 'complete', responseBody: id === 12 ? fullBody : `body-${id}`,
  }), '', token)));
  const snapshot = await store.getSnapshot();
  assert.deepEqual(snapshot.records.map((record) => record.id), ['12', '11', '10', '9', '8', '7', '6', '5', '4', '3']);
  assert.equal(snapshot.records[0].responseBody, fullBody);
  assert.deepEqual(await open(disk).getSnapshot(), snapshot);
  snapshot.records[0].responseBody = '消费者修改';
  snapshot.records.pop();
  assert.equal((await store.getSnapshot()).records[0].responseBody, fullBody);
  assert.equal((await store.getSnapshot()).records.length, 10);
}

// URL 用户信息、编码后的凭据查询名、API key 原文和额外 headers 均不会落盘。
{
  const disk = storage();
  const store = open(disk);
  await store.setEnabled(true);
  const key = 'sk-secret-123';
  await store.record(exchange(1, {
    url: 'https://alice:password@provider.example/v1/chat?api%5Fkey=query-secret&access_token=other-secret&access_token=third-secret&region=cn%2F1#token=fragment-secret',
    model: `model-${key}`, requestBody: `{"secret":"${key}","text":"完整正文"}`,
    responseBody: `data: ${key}\n\ndata: [DONE]\n`, error: `HTTP failed: ${key}`,
    headers: { Authorization: 'Bearer extra-header-secret' },
  }), key);
  const snapshot = await store.getSnapshot();
  const saved = snapshot.records[0];
  assert.equal(saved.url, 'https://provider.example/v1/chat?api%5Fkey=%5BREDACTED%5D&access_token=%5BREDACTED%5D&access_token=%5BREDACTED%5D&region=cn%2F1');
  assert.equal(saved.requestBody, '{"secret":"[REDACTED]","text":"完整正文"}');
  assert.equal(saved.responseBody, 'data: [REDACTED]\n\ndata: [DONE]\n');
  assert.equal(saved.error, 'HTTP failed: [REDACTED]');
  for (const persisted of disk.writes) {
    for (const secret of [key, 'alice', 'password@', 'query-secret', 'other-secret', 'third-secret', 'fragment-secret', 'extra-header-secret']) {
      assert.ok(!persisted.includes(secret), `磁盘写入不得包含 ${secret}`);
    }
  }
  await store.record(exchange(2, { url: 'not a URL', requestBody: '无 key 正文' }), '');
  assert.equal((await store.getSnapshot()).records[0].requestBody, '无 key 正文');
  assert.equal((await store.getSnapshot()).records[0].url, '[无效 URL]');
  assert.deepEqual(await open(disk).getSnapshot(), await store.getSnapshot());
}

// 写入和原子替换失败不伪装保存成功；旧文件可恢复，临时正文清理，后续操作继续工作。
for (const action of ['write', 'move']) {
  const disk = storage();
  const store = open(disk);
  await store.setEnabled(true);
  await store.record(exchange('old'));
  disk.fail(action, '磁盘写入失败');
  await store.record(exchange('new'));
  const snapshot = await store.getSnapshot();
  assert.match(snapshot.error, /保存失败.*磁盘写入失败/);
  assert.deepEqual(snapshot.records.map((record) => record.id), ['old']);
  assert.equal(disk.files.size, 1);
  assert.deepEqual((await open(disk).getSnapshot()).records.map((record) => record.id), ['old']);
  await store.record(exchange('next'));
  assert.equal((await store.getSnapshot()).error, null);
}

// 清空失败应向用户报错并保留可查看的旧记录；关闭失败也不会继续接受捕获。
{
  const disk = storage();
  const store = open(disk);
  await store.setEnabled(true);
  await store.record(exchange('old'));
  disk.fail('write', '清空写入失败');
  await assert.rejects(store.clear(), /清空写入失败/);
  assert.match((await store.getSnapshot()).error, /清空失败/);
  assert.equal((await store.getSnapshot()).records.length, 1);
  disk.fail('write', '设置写入被拒绝');
  await assert.rejects(store.setEnabled(false), /设置写入被拒绝/);
  assert.equal(await store.beginCapture(), null);
  assert.match((await store.getSnapshot()).error, /关闭失败.*设置写入被拒绝/);
  await store.setEnabled(false);
  assert.deepEqual((await open(disk).getSnapshot()).records.map(record => record.id), ['old']);
  disk.fail('delete', '删除被拒绝');
  await assert.rejects(store.reset(), /删除被拒绝/);
  assert.match((await store.getSnapshot()).error, /重置失败.*删除被拒绝/);
  await store.reset();
  assert.equal(disk.files.size, 0);
  assert.deepEqual(await open(disk).getSnapshot(), { enabled: false, records: [], error: null });
}

// 清空、关闭、重置和备份恢复会废弃在途 token；恢复用传入状态替换原记录。
for (const mutation of ['clear', 'disable', 'reset', 'restore']) {
  const disk = storage();
  const store = open(disk);
  await store.setEnabled(true);
  const token = await store.beginCapture();
  const hold = disk.hold('write');
  const recording = store.record(exchange('writing'), undefined, token);
  await hold.entered;
  const pending = mutation === 'clear' ? store.clear() : mutation === 'reset' ? store.reset()
    : mutation === 'restore' ? store.restoreBackupState({ version: 1, enabled: true, records: [exchange('restored')] })
      : store.setEnabled(false);
  const late = store.record(exchange('late'), undefined, token);
  hold.release();
  await Promise.all([recording, pending, late]);
  const retained = mutation === 'disable' ? ['writing'] : mutation === 'restore' ? ['restored'] : [];
  assert.deepEqual((await store.getSnapshot()).records.map(record => record.id), retained);
  assert.deepEqual((await open(disk).getSnapshot()).records.map(record => record.id), retained);
  if (mutation !== 'clear') await store.setEnabled(true);
  await store.record(exchange('after-reenable'), undefined, token);
  assert.deepEqual((await store.getSnapshot()).records.map(record => record.id), retained);
  const freshToken = await store.beginCapture();
  assert.notEqual(freshToken, token);
  await store.record(exchange('fresh'), undefined, freshToken);
  assert.deepEqual((await store.getSnapshot()).records.map((record) => record.id), ['fresh', ...retained]);
}

// 真实备份来源网关往返完整诊断；关闭仍备份记录，旧包保持本机状态，提交失败走既有回滚。
{
  const disk = storage();
  const store = open(disk);
  let coverFiles = [];
  let coversExist = true;
  function gatewayFor(diagnostics) {
    const { ApplicationBackupSourceGateway } = load('src/features/backup/infrastructure/ApplicationBackupSourceGateway.ts', {
      '@platform/persistence': {},
      '@platform/ai': { aiHttpDiagnostics: diagnostics },
      '@platform/device': { getPersistentMediaRootUri: () => 'file:///source/persistent-media/' },
      '@platform/device/DeviceMediaService': {
        PERSISTENT_IMAGE_CATEGORY: { chatCodeCover: 'chatCodeCover' }, getPersistentImageCategoryPrefix: () => 'covers/chat-code/',
        getPersistentImageInfoInRoot: async (root, key) => ({
          exists: !key.startsWith('covers/chat-code/') || (coversExist && root !== 'file:///cover-missing/'),
          isDirectory: false, size: 1,
        }),
      }, '@features/media': {},
      '@shared/theme': {
        loadStoredThemeBackupState: async () => ({}), parseStoredThemeBackupState: state => state,
        restoreStoredThemeBackupState: async () => {},
      },
      '../../../../modules/ravencat-floating-layer': {
        getBubbleSkinBackupSource: async () => ({ settingsJson: '{}', rootUri: 'file:///skins/' }),
        validateBubbleSkinBackupSettings: async () => {}, restoreBubbleSkinBackupSettings: async () => {},
      },
      './stableSettingsBackupState': load('src/features/backup/infrastructure/stableSettingsBackupState.ts'),
    });
    const credentials = { export: async () => [], validate: async () => {}, restore: async () => {} };
    return new ApplicationBackupSourceGateway({ readMediaInventory: async () => [], readChatCodeCoverFiles: async () => coverFiles.slice(), searchCredentials: credentials, mcpCredentials: credentials });
  }
  const source = gatewayFor(store);
  const empty = JSON.parse(await source.exportStableSettingsJson());
  assert.deepEqual(empty.aiHttpDiagnostics, { version: 1, enabled: false, records: [] });
  assert.equal(disk.files.size, 0, '未开启诊断的备份不创建诊断文件');
  await store.setEnabled(true);
  for (let id = 0; id < 9; id++) await store.record(exchange(id));
  const fullBody = '完整提示词📦\r\n'.repeat(100_000);
  await store.record(exchange('full', { transport: 'stream', requestBody: fullBody, responseBody: 'data: {"text":"回答"}\n\ndata: [DONE]\n' }));
  await store.setEnabled(false);
  const saved = await store.getSnapshot();
  const { stableSettingsJson } = await source.readNonDatabaseSources('file:///snapshot.db');
  assert.ok(Buffer.byteLength(stableSettingsJson) > 1024 * 1024, '完整正文超过旧设置大小限制');
  const incoming = JSON.parse(stableSettingsJson);
  const freshDisk = storage();
  const restored = open(freshDisk);
  const target = gatewayFor(restored);
  const validate = json => target.validateStableSettingsJson(json, 'file:///skins/', 'file:///media/', 'file:///snapshot.db');
  await validate(stableSettingsJson);
  // 作品封面随媒体根归档：create 侧与 restore preflight 都必须拒绝引用缺失文件的备份。
  coverFiles = ['version-one_1.jpg'];
  await source.readNonDatabaseSources('file:///snapshot.db');
  coversExist = false;
  await assert.rejects(source.readNonDatabaseSources('file:///snapshot.db'), /作品封面缺失/, 'create 侧封面文件缺失时拒绝产出备份');
  coversExist = true;
  await validate(stableSettingsJson);
  await assert.rejects(target.validateStableSettingsJson(stableSettingsJson, 'file:///skins/', 'file:///cover-missing/', 'file:///snapshot.db'),
    /作品封面缺失/, 'restore preflight 拒绝封面缺失的备份');
  coverFiles = [];
  await target.restoreStableSettingsJson(stableSettingsJson);
  assert.deepEqual(await restored.getSnapshot(), saved);
  assert.deepEqual(await open(freshDisk).getSnapshot(), saved, '换机后冷启动保持开关、顺序和完整正文');

  const detached = await restored.exportBackupState();
  detached.records[0].requestBody = '外部改动';
  detached.records.pop();
  assert.deepEqual(await restored.getSnapshot(), saved, '导出不暴露可变内部状态');

  const old = { ...incoming }; delete old.aiHttpDiagnostics;
  await validate(JSON.stringify(old));
  await target.restoreStableSettingsJson(JSON.stringify(old));
  assert.deepEqual(await restored.getSnapshot(), saved, '旧备份不覆盖本机诊断');
  for (const invalid of [null, {}, { ...incoming.aiHttpDiagnostics, version: 2 },
    { ...incoming.aiHttpDiagnostics, enabled: 'true' },
    { ...incoming.aiHttpDiagnostics, records: [{}] },
    { ...incoming.aiHttpDiagnostics, records: Array(11).fill(exchange('extra')) }]) {
    await assert.rejects(validate(JSON.stringify({ ...incoming, aiHttpDiagnostics: invalid })), /诊断文件格式无效/);
    await assert.rejects(restored.restoreBackupState(invalid), /诊断文件格式无效/);
  }
  assert.deepEqual(await restored.getSnapshot(), saved, '预检无效输入不得改写现有记录');

  const rollback = await target.exportStableSettingsJson();
  let action = { kind: 'apply_settings', stableSettingsJson: JSON.stringify({ ...incoming,
    aiHttpDiagnostics: { version: 1, enabled: true, records: [exchange('incoming')] } }) };
  const { runPendingBackupRestoreCompletion } = load('src/host/composition/runPendingBackupRestoreCompletion.ts');
  await assert.rejects(runPendingBackupRestoreCompletion({
    consumeRestoreFailure: async () => null, readPendingRestoreAction: async () => action,
    initializeDatabase: async () => {}, closeDatabaseForRollback: async () => {},
    restoreStableSettings: json => target.restoreStableSettingsJson(json),
    commitActivatedRestore: async () => {
      assert.equal((await restored.getSnapshot()).records[0].id, 'incoming');
      throw new Error('提交失败');
    },
    rollbackActivatedRestore: async failureMessage => { action = { kind: 'restore_rollback_settings', stableSettingsJson: rollback, failureMessage }; },
    completeRolledBackRestore: async () => {}, collectRestoreGarbage: async () => {},
  }), /原数据已回滚.*提交失败/);
  assert.deepEqual(await open(freshDisk).getSnapshot(), saved, '恢复提交失败后回滚完整诊断与关闭状态');

  // 记录读取失败不得在备份中静默变成空数组。
  const file = [...disk.files.keys()][0];
  disk.files.set(file, '{broken');
  await assert.rejects(gatewayFor(open(disk)).exportStableSettingsJson(), /读取失败/);
}

// 恢复边界清洗额外字段和 URL 凭据，原子写入失败保持原文件，允许重放回滚快照。
for (const fault of ['write', 'move']) {
  const disk = storage();
  const store = open(disk);
  await store.setEnabled(true);
  await store.record(exchange('old'));
  const rollback = await store.exportBackupState();
  const state = { version: 1, enabled: false, records: [exchange('restored', {
    url: 'https://user:password@example.com/chat?token=secret', headers: { Authorization: 'secret' },
  })] };
  disk.fail(fault, '恢复磁盘写入失败');
  await assert.rejects(store.restoreBackupState(state), /恢复磁盘写入失败/);
  assert.match((await store.getSnapshot()).error, /恢复失败/);
  await assert.rejects(store.exportBackupState(), /恢复失败/, '存在存储错误时不能宣称完整备份');
  assert.deepEqual(await open(disk).exportBackupState(), rollback);
  await store.restoreBackupState(rollback);
  assert.deepEqual(await store.exportBackupState(), rollback);
  await store.restoreBackupState(state);
  const record = (await open(disk).getSnapshot()).records[0];
  assert.equal(record.url, 'https://example.com/chat?token=%5BREDACTED%5D');
  assert.equal(Object.hasOwn(record, 'headers'), false);
  assert.equal((await store.getSnapshot()).enabled, false);
}

// 开始恢复时发生清空，不得给已经越过用户清空边界的请求发放旧 token。
{
  const disk = storage();
  const first = open(disk);
  await first.setEnabled(true);
  await first.record(exchange('old'));
  const store = open(disk);
  const hold = disk.hold('read');
  const capture = store.beginCapture();
  await hold.entered;
  const clearing = store.clear();
  hold.release();
  assert.equal(await capture, null);
  await clearing;
  assert.deepEqual((await open(disk).getSnapshot()).records, []);
}

// 文件是信任边界；损坏/读取失败/目录不可用时默认停止捕获，明确暴露错误并允许用户清理。
for (const mode of ['corrupt', 'shape', 'read', 'unavailable']) {
  const disk = storage();
  const first = open(disk);
  await first.setEnabled(true);
  await first.record(exchange('old'));
  const file = [...disk.files.keys()][0];
  if (mode === 'corrupt') disk.files.set(file, '{broken');
  if (mode === 'shape') disk.files.set(file, JSON.stringify({ version: 1, enabled: true, records: [{}] }));
  if (mode === 'read') disk.fail('read', '读取被拒绝');
  if (mode === 'unavailable') disk.api.documentDirectory = null;
  const store = open(disk);
  assert.equal(await store.beginCapture(), null);
  const snapshot = await store.getSnapshot();
  assert.equal(snapshot.enabled, false);
  assert.deepEqual(snapshot.records, []);
  assert.match(snapshot.error, /读取失败/);
  if (mode === 'unavailable') {
    await assert.rejects(store.setEnabled(true), /持久存储目录不可用/);
    assert.match((await store.getSnapshot()).error, /开启失败/);
  } else {
    await store.clear();
    assert.deepEqual(await open(disk).getSnapshot(), { enabled: false, records: [], error: null });
    assert.equal((await store.getSnapshot()).error, null);
  }
}

// 页面订阅读取已提交的状态；存储错误也通知，取消订阅后不再回调。
{
  const disk = storage();
  const store = open(disk);
  const observations = [];
  const reads = [];
  const unsubscribe = store.subscribe(() => {
    reads.push(store.getSnapshot().then((snapshot) => { observations.push(snapshot); }));
  });
  const flush = async () => { await Promise.all(reads.splice(0)); };
  await store.setEnabled(true);
  await flush();
  assert.equal(observations.at(-1).enabled, true);
  await store.record(exchange('first'));
  await flush();
  assert.equal(observations.at(-1).records[0].id, 'first');
  disk.fail('write', '空间不足');
  await store.record(exchange('lost'));
  await flush();
  assert.match(observations.at(-1).error, /保存失败.*空间不足/);
  await store.clear();
  await flush();
  assert.deepEqual(observations.at(-1).records, []);
  assert.equal(observations.at(-1).error, null);
  const count = observations.length;
  unsubscribe();
  await store.setEnabled(false);
  assert.equal(observations.length, count);
}

console.log('HTTP exchange diagnostics: 持久留存、十条淘汰、关闭保留、旧缓存迁移、全文备份恢复与回滚、旧包保留、凭据清洗、存储失败和清空/关闭/重置/恢复竞态全部通过。');
