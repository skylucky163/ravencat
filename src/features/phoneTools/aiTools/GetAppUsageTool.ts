/** 使用情况由 Android 按需提供，主理身份裁决沿用手机工具的执行边界。 */
import { runAsCurrentHostAuthority } from '@features/assistants';
import { queryAppUsage } from '@platform/device';
import type { ToolContext, ToolExecuteResult } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';

interface Args {
  period: 'today' | 'yesterday' | 'last_7_days';
  packageName?: string;
  limit?: number;
}

export const definition = {
  name: 'get_app_usage',
  description: '读取 Android 应用前台使用时长（按时长降序），可按精确包名查询。需用户授予使用情况权限。系统聚合区间可能扩展，非精确时间切片。',
  parameters: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['today', 'yesterday', 'last_7_days'], description: '按设备本地日期查询；最近 7 天包含今天。' },
      packageName: { type: 'string', minLength: 1, description: '可选精确 Android 包名；不知道包名时先搜索已安装应用。' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多返回多少项，默认 20。' },
    },
    required: ['period'],
    additionalProperties: false,
  },
} as const;

export async function execute(args: Args, context: ToolContext): Promise<ToolExecuteResult> {
  const actorAiId = context.getAIId();
  if (!actorAiId) return { success: false, error: 'missing_actor_ai_id: 未识别到当前 AI 身份' };
  const authorityResult = await runAsCurrentHostAuthority(actorAiId, async () => {
    throwIfAbortSignalAborted(context.abortSignal);
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let end = now;
    if (args.period === 'yesterday') {
      end = new Date(start);
      start.setDate(start.getDate() - 1);
    } else if (args.period === 'last_7_days') {
      start.setDate(start.getDate() - 6);
    }
    const snapshot = await queryAppUsage(start.getTime(), end.getTime());
    throwIfAbortSignalAborted(context.abortSignal);
    if (snapshot.status === 'permission_not_granted') return {
      success: false,
      error: 'usage_access_not_granted: 请用户在“权限与后台运行”的“使用情况访问”中打开系统设置并授权。',
    };
    if (snapshot.status === 'device_locked') return {
      success: false, error: 'device_locked: 系统用户尚未解锁，当前无法读取应用使用统计。',
    };
    const apps = snapshot.apps.filter((app) => !args.packageName || app.packageName === args.packageName)
      .sort((left, right) => right.foregroundTimeMs - left.foregroundTimeMs || left.packageName.localeCompare(right.packageName));
    const limit = args.limit ?? 20;
    const data = {
      period: args.period,
      requestedStart: start.toISOString(), requestedEnd: end.toISOString(),
      totalApps: apps.length, truncated: apps.length > limit,
      apps: apps.slice(0, limit).map((app) => ({
        packageName: app.packageName,
        foregroundTimeMs: app.foregroundTimeMs,
        statisticsStart: new Date(app.firstTimestampEpochMs).toISOString(),
        statisticsEnd: new Date(app.lastTimestampEpochMs).toISOString(),
        lastTimeUsed: new Date(app.lastTimeUsedEpochMs).toISOString(),
      })),
    };
    // Legacy adapter 只把 message 交给模型；data 用于结构化消费，不会自动进入工具 observation。
    return {
      success: true,
      message: `应用按前台使用时长降序排列，最多返回 ${limit} 项${args.limit === undefined ? '（默认上限）' : ''}。foregroundTimeMs 的单位为毫秒，各项统计区间见 statisticsStart 和 statisticsEnd。\n${JSON.stringify(data)}`,
      data,
    };
  });
  if (authorityResult.status === 'not_current_host') return {
    success: false, error: 'not_current_host: 当前 AI 已不再是主理 AI',
  };
  return authorityResult.value;
}

export const GetAppUsageTool = { name: definition.name, definition, execute };
