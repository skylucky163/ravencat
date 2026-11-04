import { mediaImageFailure, resolveMediaAsset } from '@features/media';
import { COMPLETION_INTENT_PARAMETER } from '@shared/aiTools';
import type { AgentToolExecutionContext, AgentToolExecutionResult, ToolDefinition } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import type { MediaAssetChatAttachment } from '../../messages/domain/ChatAttachment';

const IMAGE_SEND_INTENT_DISCRIMINATOR = 'ravencat.chat.image.send.v1' as const;

export interface ImageSendIntent {
  discriminator: typeof IMAGE_SEND_INTENT_DISCRIMINATOR;
  attachment: MediaAssetChatAttachment;
}

/** 工具只准备已有素材的消息引用，发送事实由 Chat 在当前回合 fence 内提交。 */
export const SendImageTool = {
  name: 'send_image',
  definition: {
    name: 'send_image',
    description: '将一张图片作为真实图片消息发送到当前单聊或群聊，用户可点击查看原图。网络图片先用 download_image 下载，再传入返回的 mediaAssetId；也可复用消息或 query_downloaded_images 中的图片 ID。一次调用发送一张，可连续调用发送多张。图片可以单独构成完整回复。',
    parameters: {
      type: 'object',
      properties: {
        media_asset_id: { type: 'string', minLength: 1, maxLength: 120, description: '已有图片的 mediaAssetId，不能传 URL 或本地路径' },
        file_name: { type: 'string', minLength: 1, maxLength: 120, description: '图片消息显示的文件名，省略时按素材 ID 命名' },
        on_success: COMPLETION_INTENT_PARAMETER,
      },
      required: ['media_asset_id', 'on_success'],
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    input: { media_asset_id: string; file_name?: string; on_success: 'finish' | 'continue' },
    context: AgentToolExecutionContext,
  ): Promise<AgentToolExecutionResult<ImageSendIntent>> {
    throwIfAbortSignalAborted(context.abortSignal);
    try {
      const { asset } = await resolveMediaAsset(input.media_asset_id);
      // 素材字节由 Media 导入边界验证；这里仅裁决素材类型，不重复解码或复制文件。
      if (!asset.mimeType.startsWith('image/')) {
        return { status: 'error', code: 'IMAGE_REQUIRED', retryable: false, modelContent: '图片尚未发送：这个素材不是图片，请使用图片的 mediaAssetId。' };
      }
      throwIfAbortSignalAborted(context.abortSignal);
      return {
        status: 'success',
        data: {
          discriminator: IMAGE_SEND_INTENT_DISCRIMINATOR,
          attachment: {
            id: `ai-image-${context.toolCallId}`,
            type: 'image',
            source: 'media_library',
            mediaAssetId: asset.id,
            fileName: input.file_name ?? `image-${asset.id}`,
            mimeType: asset.mimeType,
            fileSize: asset.byteSize,
            width: asset.width,
            height: asset.height,
            parseStatus: 'skipped',
          },
        },
        metadata: { fulfillsUserVisibleOutput: true, completionIntent: input.on_success },
        modelContent: '图片消息已准备，由 Chat 按当前回合策略提交与交付。无需重复发送或补充“已发送”。',
      };
    } catch (error) {
      const failure = mediaImageFailure(error);
      if (failure) return failure;
      throw error;
    }
  },
};

export function isImageSendIntent(value: unknown): value is ImageSendIntent {
  return (value as ImageSendIntent | null)?.discriminator === IMAGE_SEND_INTENT_DISCRIMINATOR;
}
