// sticker_annotation 已被 Sticker System V2 移除：表情包识别模型改为由
// Sticker 业务配置直接引用既有 ocr 模型，不再作为辅助模型 capability 存在。
export const CAPABILITY_KINDS = [
  'summary',
  'embedding',
  'ocr',
  'stt',
  'tts',
  'translation',
] as const;

export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];
export interface AuxiliaryModelConfig {
  id: string;
  capabilityKind: CapabilityKind;
  name: string;
  serviceConfigId?: string | null;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  metadataJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAuxiliaryModelConfigInput {
  serviceConfigId?: string | null;
  capabilityKind: CapabilityKind;
  name: string;
  baseUrl: string;
  apiKey?: string | null;
  model: string;
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
  metadataJson?: string | null;
  createdAt?: string;
}

export interface UpdateAuxiliaryModelConfigInput {
  serviceConfigId?: string | null;
  capabilityKind?: CapabilityKind;
  name?: string;
  baseUrl?: string;
  apiKey?: string | null;
  model?: string;
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
  metadataJson?: string | null;
}
