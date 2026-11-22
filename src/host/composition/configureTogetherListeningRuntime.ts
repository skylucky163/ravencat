/** 在 Host 组装 Together Listening 产品真值仓储与基础时钟。 */

import {
  configureTogetherListeningRuntimeDependencies,
  togetherListeningRepository,
  type TogetherListeningNetEaseObservation,
} from '@features/togetherListening/composition';
import {
  getCurrentTogetherListeningActivity,
  reconcileTogetherListeningSystemPresentation,
} from '@features/togetherListening';
import {
  getNetEasePlaybackSnapshot,
  getNetEaseCurrentLyric,
  NetEasePlaybackError,
} from '@features/phoneTools';
import { configureChatTogetherListeningGateway } from '@features/chat/composition';
import { appendExternalAssistantMessage } from '@features/chat';
import { getAssistantDisplayName,
  aiAssistantRepository,
  subscribeAIAssistantUpdated,
} from '@features/assistants';
import {
  clearTogetherListeningPresentation,
  updateTogetherListeningPresentation,
} from '@features/floatingLayer';
import { getCurrentUserProfile, subscribeUserProfileUpdated } from '@features/profile';
import {
  cancelTogetherListeningSystemPresentation,
  createRandomUUID,
  upsertTogetherListeningSystemPresentation,
} from '@platform/device';
import { assembleResolvedStandalonePromptPack } from '@host/prompt';
import { createChatTogetherListeningGateway } from './createChatTogetherListeningGateway';

let configured = false;

export function configureTogetherListeningRuntime(): void {
  if (configured) {
    return;
  }
  configured = true;

  const chatGateway = createChatTogetherListeningGateway();
  configureChatTogetherListeningGateway(chatGateway);

  configureTogetherListeningRuntimeDependencies({
    repository: togetherListeningRepository,
    chat: chatGateway,
    systemPresentation: {
      upsertActivePresentation: async (state) => {
        const result = await upsertTogetherListeningSystemPresentation(state);
        const user = await getCurrentUserProfile();
        await updateTogetherListeningPresentation({
          ...state,
          userName: user.name,
          userAvatar: user.avatar,
        });
        if (result.status === 'failed') {
          throw new Error(result.error || 'Android system presentation 发布失败');
        }
      },
      cancelPresentation: async (activityId) => {
        await Promise.all([
          cancelTogetherListeningSystemPresentation(activityId),
          clearTogetherListeningPresentation(activityId),
        ]);
      },
    },
    declineFollowUp: {
      resolveAIConfig: async (aiId) => {
        const assistant = await aiAssistantRepository.getById(aiId);
        if (!assistant) {
          return null;
        }
        return {
          id: assistant.id,
          agentId: assistant.agentId,
          name: assistant.name,
          avatar: assistant.avatar || null,
          model: assistant.model,
          apiKey: assistant.apiKey || '',
          apiBaseUrl: assistant.apiBaseUrl || '',
          systemPrompt: assistant.systemPrompt || undefined,
          temperature: assistant.temperature,
          topP: assistant.topP,
          disableThinking: assistant.disableThinking,
          reasoningEffort: assistant.reasoningEffort,
          maxTokens: assistant.maxTokens ?? undefined,
        };
      },
      assembleStandalonePromptPack: assembleResolvedStandalonePromptPack,
      appendExternalAssistantMessage: (input) => appendExternalAssistantMessage(input),
    },
    generateId: () => `together-listening-${createRandomUUID()}`,
    nowEpochMs: Date.now,
    observeNetEasePlayback,
    readCurrentNetEaseLyric: getNetEaseCurrentLyric,
    getCurrentHostAIId: async () => (await aiAssistantRepository.getHostAI())?.id ?? null,
    resolveSystemPresentationAIIdentity: async (aiId) => {
      const assistant = await aiAssistantRepository.getById(aiId);
      return assistant
        ? { name: getAssistantDisplayName(assistant), avatar: assistant.avatar || null }
        : null;
    },
  });

  // 身份变化后复用现有系统 presentation 对账路径，重投影当前 active Activity。
  subscribeUserProfileUpdated(() => {
    void reprojectActiveTogetherListeningPresentation().catch((error) => {
      console.warn('[TogetherListening] 用户资料更新后的系统 presentation 重投影失败：', error);
    });
  });
  subscribeAIAssistantUpdated((assistant) => {
    void reprojectActiveTogetherListeningPresentation(assistant.id).catch((error) => {
      console.warn('[TogetherListening] AI 资料更新后的系统 presentation 重投影失败：', error);
    });
  });
}

/** 身份资料更新后，把匹配的 active Together Activity 重新投影到系统 presentation。 */
async function reprojectActiveTogetherListeningPresentation(
  expectedHostAiId?: string,
): Promise<void> {
  const activity = await getCurrentTogetherListeningActivity();
  if (
    !activity
    || activity.phase !== 'active'
    || (expectedHostAiId !== undefined && activity.hostAiId !== expectedHostAiId)
  ) {
    return;
  }
  await reconcileTogetherListeningSystemPresentation();
}

async function observeNetEasePlayback(): Promise<TogetherListeningNetEaseObservation> {
  try {
    const { snapshot } = await getNetEasePlaybackSnapshot();
    return {
      status: 'snapshot_available',
      playbackState: snapshot.playback.state,
      mediaId: snapshot.metadata.mediaId,
      title: snapshot.metadata.title,
      artist: snapshot.metadata.artist,
      album: snapshot.metadata.album,
      positionMs: snapshot.playback.positionMs,
      speed: snapshot.playback.speed,
      updatedAtEpochMs: snapshot.playback.updatedAtEpochMs,
      durationMs: snapshot.metadata.durationMs,
      audioOutput: snapshot.audioOutput,
    };
  } catch (error) {
    if (!(error instanceof NetEasePlaybackError)) {
      throw error;
    }
    switch (error.reason) {
      case 'no_active_session':
      case 'permission_not_granted':
      case 'protected_app':
        return { status: error.reason };
      case 'snapshot_failed':
        return { status: 'observation_failed' };
      case 'action_not_supported':
      case 'dispatch_failed':
        throw new Error(`网易云只读观察返回了控制命令错误：${error.reason}`);
    }
  }
}
