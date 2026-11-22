/** 定义聊天附件及其草稿、解析状态和 AI 处理元数据的领域契约。 */
export type ChatAttachmentType = 'image' | 'file';

/** 文件解析和粘贴入口共用此上限，单位为 UTF-16 码元。 */
export const CHAT_TEXT_ATTACHMENT_MAX_LENGTH = 50_000;
export const CHAT_FILE_PAGE_SIZE = 4_000;

export function formatChatFileReference(messageId: number, attachment: Pick<ChatAttachment, 'id' | 'fileName'>): string {
  return `文件：${attachment.fileName}；messageId=${messageId}；attachmentId=${attachment.id}`;
}

/** 新上传文档与收藏文件分类共用 TXT/MD 的业务类型定义；历史预览独立保留旧类型。 */
export function isChatTextDocumentFileName(fileName: string): boolean {
  return /\.(txt|md)$/i.test(fileName);
}

export type ChatAttachmentSource =
  | 'gallery'
  | 'camera'
  | 'document'
  | 'clipboard'
  | 'media_library'
  | 'screen_capture';

export type AttachmentDraftStatus =
  | 'preparing'
  | 'persisting'
  | 'parsing'
  | 'ready'
  | 'failed';

export type AttachmentParseStatus =
  | 'pending'
  | 'parsing'
  | 'success'
  | 'failed'
  | 'skipped';

interface ChatAttachmentFields {
  id: string;
  type: ChatAttachmentType;
  source: ChatAttachmentSource;
  fileName: string;
  mimeType?: string | null;
  fileSize?: number | null;
  width?: number | null;
  height?: number | null;
  parseStatus?: AttachmentParseStatus;
  parsedText?: string | null;
  parseError?: string | null;
  parserName?: string | null;
  previewText?: string | null;
}

/**
 * M3a 迁移前仍由 Chat 自己持有的 legacy URI 引用。
 *
 * 这个分支只服务于 M4a 切换前的历史读路径和旧写入路径；一旦附件变成
 * MediaAsset 引用，就不能再把 localUri/thumbnailUri 留在同一个对象里。
 */
export interface LegacyChatAttachment extends ChatAttachmentFields {
  localUri: string;
  thumbnailUri?: string | null;
  mediaAssetId?: never;
  thumbnailMediaAssetId?: never;
  unavailable?: never;
}

/** 已迁移的 Chat 附件引用；媒体字节由 MediaAsset backing/resolver 所有。 */
export interface MediaAssetChatAttachment extends ChatAttachmentFields {
  mediaAssetId: string;
  thumbnailMediaAssetId?: string | null;
  localUri?: never;
  thumbnailUri?: never;
  unavailable?: never;
}

/** 外部历史记录保留附件身份和文件名，即使源端已无法提供字节。 */
export interface UnavailableChatAttachment extends ChatAttachmentFields {
  unavailable: true;
  localUri?: never;
  thumbnailUri?: never;
  mediaAssetId?: never;
  thumbnailMediaAssetId?: never;
}

export type StoredChatAttachment = MediaAssetChatAttachment | UnavailableChatAttachment;
export type ChatAttachment = LegacyChatAttachment | StoredChatAttachment;

export interface ChatMessageAttachmentAIPolicy {
  sentToModel: boolean;
  usedVision?: boolean;
  degradedReason?:
    | 'vision_unsupported'
    | 'parse_pending'
    | 'parse_failed'
    | 'unsupported_file'
    | 'empty_image_without_vision';
  degradedPrompt?: string | null;
}

export type ChatMessageHelperKind =
  | 'helper_join'
  | 'helper_leave'
  | 'helper_reply'
  | 'primary_reply'
  | 'helper_request';

export interface ChatMessageHelperMetadata {
  kind: ChatMessageHelperKind;
  actorAIId?: string | null;
  actorAgentId?: string | null;
  primaryAIId?: string | null;
  helperAIId?: string | null;
  helperEpisodeId?: string | null;
  helperTurnCount?: number | null;
  anchorImageMessageId?: number | null;
}

export interface ChatMessageAttachmentMetadata {
  kind: 'text' | 'image' | 'file' | 'mixed';
  attachments?: ChatAttachment[];
  aiPolicy?: ChatMessageAttachmentAIPolicy;
  helper?: ChatMessageHelperMetadata | null;
}

export interface AttachmentDraftItem {
  id: string;
  type: ChatAttachmentType;
  source: ChatAttachmentSource;
  originalUri?: string;
  localUri?: string | null;
  fileName: string;
  mimeType?: string | null;
  fileSize?: number | null;
  width?: number | null;
  height?: number | null;
  thumbnailUri?: string | null;
  status: AttachmentDraftStatus;
  parsedText?: string | null;
  parseStatus?: AttachmentParseStatus;
  parseError?: string | null;
  parserName?: string | null;
  previewText?: string | null;
  errorMessage?: string | null;
}

export function createAttachmentDraftId(prefix = 'att'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
