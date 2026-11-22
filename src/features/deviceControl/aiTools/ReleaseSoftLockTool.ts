/** 主理 AI 释放自己创建的指定目标 Soft Lock。 */

import { runAsCurrentHostAuthority } from '@features/assistants';
import type { ToolContext, ToolExecuteResult } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { releaseAiSoftLock } from '../application/DeviceControl';

export interface ReleaseSoftLockArgs {
  target_package: string;
}

export const definition = {
  name: 'release_soft_lock',
  description: '释放自己通过 soft_lock_app 创建的有效锁',
  parameters: {
    type: 'object',
    properties: {
      target_package: {
        type: 'string',
        description: '要解除限制的精确 Android package name',
        minLength: 1,
        pattern: '^\\S+$',
      },
    },
    required: ['target_package'],
    additionalProperties: false,
  },
} as const;

export async function execute(
  args: ReleaseSoftLockArgs,
  context: ToolContext,
): Promise<ToolExecuteResult> {
  const actorAiId = context.getAIId();
  if (!actorAiId) {
    return { success: false, error: 'missing_actor_ai_id: 未识别到当前 AI 身份' };
  }

  const authorityResult = await runAsCurrentHostAuthority(actorAiId, () => {
    throwIfAbortSignalAborted(context.abortSignal);
    return releaseAiSoftLock(
      {
        targetPackage: args.target_package,
        sourceAiId: actorAiId,
      },
      context.abortSignal,
    );
  });
  if (authorityResult.status === 'not_current_host') {
    return { success: false, error: 'not_current_host: 当前 AI 已不再是主理 AI' };
  }

  const result = authorityResult.value;
  if (result.status === 'not_found') {
    return {
      success: true,
      message: `未找到当前主理 AI 为 ${args.target_package} 创建的有效 Soft Lock。`,
      data: {
        businessStatus: result.status,
        targetPackage: args.target_package,
        native: result.native,
      },
    };
  }

  return {
    success: true,
    message: `已释放 Soft Lock ${result.lock.id}，目标 ${result.lock.targetPackage}。`,
    data: {
      businessStatus: result.status,
      lockId: result.lock.id,
      targetPackage: result.lock.targetPackage,
      native: result.native,
    },
  };
}

export const ReleaseSoftLockTool = {
  name: definition.name,
  definition,
  execute,
};
