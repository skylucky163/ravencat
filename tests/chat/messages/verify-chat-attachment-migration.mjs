/** M3a migration application 的行为测试；只验证迁移契约，不匹配源码形状。 */

import { repoRoot as repositoryRoot } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';


const migrationSourcePath = path.join(
  repositoryRoot,
  'src/features/chat/messages/application/MigrateLegacyChatAttachments.ts',
);

function loadMigrationModule() {
  const source = fs.readFileSync(migrationSourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: migrationSourcePath,
  }).outputText;
  const module = { exports: {} };
  // 共享 MIME 表按真实模块载入，迁移行为仍由当前 application 执行。
  const mimeModule = { exports: {} };
  const mimeSource = fs.readFileSync(path.join(repositoryRoot, 'src/features/chat/messages/application/ChatAttachmentMime.ts'), 'utf8');
  new Function('module', 'exports', ts.transpileModule(mimeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(mimeModule, mimeModule.exports);
  new Function('module', 'exports', 'require', compiled)(module, module.exports, () => mimeModule.exports);
  return module.exports;
}

const { MigrateLegacyChatAttachments } = loadMigrationModule();

function createDependencies(candidates, options = {}) {
  const metadataById = new Map(candidates.map((candidate) => [
    candidate.messageId,
    candidate.metadataJson,
  ]));
  const adoptionCalls = [];
  const locationCalls = [];
  let nextAsset = 1;

  const messages = {
    async listChatAttachmentMetadataCandidates(params) {
      return candidates
        .filter((candidate) => (
          params.afterMessageId === null
          || params.afterMessageId === undefined
          || candidate.messageId > params.afterMessageId
        ))
        .slice(0, params.limit);
    },
    async compareAndSwapMetadataJsonInTransaction(_transaction, input) {
      const current = metadataById.get(input.messageId);
      if (options.casFailureFor === input.messageId || current !== input.expectedMetadataJson) {
        throw new Error(`CAS conflict for ${input.messageId}`);
      }
      metadataById.set(input.messageId, input.metadataJson);
    },
  };

  const mediaAssets = {
    async locateLegacyChatFile(localUri, attachmentType) {
      locationCalls.push({ localUri, attachmentType });
      if (options.unavailableUris?.has(localUri)) {
        return null;
      }
      return {
        storageBackend: 'persistent-media',
        storageKey: `chat/${attachmentType}/${localUri.replaceAll(/[^a-z0-9]/giu, '_')}`,
        localUri,
      };
    },
    async adoptLegacyChatFiles(inputs, commit) {
      adoptionCalls.push(inputs.map((input) => ({ ...input })));
      const assets = inputs.map((input) => ({
        id: `asset-${nextAsset++}`,
        storageBackend: input.storageBackend,
        storageKey: input.storageKey,
        hashAlgorithm: 'sha256',
        contentHash: '0'.repeat(64),
        mimeType: input.mimeType,
        byteSize: 1,
        width: input.width,
        height: input.height,
        durationMs: input.durationMs,
        status: 'ready',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }));
      await commit({}, assets);
      return assets;
    },
  };

  return {
    dependencies: { messages, mediaAssets },
    metadataById,
    adoptionCalls,
    locationCalls,
  };
}

function imageAttachment(localUri, overrides = {}) {
  return {
    id: 'image-1',
    type: 'image',
    source: 'gallery',
    localUri,
    fileName: 'photo.jpg',
    mimeType: 'image/jpeg',
    width: 640,
    height: 480,
    ...overrides,
  };
}

function fileAttachment(localUri, overrides = {}) {
  return {
    id: 'file-1',
    type: 'file',
    source: 'document',
    localUri,
    fileName: 'notes.txt',
    mimeType: null,
    parseStatus: 'success',
    parsedText: 'keep this text',
    previewText: 'keep this preview',
    ...overrides,
  };
}

test('同一消息中的图片、缩略图和文本文件批量接管并原地 CAS', async () => {
  const metadataJson = JSON.stringify({
    kind: 'mixed',
    helper: { kind: 'primary_reply' },
    attachments: [
      imageAttachment('file://photo.jpg', { thumbnailUri: 'file://photo.jpg' }),
      fileAttachment('file://notes.txt'),
    ],
  });
  const fixture = createDependencies([{ messageId: 10, sessionId: 'session-a', metadataJson }]);
  const migration = new MigrateLegacyChatAttachments(fixture.dependencies);

  const result = await migration.execute({ pageSize: 1 });
  const migrated = JSON.parse(fixture.metadataById.get(10));

  assert.deepEqual(result, {
    scannedMessages: 1,
    migratedMessages: 1,
    skippedMessages: 0,
    unresolvedMessages: 0,
    migratedAttachments: 2,
    adoptedAssets: 2,
    sessionIds: ['session-a'],
    issues: [],
  });
  assert.equal(fixture.adoptionCalls.length, 1);
  assert.equal(fixture.adoptionCalls[0].length, 2, '同 URI 的 local/thumbnail 只接管一次');
  assert.equal(fixture.locationCalls.length, 2);
  assert.equal(migrated.helper.kind, 'primary_reply');
  assert.equal(migrated.attachments[0].mediaAssetId, 'asset-1');
  assert.equal(migrated.attachments[0].thumbnailMediaAssetId, 'asset-1');
  assert.equal(migrated.attachments[1].mediaAssetId, 'asset-2');
  assert.equal('localUri' in migrated.attachments[0], false);
  assert.equal('thumbnailUri' in migrated.attachments[0], false);
  assert.equal(migrated.attachments[1].parsedText, 'keep this text');
  assert.equal(migrated.attachments[1].previewText, 'keep this preview');
});

test('不同缩略图 URI 必须按自身扩展名确定 MIME', async () => {
  const metadataJson = JSON.stringify({
    attachments: [imageAttachment('file://photo.jpg', { thumbnailUri: 'file://thumb.png' })],
  });
  const fixture = createDependencies([{ messageId: 11, sessionId: 'session-thumb', metadataJson }]);
  const migration = new MigrateLegacyChatAttachments(fixture.dependencies);

  const result = await migration.execute();

  assert.equal(result.migratedMessages, 1);
  assert.deepEqual(
    fixture.adoptionCalls[0].map((input) => input.mimeType),
    ['image/jpeg', 'image/png'],
  );
});

test('坏 JSON、远程 URI、不可定位文件和 MIME 不确定消息 unresolved，但继续后续页', async () => {
  const unavailableUri = 'file://missing.txt';
  const fixture = createDependencies([
    { messageId: 1, sessionId: 'bad-json', metadataJson: '{broken' },
    {
      messageId: 2,
      sessionId: 'remote',
      metadataJson: JSON.stringify({ attachments: [imageAttachment('https://example.test/photo.jpg')] }),
    },
    {
      messageId: 3,
      sessionId: 'missing',
      metadataJson: JSON.stringify({ attachments: [fileAttachment(unavailableUri)] }),
    },
    {
      messageId: 4,
      sessionId: 'unknown-mime',
      metadataJson: JSON.stringify({ attachments: [imageAttachment('file://photo.bin', {
        fileName: 'photo.bin',
        mimeType: null,
      })] }),
    },
    {
      messageId: 5,
      sessionId: 'good',
      metadataJson: JSON.stringify({ attachments: [fileAttachment('file://good.csv', {
        fileName: 'good.csv',
      })] }),
    },
  ], { unavailableUris: new Set([unavailableUri]) });
  const migration = new MigrateLegacyChatAttachments(fixture.dependencies);

  const result = await migration.execute({ pageSize: 2 });

  assert.equal(result.scannedMessages, 5);
  assert.equal(result.migratedMessages, 1);
  assert.equal(result.unresolvedMessages, 4);
  assert.deepEqual(result.sessionIds, ['good']);
  assert.deepEqual(result.issues.map((issue) => issue.reason), [
    'invalid_json',
    'remote_uri',
    'legacy_file_unavailable',
    'mime_unknown',
  ]);
  assert.equal(fixture.adoptionCalls.length, 1);
});

test('asset-only 消息幂等跳过；CAS 失败时不报告迁移成功', async () => {
  const canonicalJson = JSON.stringify({
    kind: 'image',
    attachments: [{
      id: 'image-1',
      type: 'image',
      source: 'gallery',
      fileName: 'photo.jpg',
      mediaAssetId: 'asset-existing',
    }],
  });
  const legacyJson = JSON.stringify({ attachments: [imageAttachment('file://race.jpg')] });
  const fixture = createDependencies([
    { messageId: 6, sessionId: 'canonical', metadataJson: canonicalJson },
    { messageId: 7, sessionId: 'race', metadataJson: legacyJson },
  ], { casFailureFor: 7 });
  const migration = new MigrateLegacyChatAttachments(fixture.dependencies);

  const result = await migration.execute({ pageSize: 10 });

  assert.equal(result.skippedMessages, 1);
  assert.equal(result.unresolvedMessages, 1);
  assert.equal(result.migratedMessages, 0);
  assert.equal(fixture.metadataById.get(7), legacyJson);
  assert.equal(fixture.adoptionCalls.length, 1);
  assert.equal(result.issues[0].reason, 'commit_failed');
});

console.log('Chat attachment migration behavior tests passed.');
