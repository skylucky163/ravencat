import { Directory, File, Paths } from 'expo-file-system';
import { createRandomUUID, ImageFileReadError, inspectLocalImage } from '@platform/device';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import type { ChatAttachment, UnavailableChatAttachment } from '../domain/ChatAttachment';
import type { DeepSeekConversation, DeepSeekExportArchive, DeepSeekExportFile } from '../domain/DeepSeekImport';

const FILE_BYTES = 32 * 1024 * 1024;
const TOTAL_FILE_BYTES = 128 * 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
};

export async function materializeDeepSeekAttachments(
  conversation: DeepSeekConversation,
  signal: AbortSignal,
  extractFile: (path: string, targetUri: string, limit: number) => Promise<number | null>,
): ReturnType<DeepSeekExportArchive['extractAttachments']> {
  const files = new Map<DeepSeekExportFile, ChatAttachment>();
  const sources = conversation.messages.flatMap(message => message.files);
  if (sources.length === 0) return { files, dispose: () => {} };
  const directory = new Directory(Paths.cache, `deepseek-files-${createRandomUUID()}`);
  directory.create();
  const dispose = () => {
    try { directory.delete(); }
    catch { console.warn('[DeepSeekImport] 临时附件目录清理失败'); }
  };
  let remainingBytes = TOTAL_FILE_BYTES;
  try {
    for (const source of sources) {
      throwIfAbortSignalAborted(signal);
      const attachment: UnavailableChatAttachment = {
        id: createRandomUUID(),
        type: source.isImage ? 'image' : 'file',
        source: 'document',
        fileName: source.fileName,
        fileSize: source.fileSize,
        width: source.width,
        height: source.height,
        unavailable: true,
      };
      files.set(source, attachment);
      if (!source.archivePath || remainingBytes === 0) continue;
      const { unavailable: _unavailable, ...metadata } = attachment;
      const file = new File(directory, attachment.id);
      const size = await extractFile(source.archivePath, file.uri, Math.min(FILE_BYTES, remainingBytes));
      throwIfAbortSignalAborted(signal);
      remainingBytes -= size ?? (file.exists ? file.size : 0);
      if (size !== null) {
        try {
          if (source.isImage) {
            const image = await inspectLocalImage(file.uri, { maxByteSize: FILE_BYTES });
            const fileName = `${metadata.fileName.replace(/\.[^.]+$/, '')}.${IMAGE_EXTENSIONS[image.mimeType]}`;
            files.set(source, { ...metadata, fileName, localUri: file.uri, mimeType: image.mimeType,
              fileSize: image.byteSize, width: image.width, height: image.height });
          } else {
            const mimeType = /\.html?$/i.test(metadata.fileName) ? 'text/html' : 'application/octet-stream';
            files.set(source, { ...metadata, localUri: file.uri, mimeType, fileSize: size });
          }
          continue;
        } catch (error) {
          if (!(error instanceof ImageFileReadError)) throw error;
        }
      }
      if (file.exists) file.delete();
    }
    return { files, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
