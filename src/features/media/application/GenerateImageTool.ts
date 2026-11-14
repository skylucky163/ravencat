import type { AgentToolExecutionContext, AgentToolExecutionResult, ToolDefinition } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { aiImageRuntime } from './AIImageRuntime';
import { ImageGenerationModelError } from './ImageGenerationModels';
import { IMAGE_GENERATION_PROMPT_MAX_LENGTH, ImageGenerationFailure, prepareGeneratedImage, type ImageGenerationRunOptions } from './PrepareGeneratedImage';
import { createMediaAssetWithReference, resolveMediaAsset } from './MediaAssetRuntime';
import { inspectLocalImage } from '@platform/device';
import { IMAGE_ASPECT_RATIOS, type ImageAspectRatio, type ImageResolution } from '@platform/ai/imageGenerationConfig';
import { MEDIA_ASSET_STORAGE_BACKEND } from './MediaAssetBacking';
import { mediaImageFailure } from './MediaImageToolResult';

export const GenerateImageTool = {
  name: 'generate_image',
  definition: {
    name: 'generate_image',
    description: '使用「AI 生图」页面当前选择的模型，按提示词生成一张图片，可能产生第三方费用。成功只表示已存入角色自己的私有媒体库，不等于已发送或已看过。返回 mediaAssetId 可作为 send_image 的 media_asset_id 发送，或交给 view_image 查看。未选择或配置失效会明确失败，不自动换模型。',
    parameters: { type: 'object', properties: {
      prompt: { type: 'string', minLength: 1, maxLength: IMAGE_GENERATION_PROMPT_MAX_LENGTH },
      file_name: { type: 'string', minLength: 1, maxLength: 120, description: '只用于显示，不作为文件路径。省略时根据真实图片格式命名。' },
      aspect_ratio: { type: 'string', enum: [...IMAGE_ASPECT_RATIOS], description: '期望图片比例；仅支持所选供应商的参数，不支持时明确失败。' },
      resolution: { type: 'string', enum: ['1K', '1.5K', '2K', '4K'], description: '清晰度档位；支持范围取决于当前模型，省略使用模型默认。' },
      reference_media_asset_id: { type: 'string', minLength: 1, maxLength: 120, description: '可选人物或主体参考图的媒体 ID；需要当前生图模型支持参考图，不保证完全一致。' },
    }, required: ['prompt'], additionalProperties: false },
  } satisfies ToolDefinition,
  async execute(input: { prompt: string; file_name?: string; aspect_ratio?: ImageAspectRatio; resolution?: ImageResolution; reference_media_asset_id?: string }, context: AgentToolExecutionContext): Promise<AgentToolExecutionResult<unknown>> {
    try {
      throwIfAbortSignalAborted(context.abortSignal);
      let reference: ImageGenerationRunOptions['reference'];
      if (input.reference_media_asset_id) {
        const resolved = await resolveMediaAsset(input.reference_media_asset_id);
        const inspected = await inspectLocalImage(resolved.localUri);
        reference = { uri: resolved.localUri, mimeType: inspected.mimeType, width: inspected.width, height: inspected.height, byteSize: inspected.byteSize };
      }
      const image = await prepareGeneratedImage(input.prompt, context.abortSignal, input.file_name,
        { parameters: { aspectRatio: input.aspect_ratio, resolution: input.resolution }, reference });
      try {
        throwIfAbortSignalAborted(context.abortSignal);
        const runtime = aiImageRuntime.get();
        const result = await createMediaAssetWithReference({ sourceUri: image.uri, fileName: image.fileName, mimeType: image.mimeType,
          width: image.width, height: image.height, durationMs: null, storageBackend: MEDIA_ASSET_STORAGE_BACKEND.persistentMedia },
        async ({ transaction, asset }) => {
          await runtime.assertCurrent(transaction, context);
          await runtime.generated.addInTransaction(transaction, { assistantId: context.task.assistantId, mediaAssetId: asset.id, fileName: image.fileName });
        });
        const data = { mediaAssetId: result.asset.id, fileName: image.fileName, mimeType: image.mimeType, width: image.width, height: image.height };
        return { status: 'success', data, modelContent: JSON.stringify(data) };
      } finally { image.cleanup(); }
    } catch (error) {
      if (error instanceof ImageGenerationFailure || error instanceof ImageGenerationModelError) return {
        status: 'error', code: error.code, modelContent: error.message, retryable: error instanceof ImageGenerationFailure && error.retryable,
      };
      const failure = mediaImageFailure(error);
      if (failure) return failure;
      throw error;
    }
  },
};
