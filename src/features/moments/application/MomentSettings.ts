/** Moments 自有图片理解模型 binding；保存动作绝不触发历史扫描或模型请求。 */
import { MomentDomainError } from '../domain/MomentErrors';
import type {
  MomentImageAnalysisModelRef,
  MomentImageAnalysisModelSelection,
} from '../domain/MomentImageAnalysis';
import type { MomentSettings } from '../domain/MomentRepository';
import { getMomentMediaRuntime } from './MomentMediaRuntime';

function evaluateSelection(
  modelConfigId: string | null,
  config: MomentImageAnalysisModelRef | null
): MomentImageAnalysisModelSelection {
  if (!modelConfigId) {
    return { modelConfigId: null, status: 'unconfigured', name: null, model: null };
  }
  if (!config) return { modelConfigId, status: 'deleted', name: null, model: null };
  if (!config.baseUrl.trim() || !config.apiKey?.trim() || !config.model.trim()) return { modelConfigId, status: 'incomplete', name: null, model: null };
  if (config.capabilityKind !== 'ocr') {
    return { modelConfigId, status: 'capability_mismatch', name: null, model: null };
  }
  return { modelConfigId, status: 'active', name: config.name, model: config.model };
}

export async function getMomentSettings(): Promise<MomentSettings> {
  const runtime = getMomentMediaRuntime();
  const stored = await runtime.repository.getSettings();
  const now = runtime.now();
  return stored ?? { imageAnalysisModelConfigId: null, createdAt: now, updatedAt: now };
}

export async function setMomentImageAnalysisModel(
  modelConfigId: string | null
): Promise<MomentSettings> {
  const runtime = getMomentMediaRuntime();
  const normalized = modelConfigId?.trim() || null;
  if (normalized) {
    const config = await runtime.auxiliaryModels.getById(normalized);
    if (evaluateSelection(normalized, config).status !== 'active') {
      throw new MomentDomainError(
        'invalid_image_analysis_model',
        '图片理解模型必须选择辅助模型中心配置完整的 OCR 类模型'
      );
    }
  }
  // 这里只保存 binding。不得发 pending 信号、扫描历史或执行图片理解。
  return runtime.repository.saveSettings(normalized, runtime.now());
}

export async function listMomentImageAnalysisModelCandidates(): Promise<MomentImageAnalysisModelRef[]> {
  const configs = await getMomentMediaRuntime().auxiliaryModels.listOcr();
  return configs.filter((config) => evaluateSelection(config.id, config).status === 'active');
}

export async function getMomentImageAnalysisModelSelection(): Promise<MomentImageAnalysisModelSelection> {
  const runtime = getMomentMediaRuntime();
  const settings = await getMomentSettings();
  const config = settings.imageAnalysisModelConfigId
    ? await runtime.auxiliaryModels.getById(settings.imageAnalysisModelConfigId)
    : null;
  return evaluateSelection(settings.imageAnalysisModelConfigId, config);
}

export async function resolveMomentImageAnalysisModel(
  settings?: MomentSettings,
): Promise<MomentImageAnalysisModelRef | null> {
  const runtime = getMomentMediaRuntime();
  const current = settings ?? await getMomentSettings();
  if (!current.imageAnalysisModelConfigId) return null;
  const config = await runtime.auxiliaryModels.getById(current.imageAnalysisModelConfigId);
  return evaluateSelection(current.imageAnalysisModelConfigId, config).status === 'active'
    ? config
    : null;
}
