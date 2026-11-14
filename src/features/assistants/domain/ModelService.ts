/** 服务只拥有连接与凭据；模型、任务参数和业务选择不属于服务。 */
export interface ModelServiceConnection {
  baseUrl: string;
  apiKey: string;
  authType: 'apiKey' | 'tencentCloud';
  credentialsJson: string;
}
/** 具体 Key 的有效连接；name 与 baseUrl 由所属分组提供，id 是业务绑定身份。 */
export interface ModelServiceConfig extends ModelServiceConnection {
  id: string;
  groupId: string;
  name: string;
  keyName: string;
  ordinal: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModelServiceGroup {
  id: string;
  name: string;
  baseUrl: string;
  authType: ModelServiceConnection['authType'];
  nextKeyOrdinal: number;
  keys: ModelServiceConfig[];
}
export interface ModelServiceKeyInput { name: string; apiKey: string; credentialsJson: string; ordinal?: number }
export interface CreateModelServiceGroupInput {
  name: string;
  baseUrl: string;
  authType: ModelServiceConnection['authType'];
  keys: ModelServiceKeyInput[];
}

/** 专用提供方拥有自己的协议和凭据，只有兼容接口复用通用服务。 */
export function supportsModelService(capabilityKind: string, metadataJson: string | null | undefined): boolean {
  if (capabilityKind === 'stt') return false;
  if (capabilityKind !== 'tts' && capabilityKind !== 'translation') return true;
  const provider = metadataJson ? (JSON.parse(metadataJson) as { provider?: string }).provider : undefined;
  return capabilityKind === 'tts'
    ? provider === undefined || provider === 'openaiCompatible'
    : provider === 'aiModel';
}

export function getModelServiceConnection(baseUrl: string, apiKey: string | null): ModelServiceConnection {
  return { baseUrl: baseUrl.trim(), apiKey: apiKey?.trim() ?? '', authType: 'apiKey', credentialsJson: '{}' };
}

export function withoutServiceCredentials(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
  delete metadata.secretId;
  delete metadata.appId;
  return JSON.stringify(metadata);
}

export function withServiceCredentials(metadataJson: string | null, connection: ModelServiceConnection): string | null {
  if (connection.credentialsJson === '{}') return metadataJson;
  return JSON.stringify({ ...JSON.parse(metadataJson ?? '{}'), ...JSON.parse(connection.credentialsJson) });
}
