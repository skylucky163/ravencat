import {
  SPEECH_PROVIDERS,
  getSpeechParameters,
  getSpeechProvider,
  readSpeechMetadata,
  speechEndpoint,
  validateSpeechConfiguration,
  type SpeechConnectionConfig,
  type SpeechKind,
  type SpeechMetadata,
  type SpeechProviderId,
} from '@features/speech';
import type { AuxiliaryModelConfig, UpdateAuxiliaryModelConfigInput } from '../../domain/AuxiliaryModel';
import type { DraftCommit, DraftErrors } from '@shared/ui/AutoSaveDraftEditor';

export interface SpeechModelDraft {
  serviceConfigId: string;
  name: string;
  apiKey: string;
  provider: string;
  model: string;
  baseUrl: string;
  preserveEndpoint: boolean;
  /** 字段名来自 Speech 的提供方定义，不保存任意 JSON 请求模板。 */
  [field: string]: string | boolean;
}
export function createSpeechProviderDraft(provider: SpeechProviderId): Partial<SpeechModelDraft> {
  const definition = getSpeechProvider(provider);
  const next: Partial<SpeechModelDraft> = {
    provider,
    serviceConfigId: '',
    model: definition.defaultModel,
    baseUrl: definition.baseURL,
    apiKey: '',
    preserveEndpoint: false,
  };
  for (const field of getSpeechParameters(provider, definition.defaultModel))
    next[field.key] =
      field.type === 'boolean'
        ? field.defaultValue === true
        : field.defaultValue == null
          ? ''
          : String(field.defaultValue);
  return next;
}
export function getSpeechModelDraft(kind: SpeechKind, config: AuxiliaryModelConfig | null): SpeechModelDraft {
  let metadata: SpeechMetadata | null = null;
  if (config) {
    try { metadata = readSpeechMetadata(config.metadataJson); }
    catch { metadata = { provider: '' as SpeechProviderId }; }
  }
  // 新建草稿允许选提供方；已有资产只预留本提供方各模型需要的参数。
  const parameters: Record<string, string | boolean> = {};
  for (const provider of SPEECH_PROVIDERS.filter(entry => entry.kind === kind && (!metadata || entry.id === metadata.provider)))
    for (const model of new Set([provider.defaultModel, ...provider.models]))
      for (const field of getSpeechParameters(provider.id, model)) parameters[field.key] = '';
  if (!config) {
    const provider = kind === 'stt' ? 'dashscopeRealtimeAsr' : 'minimaxT2aV2';
    return {
      ...parameters,
      serviceConfigId: '',
      name: getSpeechProvider(provider).label,
      apiKey: '',
      baseUrl: '',
      model: '',
      preserveEndpoint: false,
      provider,
      ...createSpeechProviderDraft(provider),
    };
  }
  const savedMetadata = metadata!;
  const draft: SpeechModelDraft = {
    ...parameters,
    serviceConfigId: config.serviceConfigId ?? '',
    name: config.name,
    apiKey: config.apiKey ?? '',
    baseUrl: config.baseUrl,
    model: config.model,
    provider: savedMetadata.provider,
    preserveEndpoint: true,
  };
  if (!SPEECH_PROVIDERS.some((entry) => entry.id === savedMetadata.provider && entry.kind === kind)) return draft;
  for (const field of getSpeechParameters(savedMetadata.provider, config.model)) {
    const value = savedMetadata[field.key] ?? field.defaultValue;
    draft[field.key] = field.type === 'boolean' ? value === true : value == null ? '' : String(value);
  }
  // 旧 MiniMax 站点由已保存地址推导；打开页面本身不提交或覆盖原连接。
  if (savedMetadata.provider === 'minimaxT2aV2' && !savedMetadata.region)
    draft.region = config.baseUrl.includes('api-uw.')
      ? 'us'
      : config.baseUrl.includes('minimax.io')
        ? 'international'
        : 'china';
  draft.preserveEndpoint =
    config.baseUrl.replace(/\/$/, '') !==
    speechEndpoint(savedMetadata.provider, { ...savedMetadata, region: draft.region });
  return draft;
}
export function buildSpeechDraftConfiguration(draft: SpeechModelDraft): SpeechConnectionConfig {
  const provider = draft.provider as SpeechProviderId;
  getSpeechProvider(provider);
  const metadata: SpeechMetadata = { provider };
  for (const field of getSpeechParameters(provider, draft.model)) {
    const value = draft[field.key];
    if (value == null || value === '') continue;
    const numeric = field.type === 'number' || ['sampleRate', 'bitrate', 'stability'].includes(field.key);
    // JSON 会把 NaN 写成 null；非法数字保留原输入，让唯一表单边界报错。
    metadata[field.key] = numeric
      ? Number.isFinite(Number(value))
        ? Number(value)
        : String(value)
      : field.type === 'boolean'
        ? value === true
        : String(value).trim();
  }
  return {
    apiKey: draft.apiKey.trim(),
    model: draft.model.trim(),
    baseURL:
      draft.preserveEndpoint || provider === 'openaiCompatible'
        ? draft.baseUrl.trim()
        : speechEndpoint(provider, metadata),
    metadataJson: JSON.stringify(metadata),
  };
}
export function parseSpeechModelDraft(
  kind: SpeechKind,
  draft: SpeechModelDraft,
  changed: (keyof SpeechModelDraft)[],
): DraftCommit<SpeechModelDraft, UpdateAuxiliaryModelConfigInput> {
  const patch: UpdateAuxiliaryModelConfigInput = {};
  const accepted: (keyof SpeechModelDraft)[] = [];
  const errors: DraftErrors<SpeechModelDraft> = {};
  for (const key of changed) {
    if (key === 'name') {
      if (draft.name.trim()) {
        patch.name = draft.name.trim();
        accepted.push(key);
      } else errors.name = '配置名称不能为空';
    }
    // 清空密钥是明确修改，允许保存为不可用资产，不继承旧密钥。
    if (key === 'apiKey') {
      patch.apiKey = draft.apiKey.trim() || null;
      accepted.push(key);
    }
  }
  if (changed.includes('serviceConfigId') && !draft.serviceConfigId) { patch.serviceConfigId = null; accepted.push('serviceConfigId'); }
  const connectionKeys = changed.filter((key) => !['name', 'apiKey'].includes(String(key)) && !(key === 'serviceConfigId' && !draft.serviceConfigId));
  if (connectionKeys.length) {
    let configuration: SpeechConnectionConfig;
    try {
      configuration = buildSpeechDraftConfiguration(draft);
    } catch {
      return { patch, accepted, errors: { ...errors, provider: '语音提供方无效，请新建配置' } };
    }
    Object.assign(errors, validateSpeechConfiguration(kind, configuration));
    if (!Object.keys(errors).some((key) => key !== 'name')) {
      patch.baseUrl = configuration.baseURL;
      patch.model = configuration.model;
      patch.metadataJson = configuration.metadataJson;
      if (changed.includes('serviceConfigId')) patch.serviceConfigId = draft.serviceConfigId || null;
      accepted.push(...connectionKeys);
    }
  }
  return { patch, accepted, errors };
}
