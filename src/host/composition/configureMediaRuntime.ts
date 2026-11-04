/** 在 Host 组装唯一 MediaAsset catalog、backing registry 与 resolver。 */
import {
  AdoptExistingMediaAssets,
  CreateMediaAsset,
  MediaAssetBackingRegistry,
  MediaAssetCatalog,
  MediaAssetLifecycle,
  MediaAssetResolver,
  PersistentImageAssetBacking,
  PersistentMediaAssetBacking,
  PrepareMediaAssetBatch,
  SQLiteMediaAssetRepository,
  adoptExistingMediaAssetsWithReference as adoptExistingMediaAssetsWithReferenceRuntime,
  configureMediaAssetRuntime,
} from '@features/media/composition';
import type {
  AdoptExistingMediaAssetInput,
  AdoptExistingMediaAssetsResult,
  CommitAdoptedMediaAssetReferenceInput,
} from '@features/media/composition';
import { MEDIA_ASSET_STORAGE_BACKEND } from '@features/media';
import {
  createRandomUUID,
  inspectMediaFileContent,
  PERSISTENT_MEDIA_CATEGORY,
  persistentImageStore,
  persistentMediaStore,
} from '@platform/device';
import type { LegacyAvatarCategory } from '@platform/device';
import { databaseCoordinator } from '@platform/persistence';
import { configureWallpaperRuntime, wallpaperRepository } from '@features/profile/composition';

let configured = false;

export function configureMediaRuntime(): void {
  if (configured) {
    return;
  }
  configured = true;

  const database = databaseCoordinator.openTaskExecutor({
    name: 'media.catalog',
    feature: 'media',
    priority: 'runtime',
  });
  const repository = new SQLiteMediaAssetRepository(database);
  const catalog = new MediaAssetCatalog(repository);
  const backings = new MediaAssetBackingRegistry({
    writers: [
      new PersistentMediaAssetBacking(persistentMediaStore),
      new PersistentImageAssetBacking(persistentImageStore),
    ],
  });
  const resolver = new MediaAssetResolver(catalog, backings);
  const creator = new CreateMediaAsset({
    catalog,
    backings,
    contentInspector: { inspect: inspectMediaFileContent },
    database,
    generateId: () => `media-${createRandomUUID()}`,
    now: () => new Date().toISOString(),
    reportPostCommitCleanupFailure: (error, prepared) => {
      console.warn('[MediaAsset] 复用后清理新 backing 文件失败，等待 M5 reconciliation', {
        storageBackend: prepared.storageBackend,
        storageKey: prepared.storageKey,
        error,
      });
    },
  });
  const adopter = new AdoptExistingMediaAssets({
    catalog,
    backings,
    contentInspector: { inspect: inspectMediaFileContent },
    database,
    generateId: () => `media-${createRandomUUID()}`,
    now: () => new Date().toISOString(),
  });
  const preparer = new PrepareMediaAssetBatch({
    catalog,
    backings,
    contentInspector: { inspect: inspectMediaFileContent },
    generateId: () => `media-${createRandomUUID()}`,
    now: () => new Date().toISOString(),
  });
  const lifecycle = new MediaAssetLifecycle(repository, backings, database);

  configureMediaAssetRuntime({ catalog, creator, adopter, resolver, preparer, lifecycle });
  configureWallpaperRuntime(wallpaperRepository);
}

/**
 * Host-only 的 M3 legacy migration 入口。
 * 迁移 owner 负责在 callback 内用同一个 transaction 提交业务引用；该能力不进入
 * @features/media 的稳定公共出口，也不改变新附件的写入路径。
 */
export function adoptExistingMediaAssetsWithReference<T>(
  inputs: readonly AdoptExistingMediaAssetInput[],
  commitReference: (
    input: CommitAdoptedMediaAssetReferenceInput,
  ) => Promise<T>,
): Promise<AdoptExistingMediaAssetsResult<T>> {
  return adoptExistingMediaAssetsWithReferenceRuntime(inputs, commitReference);
}

/** Chat migration 使用的窄适配，不进入 @features/media 稳定出口。 */
export async function locateLegacyChatFile(localUri: string): Promise<{
  storageBackend: string;
  storageKey: string;
  localUri: string;
} | null> {
  for (const category of [
    PERSISTENT_MEDIA_CATEGORY.chatImage,
    PERSISTENT_MEDIA_CATEGORY.chatFile,
  ] as const) {
    const located = await persistentMediaStore.mapLegacyChatUriToAssetReference({
      uri: localUri,
      category,
    });
    if (located) {
      return {
        storageBackend: MEDIA_ASSET_STORAGE_BACKEND.persistentMedia,
        ...located,
      };
    }
  }
  return null;
}

/** M3b 头像迁移使用的窄适配；Moments/comment 不通过该入口保留历史快照。 */
export async function locateLegacyAvatarFile(
  localUri: string,
  category: LegacyAvatarCategory,
): Promise<{
  storageBackend: string;
  storageKey: string;
  localUri: string;
} | null> {
  const located = await persistentImageStore.mapLegacyAvatarUriToAssetReference({
    uri: localUri,
    category,
  });
  return located
    ? {
        storageBackend: MEDIA_ASSET_STORAGE_BACKEND.persistentImage,
        ...located,
      }
    : null;
}

/** 将通用 Media adoption 的 commit 形状收窄为 Chat 只需的 transaction + assets。 */
export async function adoptLegacyChatFiles<T>(
  inputs: Parameters<typeof adoptExistingMediaAssetsWithReference>[0],
  commit: (
    transaction: import('@platform/persistence').DatabaseTransactionExecutor,
    assets: readonly import('@features/media').MediaAsset[],
  ) => Promise<T>,
): Promise<T> {
  const result = await adoptExistingMediaAssetsWithReference(inputs, async ({ transaction, assets }) => (
    commit(transaction, assets)
  ));
  return result.value;
}
