/** 翻译拥有明确的资产引用；首次初始化后，新增、删除与停用模型不改写此引用。 */
import { createRuntimeSlot } from '@shared/runtime/RuntimeSlot';
import type { ModelSelectionSettings } from '@shared/ui/modelSelectionTypes';
import type { TranslationSettingsRepository } from '../domain/TranslationSettingsRepository';
import type { TranslationModelConfig } from '../domain/TranslationModel';

interface Dependencies {
  repository: TranslationSettingsRepository;
  getSelection(modelConfigId: string | null): Promise<ModelSelectionSettings>;
  requireModel(modelConfigId: string): Promise<void>;
  resolveModel(modelConfigId: string): Promise<TranslationModelConfig | null>;
}
const slot = createRuntimeSlot<Dependencies>('Translation models');
const listeners = new Set<() => void>();
export function configureTranslationModels(deps: Dependencies): void { slot.configure(deps); }
export function notifyTranslationModelsChanged(): void { for (const listener of listeners) listener(); }
export function subscribeTranslationModelsChanged(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export async function getTranslationModelSettings(): Promise<ModelSelectionSettings> {
  const deps = slot.get(); return deps.getSelection(await deps.repository.getModelId());
}
export async function selectTranslationModel(modelConfigId: string | null): Promise<void> {
  const deps = slot.get();
  if (modelConfigId !== null) await deps.requireModel(modelConfigId);
  await deps.repository.setModelId(modelConfigId);
  notifyTranslationModelsChanged();
}
export async function resolveTranslationModel(): Promise<TranslationModelConfig> {
  const deps = slot.get();
  const id = await deps.repository.getModelId();
  if (id === null) throw new Error('请先在翻译模型列表中选择聊天翻译使用的模型');
  const model = await deps.resolveModel(id);
  if (!model) throw new Error('所选翻译模型不可用，请检查配置或重新选择');
  return model;
}
