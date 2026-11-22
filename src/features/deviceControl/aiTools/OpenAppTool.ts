/** 主理 AI 通过 exact Android package 派发普通应用启动请求。 */

import { runAsCurrentHostAuthority } from '@features/assistants';
import type { ToolContext, ToolExecuteResult } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { OpenAppError, openAppByPackage } from '../application/OpenApp';

export interface OpenAppArgs {
  package_name: string;
}

export const definition = {
  name: 'open_app',
  description: '打开本机应用；只派发普通前台启动请求，不执行应用内操作。',
  parameters: {
    type: 'object',
    properties: {
      package_name: {
        type: 'string',
        description: '目标应用的精确 Android package name；如不知道，请先调用 search_installed_apps',
        minLength: 1,
        pattern: '^\\S+$',
      },
    },
    required: ['package_name'],
    additionalProperties: false,
  },
} as const;

export async function execute(
  args: OpenAppArgs,
  context: ToolContext,
): Promise<ToolExecuteResult> {
  const actorAiId = context.getAIId();
  if (!actorAiId) {
    return {
      success: false,
      error: 'missing_actor_ai_id: 未识别到当前 AI 身份',
      errorCode: 'missing_actor_ai_id',
    };
  }

  try {
    const authorityResult = await runAsCurrentHostAuthority(actorAiId, async () => {
      throwIfAbortSignalAborted(context.abortSignal);
      return openAppByPackage(args.package_name);
    });

    if (authorityResult.status === 'not_current_host') {
      return {
        success: false,
        error: 'not_current_host: 当前 AI 已不再是主理 AI',
        errorCode: 'not_current_host',
      };
    }

    const result = authorityResult.value;
    return {
      success: true,
      message: [
        `launch_dispatched: 已向 Android 派发打开 ${result.targetPackage} 的启动请求。`,
        '该结果不代表已同步确认目标应用进入前台；如需确认，可再调用 get_foreground_app。',
      ].join('\n'),
      data: result,
    };
  } catch (error) {
    if (!(error instanceof OpenAppError)) throw error;
    return {
      success: false,
      error: `${error.reason}: ${failureMessage(error.reason)}`,
      errorCode: error.reason,
    };
  }
}

function failureMessage(reason: OpenAppError['reason']): string {
  switch (reason) {
    case 'invalid_target_package':
      return '必须提供精确 Android package name；如不知道，请先调用 search_installed_apps。';
    case 'protected_app':
      return '目标应用受保护，不能执行打开操作。';
    case 'app_not_launchable':
      return '目标 package 的 front-door 启动入口当前无法执行；如 package 可能不正确，可调用 search_installed_apps 重新确认。';
    case 'launch_failed':
      return 'Android 应用启动请求派发失败。';
  }
}

export const OpenAppTool = {
  name: definition.name,
  definition,
  execute,
};
