/** 普通附件文件在事务外准备，最终资产引用在原有用户消息事务中物化。 */
import { MEDIA_ASSET_STORAGE_BACKEND, prepareMediaAssetBatch, type CreateMediaAssetInput } from '@features/media';
import type { DatabaseTransactionExecutor } from '@platform/persistence';
import type { ChatAttachment, LegacyChatAttachment, StoredChatAttachment } from '../domain/ChatAttachment';
import type { SharedChatRecord } from '../domain/SharedChatRecord';
import type { CommitMessageInput } from '../domain/MessageRepository';
import { CHAT_ATTACHMENT_MIME_BY_EXTENSION } from './ChatAttachmentMime';

function isLocalAttachment(attachment: ChatAttachment): attachment is LegacyChatAttachment {
  return typeof attachment.localUri === 'string';
}

export async function prepareChatAttachments(attachments: readonly ChatAttachment[]) {
  const legacy = attachments.filter(isLocalAttachment);
  if (legacy.length === 0) return null;
  const plans = legacy.map((attachment) => ({
    attachment,
    mainIndex: 0,
    thumbnailIndex: null as number | null,
  }));
  const sources: CreateMediaAssetInput[] = [];
  for (const plan of plans) {
    const attachment = plan.attachment;
    plan.mainIndex = sources.length;
    const mimeType = attachment.mimeType || CHAT_ATTACHMENT_MIME_BY_EXTENSION[attachment.fileName.toLowerCase().split('.').pop()!];
    if (!mimeType) throw new Error(`无法识别附件类型：${attachment.fileName}`);
    const main = {
      storageBackend: MEDIA_ASSET_STORAGE_BACKEND.persistentMedia,
      sourceUri: attachment.localUri, fileName: attachment.fileName,
      mimeType,
      width: attachment.width ?? null, height: attachment.height ?? null, durationMs: null,
    };
    sources.push(main);
    if (attachment.thumbnailUri && attachment.thumbnailUri !== attachment.localUri) {
      plan.thumbnailIndex = sources.length;
      sources.push({ ...main, sourceUri: attachment.thumbnailUri, width: null, height: null,
        mimeType: CHAT_ATTACHMENT_MIME_BY_EXTENSION[attachment.thumbnailUri.toLowerCase().split('.').pop()!] || mimeType });
    }
  }
  const batch = await prepareMediaAssetBatch(sources);
  const materializeAttachments = async (transaction: DatabaseTransactionExecutor): Promise<StoredChatAttachment[]> => {
    const { assets } = await batch.commitInTransaction(transaction);
    const replacements = new Map(plans.map(({ attachment, mainIndex, thumbnailIndex }) => {
      const { localUri: _source, thumbnailUri: _thumbnail, ...fields } = attachment;
      return [attachment.id, { ...fields, mediaAssetId: assets[mainIndex].id,
        ...(thumbnailIndex !== null ? { thumbnailMediaAssetId: assets[thumbnailIndex].id } : {}),
      }];
    }));
    return attachments.map(attachment => isLocalAttachment(attachment)
      ? replacements.get(attachment.id)!
      : attachment);
  };
  return {
    batch,
    materializeAttachments,
    async materialize(transaction: DatabaseTransactionExecutor, inputs: readonly CommitMessageInput[]): Promise<CommitMessageInput[]> {
      const replacements = new Map((await materializeAttachments(transaction)).map(attachment => [attachment.id, attachment]));
      return inputs.map((input) => {
        const metadata = JSON.parse(input.message.metadataJson!);
        const replace = (attachment: ChatAttachment) => replacements.get(attachment.id) ?? attachment;
        const replaceRecordAttachments = (record: SharedChatRecord) => {
          record.entries = record.entries.map((entry) => ({ ...entry, attachments: entry.attachments.map(replace) }));
        };
        if (metadata.attachments) metadata.attachments = metadata.attachments.map(replace);
        if (metadata.sharedRecord) replaceRecordAttachments(metadata.sharedRecord);
        if (metadata.replyQuote) {
          metadata.replyQuote.attachments = metadata.replyQuote.attachments.map(replace);
          if (metadata.replyQuote.sharedRecord) replaceRecordAttachments(metadata.replyQuote.sharedRecord);
        }
        return { ...input, message: { ...input.message, metadataJson: JSON.stringify(metadata) } };
      });
    },
    async finish(committed: boolean) {
      if (!committed) return batch.discardAfterRollback();
      try { await batch.finalizeAfterCommit(); }
      catch (error) { console.warn('[ChatAttachments] 已提交附件的准备文件清理失败：', error); }
    },
  };
}
