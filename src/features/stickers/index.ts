/** Sticker Feature 的稳定公共出口。 */

export type {
  Sticker,
  StickerAnnotationMetadata,
  StickerGroup,
  StickerMessageSnapshot,
  StickerListMode,
} from './domain/Sticker';
export { STICKER_LIST_LIMIT, StickerLibraryFullError, StickerNotFoundError, StickerAnnotationClaimLostError } from './domain/Sticker';
export {
  addStickerFromMessage,
  createStickerGroup,
  completeStickerAnnotation,
  completeStickerAnnotationManually,
  deleteStickerFromLibrary,
  deleteStickerGroup,
  editStickerMetadata,
  failStickerAnnotation,
  importSticker,
  moveStickerToGroup,
  recordUserStickerUse,
  recoverInterruptedStickerAnnotations,
  releaseStickerAnnotation,
  renameStickerGroup,
  toggleStickerFavorite,
  claimStickerAnnotation,
  retryStickerAnnotation,
} from './application/StickerCommands';
export {
  getStickerById,
  isStickerInUserLibrary,
  listStickerGroups,
  listStickers,
  listStickersInGroupForAI,
  resolveStickerMedia,
  searchStickers,
} from './application/StickerQueries';
export { STICKER_AI_SEARCH_DEFAULT_LIMIT, searchStickersForAI } from './application/StickerSearch';
export {
  subscribeStickerAnnotationPending,
  subscribeStickerAutomaticRecognitionChanged,
} from './application/StickerAnnotationPendingSignal';
export {
  subscribeStickerAnnotationChanged,
} from './application/StickerAnnotationChangedSignal';
export {
  subscribeStickerEmbeddingPending,
} from './application/StickerEmbeddingPendingSignal';
export {
  STICKER_EMBEDDING_BATCH_SIZE,
  generateStickerEmbeddingBatch,
  getStickerEmbeddingIndexStatus,
  rebuildStickerEmbeddingIndex,
} from './application/StickerEmbeddings';
export {
  getStickerSystemModelSelection,
  resolveStickerEmbeddingModel,
  resolveStickerRecognitionModel,
  setStickerEmbeddingModel,
  setStickerRecognitionModel,
  setStickerAutomaticRecognitionEnabled,
} from './application/StickerSystemModels';
export {
  isStickerSendIntent,
  ListStickerGroupsTool,
  ListStickersInGroupTool,
  SearchStickersTool,
  SelectStickerTool,
  listStickerGroupsDefinition,
  searchStickersDefinition,
} from './aiTools/StickerAgentTools';
export type { StickerSystemConfig } from './domain/StickerSystemConfig';
export { StickerSystemScreen } from './presentation/stickerSystem';
export { AddOwnStickerTool, MaintainOwnStickerTool } from './aiTools/AIStickerLibraryTools';
export { getStickerProcessingProgress } from './application/StickerProcessing';
export { subscribeStickerProcessingChanged } from './application/StickerProcessingSignal';
export type { StickerProcessingProgress, StickerProcessingItem, StickerVectorStatus } from './domain/StickerProcessing';
export { default as StickerProcessingScreen } from './presentation/stickerSystem/StickerProcessingScreen';
export { StickerProcessingSummary } from './presentation/stickerSystem/StickerProcessingSummary';
export { StickerAnnotationStatus } from './presentation/stickerSystem/StickerAnnotationStatus';
export { useStickerProcessingProgress } from './presentation/stickerSystem/useStickerProcessingProgress';
export { StickerProgressNavigationProvider, useStickerProgressNavigation } from './presentation/stickerSystem/StickerProgressNavigation';
