import { saveImageToGallery } from '@platform/device';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { prepareGeneratedImage, type PreparedGeneratedImage, type ImageGenerationRunOptions } from './PrepareGeneratedImage';

export type UserGeneratedImage = { status: 'saved'; uri: string; width: number; height: number; byteSize: number } | { status: 'save_failed'; image: PreparedGeneratedImage; error: string };
export async function saveUserGeneratedImage(image: PreparedGeneratedImage, signal: AbortSignal, onProgress?: ImageGenerationRunOptions['onProgress']): Promise<UserGeneratedImage> {
  try {
    throwIfAbortSignalAborted(signal);
    onProgress?.({ stage: 'saving' });
    const saved = await saveImageToGallery(image.uri, image.mimeType, signal);
    image.cleanup();
    return { status: 'saved', uri: saved.uri, width: image.width, height: image.height, byteSize: image.byteSize };
  } catch (error) {
    if (signal.aborted) { image.cleanup(); throwIfAbortSignalAborted(signal); }
    return { status: 'save_failed', image, error: error instanceof Error ? error.message : String(error) };
  }
}
/** 用户生图只经过暂存与相册，不创建私有媒体身份或业务记录。 */
export async function generateImageForUser(prompt: string, signal: AbortSignal, options: ImageGenerationRunOptions = {}): Promise<UserGeneratedImage> {
  return saveUserGeneratedImage(await prepareGeneratedImage(prompt, signal, undefined, options), signal, options.onProgress);
}
