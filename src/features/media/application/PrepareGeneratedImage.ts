import { File, Paths } from 'expo-file-system';
import { createRandomUUID, ImageFileReadError, inspectLocalImage, readLocalImageAsBase64 } from '@platform/device';
import { downloadWebImage } from '@platform/web';
import { generateImage } from '@platform/ai';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { resolveImageGenerationModel } from './ImageGenerationModels';
import { getImageGenerationCapabilities, validateImageGenerationParameters, validateImageGenerationReference, type ImageGenerationParameters, type ImageGenerationReferenceInfo } from '@platform/ai/imageGenerationConfig';
import type { ImageGenerationPreview } from '@platform/ai/ImageGenerationStream';

export interface ImageGenerationProgress {
  stage: 'preparing' | 'generating' | 'downloading' | 'checking' | 'saving';
  preview?: ImageGenerationPreview;
}
export interface ImageGenerationRunOptions {
  parameters?: ImageGenerationParameters;
  reference?: { uri: string } & ImageGenerationReferenceInfo;
  onProgress?(progress: ImageGenerationProgress): void;
}

export const IMAGE_GENERATION_PROMPT_MAX_LENGTH = 2_000;
export class ImageGenerationFailure extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable: boolean) { super(message); }
}
export interface PreparedGeneratedImage {
  uri: string; fileName: string; mimeType: string; width: number; height: number; byteSize: number;
  cleanup(): void;
}
export function cleanupGeneratedImage(uri: string): void {
  try { new File(uri).delete(); } catch (error) { console.warn('[AIImage] 生图暂存文件清理失败：', error); }
}
export async function prepareGeneratedImage(prompt: string, signal: AbortSignal, fileName?: string, options: ImageGenerationRunOptions = {}): Promise<PreparedGeneratedImage> {
  throwIfAbortSignalAborted(signal);
  const text = prompt.trim();
  if (!text) throw new ImageGenerationFailure('IMAGE_GENERATION_PROMPT_REQUIRED', '请输入生图提示词', false);
  if (text.length > IMAGE_GENERATION_PROMPT_MAX_LENGTH) throw new ImageGenerationFailure('IMAGE_GENERATION_PROMPT_TOO_LONG', `提示词不能超过 ${IMAGE_GENERATION_PROMPT_MAX_LENGTH} 字`, false);
  const model = await resolveImageGenerationModel();
  const capabilities = getImageGenerationCapabilities(model.profile, model.model);
  if (text.length > capabilities.promptMaxLength) throw new ImageGenerationFailure('IMAGE_GENERATION_PROMPT_TOO_LONG', `当前模型的提示词不能超过 ${capabilities.promptMaxLength} 字`, false);
  const parameterError = validateImageGenerationParameters(capabilities, options.parameters ?? {}, options.reference !== undefined);
  if (parameterError) throw new ImageGenerationFailure('IMAGE_GENERATION_PARAMETERS_UNSUPPORTED', parameterError, false);
  options.onProgress?.({ stage: 'preparing' });
  const referenceError = options.reference ? validateImageGenerationReference(model.profile, options.reference) : null;
  if (referenceError) throw new ImageFileReadError(referenceError);
  const reference = options.reference ? { ...options.reference, base64: await readLocalImageAsBase64(options.reference.uri) } : undefined;
  throwIfAbortSignalAborted(signal);
  options.onProgress?.({ stage: 'generating' });
  const result = await generateImage(model, text, signal, { parameters: options.parameters, reference,
    ...(options.onProgress && capabilities.preview ? { onPreview: (preview: ImageGenerationPreview) => {
      throwIfAbortSignalAborted(signal); options.onProgress!({ stage: 'generating', preview });
    } } : {}) });
  if (result.success === false) throw new ImageGenerationFailure(result.code, result.error, result.retryable);
  throwIfAbortSignalAborted(signal);
  let uri: string;
  if (result.image.kind === 'url') {
    options.onProgress?.({ stage: 'downloading' });
    const download = await downloadWebImage(result.image.url, null, signal);
    if (download.ok === false) throw new ImageGenerationFailure(download.error.code, download.error.message, false);
    uri = download.data.uri;
  } else {
    const file = new File(Paths.cache, `generated-${createRandomUUID()}`);
    uri = file.uri;
    try { file.write(result.image.base64, { encoding: 'base64' }); }
    catch (error) { cleanupGeneratedImage(uri); throw new ImageFileReadError('生成图片无法写入暂存文件', { cause: error }); }
  }
  try {
    throwIfAbortSignalAborted(signal);
    options.onProgress?.({ stage: 'checking' });
    const image = await inspectLocalImage(uri);
    throwIfAbortSignalAborted(signal);
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[image.mimeType];
    return { uri, fileName: fileName ?? `generated-${createRandomUUID()}.${ext}`, mimeType: image.mimeType, width: image.width, height: image.height, byteSize: image.byteSize,
      cleanup: () => cleanupGeneratedImage(uri) };
  } catch (error) { cleanupGeneratedImage(uri); throw error; }
}
