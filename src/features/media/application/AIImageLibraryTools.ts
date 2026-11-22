import { databaseCoordinator } from '@platform/persistence';
import type { AgentToolExecutionContext, AgentToolExecutionResult, ToolDefinition } from '@shared/aiTools';
import { aiImageRuntime } from './AIImageRuntime';
import { releaseMediaAssetCandidates } from './MediaAssetRuntime';

type ImageTarget = { media_asset_id: string };
type ImageChange = { kind: 'rename'; fileName: string } | { kind: 'delete' };

const mediaIdParameter = { type: 'string', minLength: 1, maxLength: 120, description: '图片的 mediaAssetId，可从查询或其他图片工具取得。' };

async function changeOwnImage(
  mediaAssetId: string,
  change: ImageChange,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult<unknown>> {
  const { downloads, generated, assertCurrent } = aiImageRuntime.get();
  const { assistantId } = context.task;
  const affected = await databaseCoordinator.transaction({
    name: `media.${change.kind}-own-image`, feature: 'media', priority: 'interactive',
  }, async transaction => {
    await assertCurrent(transaction, context);
    // 两个库按媒体 ID 展示，重复保存的记录也一起更新，避免旧名称或已删除条目再次出现。
    let total = 0;
    for (const repository of [downloads, generated]) {
      total += change.kind === 'rename'
        ? await repository.renameInTransaction(transaction, assistantId, mediaAssetId, change.fileName)
        : await repository.deleteInTransaction(transaction, assistantId, mediaAssetId);
    }
    return total;
  });
  if (affected === 0) return {
    status: 'error', code: 'OWN_IMAGE_NOT_FOUND', retryable: false,
    modelContent: '自己的下载库和生图库中都没有这张图片的保存记录。',
  };

  if (change.kind === 'delete') await releaseMediaAssetCandidates([mediaAssetId]);
  const data = change.kind === 'rename'
    ? { mediaAssetId, fileName: change.fileName }
    : { mediaAssetId, deleted: true };
  return { status: 'success', data, modelContent: JSON.stringify(data) };
}

export const RenameOwnImageTool = {
  name: 'rename_own_image',
  definition: {
    name: 'rename_own_image',
    description: '用图片 ID 修改自己图库里的图片名称。系统在自己的下载库与生图库中查找并更新同一张图，后续可用新名称检索。改名只作用于自己的图库记录。',
    parameters: { type: 'object', properties: {
      media_asset_id: mediaIdParameter,
      file_name: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S', description: '图库新名称，用于显示和检索。' },
    }, required: ['media_asset_id', 'file_name'], additionalProperties: false },
  } satisfies ToolDefinition,
  execute(input: ImageTarget & { file_name: string }, context: AgentToolExecutionContext) {
    return changeOwnImage(input.media_asset_id, { kind: 'rename', fileName: input.file_name.trim() }, context);
  },
};

export const DeleteOwnImageTool = {
  name: 'delete_own_image',
  definition: {
    name: 'delete_own_image',
    description: '用图片 ID 从自己的下载库与生图库移除一张图片。聊天、表情等已有引用继续保留，只有没有引用的私有图片文件才会被回收。',
    parameters: { type: 'object', properties: {
      media_asset_id: mediaIdParameter,
    }, required: ['media_asset_id'], additionalProperties: false },
  } satisfies ToolDefinition,
  execute(input: ImageTarget, context: AgentToolExecutionContext) {
    return changeOwnImage(input.media_asset_id, { kind: 'delete' }, context);
  },
};
