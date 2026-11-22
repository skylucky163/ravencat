/** 在应用组合入口连接助手、聊天与语音模型解析能力。 */
import { getAssistantDisplayName,
  aiAssistantRepository,
  configureAssistantRuntime,
  HostRelationshipError,
  runHostAuthorityMutation,
  getAuxiliaryModelSelection,
  requireAuxiliaryModel,
  resolveAuxiliaryModel,
  subscribeAuxiliaryModelsChanged,
} from '@features/assistants';
import { configureSpeechModelResolver, configureSpeechRecognitionModels, getSpeechRecognitionModelId, notifySpeechRecognitionModelsChanged, speechSettingsRepository } from '@features/speech/composition';
import { appointHostAIAssistantInTransaction, configureAssistantVoiceModels, getAssistantVoiceModelId, notifyAssistantVoiceModelsChanged, assistantVoiceSettingsRepository } from '@features/assistants/composition';
import { configureTranslationModels, notifyTranslationModelsChanged, translationSettingsRepository } from '@features/integrations/composition';
import { momentRepository } from '@features/moments';
import { protocolRepository } from '@features/protocol/composition';
import { userProfileRepository } from '@features/profile';
import { ledgerRepository } from '@features/wallet';
import {
  appendExternalAssistantMessage,
  resolveCanonicalConversation,
  upsertCallTimelineEntry,
  conversationKeyOfDirect,
} from '@features/chat';
import { recordAssistantNicknameChangeInTransaction, recordAssistantRecycleLifecycleInTransaction, resolveChatImageModelInput,
  suspendAssistantChatInTransaction, purgeAssistantChatInTransaction, abortGroupSpeechTasks,
  clearSessionTimelineCache, emitChatMessagesUpdated, emitChatTurnExecutionChanged,
  configureRoleApplicationCards,
} from '@features/chat/composition';
import { purgeAssistantMomentsInTransaction } from '@features/moments/composition';
import { getConversationTurnCoordinator } from '../runtime/ConversationTurnCoordinator';
import { startHostRelationshipReplyExecution, dismissConversationNotifications } from '@platform/device';
import { purgeAssistantSchedulesInTransaction } from '@features/companion/composition';
import {
  callAudioPlayback,
  callBackgroundRepository,
  configureCallBackgroundRuntime,
  callRingtoneRepository,
  configureCallRingtoneRuntime,
  callRepository,
  configureCallRuntimeDependencies,
  requestCallCameraPermission,
  requestCallMicrophonePermission,
  createCallExecutionAdapter,
} from '@features/calls/composition';
import { handleUserEndedCallFollowUp, getActiveCallSnapshot, endCall } from '@features/calls';
import { disableCompanionProductState, invalidateAISchedulesForRevokedOwner } from '@features/companion';
import {
  assembleResolvedChatPromptPack,
  assembleResolvedStandalonePromptPack,
} from '@host/prompt';

import { applyHostModelRunToolExposure } from '@shared/aiTools';
import { prepareHostModelRun } from '../runtime/HostModelRunPreparation';
import {
  buildToolsDescription,
  getRuntimeAllowedToolNamesForAI,
  resolveAllowedToolNames,
  resolveMcpExposure,
  runHostAgent,
} from './agent';

let configured = false;

export function configureAIRuntime(): void {
  if (configured) {
    return;
  }
  configured = true;
  configureRoleApplicationCards({
    assignLedger: (tx, assistantId) => aiAssistantRepository.setLedgerAIInTransaction(tx, assistantId),
    async appointHost(tx, assistantId) {
      try { return await appointHostAIAssistantInTransaction(tx, assistantId); }
      catch (error) {
        if (error instanceof HostRelationshipError) return null;
        throw error;
      }
    },
    runHostApproval: runHostAuthorityMutation,
  });

  configureTranslationModels({
    repository: translationSettingsRepository,
    getSelection: (modelConfigId) => getAuxiliaryModelSelection({ capabilityKind: 'translation', modelConfigId }),
    requireModel: (modelConfigId) => requireAuxiliaryModel(modelConfigId, 'translation'),
    resolveModel: async (modelConfigId) => {
      const model = await resolveAuxiliaryModel({ capabilityKind: 'translation', modelConfigId });
      return model ? { ...model, metadataJson: model.metadataJson! } : null;
    },
  });

  configureSpeechRecognitionModels({
    repository: speechSettingsRepository,
    getSelection: (modelConfigId) => getAuxiliaryModelSelection({ capabilityKind: 'stt', modelConfigId }),
    requireModel: (modelConfigId) => requireAuxiliaryModel(modelConfigId, 'stt'),
  });
  configureAssistantVoiceModels({
    repository: assistantVoiceSettingsRepository,
    getSelection: (modelConfigId) => getAuxiliaryModelSelection({ capabilityKind: 'tts', modelConfigId }),
    requireModel: (modelConfigId) => requireAuxiliaryModel(modelConfigId, 'tts'),
  });
  configureSpeechModelResolver(async ({ capabilityKind, assistantId }) => {
    const modelConfigId = capabilityKind === 'stt'
      ? await getSpeechRecognitionModelId()
      : assistantId ? await getAssistantVoiceModelId(assistantId) : null;
    const model = await resolveAuxiliaryModel({ capabilityKind, modelConfigId });
    // 失效引用与尚未选择分开报告，具体错误由 Speech 启动链路展示。
    if (capabilityKind === 'stt' && modelConfigId !== null && !model) {
      throw new Error('所选 STT 模型配置不可用，请检查配置或重新选择 STT 模型');
    }
    return model;
  });
  subscribeAuxiliaryModelsChanged(() => {
    notifySpeechRecognitionModelsChanged();
    notifyAssistantVoiceModelsChanged();
    notifyTranslationModelsChanged();
  });
  configureCallBackgroundRuntime(callBackgroundRepository);
  configureCallRingtoneRuntime(callRingtoneRepository);
  configureCallRuntimeDependencies({
    agent: {
      run: runHostAgent,
      prepareTools: async (aiConfig) => {
        if (aiConfig.enableTools !== true) {
          return { allowedToolNames: [], toolsDescription: '', mcpServices: [], additionalPromptBlocks: [] };
        }
        const persistentAllowedToolNames = await resolveAllowedToolNames(aiConfig.id);
        const preparation = await prepareHostModelRun({
          scenario: 'call.live_reply', currentAiId: aiConfig.id,
          isHostAI: aiConfig.isHostAI === true, persistentAllowedToolNames,
        });
        const names = getRuntimeAllowedToolNamesForAI({
          ...aiConfig, triggerSource: 'call', memoryParticipation: 'read_write',
          allowedToolNames: persistentAllowedToolNames,
        });
        const mcp = await resolveMcpExposure(aiConfig.id);
        const allowedToolNames = [...applyHostModelRunToolExposure(names, preparation), ...mcp.allowedToolNames];
        return {
          allowedToolNames, toolsDescription: buildToolsDescription(allowedToolNames),
          mcpServices: mcp.services, additionalPromptBlocks: preparation.additionalPromptBlocks,
        };
      },
    },
    chat: {
      upsertCallTimelineEntry,
      appendExternalAssistantMessage,
    },
    repositories: {
      calls: callRepository,
      protocol: protocolRepository,
      moment: momentRepository,
      profile: userProfileRepository,
      ledger: ledgerRepository,
    },
    assembleChatPromptPack: assembleResolvedChatPromptPack,
    assembleStandalonePromptPack: assembleResolvedStandalonePromptPack,
    resolveAIConfig: async (aiId) => {
      const assistant = await aiAssistantRepository.getById(aiId);
      if (!assistant) {
        return null;
      }
      return {
        id: assistant.id,
        agentId: assistant.agentId,
        name: assistant.name,
        avatar: assistant.avatar,
        model: assistant.model,
        apiKey: assistant.apiKey || '',
        apiBaseUrl: assistant.apiBaseUrl || '',
        systemPrompt: assistant.systemPrompt || undefined,
        temperature: assistant.temperature,
        topP: assistant.topP,
        disableThinking: assistant.disableThinking,
        reasoningEffort: assistant.reasoningEffort,
        maxTokens: assistant.maxTokens,
        privateContextPrimaryLimit: assistant.privateContextPrimaryLimit,
        privateContextSecondaryLimit: assistant.privateContextSecondaryLimit,
        groupContextPrimaryLimit: assistant.groupContextPrimaryLimit,
        groupContextSecondaryLimit: assistant.groupContextSecondaryLimit,
        enableTools: assistant.enableTools,
        allowMultipleBubbles: assistant.allowMultipleBubbles,
        isHostAI: assistant.isHostAI,
        isBlocked: assistant.isBlocked,
      };
    },
    resolveImageModelInput: resolveChatImageModelInput,
    native: {
      audioPlayback: callAudioPlayback,
      requestCallCameraPermission,
      requestMicrophonePermission: requestCallMicrophonePermission,
      execution: createCallExecutionAdapter(
        (id) => `exp+kimiphone:///calls/${encodeURIComponent(id)}`,
        async (assistantId) => {
          const assistant = await aiAssistantRepository.getById(assistantId);
          if (!assistant) throw new Error(`通话角色 ${assistantId} 不存在`);
          return { name: getAssistantDisplayName(assistant), avatar: assistant.avatar };
        },
      ),
    },
    onCallTerminated: handleUserEndedCallFollowUp,
  });
  configureAssistantRuntime({
    recordRecycleLifecycleInTransaction: recordAssistantRecycleLifecycleInTransaction,
    suspendAssistantInTransaction: async (transaction, assistantId) => {
      const suspended = await suspendAssistantChatInTransaction(transaction, assistantId);
      return async () => {
        abortGroupSpeechTasks(suspended.taskIds);
        for (const id of suspended.sessionIds) {
          clearSessionTimelineCache(id);
          await getConversationTurnCoordinator().abortInvalidatedTurn(id);
          emitChatMessagesUpdated(id);
          emitChatTurnExecutionChanged(id);
        }
        const call = getActiveCallSnapshot();
        if (call?.aiAssistantId === assistantId) await endCall(call.id, 'blocked');
        await dismissConversationNotifications(conversationKeyOfDirect(assistantId));
      };
    },
    purgeAssistantInTransaction: async (transaction, assistantId, agentId) => {
      await purgeAssistantSchedulesInTransaction(transaction, assistantId);
      return [...await purgeAssistantChatInTransaction(transaction, assistantId),
        ...await purgeAssistantMomentsInTransaction(transaction, agentId)];
    },
    recordNicknameChangeInTransaction: recordAssistantNicknameChangeInTransaction,
    resolveCanonicalConversation: (aiId) => resolveCanonicalConversation({ aiId }),
    onHostRelationshipChanged: async (aiId, change, occurredAt) => {
      // 回复属于提交后沟通，启动失败不能把已经生效的任命／撤销报告成失败。
      try {
        if (!await startHostRelationshipReplyExecution(aiId, change, occurredAt)) {
          console.warn('[HostRelationship] 身份变更已生效，原生回复任务未启动', { aiId, change });
        }
      } catch (error) {
        console.warn('[HostRelationship] 身份变更已生效，回复唤醒失败', error);
      }
    },
    onHostRelationshipRemoved: async (aiId, reason) => {
      // 跨 Feature fan-out：主理关系移除后，同步收口 Companion 与 AI Schedule 的 future 状态。
      await Promise.all([
        disableCompanionProductState({
          failureCode: reason === 'deleted' ? 'host_ai_removed' : 'host_ai_missing',
          clearHostAI: true,
          expectedHostAIId: aiId,
        }),
        invalidateAISchedulesForRevokedOwner(aiId),
      ]);
    },
  });
}
