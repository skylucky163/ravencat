/** 主理身份由现有 authority 裁决；定位授权与单次采样由 Android 边界负责。 */
import { runAsCurrentHostAuthority } from '@features/assistants';
import { getCurrentDeviceLocation } from '@platform/device';
import type { ToolContext, ToolExecuteResult } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';

export const definition = {
  name: 'get_current_location',
  description: '按需获取一次手机位置，返回 WGS84 经纬度、精度（米）、测量时间和位置年龄。支持大致位置；精度和可用性由系统授权决定。系统可能返回近期位置，结合精度、年龄与模拟位置标记解释。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
} as const;

const FAILURE_MESSAGES = {
  permission_not_granted: '请用户在“权限与后台运行”的“定位权限”中授权。',
  location_services_disabled: '系统定位已关闭，请用户在“权限与后台运行”的“系统定位”中开启。',
  location_provider_unavailable: '当前设备没有可用的系统融合定位服务。',
  location_unavailable: '系统未在单次请求期限内提供位置，可能受信号或后台限制影响；没有可报告的位置。',
} as const;

export async function execute(_args: Record<string, never>, context: ToolContext): Promise<ToolExecuteResult> {
  const actorAiId = context.getAIId();
  if (!actorAiId) return { success: false, error: 'missing_actor_ai_id: 未识别到当前 AI 身份' };
  const authorityResult = await runAsCurrentHostAuthority(actorAiId, async () => {
    throwIfAbortSignalAborted(context.abortSignal);
    const snapshot = await getCurrentDeviceLocation();
    throwIfAbortSignalAborted(context.abortSignal);
    if (snapshot.status !== 'available') return {
      success: false, error: `${snapshot.status}: ${FAILURE_MESSAGES[snapshot.status]}`,
    };
    const data = {
      latitude: snapshot.latitude, longitude: snapshot.longitude, coordinateSystem: 'WGS84',
      accuracyMeters: snapshot.accuracyMeters, measuredAt: new Date(snapshot.measuredAtEpochMs).toISOString(),
      ageMs: snapshot.ageMs, permission: snapshot.permission, isMock: snapshot.isMock,
    };
    return { success: true, message: `已获取一次系统位置；请按精度、测量时间、位置年龄及模拟位置标记解释。\n${JSON.stringify(data)}`, data };
  });
  if (authorityResult.status === 'not_current_host') return {
    success: false, error: 'not_current_host: 当前 AI 已不再是主理 AI',
  };
  return authorityResult.value;
}

export const GetCurrentLocationTool = { name: definition.name, definition, execute };
