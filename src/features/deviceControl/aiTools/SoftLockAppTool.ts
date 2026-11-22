/** 主理 AI 通过 Agent Runtime 创建限时 Soft Lock 的工具边界。 */

import { runAsCurrentHostAuthority } from '@features/assistants';
import {
  assertProtectedAppCapabilityAllowed,
  loadCurrentProtectedPackages,
  ProtectedAppsPolicyError,
} from '@features/phoneTools';
import type { ToolContext, ToolExecuteResult } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { activateAiSoftLock } from '../application/DeviceControl';
import type { ActivateAiSoftLockResult } from '../application/DeviceControlFacade';

export interface SoftLockAppArgs {
  target_package: string;
  duration_seconds: number;
  reason?: string;
}

type SuccessfulActivateAiSoftLockResult = Exclude<
  ActivateAiSoftLockResult,
  { status: 'rejected' }
>;

export type SoftLockAppResultData = {
  businessStatus: SuccessfulActivateAiSoftLockResult['status'];
  lockId: string;
  targetPackage: string;
  expiresAtEpochMs: number;
  native: {
    synchronization: SuccessfulActivateAiSoftLockResult['native'];
    runtimeState: SuccessfulActivateAiSoftLockResult['runtimeState'];
  };
} & (
  | { executionState: 'blocking_now' | 'waiting_for_target' }
  | {
      executionState: 'activated_but_not_executing';
      executionIssue: Extract<
        SuccessfulActivateAiSoftLockResult['execution'],
        { state: 'activated_but_not_executing' }
      >['issue'];
    }
);

export const definition = {
  name: 'soft_lock_app',
  description: '创建限时 Soft Lock 业务锁，到时自动解除',
  parameters: {
    type: 'object',
    properties: {
      target_package: {
        type: 'string',
        description: '要限制的精确 Android package name，例如 com.example.app',
        minLength: 1,
        pattern: '^\\S+$',
      },
      duration_seconds: {
        type: 'integer',
        description: 'Soft Lock 持续秒数，必须明确提供且大于 0',
        minimum: 1,
      },
      reason: {
        type: 'string',
        description: '可选的锁定原因，仅用于业务来源记录',
      },
    },
    required: ['target_package', 'duration_seconds'],
    additionalProperties: false,
  },
} as const;

export async function execute(
  args: SoftLockAppArgs,
  context: ToolContext,
): Promise<ToolExecuteResult> {
  const targetPackage = args.target_package;
  if (
    typeof targetPackage !== 'string'
    || targetPackage.length === 0
    || /\s/u.test(targetPackage)
  ) {
    return { success: false, error: 'invalid_target_package: 必须提供不含空白的精确 Android package name' };
  }

  const durationSeconds = args.duration_seconds;
  if (
    typeof durationSeconds !== 'number'
    || !Number.isFinite(durationSeconds)
    || !Number.isInteger(durationSeconds)
    || durationSeconds <= 0
  ) {
    return { success: false, error: 'invalid_duration_seconds: duration_seconds 必须是大于 0 的有限整数' };
  }

  if (args.reason !== undefined && typeof args.reason !== 'string') {
    return { success: false, error: 'invalid_reason: reason 必须是字符串' };
  }
  const trimmedReason = args.reason?.trim();
  const actorAiId = context.getAIId();
  if (!actorAiId) {
    return { success: false, error: 'missing_actor_ai_id: 未识别到当前 AI 身份' };
  }

  try {
    const authorityResult = await runAsCurrentHostAuthority(actorAiId, async () => {
      throwIfAbortSignalAborted(context.abortSignal);
      const protectedPackages = await loadCurrentProtectedPackages();
      assertProtectedAppCapabilityAllowed(
        targetPackage,
        protectedPackages,
        'action',
      );
      const expiresAtEpochMs = Date.now() + durationSeconds * 1000;
      return activateAiSoftLock(
        {
          targetPackage,
          sourceAiId: actorAiId,
          reason: trimmedReason || undefined,
          expiresAtEpochMs,
        },
        context.abortSignal,
      );
    });

    if (authorityResult.status === 'not_current_host') {
      return { success: false, error: 'not_current_host: 当前 AI 已不再是主理 AI' };
    }

    const result = authorityResult.value;
    if (result.status === 'rejected') {
      return {
        success: false,
        error: `rejected: Soft Lock 业务命令拒绝执行（${result.reason}）`,
      };
    }

    return {
      success: true,
      message: buildResultMessage(result),
      data: buildResultData(result),
    };
  } catch (error) {
    if (!(error instanceof ProtectedAppsPolicyError)) throw error;
    return {
      success: false,
      error: `${error.reason}: ${error.message}`,
      errorCode: error.reason,
    };
  }
}

export const SoftLockAppTool = {
  name: definition.name,
  definition,
  execute,
};

function buildResultMessage(
  result: SuccessfulActivateAiSoftLockResult,
): string {
  const businessFact = result.status === 'activated'
    ? 'Soft Lock 业务锁已创建'
    : '已存在相同的有效 Soft Lock 业务锁';
  const lockFact = `${businessFact}：${result.lock.id}，目标 ${result.lock.targetPackage}，到期时间 ${result.lock.expiresAtEpochMs}。`;
  const typedTruth = `businessStatus: ${result.status}\nexecutionState: ${result.execution.state}`;

  if (result.execution.state === 'blocking_now') {
    return `${typedTruth}\n${lockFact}\n目标 App 当前可靠匹配，阻断层已生效。`;
  }
  if (result.execution.state === 'waiting_for_target') {
    return `${typedTruth}\n${lockFact}\n目标 App 当前不在前台；当前无需显示阻断层。`;
  }

  return `${typedTruth}\nexecutionIssue: ${result.execution.issue}\n${lockFact}\n业务锁仍然 active，但当前无法执行阻断：${executionIssueMessage(result.execution.issue)}`;
}

function buildResultData(
  result: SuccessfulActivateAiSoftLockResult,
): SoftLockAppResultData {
  const common = {
    businessStatus: result.status,
    lockId: result.lock.id,
    targetPackage: result.lock.targetPackage,
    expiresAtEpochMs: result.lock.expiresAtEpochMs,
    native: {
      synchronization: result.native,
      runtimeState: result.runtimeState,
    },
  };

  return result.execution.state === 'activated_but_not_executing'
    ? {
        ...common,
        executionState: result.execution.state,
        executionIssue: result.execution.issue,
      }
    : { ...common, executionState: result.execution.state };
}

function executionIssueMessage(issue: Extract<
  SuccessfulActivateAiSoftLockResult['execution'],
  { state: 'activated_but_not_executing' }
>['issue']): string {
  switch (issue) {
    case 'background_start_restricted':
      return 'Android 不允许从当前后台状态首次启动 Device Control runtime。';
    case 'runtime_unavailable':
      return 'Device Control runtime 当前不可用。';
    case 'overlay_permission_missing':
      return '系统悬浮窗权限缺失。';
    case 'observer_unavailable':
      return 'Device Observer 当前不可用。';
    case 'window_unreliable':
      return '当前前台窗口事实不可靠。';
    case 'reconcile_failed':
      return 'Device Control 投影同步失败。';
    case 'overlay_add_failed':
      return 'blocking overlay 挂载失败。';
    case 'execution_failed':
      return '当前原生执行事实无法证明阻断已经生效。';
  }
}
