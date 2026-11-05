/** 验证皮肤编辑边界、同事务媒体引用、备份快照以及异步解码前的发布行为。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { bootstrapSqlite, createSqliteExecutor } from './helpers/sqlite-bootstrap-fixture.mjs';

function load(file, mocks = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(id => {
    assert.ok(Object.hasOwn(mocks, id), `未声明依赖：${id}`);
    return mocks[id];
  }, module, module.exports);
  return module.exports;
}

// 气泡属于 daylight/night 的装饰，主题列表不再提供独立 DIY 主题。
const themeRegistry = load('src/shared/theme/themeRegistry.ts', Object.fromEntries(
  ['defaultLight', 'defaultDark', 'liquidGlass', 'moonKimi', 'paperNote'].map(name =>
    [`./themes/${name}`, load(`src/shared/theme/themes/${name}.ts`)]),
));
const themeVariants = load('src/shared/theme/themeVariants.ts');
assert.deepEqual(themeRegistry.AVAILABLE_THEMES.filter(theme => themeVariants.supportsChatBubbleSkins(themeRegistry.getThemeById(theme.id)))
  .map(theme => theme.name), ['daylight', 'night']);
assert.equal(themeRegistry.isValidThemeId('custom-bubble'), false);

// 曾选中误加主题的本机状态和旧备份归回 daylight，素材仍由 SQLite 皮肤引用持有。
const storedSettings = new Map();
const asyncStorage = { __esModule: true, default: {
  getItem: async key => storedSettings.get(key) ?? null,
  setItem: async (key, value) => { storedSettings.set(key, value); },
  removeItem: async key => { storedSettings.delete(key); },
  multiGet: async keys => keys.map(key => [key, storedSettings.get(key) ?? null]),
  multiSet: async entries => { entries.forEach(([key, value]) => storedSettings.set(key, value)); },
} };
const footerSettings = load('src/shared/theme/chatFooterSettings.ts', { '@react-native-async-storage/async-storage': asyncStorage });
const themeStorage = load('src/shared/theme/themeStorage.ts', {
  '@react-native-async-storage/async-storage': asyncStorage,
  './themeRegistry': themeRegistry, './glassBlur': load('src/shared/theme/glassBlur.ts'), './chatFooterSettings': footerSettings,
});
const oldColors = { userText: '#123456', aiText: '#654321' };
storedSettings.set('presentation.theme.selectedThemeId', 'custom-bubble');
storedSettings.set('presentation.theme.chatColorOverrides.custom-bubble', JSON.stringify(oldColors));
const beforeMigration = await themeStorage.loadStoredThemeBackupState();
assert.equal(beforeMigration.selectedThemeId, 'default-light');
assert.deepEqual(beforeMigration.chatColorOverrides['default-light'], oldColors);
assert.equal(await themeStorage.loadStoredThemeId(), 'default-light');
assert.equal(storedSettings.get('presentation.theme.selectedThemeId'), 'default-light');
assert.deepEqual(await themeStorage.loadChatColorOverrides('default-light'), oldColors);
const oldBackup = { selectedThemeId: 'custom-bubble', chatColorOverrides: { 'custom-bubble': oldColors } };
await themeStorage.restoreStoredThemeBackupState(oldBackup);
assert.equal(await themeStorage.loadStoredThemeId(), 'default-light');
assert.deepEqual((await themeStorage.loadStoredThemeBackupState()).chatColorOverrides['default-light'], oldColors);
assert.deepEqual(themeStorage.parseStoredThemeBackupState({ ...oldBackup,
  chatColorOverrides: { 'custom-bubble': oldColors, 'default-light': { userText: '#abcdef' } } }).chatColorOverrides['default-light'],
{ userText: '#abcdef' }, '不覆盖 daylight 已有配色');
assert.throws(() => themeStorage.parseStoredThemeBackupState({ selectedThemeId: 'unknown', chatColorOverrides: {} }), /主题标识/);

// 大尺寸但文件很小的 PNG 也应自动适配；始终保留 PNG 透明格式、比例和原文件。
let pickedImage = { width: 3500, height: 2500, mimeType: 'image/png', byteSize: 2 * 1024 * 1024 };
let saveCount = 0;
const temporaryImages = new Map();
const deletedImages = [];
let corruptedPngHeader = false;
let imageReads = 0;
let animatedImage = false;
const inspectedImages = load('src/platform/device/InspectLocalImage.ts', {
  'expo-file-system': { File: class {
    constructor(uri) { this.uri = uri; }
    exists = true;
    get size() { return pickedImage.byteSize; }
    async bytes() {
      imageReads++;
      if (this.uri === 'file:///broken.png') throw new Error('PNG 解码失败');
      if (corruptedPngHeader) return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
      if (pickedImage.mimeType === 'image/jpeg') return Uint8Array.from([255, 216, 255]);
      if (pickedImage.mimeType === 'image/webp') return Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]);
      const header = new Uint8Array(pickedImage.byteSize);
      header.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
      const view = new DataView(header.buffer);
      view.setUint32(16, pickedImage.width); view.setUint32(20, pickedImage.height);
      return header;
    }
  } },
  'react-native': { Image: { getSize: async () => pickedImage.mimeType === 'image/png'
    ? { width: Math.floor(pickedImage.width / 2), height: Math.floor(pickedImage.height / 2) }
    : { width: pickedImage.width, height: pickedImage.height } } },
  './ImageAnimation': { detectImageAnimation: () => animatedImage },
});
assert.deepEqual(await inspectedImages.inspectLocalImage('file:///original.png'), { ...pickedImage, isAnimated: false },
  'Android 解码降采样为 1750×1250 时，检查结果仍应是 PNG 原始 3500×2500');
pickedImage = { ...pickedImage, width: 9000 };
await assert.rejects(inspectedImages.inspectLocalImage('file:///too-wide.png'), /8192/,
  '原始 PNG 超限时，不能因解码后宽度缩小而绕过文件边界');
pickedImage = { ...pickedImage, width: 3500 };
corruptedPngHeader = true;
await assert.rejects(inspectedImages.inspectLocalImage('file:///truncated.png'), /PNG.*文件头损坏/);
corruptedPngHeader = false;
const normalization = load('src/platform/device/MessageBubbleBackground.ts', {
  './randomUUID': { createRandomUUID: () => 'draft-image' },
  '../../../modules/message-bubble-background': { prepareBubbleImage: async uri => {
    const image = temporaryImages.get(uri); return { width: image.width, height: image.height };
  } },
  'expo-file-system/legacy': { cacheDirectory: 'file:///cache/',
    copyAsync: async ({ from, to }) => { temporaryImages.set(to, temporaryImages.get(from) ?? pickedImage); },
    deleteAsync: async uri => { temporaryImages.delete(uri); deletedImages.push(uri); } },
  './InspectLocalImage': inspectedImages,
  'expo-image-manipulator': { SaveFormat: { PNG: 'png' }, ImageManipulator: { manipulate: () => {
    let width = pickedImage.width;
    let height = pickedImage.height;
    return {
      resize(size) {
        if (size.width) { height = Math.floor(height * size.width / width); width = size.width; }
        else { width = Math.floor(width * size.height / height); height = size.height; }
      },
      async renderAsync() { return {
        async saveAsync(options) {
          const result = { uri: `file:///normalized-${++saveCount}.png`, width, height, format: options.format };
          temporaryImages.set(result.uri, result);
          return result;
        }, release() {},
      }; }, release() {},
    };
  } } },
});
for (const dimensions of [[3500, 2500], [2500, 3500]]) {
  pickedImage = { ...pickedImage, width: dimensions[0], height: dimensions[1] };
  const imported = await normalization.prepareBubbleSkinImport('file:///original.png');
  const output = temporaryImages.get(imported.uri);
  assert.equal(output.format, 'png', '不能转成丢失透明通道的 JPEG');
  assert.ok(Math.max(output.width, output.height) <= 2048);
  assert.ok(Math.abs(output.width * pickedImage.height - output.height * pickedImage.width) <= Math.max(...dimensions),
    '等比缩放只允许整数像素取整误差，不裁剪或拉伸');
  await imported.dispose();
  assert.equal(temporaryImages.has(imported.uri), false);
  assert.equal(deletedImages.includes('file:///original.png'), false);
}
pickedImage = { ...pickedImage, width: 320, height: 200 };
const smallImage = await normalization.prepareBubbleSkinImport('file:///small.png');
assert.equal(smallImage.uri, 'file:///small.png');
await smallImage.dispose();
assert.equal(deletedImages.includes('file:///small.png'), false, '小图不重编码，也不接管原文件清理');
pickedImage = { ...pickedImage, byteSize: 9 * 1024 * 1024 };
const oversizedFile = await normalization.prepareBubbleSkinImport('file:///metadata-heavy.png');
assert.equal(temporaryImages.get(oversizedFile.uri).width, 320, '大文件重编码时不放大小图');
await oversizedFile.dispose();
// 选择器已接受的文件即使容器与 PNG 标记不同，也应生成真实 PNG，而非拒绝或只改后缀。
for (const mimeType of ['image/jpeg', 'image/webp']) {
  pickedImage = { width: 128, height: 256, mimeType, byteSize: 1024 };
  for (const kind of ['background', 'decoration']) {
    const imported = await normalization.prepareBubbleDraftImage('file:///provider-image.png', kind);
    assert.deepEqual({ width: imported.width, height: imported.height }, { width: 128, height: 256 });
    assert.equal(temporaryImages.get(imported.uri).format, 'png', '实际编码为 PNG，保持绘制与媒体存储契约');
    await imported.dispose();
    assert.equal(temporaryImages.size, 0, '格式转换中间图和草稿副本均被释放');
  }
}
await assert.rejects(normalization.prepareBubbleDraftImage('file:///broken.png', 'background'), /无法读取或已损坏/,
  '读取失败继续报告真实文件错误，不伪装成格式不符');
pickedImage = { width: 3500, height: 2500, mimeType: 'image/png', byteSize: 2 * 1024 * 1024 };
const editingImage = await normalization.prepareBubbleDraftImage('file:///picker.png', 'background');
assert.equal(editingImage.width, 1024);
assert.equal(temporaryImages.size, 1, '会话保留缓存副本，适配中间图已释放');
assert.ok(temporaryImages.has(editingImage.uri));
await editingImage.dispose();
assert.equal(temporaryImages.size, 0);

// 装饰的输入字节预算在读取内容前裁决；显示用副本单独限制像素，避免压缩小但解码大的 PNG。
pickedImage = { width: 2048, height: 1024, mimeType: 'image/png', byteSize: 2 * 1024 * 1024 };
const decoration = await normalization.prepareBubbleDraftImage('file:///decoration.png', 'decoration');
assert.equal(decoration.width, 512);
assert.equal(decoration.height, 256);
assert.equal(temporaryImages.size, 1);
assert.equal(temporaryImages.get(decoration.uri).format, 'png');
await decoration.dispose();
assert.equal(temporaryImages.size, 0, '装饰适配中间图与会话副本都由各自的所有者释放');
pickedImage = { ...pickedImage, width: 128, height: 256 };
const smallDecoration = await normalization.prepareBubbleSkinImport('file:///small-decoration.png', 'decoration');
assert.equal(smallDecoration.uri, 'file:///small-decoration.png', '小装饰不重编码或放大');
await smallDecoration.dispose();
const readsBeforeLimit = imageReads;
pickedImage = { ...pickedImage, byteSize: 2 * 1024 * 1024 + 1 };
await assert.rejects(normalization.prepareBubbleDraftImage('file:///oversized-decoration.png', 'decoration'), /2 MiB/);
assert.equal(imageReads, readsBeforeLimit, '超限装饰在读入字节及解码前拒绝');
pickedImage = { ...pickedImage, byteSize: 1024 };
animatedImage = true;
await assert.rejects(normalization.prepareBubbleDraftImage('file:///animated-decoration.png', 'decoration'), /静态 PNG/);
animatedImage = false;

const domain = load('src/features/chat/appearance/domain/ChatBubbleSkin.ts');
const { defaultBubbleSkinConfig, parseBubbleSkinConfig } = domain;
const config = defaultBubbleSkinConfig(120, 90);
assert.deepEqual(config.slices, { left: 0, right: 0, top: 0, bottom: 0 });
assert.deepEqual(config.padding, { left: 10, right: 10, top: 8, bottom: 8 });
assert.deepEqual(parseBubbleSkinConfig(config, 120, 90), config);
assert.deepEqual(parseBubbleSkinConfig({ ...config, textColor: '#123456' }, 120, 90), config,
  '旧组合字色在持久化边界不再进入当前配置，主题拥有唯一字色来源');
assert.equal(defaultBubbleSkinConfig(240, 180).scale * 240, config.scale * 120, '同一图案的不同分辨率按相同显示标尺导入');
assert.notDeepEqual(config.padding, config.slices, '留白与切线是独立配置');
assert.deepEqual(parseBubbleSkinConfig({ ...config, slices: { ...config.slices, uri: 'file:///other.png' } }, 120, 90), config,
  'SQLite JSON 边界只保留已声明的配置字段，不能覆盖渲染素材身份');
assert.throws(() => parseBubbleSkinConfig({ ...config, slices: { ...config.slices, left: 120 } }, 120, 90));
assert.throws(() => parseBubbleSkinConfig({ ...config, scale: NaN }, 120, 90));
assert.throws(() => parseBubbleSkinConfig({ ...config, padding: { ...config.padding, top: -1 } }, 120, 90));
const outsideDecoration = { ...domain.DEFAULT_BUBBLE_DECORATION_CONFIG, offsetX: -180, offsetY: 240 };
assert.deepEqual(domain.parseBubbleDecorationConfig(outsideDecoration), outsideDecoration);
for (const offset of [NaN, Infinity, -Infinity]) {
  assert.throws(() => domain.parseBubbleDecorationConfig({ ...outsideDecoration, offsetX: offset }));
}
assert.deepEqual(domain.bubblePaddingOutsideFrame(config), config.padding, '零固定边框不会改变默认文字留白');

function removeModelServiceSchema(database) {
  for (const table of ['auxiliary_model_configs', 'ai_assistants', 'group_chat_admin_configs']) {
    database.exec(`ALTER TABLE ${table} DROP COLUMN service_config_id;`);
  }
  database.exec('DROP TABLE model_service_configs; DROP TABLE model_service_settings;');
}

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
const executor = createSqliteExecutor(db);
await bootstrapSqlite(executor);
const coordinator = {
  read: async (_options, task) => task(executor),
  transaction: async (_options, task) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = await task(executor); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  },
};
const { SQLiteChatBubbleSkinRepository } = load('src/features/chat/appearance/infrastructure/SQLiteChatBubbleSkinRepository.ts', {
  '@platform/persistence': { databaseCoordinator: coordinator }, '../domain/ChatBubbleSkin': domain,
});
const { SQLiteMediaAssetRepository } = load('src/features/media/infrastructure/SQLiteMediaAssetRepository.ts');
const repository = new SQLiteChatBubbleSkinRepository();
const media = new SQLiteMediaAssetRepository(executor);
for (const version of [151, 152]) {
  const legacy = new DatabaseSync(':memory:');
  const legacyExecutor = createSqliteExecutor(legacy);
  await bootstrapSqlite(legacyExecutor);
  removeModelServiceSchema(legacy);
  legacy.exec(`DROP TABLE chat_bubble_selections; DROP TABLE chat_bubble_preset_decorations; DROP TABLE chat_bubble_presets;
    CREATE TABLE chat_bubble_skins (role TEXT PRIMARY KEY, media_asset_id TEXT, width INTEGER, height INTEGER, config_json TEXT);
    PRAGMA user_version = ${version};`);
  assert.deepEqual(await media.listBackupAssets(legacyExecutor), [], '无饰品表的旧备份可正常预检');
  await bootstrapSqlite(legacyExecutor);
  assert.equal(legacy.prepare('SELECT COUNT(*) AS total FROM chat_bubble_presets').get().total, 0);
  legacy.close();
}
const dimensions = new Map();
function insertAsset(id, width = 120, height = 90) {
  db.prepare(`INSERT INTO media_assets (id,storage_backend,storage_key,hash_algorithm,content_hash,mime_type,
    byte_size,width,height,duration_ms,status,created_at,updated_at)
    VALUES (?, 'persistent-media', ?, 'sha256', ?, 'image/png', 128, ?, ?, NULL, 'ready', 'now', 'now')`)
    .run(id, `catalog/media/${id}.png`, 'a'.repeat(64), width, height);
  dimensions.set(id, { width, height });
}
insertAsset('skin-a'); insertAsset('logo-asset');
// 153 真实结构升级到收藏：旧皮肤和饰品的媒体身份、配置、顺序均保留。
removeModelServiceSchema(db);
db.exec(`DROP TABLE chat_bubble_selections; DROP TABLE chat_bubble_preset_decorations; DROP TABLE chat_bubble_presets;
  CREATE TABLE chat_bubble_skins (role TEXT PRIMARY KEY, media_asset_id TEXT REFERENCES media_assets(id), width INTEGER, height INTEGER, config_json TEXT);
  CREATE TABLE chat_bubble_decorations (id TEXT PRIMARY KEY, role TEXT REFERENCES chat_bubble_skins(role) ON DELETE CASCADE,
    media_asset_id TEXT REFERENCES media_assets(id), width INTEGER, height INTEGER, config_json TEXT);
  PRAGMA user_version = 153;`);
db.prepare('INSERT INTO chat_bubble_skins VALUES (?, ?, 120, 90, ?)').run('user', 'skin-a', JSON.stringify(config));
db.prepare('INSERT INTO chat_bubble_decorations VALUES (?, ?, ?, 120, 90, ?)').run('logo', 'user', 'logo-asset', JSON.stringify(domain.DEFAULT_BUBBLE_DECORATION_CONFIG));
assert.deepEqual((await media.listBackupAssets(executor)).map(asset => asset.id).sort(), ['logo-asset', 'skin-a'], '旧备份仍按旧表枚举');
await bootstrapSqlite(executor);
const migrated = await repository.list();
assert.equal(migrated.selected.user, 'migrated-user');
assert.equal(migrated.presets[0].role, 'user');
assert.equal(migrated.presets[0].decorations[0].slot, 0);
assert.equal(migrated.presets[0].decorations[0].mediaAssetId, 'logo-asset');
assert.deepEqual(migrated.presets[0].config, config);
assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='chat_bubble_skins'").get(), undefined, '迁移完成删除旧事实路径');
const preset = migrated.presets[0];
assert.equal(preset.textColor, domain.DEFAULT_BUBBLE_TEXT_COLORS.user, '旧组合补足自己的字色');
await repository.setTextColor(preset.id, '#112233');
const moved = { ...preset, name: '海蓝气泡', config: { ...config, padding: { ...config.padding, left: 24 } },
  decorations: [{ ...preset.decorations[0], slot: 3, config: { anchor: 'top-right', size: 96, offsetX: -180, offsetY: -90 } }] };
await coordinator.transaction({}, tx => repository.save(tx, moved));
assert.equal((await repository.list()).presets[0].textColor, '#112233', '结构草稿不能覆盖另一入口刚提交的字色');
assert.equal((await repository.list()).presets[0].revision, 2);
assert.deepEqual((await repository.list()).presets[0].decorations[0].config, moved.decorations[0].config, '重新读取保留实际破形偏移');
await assert.rejects(coordinator.transaction({}, tx => repository.save(tx, moved)), /已被修改/);
assert.equal((await repository.list()).presets[0].name, '海蓝气泡');
const updated = (await repository.list()).presets[0];
await assert.rejects(coordinator.transaction({}, tx => repository.save(tx, { ...updated,
  name: '不应提交', decorations: [updated.decorations[0], { ...updated.decorations[0], id: 'duplicate-slot' }] })), /UNIQUE/);
assert.equal((await repository.list()).presets[0].name, '海蓝气泡', '饰品槽冲突回滚整个作品及选择');
assert.equal((await repository.list()).selected.ai, null);
await coordinator.transaction({}, tx => repository.save(tx, { ...preset, id: 'second', role: 'ai', revision: 0, name: '另一款', decorations: [] }));
await assert.rejects(repository.select('user', 'second'), /FOREIGN KEY/, '持久化边界禁止跨侧选择');
await assert.rejects(coordinator.transaction({}, tx => repository.save(tx, { ...updated, role: 'ai' })), /已被修改/, '已有组合不能改变归属');
await repository.select('user', null);
assert.equal((await repository.list()).presets.length, 2, '恢复默认保留全部收藏和引用');
assert.deepEqual((await media.listBackupAssets(executor)).map(asset => asset.id).sort(), ['logo-asset', 'skin-a']);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-backup-'));
try {
  const snapshotPath = path.join(directory, 'snapshot.db');
  db.exec(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`);
  const backup = new DatabaseSync(snapshotPath);
  assert.deepEqual((await repository.remove(preset.id)).sort(), ['logo-asset', 'skin-a']);
  assert.deepEqual((await media.listBackupAssets(executor)).map(asset => asset.id), ['skin-a'], '另一个组合仍引用同一底图');
  assert.deepEqual((await media.listBackupAssets(createSqliteExecutor(backup))).map(asset => asset.id).sort(), ['logo-asset', 'skin-a']);
  assert.equal(backup.prepare('SELECT slot FROM chat_bubble_preset_decorations').get().slot, 3, '备份保留有空位的四槽位置');
  backup.close();
} finally { fs.rmSync(directory, { recursive: true }); }
await repository.remove('second');
await coordinator.transaction({}, tx => repository.save(tx, { ...preset, revision: 0 }));

// 两侧作品各自独立；草稿只有保存时才物化媒体，事务失败不改变已启用作品。
const released = [];
let blockDecoding = true;
let decodeResolve;
const decoding = new Promise(resolve => { decodeResolve = resolve; });
let serial = 0;
let rollbackCleanup = 0;
let finalized = 0;
const runtime = load('src/features/chat/appearance/application/ChatBubbleSkinRuntime.ts', {
  '@platform/device': { createRandomUUID: () => `new-preset-${++serial}` },
  '@platform/persistence': { databaseCoordinator: coordinator },
  '@features/media': {
    resolveMediaAsset: async id => ({ localUri: `file:///persistent/${id}.png` }),
    releaseMediaAssetCandidates: async ids => { released.push(...ids); },
    MEDIA_ASSET_STORAGE_BACKEND: { persistentMedia: 'persistent-media' },
    prepareMediaAssetBatch: async inputs => ({
      async commitInTransaction() {
        return { assets: inputs.map(input => {
          const id = `imported-${++serial}`; insertAsset(id, input.width, input.height); return { id };
        }) };
      },
      async discardAfterRollback() { rollbackCleanup++; },
      async finalizeAfterCommit() { finalized++; },
    }),
  },
  '@platform/device/MessageBubbleBackground': { prepareBubbleImage: async uri => {
    if (blockDecoding) await decoding;
    const id = uri.split('/').at(-1).slice(0, -4);
    return dimensions.get(id);
  } },
  '@shared/runtime/RuntimeSlot': { createRuntimeSlot: () => { let value; return { configure: input => { value = input; }, get: () => value }; } },
  '../domain/ChatBubbleSkin': domain,
});
runtime.configureChatBubbleSkins(repository);
const firstLoad = runtime.loadChatBubbleSkins();
assert.equal(firstLoad, runtime.loadChatBubbleSkins(), '同时挂载的消息合并加载');
assert.equal(runtime.getBubbleSkinSnapshot().user, null, '解码完成前不发布皮肤');
decodeResolve(); blockDecoding = false; await firstLoad;
assert.equal(runtime.getBubbleSkinSnapshot().user.uri, 'file:///persistent/skin-a.png');
let draft = await runtime.openBubbleSkinDraft('ai', null);
assert.equal(draft.image, null);
draft = { ...draft, image: { mediaAssetId: null, uri: 'file:///cache/new.png', width: 120, height: 90 } };
assert.equal(runtime.getBubbleSkinSnapshot().presets.length, 1, '编辑草稿不提前改变收藏');
await runtime.saveBubbleSkinDraft(draft);
assert.equal(finalized, 1);
assert.equal(runtime.getBubbleSkinSnapshot().presets.length, 2);
assert.equal(runtime.getBubbleSkinSnapshot().ai.id, draft.id);
const saved = await runtime.openBubbleSkinDraft('ai', draft.id);
assert.ok(saved.image.mediaAssetId, '再次打开使用持久身份');
const userId = runtime.getBubbleSkinSnapshot().user.id;
await assert.rejects(runtime.selectChatBubblePreset('user', draft.id), /FOREIGN KEY/);
await assert.rejects(runtime.openBubbleSkinDraft('user', draft.id), /不存在/);
assert.equal(runtime.getBubbleSkinSnapshot().user.id, userId);
await runtime.setChatBubblePresetTextColor(saved.id, '#102030');
await runtime.setChatBubblePresetTextColor(saved.id, '#405060');
await runtime.saveBubbleSkinDraft(saved);
assert.equal(Object.hasOwn(runtime.getBubbleSkinSnapshot().user.config, 'textColor'), false);
assert.equal(runtime.getBubbleSkinSnapshot().ai.textColor, '#405060', '最新字色胜出，保存旧结构草稿也不会覆盖它');
assert.equal(runtime.getBubbleSkinSnapshot().user.textColor, domain.DEFAULT_BUBBLE_TEXT_COLORS.user, '改色只影响所属组合');
assert.equal(JSON.parse(db.prepare('SELECT config_json FROM chat_bubble_presets WHERE id = ?').get(saved.id).config_json).textColor, '#405060');
await assert.rejects(runtime.setChatBubblePresetTextColor(saved.id, 'red'), /颜色无效/);
const stale = { ...saved, revision: 999, image: { ...draft.image } };
await assert.rejects(runtime.saveBubbleSkinDraft(stale), /已被修改/);
assert.equal(rollbackCleanup, 1);
assert.equal(db.prepare("SELECT COUNT(*) AS total FROM media_assets WHERE id LIKE 'imported-%'").get().total, 1, '失败事务没有半成品');
runtime.reportBubbleSkinLoadError('file:///stale.png', 'stale');
assert.ok(runtime.getBubbleSkinSnapshot().user.uri);
runtime.reportBubbleSkinLoadError(runtime.getBubbleSkinSnapshot().ai.uri, 'missing');
assert.ok(runtime.getBubbleSkinSnapshot().user.uri, '不同文件不受影响');
assert.equal(runtime.getBubbleSkinSnapshot().ai.uri, null);
await runtime.selectChatBubblePreset('user', null);
assert.equal(runtime.getBubbleSkinSnapshot().user, null);
assert.equal(runtime.getBubbleSkinSnapshot().presets.length, 2);
await runtime.removeChatBubblePreset(draft.id);
assert.equal(runtime.getBubbleSkinSnapshot().ai, null, '删除作品撤销对应选择');
assert.ok(released.some(id => id.startsWith('imported-')));
db.close();

// 154 的共享作品迁为各侧独立副本，未启用收藏与空槽也不能丢失。
const shared = new DatabaseSync(':memory:');
shared.exec('PRAGMA foreign_keys = ON');
const sharedExecutor = createSqliteExecutor(shared);
await bootstrapSqlite(sharedExecutor);
removeModelServiceSchema(shared);
shared.exec(`DROP TABLE chat_bubble_selections; DROP TABLE chat_bubble_preset_decorations; DROP TABLE chat_bubble_presets;
  CREATE TABLE chat_bubble_presets (id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL,
    media_asset_id TEXT NOT NULL REFERENCES media_assets(id), width INTEGER, height INTEGER, config_json TEXT);
  CREATE TABLE chat_bubble_preset_decorations (id TEXT PRIMARY KEY, preset_id TEXT REFERENCES chat_bubble_presets(id) ON DELETE CASCADE,
    slot INTEGER, media_asset_id TEXT REFERENCES media_assets(id), width INTEGER, height INTEGER, config_json TEXT, UNIQUE(preset_id, slot));
  CREATE TABLE chat_bubble_selections (role TEXT PRIMARY KEY, preset_id TEXT REFERENCES chat_bubble_presets(id) ON DELETE CASCADE);
  INSERT INTO media_assets (id, storage_backend, storage_key, hash_algorithm, content_hash, mime_type, byte_size, width, height, status, created_at, updated_at)
    VALUES ('shared-image', 'persistent-media', 'shared.png', 'sha256', '${'a'.repeat(64)}', 'image/png', 128, 120, 90, 'ready', 'now', 'now');
  PRAGMA user_version = 154;`);
for (const id of ['shared', 'unused']) shared.prepare('INSERT INTO chat_bubble_presets VALUES (?, ?, 3, ?, 120, 90, ?)')
  .run(id, id, 'shared-image', JSON.stringify(config));
shared.prepare('INSERT INTO chat_bubble_preset_decorations VALUES (?, ?, 3, ?, 120, 90, ?)')
  .run('decoration', 'shared', 'shared-image', JSON.stringify(domain.DEFAULT_BUBBLE_DECORATION_CONFIG));
shared.exec("INSERT INTO chat_bubble_selections VALUES ('user', 'shared'), ('ai', 'shared')");
await assert.rejects(bootstrapSqlite({ ...sharedExecutor, execAsync: async sql => {
  if (sql.includes('DROP TABLE chat_bubble_shared_presets')) throw new Error('组合迁移提交失败');
  return sharedExecutor.execAsync(sql);
} }), /组合迁移提交失败/);
assert.equal(shared.prepare('PRAGMA user_version').get().user_version, 154);
assert.equal(shared.prepare('PRAGMA table_info(chat_bubble_presets)').all().some(column => column.name === 'role'), false);
assert.deepEqual(shared.prepare('SELECT preset_id FROM chat_bubble_selections').all().map(row => row.preset_id), ['shared', 'shared']);
await bootstrapSqlite(sharedExecutor);
assert.deepEqual(shared.prepare('PRAGMA foreign_key_check').all(), []);
assert.equal(shared.prepare('SELECT COUNT(*) AS n FROM chat_bubble_presets').get().n, 4);
assert.equal(shared.prepare('SELECT COUNT(*) AS n FROM chat_bubble_preset_decorations WHERE slot = 3').get().n, 2);
const selections = shared.prepare('SELECT * FROM chat_bubble_selections ORDER BY role').all();
assert.deepEqual(selections.map(row => [row.role, row.preset_id]), [['ai', 'ai:shared'], ['user', 'user:shared']]);
shared.exec("UPDATE chat_bubble_presets SET name = 'changed' WHERE id = 'user:shared'");
assert.equal(shared.prepare("SELECT name FROM chat_bubble_presets WHERE id = 'ai:shared'").get().name, 'shared');
shared.exec("DELETE FROM chat_bubble_presets WHERE id = 'user:shared'");
assert.equal(shared.prepare('SELECT * FROM chat_bubble_selections').get().role, 'ai');
assert.equal((await media.listBackupAssets(sharedExecutor)).length, 1, '独立作品继续共享媒体引用，不重复打包文件');
await bootstrapSqlite(sharedExecutor);
assert.equal(shared.prepare('SELECT COUNT(*) AS n FROM chat_bubble_presets').get().n, 3, '重复启动不会重新复制组合');
// 155 的独立组合升级时，只为缺少颜色的作品补值，已有颜色及选择保持不变。
removeModelServiceSchema(shared);
shared.exec(`PRAGMA user_version = 155;
  UPDATE chat_bubble_presets SET config_json = json_set(config_json, '$.textColor', '#123456') WHERE id = 'ai:shared';
  UPDATE chat_bubble_presets SET config_json = json_remove(config_json, '$.textColor') WHERE id <> 'ai:shared';`);
await bootstrapSqlite(sharedExecutor);
assert.equal(JSON.parse(shared.prepare("SELECT config_json FROM chat_bubble_presets WHERE id = 'ai:shared'").get().config_json).textColor, '#123456');
assert.equal(JSON.parse(shared.prepare("SELECT config_json FROM chat_bubble_presets WHERE id = 'ai:unused'").get().config_json).textColor, '#1C1C1E');
assert.equal(JSON.parse(shared.prepare("SELECT config_json FROM chat_bubble_presets WHERE id = 'user:unused'").get().config_json).textColor, '#FFFFFF');
assert.equal(shared.prepare('SELECT * FROM chat_bubble_selections').get().preset_id, 'ai:shared');
shared.close();
console.log('DIY 气泡：大图适配、单侧归属、共享收藏迁移、媒体引用、四槽、CAS、备份与草稿提交验证通过。');
