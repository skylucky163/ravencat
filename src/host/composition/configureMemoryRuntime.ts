/** Host 装配身份空间与 Memory 自有向量选择，不向 Memory 泄露其他 Feature 的仓储。 */
import { getAssistantDisplayName, aiAssistantRepository, getAuxiliaryModelSelection, requireAuxiliaryModel, resolveAuxiliaryModel, subscribeAuxiliaryModelsChanged } from '@features/assistants';
import { createAIClient } from '@platform/ai';
import { configureMemoryRuntimeDependencies, memoryEntryRepository, memoryRepository, MemoryEmbeddingError, synchronizeMemoryEmbeddingModel } from '@features/memory/composition';
import { configureMemoryEmbeddingQueue, refreshMemoryEmbeddingModel, updateMemoryEmbeddingModel } from '../runtime/MemoryEmbeddingQueueCoordinator';
import { convertExitedGroupHistoryToMemory } from '../application/ConvertExitedGroupHistoryToMemory';

let configured = false;
export function configureMemoryRuntime(): void {
  if (configured) return;
  configured = true;
  const resolveMemorySpace = async (assistantId: string) => {
    const assistant = await aiAssistantRepository.getById(assistantId);
    if (!assistant) throw new Error('无法为不存在的 AI 解析记忆空间');
    const pool = await memoryRepository.getOrCreatePairPool({ aiAssistantId: assistant.id });
    return { poolId: pool.id, assistantId: assistant.id, assistantName: getAssistantDisplayName(assistant),
      assistantAvatar: assistant.avatar, isHost: assistant.isHostAI };
  };
  const resolveEmbeddingModel = async () => {
    const settings = await memoryEntryRepository.getEmbeddingSettings();
    if (!settings.enabled) return null;
    const model = await resolveAuxiliaryModel({ capabilityKind: 'embedding', modelConfigId: settings.modelConfigId });
    if (!model) return null;
    return { id: model.modelConfigId, name: model.modelConfigName,
      fingerprint: JSON.stringify([model.modelConfigId, model.modelConfigUpdatedAt, model.baseURL, model.model, model.metadataJson]),
      baseURL: model.baseURL, apiKey: model.apiKey, model: model.model, metadataJson: model.metadataJson };
  };
  configureMemoryRuntimeDependencies({
    repository: memoryEntryRepository,
    convertExitedGroupHistory: convertExitedGroupHistoryToMemory,
    resolveMemorySpace,
    async listMemorySpaces() {
      // 星空只消费身份摘要；已列出的身份不再逐个读取完整模型配置。
      const assistants = await aiAssistantRepository.listSummaries();
      return Promise.all(assistants.map(async (assistant) => {
        const pool = await memoryRepository.getOrCreatePairPool({ aiAssistantId: assistant.id });
        return { poolId: pool.id, assistantId: assistant.id, assistantName: getAssistantDisplayName(assistant),
          assistantAvatar: assistant.avatar, isHost: assistant.isHostAI };
      }));
    },
    resolveEmbeddingModel,
    withEmbeddingMaintenance: updateMemoryEmbeddingModel,
    async getEmbeddingModelSettings() {
      return getAuxiliaryModelSelection({ capabilityKind: 'embedding', modelConfigId: (await memoryEntryRepository.getEmbeddingSettings()).modelConfigId });
    },
    async selectEmbeddingModel(modelConfigId) {
      if (modelConfigId !== null) await requireAuxiliaryModel(modelConfigId, 'embedding');
      await updateMemoryEmbeddingModel(async () => {
        await memoryEntryRepository.setEmbeddingModelId(modelConfigId);
        await synchronizeMemoryEmbeddingModel();
      });
    },
    async clearEmbeddings() {
      await updateMemoryEmbeddingModel(async () => memoryEntryRepository.clearEmbeddings(await resolveEmbeddingModel()));
    },
    async setEmbeddingEnabled(enabled) {
      await updateMemoryEmbeddingModel(async () => {
        await memoryEntryRepository.setEmbeddingEnabled(enabled);
        await synchronizeMemoryEmbeddingModel();
      });
    },
    async embed(text, model, signal) {
      const controller = new AbortController();
      const forward = () => controller.abort();
      signal.addEventListener('abort', forward, { once: true });
      if (signal.aborted) controller.abort();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 60_000);
      try {
        const response = await createAIClient({ baseURL: model.baseURL, apiKey: model.apiKey, model: model.model }).embed(text, { signal: controller.signal });
        if (!response.success) {
          const code = response.errorCode ?? 'unknown';
          const messages = {
            authentication: '向量模型认证失败，请检查 API Key', configuration: '向量模型拒绝了当前配置或输入，请检查模型设置',
            model_unavailable: '向量模型不存在或接口不可用', input_too_long: '输入超过向量模型支持的长度',
            rate_limit: '向量服务请求过于频繁', network: '无法连接向量服务', timeout: '向量服务请求超时',
            service: '向量服务暂时不可用', invalid_response: '向量服务返回的数据不符合数量、顺序或数值契约',
            dimension_mismatch: '向量模型返回的维度不一致', unknown: '向量化请求失败，未能取得更详细原因',
          };
          throw new MemoryEmbeddingError(messages[code], ['authentication', 'configuration', 'model_unavailable', 'input_too_long', 'invalid_response', 'dimension_mismatch'].includes(code));
        }
        return response.embeddings[0];
      } catch (error) {
        if (timedOut && !signal.aborted) throw new MemoryEmbeddingError('向量请求超过 60 秒', false);
        throw error;
      } finally { clearTimeout(timer); signal.removeEventListener('abort', forward); }
    },
  });
  configureMemoryEmbeddingQueue();
  subscribeAuxiliaryModelsChanged(refreshMemoryEmbeddingModel);
}
