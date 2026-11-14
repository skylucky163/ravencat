import { nativeGalleryWriter } from '../../../modules/gallery-writer';
import { createRandomUUID } from './randomUUID';
import { inspectMediaFileContent } from './MediaFileContent';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';

/** 原图已经由文件入口检查；这里只负责命名、取消与写入系统相册。 */
export async function saveImageToGallery(uri: string, mimeType: string, signal: AbortSignal): Promise<{ uri: string; fileName: string }> {
  throwIfAbortSignalAborted(signal);
  const { contentHash } = await inspectMediaFileContent(uri);
  throwIfAbortSignalAborted(signal);
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[mimeType];
  const id = createRandomUUID();
  nativeGalleryWriter.begin(id);
  const abort = () => nativeGalleryWriter.cancel(id);
  signal.addEventListener('abort', abort, { once: true });
  try { return await nativeGalleryWriter.save(id, uri, mimeType, `ravencat-${stamp}-${contentHash.slice(0, 8)}.${ext}`); }
  catch (error) { throwIfAbortSignalAborted(signal); throw error; }
  finally { signal.removeEventListener('abort', abort); }
}
