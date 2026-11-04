import { searchWeb, type WebSearchEngine, type WebSearchOptions } from '@platform/web';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import type { ModelSelectionSettings } from '@shared/ui/modelSelectionTypes';
import { SEARCH_SOURCES, availableSearchSources, type SearchSettingsChange } from '../domain/SearchSettings';
import { getWebToolsRuntime } from './WebToolsRuntime';

const listeners = new Set<() => void>();
export function subscribeSearchConfigurationChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function notifySearchConfigurationChanged(): void { for (const listener of listeners) listener(); }

export async function readSearchConfiguration() {
  const runtime = getWebToolsRuntime();
  const settings = await runtime.settings.read();
  // 密钥仅供用户配置页回填；模型执行的 observation 不使用这个编辑视图。
  const sources = await Promise.all(settings.sources.map(async source => {
    const apiKey = source.credentialRef === null ? null : await runtime.credentials.read(source.credentialRef);
    return { engine: source.engine,
      configured: !SEARCH_SOURCES.find(item => item.engine === source.engine)!.needsKey || apiKey !== null,
      apiKey: apiKey ?? '' };
  }));
  return { defaultEngine: settings.defaultEngine, allowAdvanced: settings.allowAdvanced, connectionMode: settings.connectionMode,
    sources };
}

export async function updateSearchConfiguration(change: Exclude<SearchSettingsChange, { kind: 'credential' }>) {
  await getWebToolsRuntime().settings.change(change);
  notifySearchConfigurationChanged();
}

/** 通用选择器只接收展示投影；来源凭据与联网选择事实仍归 Web Tools。 */
export async function readSearchSelection(): Promise<ModelSelectionSettings> {
  const configuration = await readSearchConfiguration();
  const selected = configuration.sources.find(source => source.engine === configuration.defaultEngine);
  return {
    models: SEARCH_SOURCES.filter(source => configuration.sources.find(item => item.engine === source.engine)!.configured)
      .map(source => ({ id: source.engine, name: source.name, model: source.needsKey ? '已配置' : '内置来源' })),
    selectedModelId: configuration.defaultEngine,
    selectedModelName: configuration.defaultEngine === null ? null : SEARCH_SOURCES.find(source => source.engine === configuration.defaultEngine)!.name,
    status: configuration.defaultEngine === null ? 'unconfigured' : selected!.configured ? 'active' : 'unavailable',
    unavailableReason: selected && !selected.configured ? '请重新配置 API Key' : null,
  };
}

export async function selectSearchSource(engine: string | null): Promise<void> {
  await updateSearchConfiguration({ kind: 'default', engine: engine as WebSearchEngine | null });
}

async function releaseCredential(reference: string) {
  try { await getWebToolsRuntime().credentials.delete(reference); }
  catch { console.warn('[WebTools] 未引用的搜索凭据清理失败'); }
}

/** 测试结果只发布到开始测试时的配置版本；网络与安全存储不进入 SQLite 事务。 */
export async function testAndSaveSearchKey(engine: 'tavily' | 'brave', input: string, signal: AbortSignal): Promise<void> {
  const key = input.trim();
  if (!key || !/^[\x21-\x7E]{1,512}$/.test(key)) throw new Error('请填写有效的 API Key，不包含空格或 Bearer 前缀');
  const runtime = getWebToolsRuntime();
  const before = await runtime.settings.read();
  const previous = before.sources.find(source => source.engine === engine)!.credentialRef;
  const previousKey = previous === null ? null : await runtime.credentials.read(previous);
  const tested = await searchWeb('RavenCat', 1, signal, { engine, apiKey: key, depth: 'basic', timeRange: null, includeImages: false });
  if (tested.ok === false) throw new Error(tested.error.message);
  throwIfAbortSignalAborted(signal);
  if (key === previousKey) return;
  const reference = await runtime.credentials.save(key);
  try {
    throwIfAbortSignalAborted(signal);
    await runtime.settings.change({ kind: 'credential', engine, reference, expectedRevision: before.revision });
  } catch (error) {
    await releaseCredential(reference);
    throw error;
  }
  if (previous !== null) await releaseCredential(previous);
  notifySearchConfigurationChanged();
}

export interface SearchInput {
  query: string;
  limit?: number;
  engine?: WebSearchEngine;
  depth?: 'basic' | 'advanced';
  time_range?: NonNullable<WebSearchOptions['timeRange']>;
  include_images?: boolean;
}

export async function executeConfiguredSearch(input: SearchInput, signal: AbortSignal) {
  const runtime = getWebToolsRuntime();
  const settings = await runtime.settings.read();
  const available = availableSearchSources(settings);
  const engine = input.engine ?? settings.defaultEngine;
  const failure = (code: string, message: string) => ({ ok: false as const,
    error: { code, message: `${message}。默认来源：${settings.defaultEngine ?? '未选择'}；可用来源：${available.join('、') || '无'}。需要时可显式指定 engine 换来源或改写关键词。` } });
  if (engine === null) return failure('WEB_SEARCH_NOT_CONFIGURED', '请在「AI 工具 → 联网搜索」选择默认来源，或指定一个可用来源');
  if (!available.includes(engine)) return failure('WEB_SEARCH_SOURCE_DISABLED', '指定的搜索来源未启用或未配置');
  const depth = input.depth ?? 'basic';
  if (depth === 'advanced' && (engine !== 'tavily' || !settings.allowAdvanced)) {
    return failure('WEB_SEARCH_OPTION_UNAVAILABLE', '深度搜索仅适用于 Tavily，且需要用户在联网搜索配置中允许');
  }
  if (input.time_range && engine === 'bing') return failure('WEB_SEARCH_OPTION_UNAVAILABLE', 'Bing RSS 不支持时间范围筛选');
  if (input.include_images && engine !== 'tavily') return failure('WEB_SEARCH_OPTION_UNAVAILABLE', '图片候选仅适用于 Tavily，请显式指定已启用的 engine=tavily');
  const source = settings.sources.find(source => source.engine === engine)!;
  const apiKey = source.credentialRef === null ? null : await runtime.credentials.read(source.credentialRef);
  if (source.credentialRef !== null && apiKey === null) return failure('WEB_SEARCH_CREDENTIAL_MISSING', '本机搜索密钥不可用，请用户重新配置');
  const result = await searchWeb(input.query, input.limit ?? 5, signal, {
    engine, apiKey, depth, timeRange: input.time_range ?? null, includeImages: input.include_images ?? false,
  });
  if (result.ok === false) return failure(result.error.code, result.error.message);
  return { ok: true as const, data: { ...result.data, defaultEngine: settings.defaultEngine, availableEngines: available } };
}
