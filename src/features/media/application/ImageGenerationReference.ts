import { inspectLocalImage, selectChatImages } from '@platform/device';
import { File } from 'expo-file-system';
import type { ImageGenerationReferenceInfo } from '@platform/ai/imageGenerationConfig';
export interface ImageGenerationReferenceSelection extends ImageGenerationReferenceInfo { uri: string }

/** 相册选择器交付应用缓存副本；这里只持有一次生成的临时输入，不登记 MediaAsset。 */
export async function pickImageGenerationReference(): Promise<ImageGenerationReferenceSelection | null> {
  const selected = await selectChatImages(1);
  if (!selected) return null;
  const source = selected[0];
  try { const image = await inspectLocalImage(source.uri); return { uri: source.uri, mimeType: image.mimeType, width: image.width, height: image.height, byteSize: image.byteSize }; }
  catch (error) { releaseImageGenerationReference(source); throw error; }
}
export function releaseImageGenerationReference(reference: { uri: string }): void {
  try { new File(reference.uri).delete(); } catch (error) { console.warn('[AIImage] 参考图缓存清理失败：', error); }
}
