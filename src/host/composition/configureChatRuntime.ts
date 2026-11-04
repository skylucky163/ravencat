/** 将 Chat 的仓储端口与数据库维护能力连接到具体实现。 */
import { chatSummaryRepository } from './chatSummaryRepository';
import { resolveImageGroundingPrompt, resolveVisionOCRPrompt } from '@features/prompting';
import {
  configureChatRuntimeDependencies,
  configureChatTextDrafts,
  configureChatBubbleSkins,
  SQLiteChatBubbleSkinRepository,
  SQLiteChatTextDraftRepository,
  configureChatImageModels,
  resolveChatRecognitionModel,
  notifyChatImageModelsChanged,
  chatImageSettingsRepository,
  conversationTurnRepository,
  groupChatRepository,
  groupMembershipRepository,
  messageRepository,
  sessionRepository,
  configureChatFavoriteRuntime,
  SQLiteChatFavoriteRepository,
  configureChatTurnPresentation,
  chatTurnPresentationRepository,
  configureTurnDisplayPacing,
  freezeTurnDisplays,
  interruptSessionTurnDisplays,
  applyAssistantMessageArrivalSnapshot,
} from '@features/chat/composition';
import { clearDB, getDBInfo } from '@platform/persistence';
import {
  PERSISTENT_MEDIA_CATEGORY,
  awaitTurnDisplayArrival,
  setTurnDisplayOpen,
  setTurnDisplayActive,
  finishMessageArrival,
  persistentMediaStore,
  readVisionImageAsBase64,
} from '@platform/device';
import {
  aiAssistantRepository,
  aiHostRepository,
  getAuxiliaryModelSelection,
  requireAuxiliaryModel,
  resolveAuxiliaryModel,
  subscribeAuxiliaryModelsChanged,
} from '@features/assistants';
import {
  buildToolsDescription,
  getRuntimeAllowedToolNamesForAI,
  cancelHostAgentRun,
  runHostAgent,
  resolveMcpExposure,
  resolveAllowedToolNames,
  resolveToolRuntimeContext,
} from './agent';
import { ToolContext } from '@shared/aiTools';
import { momentRepository } from '@features/moments';
import { protocolRepository } from '@features/protocol';
import { userProfileRepository } from '@features/profile';
import { ledgerRepository } from '@features/wallet';
import {
  assembleResolvedChatPromptPack,
  assembleResolvedLedgerPromptPack,
  assembleResolvedStandalonePromptPack,
} from '@host/prompt';
import { prepareHostModelRun } from '@host/runtime/HostModelRunPreparation';
import { getConversationTurnCoordinator } from '../runtime/ConversationTurnCoordinator';
import { aiScheduleRepository } from '@features/companion/composition';
import {
  MEDIA_ASSET_STORAGE_BACKEND,
  resolveMediaAsset,
} from '@features/media';
import { adoptExistingMediaAssetsWithReference } from './configureMediaRuntime';

let configured = false;

export function configureChatRuntime(): void {
  if (configured) {
    return;
  }
  configured = true;
  configureChatTextDrafts(new SQLiteChatTextDraftRepository());
  configureChatBubbleSkins(new SQLiteChatBubbleSkinRepository());
  configureChatFavoriteRuntime(new SQLiteChatFavoriteRepository());
  configureChatTurnPresentation(chatTurnPresentationRepository);
  configureTurnDisplayPacing(awaitTurnDisplayArrival, setTurnDisplayOpen, async messageIds => {
    applyAssistantMessageArrivalSnapshot(await finishMessageArrival(messageIds));
  }, setTurnDisplayActive);

  configureChatImageModels({
    repository: chatImageSettingsRepository,
    getSelection: (modelConfigId) => getAuxiliaryModelSelection({ capabilityKind: 'ocr', modelConfigId }),
    resolveModel: (modelConfigId) => resolveAuxiliaryModel({ capabilityKind: 'ocr', modelConfigId }),
    requireModel: (modelConfigId) => requireAuxiliaryModel(modelConfigId, 'ocr'),
  });
  subscribeAuxiliaryModelsChanged(notifyChatImageModelsChanged);
  configureChatRuntimeDependencies({
    captureGroupHistory: (tx, groupId, groupName) => chatSummaryRepository.captureGroupHistoryInTransaction(tx, groupId, groupName),
    mutations: { isRunCurrent: (transaction, runId) => conversationTurnRepository.isRunCurrentInTransaction(transaction, runId) },
    turnPresentation: { freeze: freezeTurnDisplays, interrupt: interruptSessionTurnDisplays },
    repositories: {
      messages: messageRepository,
      sessions: sessionRepository,
      groups: groupChatRepository,
      membership: groupMembershipRepository,
      turns: conversationTurnRepository,
    },
    assistantDirectory: {
      list: () => aiAssistantRepository.getAll(),
      getById: (assistantId) => aiAssistantRepository.getById(assistantId),
      getBlockState: async (assistantId) => {
        await aiHostRepository.cleanupExpiredBlocks();
        return aiHostRepository.isAIBlocked(assistantId);
      },
    },
    currentUserDirectory: {
      getCurrent: () => userProfileRepository.ensureDefault(),
    },
    // canonical 用户消息 commit 后：abort 被 supersede 的旧句柄并启动新一轮 claimIfIdle。
    canonicalUserMessage: {
      onCommitted: async (payload) => {
        // T1 已撤销旧 fence；先持久交接日程背景，再允许新聊天组装上下文。
        // 即使旧执行已抢先 consume，也不能丢掉此次交接。
        if (payload.supersededRunId) await aiScheduleRepository.mergeClaimedRun(
          payload.supersededRunId, null, new Date().toISOString());
        const session = await sessionRepository.getSession(payload.sessionId);
        if (session) await aiScheduleRepository.mergeDueIntoChat(session.aiAssistantId, new Date().toISOString());
        await getConversationTurnCoordinator().onCanonicalUserMessageCommitted(payload);
      },
    },
    regeneration: {
      onRequested: (sessionId) => getConversationTurnCoordinator().requestRegenerationFromHost(sessionId),
      onInvalidated: (sessionId) => getConversationTurnCoordinator().abortInvalidatedTurn(sessionId),
    },
    legacyChatAttachments: {
      locateLegacyChatFile: async (localUri, attachmentType) => {
        const located = await persistentMediaStore.mapLegacyChatUriToAssetReference({
          uri: localUri,
          category: attachmentType === 'image'
            ? PERSISTENT_MEDIA_CATEGORY.chatImage
            : PERSISTENT_MEDIA_CATEGORY.chatFile,
        });
        return located
          ? {
              storageBackend: MEDIA_ASSET_STORAGE_BACKEND.persistentMedia,
              ...located,
            }
          : null;
      },
      adoptLegacyChatFiles: async (inputs, commit) => {
        const result = await adoptExistingMediaAssetsWithReference(
          inputs,
          ({ transaction, assets }) => commit(transaction, assets),
        );
        return result.value;
      },
    },
    database: {
      clear: clearDB,
      getInfo: getDBInfo,
    },
    media: {
      readVisionImage: async (input) => {
        const localUri = input.kind === 'media_asset'
          ? (await resolveMediaAsset(input.assetId)).localUri
          : input.uri;
        return readVisionImageAsBase64(localUri);
      },
    },
    vision: {
      resolveOCRModel: resolveChatRecognitionModel,
    },
    agent: {
      run: runHostAgent,
      cancel: cancelHostAgentRun,
    },
    runPreparation: {
      prepare: prepareHostModelRun,
    },
    tools: {
      createContext: (params) => new ToolContext({
        ...params,
        repositories: {
          message: messageRepository,
          protocol: protocolRepository,
          moment: momentRepository,
          profile: userProfileRepository,
          ledger: ledgerRepository,
        },
      }),
      buildDescription: buildToolsDescription,
      getRuntimeAllowedNames: getRuntimeAllowedToolNamesForAI,
      resolveAllowedNames: resolveAllowedToolNames,
      resolveMcpExposure,
      resolveRuntimeContext: resolveToolRuntimeContext,
    },
    prompt: {
      readImageGroundingReminder: resolveImageGroundingPrompt,
      resolveVisionOCRPrompt,
      assembleChat: assembleResolvedChatPromptPack,
      assembleLedger: assembleResolvedLedgerPromptPack,
      assembleStandalone: assembleResolvedStandalonePromptPack,
    },
  });
}
