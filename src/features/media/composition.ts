/** Host-only composition 出口；业务 Feature 只能依赖 @features/media 根出口。 */

export {
  adoptExistingMediaAssetsWithReference,
  configureMediaAssetRuntime,
} from './application/MediaAssetRuntime';
export { AdoptExistingMediaAssets } from './application/AdoptExistingMediaAssets';
export type {
  AdoptExistingMediaAssetInput,
  AdoptExistingMediaAssetsDependencies,
  AdoptExistingMediaAssetsResult,
  AdoptedMediaAssetEntry,
  CommitAdoptedMediaAssetReferenceInput,
} from './application/AdoptExistingMediaAssets';
export { CreateMediaAsset } from './application/CreateMediaAsset';
export { PrepareMediaAssetBatch } from './application/PreparedMediaAssetBatch';
export { MediaAssetLifecycle } from './application/MediaAssetLifecycle';
export { MediaAssetBackingRegistry } from './application/MediaAssetBacking';
export {
  MediaAssetCatalog,
  MediaAssetLocatorConflictError,
} from './application/MediaAssetCatalog';
export { MediaAssetResolver } from './application/MediaAssetResolver';
export { configureAIImageRuntime } from './application/AIImageRuntime';
export { SQLiteAIDownloadedImageRepository } from './infrastructure/SQLiteAIDownloadedImageRepository';
export { SQLiteMediaAssetRepository } from './infrastructure/SQLiteMediaAssetRepository';
export {
  PersistentImageAssetBacking,
  PersistentMediaAssetBacking,
} from './infrastructure/PersistentMediaAssetBackings';
