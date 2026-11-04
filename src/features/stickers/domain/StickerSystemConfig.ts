/** Sticker System V2 的业务级模型配置领域对象与解析规则。 */

/**
 * 辅助模型中心模型配置在 Sticker 侧的引用视图。
 * Sticker 只保存 modelConfigId，Base URL / API Key / model name 始终
 * 由辅助模型中心唯一持有，本对象只在 resolver 运行时携带。
 */
export interface StickerModelConfigRef {
  id: string;
  capabilityKind: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  updatedAt: string;
}

/** Sticker System 允许引用的辅助模型 capability 类型。 */
export type StickerModelRequirementKind = 'ocr' | 'embedding';

export interface StickerSystemConfig {
  automaticRecognitionEnabled: boolean;
  recognitionModelConfigId: string | null;
  embeddingModelConfigId: string | null;
  updatedAt: string;
}

/** 已绑定模型相对当前辅助模型中心状态的展示判定结果。 */
export type StickerModelSelectionStatus =
  | 'unconfigured'
  | 'active'
  | 'incomplete'
  | 'deleted'
  | 'capability_mismatch';

/**
 * 当前绑定模型的展示投影。UI 只消费这一层，不再用 picker candidate list 反查
 * 已配置模型——candidate 只在打开 picker 后才加载，而且 recognition / embedding
 * 共用同一份 state 时会互相污染显示。
 */
export interface StickerModelSelection {
  modelConfigId: string | null;
  status: StickerModelSelectionStatus;
  /** 只在 status === 'active' 时给出，用于显示真实模型名称。 */
  name: string | null;
  model: string | null;
}

function rejectedSelection(
  modelConfigId: string,
  status: Exclude<StickerModelSelectionStatus, 'unconfigured' | 'active'>,
): StickerModelSelection {
  return { modelConfigId, status, name: null, model: null };
}

/**
 * 把「已绑定的 modelConfigId + 当前读到的配置」判定成展示状态。
 * 与 resolver 共用同一套规则：必须存在、连接完整且 capabilityKind 匹配；
 * 三种失效原因分别落到 deleted / incomplete / capability_mismatch，便于 UI 与
 * verifier 区分“模型不存在”和“模型存在但不可用”。
 */
export function evaluateStickerModelSelection(
  modelConfigId: string | null,
  config: StickerModelConfigRef | null,
  requirement: StickerModelRequirementKind,
): StickerModelSelection {
  if (!modelConfigId) {
    return { modelConfigId: null, status: 'unconfigured', name: null, model: null };
  }
  if (!config) return rejectedSelection(modelConfigId, 'deleted');
  if (!config.baseUrl.trim() || !config.apiKey?.trim() || !config.model.trim()) return rejectedSelection(modelConfigId, 'incomplete');
  if (config.capabilityKind !== requirement) {
    return rejectedSelection(modelConfigId, 'capability_mismatch');
  }
  return {
    modelConfigId,
    status: 'active',
    name: config.name,
    model: config.model,
  };
}

/**
 * Sticker-owned 模型解析规则：必须存在、连接完整且 capabilityKind 匹配。
 * 只读取 Sticker 自有选择，不读取其他 Feature 的模型设置。
 * 未配置或失效时返回 null，调用方据此保持待机而不是循环刷错误。
 */
export function evaluateStickerModelConfig(
  config: StickerModelConfigRef | null,
  requirement: StickerModelRequirementKind,
): StickerModelConfigRef | null {
  // 与展示投影共用同一条判定，避免 resolver 和 UI 出现两套可用性规则。
  const selection = evaluateStickerModelSelection(config ? config.id : null, config, requirement);
  return selection.status === 'active' ? config : null;
}
