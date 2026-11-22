import type { AgentToolExecutionContext, AgentToolExecutionResult, ToolDefinition } from '@shared/aiTools';
import { mediaImageFailure } from '@features/media';
import { StickerLibraryFullError, StickerNotFoundError } from '../domain/Sticker';
import { addAISticker, maintainAISticker, AIStickerCommandError } from '../application/AIStickerCommands';

async function execute(command: () => Promise<unknown>): Promise<AgentToolExecutionResult<unknown>> {
  try {
    const data = await command();
    return { status: 'success', data, modelContent: JSON.stringify(data) };
  } catch (error) {
    const media = mediaImageFailure(error);
    if (media) return media;
    if (error instanceof AIStickerCommandError || error instanceof StickerLibraryFullError || error instanceof StickerNotFoundError) {
      return { status: 'error', code: error instanceof AIStickerCommandError ? error.code : error.name,
        retryable: false, modelContent: error.message };
    }
    throw error;
  }
}

export const AddOwnStickerTool = {
  name: 'add_own_sticker',
  definition: {
    name: 'add_own_sticker', description: '收藏一张静态图片到自己的表情库。',
    parameters: { type: 'object', properties: {
      media_asset_id: { type: 'string', minLength: 1, maxLength: 120, description: '聊天图片或 download_image 返回的 mediaAssetId' },
      name: { type: 'string', minLength: 1, maxLength: 120, description: '可选初始名称，识别成功后使用标准标注名称' },
    }, required: ['media_asset_id'], additionalProperties: false },
  } satisfies ToolDefinition,
  execute: (input: Parameters<typeof addAISticker>[0], context: AgentToolExecutionContext) => execute(() => addAISticker(input, context)),
};

export const MaintainOwnStickerTool = {
  name: 'maintain_own_sticker',
  definition: {
    name: 'maintain_own_sticker', description: '维护自己的表情收藏。inspect 查询状态；recognize 显式识别一次；embed 用现有语义显式向量化一次；edit 修正语义（必须给出 description，不自动向量化）；delete 删除自己的收藏。用户收藏不能修改。识别错误可先 view_image 核实再 edit。',
    parameters: { type: 'object', properties: {
      sticker_id: { type: 'string', minLength: 1, maxLength: 120 },
      action: { type: 'string', enum: ['inspect', 'recognize', 'embed', 'edit', 'delete'] },
      name: { type: 'string', minLength: 1, maxLength: 120 },
      description: { type: 'string', minLength: 1, maxLength: 500 },
      tags: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 40 } },
      emotion: { type: 'string', maxLength: 40 },
    }, required: ['sticker_id', 'action'], additionalProperties: false },
  } satisfies ToolDefinition,
  execute: (input: Parameters<typeof maintainAISticker>[0], context: AgentToolExecutionContext) => execute(() => maintainAISticker(input, context)),
};
