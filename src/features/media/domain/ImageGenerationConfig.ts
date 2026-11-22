/** Media 只持有资产 ID；连接与凭据由辅助模型中心持有。 */
export interface ImageGenerationConfig { modelConfigId: string | null }
export interface ImageGenerationModelConfigRef {
  id: string; capabilityKind: string; name: string; baseUrl: string; apiKey: string | null; model: string; metadataJson?: string | null;
  serviceConfigId?: string | null;
}
export type ImageGenerationModelSelectionStatus = 'unconfigured' | 'active' | 'incomplete' | 'deleted' | 'capability_mismatch';
export interface ImageGenerationModelSelection {
  modelConfigId: string | null; status: ImageGenerationModelSelectionStatus; name: string | null;
}
export function evaluateImageGenerationModelSelection(id: string | null, config: ImageGenerationModelConfigRef | null): ImageGenerationModelSelection {
  const status: ImageGenerationModelSelectionStatus = id === null ? 'unconfigured' : config === null ? 'deleted'
    : !config.baseUrl.trim() || !config.apiKey?.trim() || !config.model.trim() ? 'incomplete'
    : config.capabilityKind !== 'image_generation' ? 'capability_mismatch' : 'active';
  return { modelConfigId: id, status, name: config?.name ?? null };
}
export function evaluateImageGenerationModelConfig(config: ImageGenerationModelConfigRef | null): ImageGenerationModelConfigRef | null {
  return evaluateImageGenerationModelSelection(config?.id ?? null, config).status === 'active' ? config : null;
}
