import { checkImageGenerationParameter } from '@platform/ai/ImageGenerationClient';
import type { ImageParameterCheck, ImageParameterCheckResult } from '@platform/ai/ImageGenerationParameterCheck';
import { ImageGenerationModelError, resolveImageGenerationModel, type CustomImageConnection } from './ImageGenerationModels';
import { stageGeneratedImage } from './PrepareGeneratedImage';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';

export async function checkSelectedImageParameter(connection: CustomImageConnection, check: ImageParameterCheck, signal: AbortSignal): Promise<ImageParameterCheckResult | null> {
  try {
    const model = await resolveImageGenerationModel(connection);
    const result = await checkImageGenerationParameter(model, check, signal, async (content, inspectionSignal) => {
      const image = await stageGeneratedImage(content, inspectionSignal);
      image.cleanup();
      return image;
    });
    // 模型中心的写入可能已提交，页面还在等待设置列表刷新。
    throwIfAbortSignalAborted(signal);
    await resolveImageGenerationModel(connection);
    return result;
  } catch (error) {
    if (error instanceof ImageGenerationModelError) return null;
    throw error;
  }
}
