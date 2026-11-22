import type { AgentToolExecutionContext, AgentToolExecutionResult, JsonSchema, ToolDefinition } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { aiImageRuntime } from './AIImageRuntime';
import { ImageGenerationModelError, resolveImageGenerationModel } from './ImageGenerationModels';
import { IMAGE_GENERATION_PROMPT_MAX_LENGTH, ImageGenerationFailure, prepareGeneratedImage, type ImageGenerationRunOptions } from './PrepareGeneratedImage';
import { createMediaAssetWithReference, resolveMediaAsset } from './MediaAssetRuntime';
import { inspectLocalImage } from '@platform/device';
import { getImageGenerationCapabilities, type ImageGenerationParameters } from '@platform/ai/imageGenerationConfig';
import type { ImageGenerationConnection } from '@platform/ai/ImageGenerationRequest';
import { MEDIA_ASSET_STORAGE_BACKEND } from './MediaAssetBacking';
import { mediaImageFailure } from './MediaImageToolResult';

interface GenerateImageInput {
  prompt: string;
  file_name?: string;
  aspect_ratio?: ImageGenerationParameters['aspectRatio'];
  resolution?: ImageGenerationParameters['resolution'];
  quality?: ImageGenerationParameters['quality'];
  output_format?: ImageGenerationParameters['outputFormat'];
  output_compression?: ImageGenerationParameters['outputCompression'];
  reference_media_asset_id?: string;
}

const definition: ToolDefinition = {
  name: 'generate_image',
  description: '使用「AI 生图」中选定的模型生成一张图片。图片存入自己的私有媒体库，返回可用于查看或发送的 mediaAssetId。',
  parameters: { type: 'object', properties: {
    prompt: { type: 'string', minLength: 1, maxLength: IMAGE_GENERATION_PROMPT_MAX_LENGTH },
    file_name: { type: 'string', minLength: 1, maxLength: 120, description: '用于显示与之后按关键词找回图片，不作为文件路径；建议取有意义的名字，如“雪山日落.png”。省略时根据真实图片格式自动命名。' },
  }, required: ['prompt'], additionalProperties: false },
};

export const GenerateImageTool = {
  name: definition.name,
  definition,
  async execute(input: GenerateImageInput, context: AgentToolExecutionContext, modelSnapshot?: ImageGenerationConnection): Promise<AgentToolExecutionResult<unknown>> {
    try {
      throwIfAbortSignalAborted(context.abortSignal);
      const model = modelSnapshot ?? await resolveImageGenerationModel();
      const custom = model.profile.provider === 'customOpenAIImages';
      let reference: ImageGenerationRunOptions['reference'];
      if (!custom && input.reference_media_asset_id) {
        const resolved = await resolveMediaAsset(input.reference_media_asset_id);
        const inspected = await inspectLocalImage(resolved.localUri);
        reference = { uri: resolved.localUri, mimeType: inspected.mimeType, width: inspected.width, height: inspected.height, byteSize: inspected.byteSize };
      }
      const image = await prepareGeneratedImage(input.prompt, context.abortSignal, input.file_name,
        { parameters: custom ? {} : { aspectRatio: input.aspect_ratio, resolution: input.resolution, quality: input.quality,
          outputFormat: input.output_format, outputCompression: input.output_compression }, reference }, model);
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

/** 一次运行的参数定义与计费请求共用模型快照，切换模型只影响下一次运行。 */
export async function createConfiguredGenerateImageTool(): Promise<typeof GenerateImageTool> {
  let model: ImageGenerationConnection;
  try { model = await resolveImageGenerationModel(); }
  catch (error) {
    if (!(error instanceof ImageGenerationModelError)) throw error;
    return { ...GenerateImageTool,
      definition: { ...GenerateImageTool.definition, description: `${GenerateImageTool.definition.description}当前不可用：${error.message}。` },
      async execute(_input, context) {
        throwIfAbortSignalAborted(context.abortSignal);
        return { status: 'error', code: error.code, modelContent: error.message, retryable: false };
      },
    };
  }
  const capabilities = getImageGenerationCapabilities(model.profile, model.model);
  const properties: Record<string, JsonSchema> = {
    ...GenerateImageTool.definition.parameters.properties,
    prompt: { type: 'string', minLength: 1, maxLength: capabilities.promptMaxLength },
  };
  if (capabilities.aspectRatios.length > 0) properties.aspect_ratio = {
    type: 'string', enum: [...capabilities.aspectRatios], description: '本次图片比例，省略使用模型默认。',
  };
  if (capabilities.resolutions.length > 0) properties.resolution = {
    type: 'string', enum: [...capabilities.resolutions], description: '本次清晰度档位，省略使用模型默认。',
  };
  if (capabilities.quality) properties.quality = {
    type: 'string', enum: ['low', 'medium', 'high'], description: '渲染画质：low 快速、medium 均衡、high 精细；省略为自动。',
  };
  if (capabilities.outputFormat) {
    properties.output_format = { type: 'string', enum: ['png', 'jpeg', 'webp'], description: '本次图片文件格式，省略使用服务默认。' };
    properties.output_compression = { type: 'integer', enum: [100, 80, 60], description: '压缩质量：100 细节优先、80 均衡体积、60 较小体积；仅在 output_format 为 jpeg 或 webp 时使用，省略使用服务默认。' };
  }
  if (capabilities.references) properties.reference_media_asset_id = {
    type: 'string', minLength: 1, maxLength: 120,
    description: '一张人物或主体参考图的媒体 ID，可用聊天图片、download_image 或 generate_image 返回的 mediaAssetId；不是网址或文件路径，不保证完全一致。',
  };
  return { ...GenerateImageTool,
    definition: { ...GenerateImageTool.definition,
      description: `${GenerateImageTool.definition.description}本次使用模型 ${model.model}；只支持下列已列出的参数与选项，省略可选参数使用模型默认。`,
      parameters: { ...GenerateImageTool.definition.parameters, properties,
        required: capabilities.referenceRequired ? ['prompt', 'reference_media_asset_id'] : ['prompt'] },
    },
    execute: (input, context) => GenerateImageTool.execute(input, context, model),
  };
}
