/** 跨 Feature 初始选择只在 Host 装配；SQL 与用户选择保护留在各 owner。 */
import { configureAuxiliaryModelInitialization, initializeAssistantVoiceModelInTransaction } from '@features/assistants/composition';
import { initializeChatImageModelInTransaction, invalidateChatSummaryModelReferencesInTransaction, invalidateChatSummaryServiceReferencesInTransaction } from '@features/chat/composition';
import { initializeSpeechRecognitionModelInTransaction } from '@features/speech/composition';
import { initializeTranslationModelInTransaction } from '@features/integrations/composition';
import { momentRepository } from '@features/moments/composition';
import { stickerRepository, emitStickerAnnotationPending, emitStickerEmbeddingPending } from '@features/stickers/composition';
import { memoryEntryRepository } from '@features/memory/composition';

export function configureAuxiliaryModelInitializationRuntime(): void {
  configureAuxiliaryModelInitialization({
    async invalidateModelReferencesInTransaction(transaction, modelConfigId) {
      await invalidateChatSummaryModelReferencesInTransaction(transaction, modelConfigId);
      await memoryEntryRepository.invalidateEmbeddingModelInTransaction(transaction, modelConfigId);
      await stickerRepository.invalidateEmbeddingModelInTransaction(transaction, modelConfigId);
    },
    invalidateServiceReferencesInTransaction: invalidateChatSummaryServiceReferencesInTransaction,
    async initializeModelSelections(transaction, model) {
      switch (model.capabilityKind) {
        case 'ocr':
          await initializeChatImageModelInTransaction(transaction, model.id);
          await momentRepository.initializeImageAnalysisModelInTransaction(transaction, model.id, model.updatedAt);
          await stickerRepository.initializeSystemModelInTransaction(transaction, 'ocr', model.id, model.updatedAt);
          break;
        case 'tts':
          await initializeAssistantVoiceModelInTransaction(transaction, model.id);
          break;
        case 'stt':
          await initializeSpeechRecognitionModelInTransaction(transaction, model.id);
          break;
        case 'embedding':
          // Memory 的空选择明确表示关闭，只能由用户在记忆设置中开启。
          await stickerRepository.initializeSystemModelInTransaction(transaction, 'embedding', model.id, model.updatedAt);
          break;
        case 'translation':
          await initializeTranslationModelInTransaction(transaction, model.id);
          break;
      }
    },
    async initializeAssistantSelections(transaction, assistantId, models) {
      for (const model of models) {
        if (model.capabilityKind === 'ocr') await initializeChatImageModelInTransaction(transaction, model.id, assistantId);
        if (model.capabilityKind === 'tts') await initializeAssistantVoiceModelInTransaction(transaction, model.id, assistantId);
      }
    },
    modelSelectionsInitialized(model) {
      // 队列唤醒在创建事务提交后；Memory 和设置投影继续消费原有资产变更信号。
      if (model.capabilityKind === 'ocr') emitStickerAnnotationPending();
      if (model.capabilityKind === 'embedding') emitStickerEmbeddingPending();
    },
  });
}
