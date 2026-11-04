/** MediaAsset M2 application/repository 的行为验证，不锁定源码形状。 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadTypeScriptModule(relativePath) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

function loadTypeScriptModuleWithMocks(relativePath, mocks) {
  const sourcePath = path.join(ROOT, relativePath);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const requireMock = (specifier) => {
    if (specifier === './MediaFileLifetime') return loadTypeScriptModuleWithMocks('src/platform/device/MediaFileLifetime.ts', {});
    if (specifier === './ChatAttachmentMime') return loadTypeScriptModuleWithMocks('src/features/chat/messages/application/ChatAttachmentMime.ts', {});
    assert.ok(Object.hasOwn(mocks, specifier), `未声明的运行时依赖：${specifier}`);
    return mocks[specifier];
  };
  new Function('exports', 'require', 'module', output)(module.exports, requireMock, module);
  return module.exports;
}

const mediaAssetBackingModule = await loadTypeScriptModule(
  'src/features/media/application/MediaAssetBacking.ts',
);
const {
  MediaAssetBackingNotFoundError,
  MediaAssetBackingRegistry,
} = mediaAssetBackingModule;
const mediaAssetCatalogModule = loadTypeScriptModuleWithMocks(
  'src/features/media/application/MediaAssetCatalog.ts',
  { './MediaAssetBacking': mediaAssetBackingModule },
);
const { MediaAssetCatalog, MediaAssetLocatorConflictError } = mediaAssetCatalogModule;
const { AdoptExistingMediaAssets } = await loadTypeScriptModule(
  'src/features/media/application/AdoptExistingMediaAssets.ts',
);
const {
  MediaAssetMissingError,
  MediaAssetNotFoundError,
  MediaAssetResolver,
} = loadTypeScriptModuleWithMocks(
  'src/features/media/application/MediaAssetResolver.ts',
  { './MediaAssetBacking': mediaAssetBackingModule },
);
const { CreateMediaAsset } = await loadTypeScriptModule(
  'src/features/media/application/CreateMediaAsset.ts',
);
const { SQLiteMediaAssetRepository } = await loadTypeScriptModule(
  'src/features/media/infrastructure/SQLiteMediaAssetRepository.ts',
);

function asset(overrides = {}) {
  return {
    id: 'media-existing',
    storageBackend: 'persistent-media',
    storageKey: 'catalog/media/existing.png',
    hashAlgorithm: 'sha256',
    contentHash: 'a'.repeat(64),
    mimeType: 'image/png',
    byteSize: 3,
    width: 20,
    height: 10,
    durationMs: null,
    status: 'ready',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
    ...overrides,
  };
}

{
  const row = {
    id: 'media-row',
    storage_backend: 'persistent-image',
    storage_key: 'catalog/images/row.jpg',
    hash_algorithm: 'sha256',
    content_hash: 'b'.repeat(64),
    mime_type: 'image/jpeg',
    byte_size: 42,
    width: 30,
    height: 40,
    duration_ms: null,
    status: 'ready',
    created_at: '2026-08-25T01:00:00.000Z',
    updated_at: '2026-08-25T01:00:00.000Z',
  };
  const database = { getFirstAsync: async () => row };
  const repository = new SQLiteMediaAssetRepository(database);
  const mapped = await repository.getById('media-row');
  assert.equal(mapped.storageBackend, 'persistent-image');
  assert.equal(mapped.storageKey, 'catalog/images/row.jpg');
  assert.equal(mapped.byteSize, 42);

  let updatedParams;
  await repository.updateStatusInTransaction({
    runAsync: async (_sql, params) => {
      updatedParams = params;
      return { changes: 1 };
    },
  }, {
    id: 'media-row',
    status: 'missing',
    updatedAt: '2026-08-25T02:00:00.000Z',
  });
  assert.deepEqual(updatedParams, [
    'missing',
    '2026-08-25T02:00:00.000Z',
    'media-row',
  ]);
  await assert.rejects(
    repository.updateStatusInTransaction({
      runAsync: async () => ({ changes: 0 }),
    }, {
      id: 'unknown',
      status: 'missing',
      updatedAt: '2026-08-25T02:00:00.000Z',
    }),
    /必须恰好影响一行/,
  );

  let locatorQuery;
  const locatorRepository = new SQLiteMediaAssetRepository({ getFirstAsync: async () => null });
  const locatorResult = await locatorRepository.getByStorageLocatorInTransaction({
    getAllAsync: async (_sql, params) => {
      locatorQuery = params;
      return [row];
    },
  }, {
    storageBackend: 'persistent-image',
    storageKey: 'catalog/images/row.jpg',
  });
  assert.equal(locatorResult.id, 'media-row');
  assert.deepEqual(locatorQuery, ['persistent-image', 'catalog/images/row.jpg']);
  await assert.rejects(
    locatorRepository.getByStorageLocatorInTransaction({
      getAllAsync: async () => [row, { ...row, id: 'media-duplicate' }],
    }, {
      storageBackend: 'persistent-image',
      storageKey: 'catalog/images/row.jpg',
    }),
    /locator 必须唯一/,
  );
}

{
  let created = null;
  const repository = {
    getById: async () => null,
    listHashCandidatesInTransaction: async () => [asset()],
    createInTransaction: async (_transaction, candidate) => {
      created = candidate;
    },
  };
  const catalog = new MediaAssetCatalog(repository);
  const reused = await catalog.selectOrCreateInTransaction({}, asset({ id: 'new-id' }), { available: [asset()], missing: [] });
  assert.equal(reused.reused, true);
  assert.equal(reused.asset.id, 'media-existing');
  assert.equal(created, null);

  const otherBackend = asset({
    id: 'other-backend',
    storageBackend: 'persistent-image',
    storageKey: 'catalog/images/other.png',
  });
  const inserted = await catalog.selectOrCreateInTransaction({}, otherBackend, { available: [asset()], missing: [] });
  assert.equal(inserted.reused, false);
  assert.equal(created, otherBackend, '不同 backend 的相同内容不得被强制复用');
}

{
  const existing = asset({ storageKey: 'chat/images/legacy.png' });
  const locatorRepository = {
    getByStorageLocatorInTransaction: async () => existing,
    listHashCandidatesInTransaction: async () => [],
    createInTransaction: async () => assert.fail('locator 已存在时不能重复插入'),
  };
  const catalog = new MediaAssetCatalog(locatorRepository);
  const adopted = await catalog.adoptExistingInTransaction({}, asset({
    id: 'new-id',
    storageKey: 'chat/images/legacy.png',
  }));
  assert.equal(adopted.reused, true);
  assert.equal(adopted.asset.id, existing.id);

  await assert.rejects(
    catalog.adoptExistingInTransaction({}, asset({
      id: 'new-id',
      storageKey: 'chat/images/legacy.png',
      byteSize: 99,
    })),
    (error) => {
      assert.ok(error instanceof MediaAssetLocatorConflictError);
      assert.equal(error.existing.id, existing.id);
      return true;
    },
  );

  const missingCatalog = new MediaAssetCatalog({
    ...locatorRepository,
    getByStorageLocatorInTransaction: async () => asset({
      storageKey: 'chat/images/legacy.png',
      status: 'missing',
    }),
  });
  await assert.rejects(
    missingCatalog.adoptExistingInTransaction({}, asset({
      id: 'new-id',
      storageKey: 'chat/images/legacy.png',
    })),
    MediaAssetLocatorConflictError,
  );
}

{
  const reused = asset({ storageKey: 'chat/images/first.png' });
  let created = null;
  const repository = {
    getByStorageLocatorInTransaction: async () => null,
    listHashCandidatesInTransaction: async () => [reused],
    createInTransaction: async (_transaction, candidate) => {
      created = candidate;
    },
  };
  const catalog = new MediaAssetCatalog(repository);
  const result = await catalog.adoptExistingInTransaction({}, asset({
    id: 'second-id',
    storageKey: 'chat/images/second.png',
  }), { available: [reused], missing: [] });
  assert.equal(result.reused, true);
  assert.equal(result.asset.id, reused.id);
  assert.equal(created, null, '同 backend、同 SHA-256、大小和 MIME 应复用不同路径内容');
}

{
  const inspected = [];
  const transactions = [];
  const adopted = new AdoptExistingMediaAssets({
    catalog: {
      inspectReuseCandidates: async () => ({ available: [], missing: [] }),
      adoptExistingInTransaction: async (_transaction, draft) => ({
        asset: { ...draft },
        reused: false,
      }),
    },
    contentInspector: {
      inspect: async (localUri) => {
        inspected.push(localUri);
        return {
          contentHash: localUri.endsWith('a.png') ? 'a'.repeat(64) : 'b'.repeat(64),
          byteSize: localUri.endsWith('a.png') ? 3 : 4,
        };
      },
    },
    database: {
      withExclusiveTransactionAsync: async (task) => task({ transaction: 'same' }),
    },
    generateId: (() => {
      let sequence = 0;
      return () => `media-${++sequence}`;
    })(),
    now: () => '2026-08-25T04:00:00.000Z',
  });
  const input = (name) => ({
    storageBackend: 'persistent-media',
    storageKey: `chat/images/${name}`,
    localUri: `file:///documents/persistent-media/chat/images/${name}`,
    mimeType: 'image/png',
    width: null,
    height: null,
    durationMs: null,
  });
  let callbackTransaction;
  const result = await adopted.execute([input('a.png'), input('b.png')], async ({
    transaction,
    entries,
    assets,
  }) => {
    callbackTransaction = transaction;
    assert.equal(entries.length, 2);
    assert.equal(assets.length, 2);
    transactions.push(entries.map(({ asset }) => asset.id));
    return 'committed';
  });
  assert.deepEqual(inspected, [
    'file:///documents/persistent-media/chat/images/a.png',
    'file:///documents/persistent-media/chat/images/b.png',
  ]);
  assert.deepEqual(result.assets.map(({ id }) => id), ['media-1', 'media-2']);
  assert.equal(callbackTransaction.transaction, 'same');
  assert.deepEqual(transactions, [['media-1', 'media-2']]);
}

{
  const writer = {
    storageBackend: 'persistent-media',
    prepare: async ({ assetId }) => ({
      storageBackend: 'persistent-media',
      storageKey: `catalog/media/${assetId}.png`,
      localUri: `file:///catalog/media/${assetId}.png`,
    }),
    resolve: async (storageKey) => ({ localUri: `file:///${storageKey}` }),
    commitPrepared: () => undefined,
    delete: async () => undefined,
    listCanonicalStorageKeys: async () => [],
  };
  const registry = new MediaAssetBackingRegistry({ writers: [writer] });
  assert.equal(registry.requireWriter('persistent-media'), writer);
  assert.throws(
    () => new MediaAssetBackingRegistry({ writers: [writer, writer] }),
    /重复注册/,
  );

  const resolver = new MediaAssetResolver(
    { getById: async () => asset() },
    registry,
  );
  const resolved = await resolver.resolve('media-existing');
  assert.equal(resolved.localUri, 'file:///catalog/media/existing.png');
  await assert.rejects(
    new MediaAssetResolver({ getById: async () => null }, registry).resolve('unknown'),
    MediaAssetNotFoundError,
  );
  await assert.rejects(
    new MediaAssetResolver({ getById: async () => asset({ status: 'missing' }) }, registry)
      .resolve('media-existing'),
    MediaAssetMissingError,
  );

  const backingMissing = new MediaAssetBackingNotFoundError(
    'persistent-media',
    'catalog/media/existing.png',
  );
  const missingRegistry = new MediaAssetBackingRegistry({
    writers: [{ ...writer, resolve: async () => { throw backingMissing; } }],
  });
  await assert.rejects(
    new MediaAssetResolver({ getById: async () => asset() }, missingRegistry)
      .resolve('media-existing'),
    (error) => {
      assert.ok(error instanceof MediaAssetMissingError);
      assert.equal(error.cause, backingMissing);
      return true;
    },
  );

  const backendFailure = new Error('backing unavailable');
  const failedRegistry = new MediaAssetBackingRegistry({
    writers: [{ ...writer, resolve: async () => { throw backendFailure; } }],
  });
  await assert.rejects(
    new MediaAssetResolver({ getById: async () => asset() }, failedRegistry)
      .resolve('media-existing'),
    (error) => error === backendFailure,
  );
}

{
  const fileSystem = {
    documentDirectory: 'file:///documents/',
    getInfoAsync: async (uri) => ({ exists: true, isDirectory: false, uri }),
  };
  const { PersistentMediaStore } = loadTypeScriptModuleWithMocks(
    'src/platform/device/PersistentMediaStore.ts',
    { 'expo-file-system/legacy': fileSystem },
  );
  const { PersistentImageStore } = loadTypeScriptModuleWithMocks(
    'src/platform/device/PersistentImageStore.ts',
    { 'expo-file-system/legacy': fileSystem },
  );
  assert.equal(
    await new PersistentMediaStore().resolveAssetStorageKey('chat/images/legacy.png'),
    'file:///documents/persistent-media/chat/images/legacy.png',
  );
  const persistentMediaStore = new PersistentMediaStore();
  assert.deepEqual(
    await persistentMediaStore.mapLegacyChatUriToAssetReference({
      uri: 'file:///documents/persistent-media/chat/images/legacy.png',
      category: 'chatImage',
    }),
    {
      storageKey: 'chat/images/legacy.png',
      localUri: 'file:///documents/persistent-media/chat/images/legacy.png',
    },
  );
  assert.deepEqual(
    await persistentMediaStore.mapLegacyChatUriToAssetReference({
      uri: 'persistent-media/chat/files/legacy.txt',
      category: 'chatFile',
    }),
    {
      storageKey: 'chat/files/legacy.txt',
      localUri: 'file:///documents/persistent-media/chat/files/legacy.txt',
    },
  );
  assert.deepEqual(
    await persistentMediaStore.mapLegacyChatUriToAssetReference({
      uri: '/documents/persistent-media/chat/images/legacy.png',
      category: 'chatImage',
    }),
    {
      storageKey: 'chat/images/legacy.png',
      localUri: 'file:///documents/persistent-media/chat/images/legacy.png',
    },
  );
  for (const uri of [
    'content://picked/legacy.png',
    'https://example.test/legacy.png',
    'bundle://legacy.png',
    'file:///documents/other/legacy.png',
    'file:///documents/persistent-media/chat/images/../files/legacy.txt',
  ]) {
    assert.equal(
      await persistentMediaStore.mapLegacyChatUriToAssetReference({
        uri,
        category: 'chatImage',
      }),
      null,
      `不应接管非应用拥有或越界 URI：${uri}`,
    );
  }
  assert.equal(
    await persistentMediaStore.mapLegacyChatUriToAssetReference({
      uri: 'file:///documents/persistent-media/chat/files/legacy.txt',
      category: 'chatImage',
    }),
    null,
    'chatFile 文件不能伪装成 chatImage locator',
  );
  await assert.rejects(
    // 运行时仍必须拒绝未允许的 category，不能只依赖 TypeScript union。
    persistentMediaStore.mapLegacyChatUriToAssetReference({
      uri: 'file:///documents/persistent-media/chat/images/legacy.png',
      category: 'callSnapshot',
    }),
    /不支持该媒体 category/,
  );
  await assert.rejects(
    new PersistentMediaStore().resolveAssetStorageKey('catalog/images/wrong.png'),
    /不属于 persistent-media backing/,
  );
  assert.equal(
    await new PersistentImageStore().resolveAssetStorageKey('avatars/user/legacy.jpg'),
    'file:///documents/persistent-media/avatars/user/legacy.jpg',
  );
  const persistentImageStore = new PersistentImageStore();
  for (const [category, uri, expected] of [
    [
      'userAvatar',
      'file:///documents/persistent-media/avatars/user/legacy.jpg',
      { storageKey: 'avatars/user/legacy.jpg', localUri: 'file:///documents/persistent-media/avatars/user/legacy.jpg' },
    ],
    [
      'aiAvatar',
      'persistent-media/avatars/ai/legacy.PNG',
      { storageKey: 'avatars/ai/legacy.PNG', localUri: 'file:///documents/persistent-media/avatars/ai/legacy.PNG' },
    ],
    [
      'groupAvatar',
      '/documents/persistent-media/avatars/group/legacy.webp',
      { storageKey: 'avatars/group/legacy.webp', localUri: 'file:///documents/persistent-media/avatars/group/legacy.webp' },
    ],
  ]) {
    assert.deepEqual(
      await persistentImageStore.mapLegacyAvatarUriToAssetReference({ uri, category }),
      expected,
    );
  }
  for (const uri of [
    'content://picked/avatar.jpg',
    'https://example.test/avatar.jpg',
    'bundle://avatar.jpg',
    'data:image/png;base64,AAAA',
    'file:///documents/other/avatar.jpg',
    'file:///documents/persistent-media/avatars/ai/avatar.jpg',
    'file:///documents/persistent-media/avatars/user/../ai/avatar.jpg',
    'file:///documents/persistent-media/avatars/user/nested/avatar.jpg',
    'file:///documents/persistent-media/avatars/user/avatar.txt',
    'file:///documents/persistent-media/avatars/user/avatar',
    'file:///documents/persistent-media/avatars/user/avatar.svg',
    'file:///documents/persistent-media/avatars/user/avatar.jpg?version=2',
  ]) {
    assert.equal(
      await persistentImageStore.mapLegacyAvatarUriToAssetReference({
        uri,
        category: 'userAvatar',
      }),
      null,
      `不应接管非应用拥有、越界或非可靠图片 URI：${uri}`,
    );
  }
  await assert.rejects(
    persistentImageStore.mapLegacyAvatarUriToAssetReference({
      uri: 'file:///documents/persistent-media/avatars/user/avatar.jpg',
      category: 'appIcon',
    }),
    /不支持该媒体 category/,
  );
  await assert.rejects(
    new PersistentImageStore().resolveAssetStorageKey('catalog/media/wrong.jpg'),
    /不属于 persistent-image backing/,
  );
  await assert.rejects(
    new PersistentImageStore().resolveAssetStorageKey('avatars/user/../group/avatar.jpg'),
    /不属于 persistent-image backing/,
  );

  const missingFileSystem = {
    documentDirectory: 'file:///documents/',
    getInfoAsync: async () => ({ exists: false, isDirectory: false }),
  };
  const { PersistentMediaStore: MissingPersistentMediaStore } = loadTypeScriptModuleWithMocks(
    'src/platform/device/PersistentMediaStore.ts',
    { 'expo-file-system/legacy': missingFileSystem },
  );
  assert.equal(
    await new MissingPersistentMediaStore().resolveAssetStorageKey('chat/images/missing.png'),
    null,
  );
  assert.equal(
    await new MissingPersistentMediaStore().mapLegacyChatUriToAssetReference({
      uri: 'file:///documents/persistent-media/chat/images/missing.png',
      category: 'chatImage',
    }),
    null,
  );

  const { PersistentImageStore: MissingPersistentImageStore } = loadTypeScriptModuleWithMocks(
    'src/platform/device/PersistentImageStore.ts',
    { 'expo-file-system/legacy': missingFileSystem },
  );
  assert.equal(
    await new MissingPersistentImageStore().mapLegacyAvatarUriToAssetReference({
      uri: 'file:///documents/persistent-media/avatars/user/missing.jpg',
      category: 'userAvatar',
    }),
    null,
  );

  const directoryFileSystem = {
    documentDirectory: 'file:///documents/',
    getInfoAsync: async () => ({ exists: true, isDirectory: true }),
  };
  const { PersistentMediaStore: DirectoryPersistentMediaStore } = loadTypeScriptModuleWithMocks(
    'src/platform/device/PersistentMediaStore.ts',
    { 'expo-file-system/legacy': directoryFileSystem },
  );
  assert.equal(
    await new DirectoryPersistentMediaStore().mapLegacyChatUriToAssetReference({
      uri: 'file:///documents/persistent-media/chat/images/directory',
      category: 'chatImage',
    }),
    null,
  );

  const { PersistentImageStore: DirectoryPersistentImageStore } = loadTypeScriptModuleWithMocks(
    'src/platform/device/PersistentImageStore.ts',
    { 'expo-file-system/legacy': directoryFileSystem },
  );
  assert.equal(
    await new DirectoryPersistentImageStore().mapLegacyAvatarUriToAssetReference({
      uri: 'file:///documents/persistent-media/avatars/user/directory.jpg',
      category: 'userAvatar',
    }),
    null,
  );

  const { PersistentMediaAssetBacking } = loadTypeScriptModuleWithMocks(
    'src/features/media/infrastructure/PersistentMediaAssetBackings.ts',
    {
      '../application/MediaAssetBacking': mediaAssetBackingModule,
    },
  );
  await assert.rejects(
    new PersistentMediaAssetBacking({ resolveAssetStorageKey: async () => null })
      .resolve('chat/images/missing.png'),
    MediaAssetBackingNotFoundError,
  );

  const { PersistentMediaStore: FailingPersistentMediaStore } = loadTypeScriptModuleWithMocks(
    'src/platform/device/PersistentMediaStore.ts',
    {
      'expo-file-system/legacy': {
        documentDirectory: 'file:///documents/',
        getInfoAsync: async () => ({ exists: true, isDirectory: true }),
        copyAsync: async () => { throw new Error('copy failed'); },
        deleteAsync: async () => { throw new Error('cleanup failed'); },
      },
    },
  );
  const failingStore = new FailingPersistentMediaStore();
  // canonical key 必须是纯计算：backing 要先 reserve，再 copy，因此 key 不能依赖文件写入结果。
  assert.equal(
    failingStore.buildAssetStorageKey({
      sourceUri: 'content://picked/image',
      assetId: 'media-new',
      fileName: 'image.png',
    }),
    'catalog/media/media-new.png',
  );
  await assert.rejects(
    failingStore.copyAssetToStorageKey({
      sourceUri: 'content://picked/image',
      storageKey: 'catalog/media/media-new.png',
    }),
    AggregateError,
  );
}

{
  const readInputs = [];
  const dependencies = {
    media: {
      readVisionImage: async (input) => {
        readInputs.push(input);
        return { base64: 'AQID', mimeType: 'image/png' };
      },
    },
    vision: {
      // direct 策略：即使视觉模型缺失也必须原图直传，且不得创建 OCR client。
      resolveOCRModel: async () => ({ status: 'unconfigured' }),
    },
  };
  const { resolveChatImageModelInput } = loadTypeScriptModuleWithMocks(
    'src/features/chat/reply/application/ResolveChatImageModelInput.ts',
    {
      '@shared/runtime/abortSignal': loadTypeScriptModuleWithMocks('src/shared/runtime/abortSignal.ts', {}),
      '@platform/ai': { createAIClient: () => assert.fail('direct vision 不应创建 OCR client') },
      './ChatReplyRuntimeDependencies': {
        getChatReplyRuntimeDependencies: () => dependencies,
      },
      './ReplyTaskPromptBlocks': { buildVisionOCRPromptBlocks: () => [] },
    },
  );
  const originalInfo = console.info;
  console.info = () => undefined;
  try {
    await resolveChatImageModelInput({
      assistantId: 'assistant-1',
      mediaAssetId: 'media-1',
      mimeType: 'image/png',
      contextText: 'asset image',
    });
    await resolveChatImageModelInput({
      assistantId: 'assistant-1',
      imageUri: 'file:///legacy.png',
      mimeType: 'image/png',
      contextText: 'legacy image',
    });
  } finally {
    console.info = originalInfo;
  }
  assert.deepEqual(readInputs, [
    { kind: 'media_asset', assetId: 'media-1' },
    { kind: 'legacy_uri', uri: 'file:///legacy.png' },
  ]);
}

async function runCreationScenario({ candidates = [], transactionError, cleanupError, missingKeys = [] } = {}) {
  const deleted = [];
  const statusUpdates = [];
  const reported = [];
  const writer = {
    storageBackend: 'persistent-media',
    prepare: async ({ assetId }) => ({
      storageBackend: 'persistent-media',
      storageKey: `catalog/media/${assetId}.png`,
      localUri: `file:///catalog/media/${assetId}.png`,
    }),
    resolve: async (storageKey) => {
      if (missingKeys.includes(storageKey)) throw new MediaAssetBackingNotFoundError('persistent-media', storageKey);
      return { localUri: 'file:///unused' };
    },
    commitPrepared: () => undefined,
    delete: async (storageKey) => {
      deleted.push(storageKey);
      if (cleanupError) throw cleanupError;
    },
    listCanonicalStorageKeys: async () => [],
  };
  const registry = new MediaAssetBackingRegistry({ writers: [writer] });
  const repository = {
    getById: async () => null,
    listHashCandidates: async () => candidates,
    listHashCandidatesInTransaction: async () => candidates,
    createInTransaction: async () => undefined,
    updateStatusInTransaction: async (_transaction, update) => statusUpdates.push(update),
  };
  const creator = new CreateMediaAsset({
    catalog: new MediaAssetCatalog(repository),
    backings: registry,
    contentInspector: {
      inspect: async () => ({ contentHash: 'a'.repeat(64), byteSize: 3 }),
    },
    database: {
      withExclusiveTransactionAsync: async (task) => {
        if (transactionError) throw transactionError;
        return task({ transaction: 'same-executor' });
      },
    },
    generateId: () => 'media-new',
    now: () => '2026-08-25T03:00:00.000Z',
    reportPostCommitCleanupFailure: (error, prepared) => reported.push({ error, prepared }),
  });
  return { creator, deleted, reported, statusUpdates };
}

const input = {
  storageBackend: 'persistent-media',
  sourceUri: 'content://picked/image',
  fileName: 'picked.png',
  mimeType: 'image/png',
  width: 20,
  height: 10,
  durationMs: null,
};

{
  const existing = asset();
  const scenario = await runCreationScenario({ candidates: [existing], missingKeys: [existing.storageKey] });
  const result = await scenario.creator.execute(input, async ({ asset }) => asset.id);
  assert.equal(result.reused, false, '已丢失的 ready backing 不得吞掉重新导入的有效文件');
  assert.equal(result.value, 'media-new');
  assert.deepEqual(scenario.deleted, [], '重新导入的新文件由新引用接管');
  assert.equal(scenario.statusUpdates[0].id, existing.id);
  assert.equal(scenario.statusUpdates[0].status, 'missing');
}

{
  const scenario = await runCreationScenario();
  let callbackTransaction;
  const result = await scenario.creator.execute(input, async ({ transaction }) => {
    callbackTransaction = transaction;
    return 'business-reference';
  });
  assert.equal(result.reused, false);
  assert.equal(result.value, 'business-reference');
  assert.equal(callbackTransaction.transaction, 'same-executor');
  assert.deepEqual(scenario.deleted, [], '成功创建的新 backing 已被事务接管，不得删除');
}

{
  const scenario = await runCreationScenario({ candidates: [asset()] });
  const result = await scenario.creator.execute(input, async () => 'reused-reference');
  assert.equal(result.reused, true);
  assert.equal(result.asset.id, 'media-existing');
  assert.deepEqual(scenario.deleted, ['catalog/media/media-new.png']);
}

{
  const transactionError = new Error('business transaction failed');
  const scenario = await runCreationScenario({ transactionError });
  await assert.rejects(
    scenario.creator.execute(input, async () => undefined),
    transactionError,
  );
  assert.deepEqual(scenario.deleted, ['catalog/media/media-new.png']);
}

{
  const cleanupError = new Error('cleanup failed');
  const scenario = await runCreationScenario({ candidates: [asset()], cleanupError });
  const result = await scenario.creator.execute(input, async () => 'committed');
  assert.equal(result.value, 'committed', '事务提交后清理失败不得伪装成业务失败');
  assert.equal(scenario.reported.length, 1);
}

{
  const scenario = await runCreationScenario({
    transactionError: new Error('transaction failed'),
    cleanupError: new Error('cleanup failed'),
  });
  await assert.rejects(
    scenario.creator.execute(input, async () => undefined),
    AggregateError,
  );
}

// ============================================================================
// PreparedMediaAssetBatch：事务结果未知阶段绝不允许删除已可能被接管的 backing
// ============================================================================
const createMediaAssetModule = loadTypeScriptModuleWithMocks(
  'src/features/media/application/CreateMediaAsset.ts',
  {},
);
const { PrepareMediaAssetBatch } = loadTypeScriptModuleWithMocks(
  'src/features/media/application/PreparedMediaAssetBatch.ts',
  { './CreateMediaAsset': createMediaAssetModule },
);

async function runPreparedBatchScenario({
  candidates = [],
  failFirstDelete = false,
  failSecondInspect = false,
} = {}) {
  const deleted = [];
  let deleteAttempts = 0;
  let inspectAttempts = 0;
  const writer = {
    storageBackend: 'persistent-media',
    prepare: async ({ assetId }) => ({
      storageBackend: 'persistent-media',
      storageKey: `catalog/media/${assetId}.png`,
      localUri: `file:///catalog/media/${assetId}.png`,
    }),
    resolve: async (storageKey) => ({ localUri: `file:///${storageKey}` }),
    commitPrepared: () => undefined,
    delete: async (storageKey) => {
      deleteAttempts += 1;
      if (failFirstDelete && deleteAttempts === 1) {
        throw new Error('cleanup failed');
      }
      deleted.push(storageKey);
    },
    listCanonicalStorageKeys: async () => [],
  };
  const preparer = new PrepareMediaAssetBatch({
    catalog: new MediaAssetCatalog({
      getById: async () => null,
      listHashCandidates: async () => candidates,
    listHashCandidatesInTransaction: async () => candidates,
      createInTransaction: async () => undefined,
    }),
    backings: new MediaAssetBackingRegistry({ writers: [writer] }),
    contentInspector: {
      inspect: async () => {
        inspectAttempts += 1;
        if (failSecondInspect && inspectAttempts === 2) {
          throw new Error('inspect failed');
        }
        return { contentHash: 'a'.repeat(64), byteSize: 3 };
      },
    },
    generateId: (() => {
      let sequence = 0;
      return () => `media-${++sequence}`;
    })(),
    now: () => '2026-09-12T00:00:00.000Z',
  });
  return { preparer, deleted };
}

{
  const scenario = await runPreparedBatchScenario();
  const batch = await scenario.preparer.execute([input]);
  const committed = await batch.commitInTransaction({ transaction: 'same-executor' });
  assert.deepEqual(committed.assets.map(({ id }) => id), ['media-1']);
  await batch.finalizeAfterCommit();
  assert.deepEqual(
    scenario.deleted,
    [],
    '新建 MediaAsset 的 backing 已被 catalog 行接管，提交后清理不得删除',
  );
}

{
  const scenario = await runPreparedBatchScenario();
  const batch = await scenario.preparer.execute([input]);
  await batch.commitInTransaction({ transaction: 'same-executor' });
  await assert.rejects(
    batch.discard(),
    /必须显式声明事务结果/,
    '事务结果未知时不得用含糊的 discard 删除 backing',
  );
  assert.deepEqual(scenario.deleted, [], '被拒绝的 discard 不得产生任何文件删除');
  await batch.discardAfterRollback();
  assert.deepEqual(
    scenario.deleted,
    ['catalog/media/media-1.png'],
    '显式声明回滚后必须删除本次准备的 backing',
  );
}

{
  const scenario = await runPreparedBatchScenario();
  const batch = await scenario.preparer.execute([input]);
  await batch.discard();
  assert.deepEqual(
    scenario.deleted,
    ['catalog/media/media-1.png'],
    '尚未进入 catalog 事务时取消必须删除全部准备文件',
  );
}

{
  const scenario = await runPreparedBatchScenario();
  const batch = await scenario.preparer.execute([input]);
  await assert.rejects(
    batch.finalizeAfterCommit(),
    /必须先在事务内 commit/,
    '未进入事务不得声明提交成功',
  );
  assert.deepEqual(scenario.deleted, []);
}

{
  const scenario = await runPreparedBatchScenario({ candidates: [asset()] });
  const batch = await scenario.preparer.execute([input]);
  const committed = await batch.commitInTransaction({ transaction: 'same-executor' });
  assert.equal(committed.entries[0].reused, true);
  await batch.finalizeAfterCommit();
  assert.deepEqual(
    scenario.deleted,
    ['catalog/media/media-1.png'],
    'catalog 复用既有资产时，本次多余准备的 backing 必须在提交后删除',
  );
}

{
  const scenario = await runPreparedBatchScenario({
    candidates: [asset()],
    failFirstDelete: true,
  });
  const batch = await scenario.preparer.execute([input, input]);
  const committed = await batch.commitInTransaction({ transaction: 'same-executor' });
  assert.deepEqual(committed.entries.map(({ reused }) => reused), [true, true]);

  await assert.rejects(batch.finalizeAfterCommit(), AggregateError);
  assert.deepEqual(scenario.deleted, ['catalog/media/media-2.png']);
  await assert.rejects(
    batch.discardAfterRollback(),
    /不能按回滚清理/,
    '已声明提交成功后不得再按回滚语义删除 backing',
  );
  assert.deepEqual(
    scenario.deleted,
    ['catalog/media/media-2.png'],
    '被拒绝的回滚清理不得删除任何已提交 backing',
  );

  await batch.finalizeAfterCommit();
  assert.deepEqual(
    scenario.deleted,
    ['catalog/media/media-2.png', 'catalog/media/media-1.png'],
    '重试只处理尚未删除的 entry',
  );
  await batch.finalizeAfterCommit();
  assert.deepEqual(scenario.deleted.length, 2, '已 finalize 的 batch 不得重复删除');
}

{
  const scenario = await runPreparedBatchScenario({ failSecondInspect: true });
  await assert.rejects(
    scenario.preparer.execute([input, input]),
    /inspect failed/,
    '准备阶段自身失败必须抛出',
  );
  assert.deepEqual(
    scenario.deleted,
    ['catalog/media/media-2.png', 'catalog/media/media-1.png'],
    '准备失败发生在事务之前：失败项由 prepare 自身补偿删除，先前已准备的项由 batch discard 回收',
  );
}

console.log('MediaAsset M2 runtime contract：行为验证通过。');
