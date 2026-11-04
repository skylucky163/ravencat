/** Media Feature 的稳定公共出口。 */

export type {
  MediaAsset,
  MediaAssetStatus,
  MediaHashAlgorithm,
} from './domain/MediaAsset';
export type {
  MediaAssetHashCandidateQuery,
  MediaAssetRepository,
  MediaAssetStorageLocatorQuery,
  UpdateMediaAssetStatusInput,
} from './domain/MediaAssetRepository';
export type {
  InvalidMediaAssetReferenceSource,
  MediaAssetDatabaseAudit,
  MediaAssetLifecycleRepository,
  MediaAssetReference,
  MediaAssetReferenceKind,
} from './domain/MediaAssetLifecycle';
export {
  MEDIA_ASSET_STORAGE_BACKEND,
  MediaAssetBackingNotFoundError,
} from './application/MediaAssetBacking';
export type {
  MediaAssetStorageBackend,
  ResolvedMediaAssetBacking,
} from './application/MediaAssetBacking';
export type {
  CommitMediaAssetReferenceInput,
  CreateMediaAssetInput,
  CreateMediaAssetResult,
} from './application/CreateMediaAsset';
export type { ResolvedMediaAsset } from './application/MediaAssetResolver';
export { MediaAssetNotFoundError, MediaAssetMissingError } from './application/MediaAssetResolver';
export { mediaImageFailure } from './application/MediaImageToolResult';
export { DownloadImageTool, QueryDownloadedImagesTool, ViewImageTool, viewImageSource } from './application/AIImageTools';
export { commitCroppedImageSelection } from './application/CommitCroppedImageSelection';
export type { CroppedImageSelectionInput } from './application/CommitCroppedImageSelection';
export {
  createMediaAssetWithReference,
  auditMediaAssetClosure,
  cleanupMediaAssetOrphans,
  collectChatSessionMediaAssetCandidatesInTransaction,
  collectAssistantMediaAssetCandidatesInTransaction,
  getMediaAsset,
  releaseMediaAssetCandidates,
  resolveMediaAsset,
  resolveMediaAssetReferenceUri,
  prepareMediaAssetBatch,
} from './application/MediaAssetRuntime';
export type {
  MediaAssetCleanupFailure,
  MediaAssetCleanupPhase,
  MediaAssetCleanupResult,
  MediaAssetClosureAudit,
  MediaAssetPhysicalOrphan,
  MediaAssetReleaseResult,
} from './application/MediaAssetLifecycle';
export type {
  PreparedMediaAssetBatchCommitEntry,
  PreparedMediaAssetBatchCommitResult,
} from './application/PreparedMediaAssetBatch';
export type { MediaAssetReferenceUriInput } from './application/MediaAssetRuntime';

export { default as MediaAssetImage } from './presentation/MediaAssetImage';
