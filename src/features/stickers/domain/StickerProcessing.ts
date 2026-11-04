/** 用户收藏库的处理进度；识别可用性与可选的向量索引分别表达。 */
import type { Sticker } from './Sticker';
import type { StickerModelSelection } from './StickerSystemConfig';

export interface StickerProcessingRow {
  sticker: Sticker;
  annotationStartedAt: string | null;
  manuallyRequested: boolean;
  hasEmbedding: boolean;
  embeddingError: string | null;
}

export type StickerVectorStatus = 'waiting_annotation' | 'unconfigured' | 'unavailable'
  | 'pending_rebuild' | 'pending' | 'processing' | 'failed' | 'ready';

export interface StickerProcessingItem extends StickerProcessingRow {
  vectorStatus: StickerVectorStatus;
}

/** 仅表示本进程真正持有的请求，不把上次进程的请求伪装成仍在运行。 */
export interface StickerEmbeddingActivity {
  kind: 'automatic' | 'rebuild';
  stickerIds: string[];
  startedAt: string;
  completed: number;
  total: number;
}

export interface StickerProcessingProgress {
  items: StickerProcessingItem[];
  recognitionModel: StickerModelSelection;
  embeddingModel: StickerModelSelection;
  embeddingPublished: boolean;
  embeddingCanBackfill: boolean;
  automaticRecognitionEnabled: boolean;
  embeddingActivity: StickerEmbeddingActivity | null;
}
