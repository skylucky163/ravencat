/** 翻译提供方契约；连接资产属于辅助模型中心，语言与提供方参数随资产保存。 */
export type TranslationProvider = 'aiModel' | 'tencentCloudTmt';

export interface TranslationFieldSpec {
  key: string;
  label: string;
  placeholder: string;
  hint?: string;
  advanced?: boolean;
}
export interface TranslationProviderMeta {
  provider: TranslationProvider;
  label: string;
  optionFields: TranslationFieldSpec[];
}

export interface TranslationMetadata {
  provider: TranslationProvider;
  source: string;
  target: string;
  secretId?: string;
  region?: string;
  projectId?: number;
}

export interface TranslationModelConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  metadataJson: string;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
}

export interface ResolvedTranslationModel extends TranslationModelConfig {
  modelConfigId: string;
}

export function readTranslationMetadata(json: string): TranslationMetadata {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('翻译参数必须是 JSON 对象');
  const data = value as Record<string, unknown>;
  if (data.provider !== 'aiModel' && data.provider !== 'tencentCloudTmt') throw new Error('翻译提供方无效');
  if (typeof data.source !== 'string' || typeof data.target !== 'string') throw new Error('翻译语言参数无效');
  if (data.provider === 'tencentCloudTmt' && (typeof data.secretId !== 'string' || typeof data.region !== 'string'
    || typeof data.projectId !== 'number')) {
    throw new Error('腾讯云翻译参数无效');
  }
  return data as unknown as TranslationMetadata;
}

export function validateTranslationModelConfig(config: Pick<TranslationModelConfig, 'baseURL' | 'apiKey' | 'model'> & { metadataJson: string | null }): Record<string, string> {
  const errors: Record<string, string> = {};
  let metadata: TranslationMetadata;
  try { metadata = readTranslationMetadata(config.metadataJson!); }
  catch (error) { return { provider: (error as Error).message }; }
  try {
    const url = new URL(config.baseURL);
    if (!['http:', 'https:'].includes(url.protocol)) errors.baseUrl = 'API 地址须为完整的 HTTP 或 HTTPS 地址';
  } catch { errors.baseUrl = 'API 地址须为完整的 HTTP 或 HTTPS 地址'; }
  if (!config.apiKey.trim()) errors.apiKey = metadata.provider === 'aiModel' ? '请填写 API Key' : '请填写 SecretKey';
  if (!config.model.trim()) errors.model = '请填写模型名称';
  if (!metadata.source.trim()) errors.source = '请填写源语言，自动识别请填 auto';
  if (!metadata.target.trim()) errors.target = '请填写目标语言';
  if (metadata.provider === 'tencentCloudTmt') {
    if (!metadata.secretId!.trim()) errors.secretId = '请填写 SecretId';
    if (!metadata.region!.trim()) errors.region = '请填写地域';
    if (!Number.isSafeInteger(metadata.projectId) || metadata.projectId! < 0) errors.projectId = '项目 ID 需要填写非负整数';
  }
  return errors;
}
