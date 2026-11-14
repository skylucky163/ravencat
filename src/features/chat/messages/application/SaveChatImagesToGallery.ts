import { inspectLocalImage, saveImageToGallery } from '@platform/device';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import type { ChatAttachment } from '../domain/ChatAttachment';
import { resolveChatAttachmentPrimaryUri } from './ResolveChatAttachmentMedia';

/** 导出只读取原图，不修改消息或新增媒体引用。 */
export async function saveChatImagesToGallery(images: readonly ChatAttachment[], signal: AbortSignal): Promise<void> {
  for (const attachment of images) {
    throwIfAbortSignalAborted(signal);
    const uri = await resolveChatAttachmentPrimaryUri(attachment);
    const image = await inspectLocalImage(uri);
    await saveImageToGallery(uri, image.mimeType, signal);
  }
}
