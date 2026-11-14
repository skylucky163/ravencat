import { Asset } from 'expo-asset';
import { getCurrentUserProfile } from '@features/profile';
import { listAIAssistantSummaries, getAuxiliaryModelConfigById, listAuxiliaryModelConfigs, subscribeAuxiliaryModelsChanged } from '@features/assistants';
import { resolveChatImageModelInput } from '@features/chat/composition';
import { configureAIImageRuntime, SQLiteAIDownloadedImageRepository, SQLiteAIGeneratedImageRepository,
  configureImageGenerationModels, notifyImageGenerationModelsChanged, SQLiteImageGenerationSettingsRepository } from '@features/media/composition';
import { getDefaultAIAvatarAsset, getDefaultUserAvatarAsset } from '@shared/avatar/avatarRegistry';
import { assertImageToolRunCurrent } from './agent/assertImageToolRunCurrent';

let configured = false;

/** 默认头像与当前头像引用均来自现有展示契约，不建立另一份头像数据。 */
export function configureAIImageTools(): void {
  if (configured) return;
  configured = true;
  configureImageGenerationModels({
    repository: new SQLiteImageGenerationSettingsRepository(),
    getModel: id => getAuxiliaryModelConfigById({ id }),
    listModels: () => listAuxiliaryModelConfigs({ capabilityKind: 'image_generation' }),
  });
  subscribeAuxiliaryModelsChanged(notifyImageGenerationModelsChanged);
  configureAIImageRuntime({
    downloads: new SQLiteAIDownloadedImageRepository(),
    generated: new SQLiteAIGeneratedImageRepository(),
    assertCurrent: assertImageToolRunCurrent,
    async resolveAvatar(target, assistantId, selector) {
      let owner: { name: string; avatar: string | null; avatarMediaAssetId: string | null };
      if (target === 'user_avatar') owner = await getCurrentUserProfile();
      else {
        const assistants = await listAIAssistantSummaries();
        const matchesById = assistants.filter(ai => ai.id === selector || ai.agentId === selector);
        const candidates = target === 'self_avatar' ? assistants.filter(ai => ai.id === assistantId)
          : matchesById.length > 0 ? matchesById : assistants.filter(ai => ai.name === selector);
        if (candidates.length === 0) return { status: 'not_found', message: '未找到指定 AI 的头像，请提供准确的 id 或名称' };
        if (candidates.length > 1) return { status: 'ambiguous', candidates: candidates.map(ai => ({ id: ai.id, name: ai.name })) };
        owner = candidates[0];
      }
      const label = `${owner.name}的头像`;
      if (owner.avatarMediaAssetId) return { status: 'found', mediaAssetId: owner.avatarMediaAssetId, label };
      if (owner.avatar) return { status: 'found', imageUri: owner.avatar, label };
      const asset = target === 'user_avatar' ? getDefaultUserAvatarAsset() : getDefaultAIAvatarAsset();
      const bundled = await Asset.fromModule(asset).downloadAsync();
      return { status: 'found', imageUri: bundled.localUri!, label };
    },
    async view(input) {
      return resolveChatImageModelInput(input);
    },
  });
}
