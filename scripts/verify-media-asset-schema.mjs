/** MediaAsset schema 的可执行 SQLite contract 验证。 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaSource = fs.readFileSync(
  path.join(ROOT, 'src/platform/persistence/sqlite/mediaAssetSchema.ts'),
  'utf8',
);
const transpiledSchema = ts.transpileModule(schemaSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const schemaModuleUrl = `data:text/javascript;base64,${Buffer.from(transpiledSchema).toString('base64')}`;
const {
  MEDIA_ASSET_CONTENT_HASH_INDEX,
  MEDIA_ASSET_SCHEMA,
} = await import(schemaModuleUrl);

function insertAsset(db, overrides = {}) {
  const asset = {
    id: 'media-1',
    storageBackend: 'persistent-media',
    storageKey: 'chat/images/media-1.webp',
    hashAlgorithm: 'sha256',
    contentHash: 'a'.repeat(64),
    mimeType: 'image/webp',
    byteSize: 12,
    width: 100,
    height: 80,
    durationMs: null,
    status: 'ready',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
    ...overrides,
  };
  db.prepare(`
    INSERT INTO media_assets (
      id, storage_backend, storage_key, hash_algorithm, content_hash,
      mime_type, byte_size, width, height, duration_ms, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    asset.id,
    asset.storageBackend,
    asset.storageKey,
    asset.hashAlgorithm,
    asset.contentHash,
    asset.mimeType,
    asset.byteSize,
    asset.width,
    asset.height,
    asset.durationMs,
    asset.status,
    asset.createdAt,
    asset.updatedAt,
  );
}

const db = new DatabaseSync(':memory:');
db.exec(MEDIA_ASSET_SCHEMA);
db.exec(MEDIA_ASSET_CONTENT_HASH_INDEX);
db.exec(MEDIA_ASSET_SCHEMA);
db.exec(MEDIA_ASSET_CONTENT_HASH_INDEX);

insertAsset(db);
insertAsset(db, {
  id: 'media-2',
  storageBackend: 'persistent-image',
  storageKey: 'skins/media-2.webp',
  status: 'missing',
});

assert.equal(
  db.prepare('SELECT COUNT(*) AS count FROM media_assets').get().count,
  2,
  '相同 SHA-256 必须允许存在于不同 backing 的资产行',
);
assert.throws(
  () => insertAsset(db, { id: 'bad-uri', storageKey: 'file:///absolute.webp' }),
  /CHECK constraint failed/,
  'storage_key 必须拒绝绝对 URI',
);
assert.throws(
  () => insertAsset(db, { id: 'bad-path', storageKey: 'C:\\absolute.webp' }),
  /CHECK constraint failed/,
  'storage_key 必须拒绝带盘符的绝对路径',
);
assert.throws(
  () => insertAsset(db, { id: 'bad-traversal', storageKey: '../outside.webp' }),
  /CHECK constraint failed/,
  'storage_key 不得越出 backing 命名空间',
);
assert.throws(
  () => insertAsset(db, { id: 'bad-hash', contentHash: 'A'.repeat(64) }),
  /CHECK constraint failed/,
  'content_hash 必须是 64 位小写十六进制 SHA-256',
);
assert.throws(
  () => insertAsset(db, { id: 'bad-algorithm', hashAlgorithm: 'md5' }),
  /CHECK constraint failed/,
  '第一版必须拒绝 SHA-256 之外的 Hash 算法',
);
assert.throws(
  () => insertAsset(db, { id: 'bad-status', status: 'pending' }),
  /CHECK constraint failed/,
  '第一版必须拒绝 ready/missing 之外的状态',
);
assert.throws(
  () => insertAsset(db, { id: 'bad-size', byteSize: -1 }),
  /CHECK constraint failed/,
  'byte_size 不得为负数',
);
assert.throws(
  () => insertAsset(db, { id: 'bad-width', width: 0 }),
  /CHECK constraint failed/,
  '已知图片尺寸必须大于零',
);
assert.throws(
  () => insertAsset(db, { id: 'bad-duration', durationMs: -1 }),
  /CHECK constraint failed/,
  '已知媒体时长不得为负数',
);
assert.throws(
  () => insertAsset(db, {
    id: 'duplicate-locator',
    storageBackend: 'persistent-media',
    storageKey: 'chat/images/media-1.webp',
    contentHash: 'b'.repeat(64),
  }),
  /UNIQUE constraint failed/,
  '同一 backing locator 只能对应一个资产身份',
);

const indexes = db.prepare(`PRAGMA index_list('media_assets')`).all();
const hashIndex = indexes.find((index) => index.name === 'idx_media_assets_content_hash');
assert.ok(hashIndex, '必须建立 Hash 候选查询索引');
assert.equal(hashIndex.unique, 0, 'Hash 候选索引不得是 UNIQUE');
assert.deepEqual(
  db.prepare(`PRAGMA index_info('idx_media_assets_content_hash')`).all()
    .map((column) => column.name),
  ['hash_algorithm', 'content_hash'],
  'Hash 候选索引的列顺序必须与查询 contract 一致',
);

console.log('MediaAsset schema contract：node:sqlite 验证通过。');
