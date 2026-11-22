/** 主理 AI 按本机 Launcher 应用目录搜索 exact package 候选。 */

import { runAsCurrentHostAuthority } from '@features/assistants';
import type { ToolContext, ToolExecuteResult } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { getInstalledLaunchableApps } from '../application/DeviceObserverFacade';
import type { DeviceObserverInstalledLaunchableApp } from '../application/DeviceObserverPort';
import { DeviceObserverInstalledAppsQueryError } from '../application/DeviceObserverPort';

const MAX_CANDIDATES = 5;

export interface SearchInstalledAppsArgs {
  query: string;
}

export interface InstalledAppSearchCandidate {
  label: string;
  packageName: string;
  isSystemApp: boolean;
}

export const definition = {
  name: 'search_installed_apps',
  description: '按名称搜索本机可启动 App，返回可精确调用的 package name',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '应用名称或 Android package name 搜索词',
        minLength: 1,
        pattern: '.*\\S.*',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
} as const;

export async function execute(
  args: SearchInstalledAppsArgs,
  context: ToolContext,
): Promise<ToolExecuteResult> {
  const query = args.query.trim();
  const actorAiId = context.getAIId();
  if (!actorAiId) {
    return { success: false, error: 'missing_actor_ai_id: 未识别到当前 AI 身份' };
  }

  const authorityResult = await runAsCurrentHostAuthority(actorAiId, async () => {
    throwIfAbortSignalAborted(context.abortSignal);

    let apps: DeviceObserverInstalledLaunchableApp[];
    try {
      apps = await getInstalledLaunchableApps();
    } catch (error) {
      if (!(error instanceof DeviceObserverInstalledAppsQueryError)) {
        throw error;
      }
      return {
        success: false,
        error: 'installed_apps_query_failed: 暂时无法读取本机可启动 App 列表',
      } satisfies ToolExecuteResult;
    }

    const candidates = searchInstalledApps(apps, query);
    return {
      success: true,
      message: candidates.length > 0
        ? [
            `找到 ${candidates.length} 个最相关的本机可启动 App：`,
            ...candidates.map((candidate, index) => (
              `${index + 1}. ${candidate.label} — ${candidate.packageName}`
            )),
            '后续设备工具必须使用候选中的精确 packageName。',
          ].join('\n')
        : `未找到与“${query}”匹配的本机可启动 App。`,
      data: { query, candidates },
    } satisfies ToolExecuteResult;
  });

  if (authorityResult.status === 'not_current_host') {
    return { success: false, error: 'not_current_host: 当前 AI 已不再是主理 AI' };
  }

  return authorityResult.value;
}

export function searchInstalledApps(
  apps: readonly DeviceObserverInstalledLaunchableApp[],
  query: string,
): InstalledAppSearchCandidate[] {
  const normalizedQuery = query.toLocaleLowerCase();
  return apps
    .map((app) => ({ app, rank: matchRank(app, normalizedQuery) }))
    .filter((candidate): candidate is { app: DeviceObserverInstalledLaunchableApp; rank: number } => (
      candidate.rank !== null
    ))
    .sort((left, right) => (
      left.rank - right.rank
      || compareWithinRank(left, right)
    ))
    .slice(0, MAX_CANDIDATES)
    .map(({ app }) => ({
      label: app.label,
      packageName: app.packageName,
      isSystemApp: app.isSystemApp,
    }));
}

function compareWithinRank(
  left: { app: DeviceObserverInstalledLaunchableApp; rank: number },
  right: { app: DeviceObserverInstalledLaunchableApp; rank: number },
): number {
  if (left.rank === 2 || left.rank === 4) {
    return left.app.packageName.localeCompare(right.app.packageName)
      || left.app.label.localeCompare(right.app.label, 'zh-CN', { sensitivity: 'base' });
  }
  return left.app.label.localeCompare(right.app.label, 'zh-CN', { sensitivity: 'base' })
    || left.app.packageName.localeCompare(right.app.packageName);
}

function matchRank(
  app: DeviceObserverInstalledLaunchableApp,
  normalizedQuery: string,
): number | null {
  const label = app.label.toLocaleLowerCase();
  const packageName = app.packageName.toLocaleLowerCase();
  if (label === normalizedQuery || packageName === normalizedQuery) return 0;
  if (label.startsWith(normalizedQuery)) return 1;
  if (packageName.startsWith(normalizedQuery)) return 2;
  if (label.includes(normalizedQuery)) return 3;
  if (packageName.includes(normalizedQuery)) return 4;
  return null;
}

export const SearchInstalledAppsTool = {
  name: definition.name,
  definition,
  execute,
};
