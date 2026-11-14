import { createRuntimeSlot } from '@shared/runtime/RuntimeSlot';
import type { ModelSelectionSettings } from '@shared/ui/modelSelectionTypes';
import { evaluateImageGenerationModelConfig, evaluateImageGenerationModelSelection, type ImageGenerationModelConfigRef } from '../domain/ImageGenerationConfig';
import type { ImageGenerationSettingsRepository } from '../domain/ImageGenerationSettingsRepository';
import { readImageGenerationProfile, getImageGenerationCapabilities, getImageGenerationConfigurationError, type ImageGenerationCapabilities, type ImageGenerationProfile } from '@platform/ai/imageGenerationConfig';

interface Dependencies {
  repository: ImageGenerationSettingsRepository;
  getModel(id: string): Promise<ImageGenerationModelConfigRef | null>;
  listModels(): Promise<ImageGenerationModelConfigRef[]>;
}
const slot = createRuntimeSlot<Dependencies>('Image generation models');
const listeners = new Set<() => void>();
export const configureImageGenerationModels = (deps: Dependencies): void => slot.configure(deps);
export const notifyImageGenerationModelsChanged = (): void => { for (const listener of listeners) listener(); };
export function subscribeImageGenerationModelsChanged(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
const reasons = { incomplete: '连接配置不完整', deleted: '模型已删除', capability_mismatch: '模型类型不匹配' };
export async function getImageGenerationModelSettings(): Promise<ModelSelectionSettings & { capabilities: ImageGenerationCapabilities | null }> {
  const deps = slot.get();
  const id = await deps.repository.getModelId();
  const [models, config] = await Promise.all([deps.listModels(), id === null ? null : deps.getModel(id)]);
  const selection = evaluateImageGenerationModelSelection(id, config);
  const profile = selection.status === 'active' ? readImageGenerationProfile(config!.metadataJson) : null;
  const configurationError = selection.status === 'active' ? getImageGenerationConfigurationError(profile, config!.baseUrl, config!.model) : null;
  return { models: models.filter(model => evaluateImageGenerationModelConfig(model) !== null).map(({ id, name, model }) => ({ id, name, model })),
    selectedModelId: id, selectedModelName: selection.name,
    status: configurationError ? 'unavailable' : selection.status === 'active' || selection.status === 'unconfigured' ? selection.status : 'unavailable',
    unavailableReason: configurationError ?? reasons[selection.status] ?? null,
    capabilities: selection.status === 'active' && !configurationError ? getImageGenerationCapabilities(profile!, config!.model) : null };
}
export async function selectImageGenerationModel(id: string | null): Promise<void> {
  const deps = slot.get();
  if (id !== null) {
    const config = evaluateImageGenerationModelConfig(await deps.getModel(id));
    if (!config) throw new Error('请选择类型匹配且连接完整的生图模型');
    const issue = getImageGenerationConfigurationError(readImageGenerationProfile(config.metadataJson), config.baseUrl, config.model);
    if (issue) throw new Error(issue);
  }
  await deps.repository.setModelId(id);
  notifyImageGenerationModelsChanged();
}
export class ImageGenerationModelError extends Error {
  constructor(public readonly code: 'IMAGE_GENERATION_UNCONFIGURED' | 'IMAGE_GENERATION_MODEL_UNAVAILABLE', message: string) { super(message); }
}
export async function resolveImageGenerationModel(): Promise<{ baseURL: string; apiKey: string; model: string; profile: ImageGenerationProfile }> {
  const deps = slot.get();
  const id = await deps.repository.getModelId();
  if (id === null) throw new ImageGenerationModelError('IMAGE_GENERATION_UNCONFIGURED', '请先在「AI 生图」页面选择生图模型');
  const config = evaluateImageGenerationModelConfig(await deps.getModel(id));
  if (!config) throw new ImageGenerationModelError('IMAGE_GENERATION_MODEL_UNAVAILABLE', '所选生图模型不可用，请检查配置或重新选择');
  const profile = readImageGenerationProfile(config.metadataJson);
  const issue = getImageGenerationConfigurationError(profile, config.baseUrl, config.model);
  if (issue) throw new ImageGenerationModelError('IMAGE_GENERATION_MODEL_UNAVAILABLE', issue);
  return { baseURL: config.baseUrl.trim(), apiKey: config.apiKey!.trim(), model: config.model.trim(), profile: profile! };
}
