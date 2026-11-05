/** 聊天详情及其子页面的独立路由内容。 */
import React, {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { ProtocolView, type Protocol } from '@features/protocol';
import { useTheme, type PresentationTheme } from '@shared/theme';
import { EmptyState, showAppDialog } from '@shared/ui';
import CreateGroup from '../group/CreateGroup';
import GroupAdminSettings from '../group/GroupAdminSettings';
import GroupChatDetail from '../group/GroupChatDetail';
import GroupOptions from '../group/GroupOptions';
import { renameGroupChat, subscribeGroupChanged } from '../../group/application/GroupMembership';
import AIOptions from '../conversation/AIOptions';
import ChatStatisticsScreen from '../conversation/ChatStatisticsScreen';
import ChatMessageSearchScreen from '../messages/ChatMessageSearchScreen';
import ChatMessageContextScreen from '../messages/ChatMessageContextScreen';
import ChatSummaryScreen from '../../summary/presentation/ChatSummaryScreen';
import ChatSummaryEditorScreen from '../../summary/presentation/ChatSummaryEditorScreen';
import ChatSummarySettingsScreen from '../../summary/presentation/ChatSummarySettingsScreen';
import ChatSummaryTaskScreen from '../../summary/presentation/ChatSummaryTaskScreen';
import ChatSecondarySummaryScreen from '../../summary/presentation/ChatSecondarySummaryScreen';
import ChatDetail from '../messages/ChatDetail';
import FilePreview from '../messages/FilePreview';
import ChatBackground from '../messages/components/ChatBackground';
import type { ChatSubScreen } from './chatScreenTypes';
import { useChatRouter } from './ChatRouterContext';
import {
  deleteGroupChat,
  getGroupChat,
  updateGroupChatAdminConfig,
  updateGroupChatProfile,
  updateGroupChatAvatarFromDraft,
} from '../../group/application';
import type {
  GroupChatDetails,
  UpdateGroupChatProfileInput,
} from '../../group/domain/GroupChat';
import { clearChatConversationHistory } from '../../conversation/application/ChatPresentation';
import { clearSessionTimelineCache } from '../messages/components/sessionTimelineCache';

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background.app },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function RouteLoading({ chatBackgroundKey = null }: { chatBackgroundKey?: string | null }) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const loading = (
    <View style={styles.loading}>
      <ActivityIndicator size="large" color={theme.colors.brand.primary} />
    </View>
  );

  return chatBackgroundKey
    ? <ChatBackground chatKey={chatBackgroundKey}>{loading}</ChatBackground>
    : <View style={styles.container}>{loading}</View>;
}

function usePreparedConversation(
  aiId: string,
  sessionId?: string | null,
  preparationEnabled = true
) {
  const router = useChatRouter();
  const currentAIId = router.state.currentAI?.id;
  const currentSessionId = router.state.currentSession?.id;
  const ensureConversation = router.ensureConversation;

  const initiallyReady = currentAIId === aiId
    && (!sessionId || currentSessionId === sessionId);

  const [preparing, setPreparing] = useState(!initiallyReady);
  const [unavailableReason, setUnavailableReason] = useState<
    'assistant-not-found' | 'session-not-found' | null
  >(null);

  useEffect(() => {
    let active = true;

    if (!preparationEnabled) {
      return () => {
        active = false;
      };
    }

    if (
      currentAIId === aiId
      && (!sessionId || currentSessionId === sessionId)
    ) {
      setUnavailableReason(null);
      setPreparing(false);

      return () => {
        active = false;
      };
    }

    setUnavailableReason(null);
    setPreparing(true);

    void (async () => {
      while (active) {
        const result = await ensureConversation(aiId, sessionId);
        if (!active) {
          return;
        }
        if (result === 'superseded') {
          continue;
        }

        setPreparing(false);
        if (result !== 'ready') {
          setUnavailableReason(result);
        }
        return;
      }
    })();

    return () => {
      active = false;
    };
  }, [
    aiId,
    sessionId,
    currentAIId,
    currentSessionId,
    ensureConversation,
    preparationEnabled,
  ]);

  return {
    ...router,
    preparing,
    unavailableReason,
  };
}

function ConversationUnavailable({
  reason,
  onBack,
}: {
  reason: 'assistant-not-found' | 'session-not-found';
  onBack: () => void;
}) {
  return (
    <EmptyState
      title={reason === 'assistant-not-found' ? '找不到这个 AI' : '找不到这个会话'}
      description="目标可能已被删除，或链接已经失效。"
      actionText="返回会话列表"
      onAction={onBack}
    />
  );
}

function openNestedScreen(
  openSubScreen: (screen: ChatSubScreen) => void,
  screen: ChatSubScreen
) {
  openSubScreen(screen);
}

function useSubScreenLifecycle(
  setCurrentSubScreen: Dispatch<SetStateAction<ChatSubScreen | null>>,
  screen: ChatSubScreen,
  fallback: ChatSubScreen | null
) {
  useEffect(() => {
    setCurrentSubScreen(screen);
    return () => setCurrentSubScreen((current) => current === screen ? fallback : current);
  }, [fallback, screen, setCurrentSubScreen]);
}

function usePreparedGroup(groupId: string) {
  const router = useChatRouter();
  const { currentGroup, ensureGroup, routeBack } = router;
  const [preparing, setPreparing] = useState(currentGroup?.id !== groupId);

  useEffect(() => {
    let active = true;

    if (currentGroup?.id === groupId) {
      setPreparing(false);
      return () => {
        active = false;
      };
    }

    setPreparing(true);
    void ensureGroup(groupId).then((found) => {
      if (!active) {
        return;
      }

      setPreparing(false);
      if (!found) {
        routeBack();
      }
    });

    return () => {
      active = false;
    };
  }, [currentGroup?.id, ensureGroup, groupId, routeBack]);

  return { ...router, preparing };
}

function useGroupRouteDetails(groupId: string, enabled: boolean) {
  const [details, setDetails] = useState<GroupChatDetails | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let request = 0;
    setDetails(null);
    setLoadError(null);
    const load = () => {
      const currentRequest = ++request;
      void getGroupChat(groupId)
      .then((nextDetails) => {
        if (!active || currentRequest !== request) {
          return;
        }
        if (!nextDetails) {
          setLoadError('目标群聊可能已被删除，或链接已经失效。');
          return;
        }
        setDetails(nextDetails);
        setLoadError(null);
      })
      .catch((error) => {
        if (!active || currentRequest !== request) {
          return;
        }
        setLoadError(error instanceof Error ? error.message : '群聊信息加载失败');
      });
    };
    load();
    const unsubscribe = subscribeGroupChanged(id => { if (id === groupId) load(); });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [enabled, groupId]);

  return { details, setDetails, loadError };
}

function GroupRouteUnavailable({
  description,
  onBack,
}: {
  description: string;
  onBack: () => void;
}) {
  return (
    <EmptyState
      title="无法打开群聊"
      description={description}
      actionText="返回会话列表"
      onAction={onBack}
    />
  );
}

export function ChatConversationRouteScreen({
  aiId,
  sessionId = null,
  anchorMessageId = null,
  routeFocused,
  onOpenAssistantProfile,
}: {
  aiId: string;
  sessionId?: string | null;
  /** 主动生活「查看当时的聊天」一次性定位目标；null 表示正常进入。 */
  anchorMessageId?: number | null;
  routeFocused: boolean;
  onOpenAssistantProfile: (aiId: string) => void;
}) {
  const router = usePreparedConversation(aiId, sessionId, routeFocused);
  const theme = useTheme();
  const { state } = router;
  const onActiveChatContextChange = router.onActiveChatContextChange;
  const chatBackgroundKey = `single:${sessionId || state.currentSession?.id || aiId}`;
  const foregroundOwnerId = `direct:${aiId}:${sessionId || 'current'}`;
  const visibleSessionId = state.currentSession?.id || null;
  const conversationVisible = !router.preparing
    && !router.unavailableReason
    && router.currentUserReady
    && state.currentAI?.id === aiId
    && (!sessionId || visibleSessionId === sessionId);
  const backToListRef = useRef(state.handleBackToList);
  const handledBackRef = useRef(false);
  backToListRef.current = state.handleBackToList;
  useEffect(() => () => {
    if (!handledBackRef.current) {
      void backToListRef.current();
    }
  }, []);
  useEffect(() => {
    if (!routeFocused) {
      return undefined;
    }
    onActiveChatContextChange?.({
      ownerId: foregroundOwnerId,
      aiId,
      sessionId: visibleSessionId,
      isChatVisible: conversationVisible,
      conversationKind: 'direct',
      groupId: null,
    });
    return () => {
      onActiveChatContextChange?.({
        ownerId: foregroundOwnerId,
        releaseOwner: true,
        aiId: null,
        sessionId: null,
        isChatVisible: false,
        conversationKind: 'direct',
        groupId: null,
      });
    };
  }, [
    aiId,
    conversationVisible,
    foregroundOwnerId,
    routeFocused,
    onActiveChatContextChange,
    visibleSessionId,
  ]);
  if (router.unavailableReason) {
    return (
      <ConversationUnavailable
        reason={router.unavailableReason}
        onBack={router.returnToConversations}
      />
    );
  }
  if (
    router.preparing
    || !router.currentUserReady
    || state.currentAI?.id !== aiId
    || (sessionId && state.currentSession?.id !== sessionId)
  ) {
    return <RouteLoading chatBackgroundKey={chatBackgroundKey} />;
  }
  return (
    <View style={createStyles(theme).container}>
      <ChatDetail
        aiAssistant={state.currentAI}
        session={state.currentSession}
        isActive={routeFocused && conversationVisible}
        anchorMessageId={anchorMessageId}
        currentUser={router.currentUser}
        aiAssistants={state.aiList}
        onOpenAssistantProfile={onOpenAssistantProfile}
        onOpenMenu={() => openNestedScreen(router.openSubScreen, 'menu')}
        onOpenFilePreview={(params) => {
          state.openFilePreview(params);
          router.openSubScreen('filePreview');
        }}
        onGoBack={() => {
          handledBackRef.current = true;
          void state.handleBackToList();
          router.routeBack();
        }}
        onCallCreated={router.onCallCreated}
      />
    </View>
  );
}

export function ChatMenuRouteScreen({ aiId, onOpenAssistantProfile, onOpenModelSettings, onOpenConversationSettings, onOpenSummary }: {
  aiId: string;
  onOpenAssistantProfile: () => void;
  onOpenModelSettings: () => void;
  onOpenConversationSettings: () => void;
  onOpenSummary: () => void;
}) {
  const router = usePreparedConversation(aiId);
  const { state } = router;
  useSubScreenLifecycle(state.setCurrentSubScreen, 'menu', null);
  if (router.preparing || !state.currentAI) {
    return <RouteLoading />;
  }
  return (
    <AIOptions
      conversationId={state.currentSession?.id}
      aiAssistant={state.currentAI}
      onBack={() => {
        state.handleCloseMenu();
        router.routeBack();
      }}
      onProtocolSpace={() => router.openSubScreen('protocol')}
      onClearHistory={async () => {
        const sessionId = state.currentSession?.id;
        if (!sessionId) {
          throw new Error('当前 canonical conversation 尚未就绪');
        }
        await clearChatConversationHistory(sessionId);
        clearSessionTimelineCache(sessionId);
        state.handleCloseMenu();
        router.returnToConversation(aiId);
      }}
      onOpenProfile={onOpenAssistantProfile}
      onModelSettings={onOpenModelSettings}
      onChatSettings={onOpenConversationSettings}
      onChatSummary={onOpenSummary}
      onSearchMessages={() => router.openSubScreen('search')}
      onCallHistory={() => router.openSubScreen('callHistory')}
      onChatStatistics={() => router.openSubScreen('statistics')}
      onDeleteAI={async () => {
        await state.handleDeleteAI();
        router.returnToConversations();
      }}
    />
  );
}

export function ChatProtocolRouteScreen({ aiId, onConvertToMemory }: {
  aiId: string; onConvertToMemory: (protocol: Protocol, values: { content: string; summary: string | null }) => Promise<void>;
}) {
  const router = usePreparedConversation(aiId);
  useSubScreenLifecycle(router.state.setCurrentSubScreen, 'protocol', 'menu');
  if (router.preparing || !router.state.currentAI) {
    return <RouteLoading />;
  }
  return (
    <ProtocolView
      aiAssistant={router.state.currentAI}
      onConvertToMemory={onConvertToMemory}
      onBack={() => {
        router.state.handleBackToMenu();
        router.routeBack();
      }}
    />
  );
}

type MessageSearchRouteProps = { messageId: number; onOpenMessage?: never }
  | { messageId?: undefined; onOpenMessage(messageId: number): void };

export function ChatSearchRouteScreen({ aiId, messageId, onOpenMessage }: { aiId: string } & MessageSearchRouteProps) {
  const router = usePreparedConversation(aiId);
  useSubScreenLifecycle(router.state.setCurrentSubScreen, 'search', messageId !== undefined ? 'search' : 'menu');
  if (router.unavailableReason) {
    return <ConversationUnavailable reason={router.unavailableReason} onBack={router.returnToConversations} />;
  }
  if (router.preparing || !router.state.currentSession) return <RouteLoading />;
  const conversationId = router.state.currentSession.id;
  return messageId !== undefined
    ? <ChatMessageContextScreen key={`${conversationId}:${messageId}`} conversationId={conversationId} messageId={messageId} onBack={router.routeBack} />
    : <ChatMessageSearchScreen key={conversationId} conversationId={conversationId} onBack={router.routeBack} onOpenMessage={onOpenMessage} />;
}

export function GroupSearchRouteScreen({ groupId, messageId, onOpenMessage }: { groupId: string } & MessageSearchRouteProps) {
  const router = usePreparedGroup(groupId);
  if (router.preparing || router.currentGroup?.id !== groupId) return <RouteLoading />;
  return messageId !== undefined
    ? <ChatMessageContextScreen key={`${groupId}:${messageId}`} conversationId={groupId} messageId={messageId} onBack={router.routeBack} />
    : <ChatMessageSearchScreen key={groupId} conversationId={groupId} onBack={router.routeBack} onOpenMessage={onOpenMessage} />;
}

export function ChatStatisticsRouteScreen({ aiId }: { aiId: string }) {
  const router = usePreparedConversation(aiId);
  useSubScreenLifecycle(router.state.setCurrentSubScreen, 'statistics', 'menu');
  if (router.unavailableReason) {
    return <ConversationUnavailable reason={router.unavailableReason} onBack={router.returnToConversations} />;
  }
  if (router.preparing || !router.state.currentSession || !router.state.currentAI) return <RouteLoading />;
  return <ChatStatisticsScreen key={router.state.currentSession.id}
    conversationId={router.state.currentSession.id} assistantCreatedAt={router.state.currentAI.createdAt}
    onBack={router.routeBack}
  />;
}

export function ChatFilePreviewRouteScreen({ aiId }: { aiId: string }) {
  const router = usePreparedConversation(aiId);
  useSubScreenLifecycle(router.state.setCurrentSubScreen, 'filePreview', null);
  if (router.preparing) {
    return <RouteLoading />;
  }
  return (
    <FilePreview
      fileUri={router.state.filePreviewParams?.fileUri}
      fileName={router.state.filePreviewParams?.fileName}
      mimeType={router.state.filePreviewParams?.mimeType}
      onBack={() => {
        router.state.closeFilePreview();
        router.routeBack();
      }}
    />
  );
}

export function CreateGroupRouteScreen() {
  const router = useChatRouter();
  return (
    <CreateGroup
      aiList={router.state.aiList}
      onBack={router.routeBack}
      onCreated={router.groupCreated}
    />
  );
}

export function GroupConversationRouteScreen({
  groupId,
  routeFocused,
  onOpenAssistantProfile,
}: {
  groupId: string;
  routeFocused: boolean;
  onOpenAssistantProfile: (aiId: string) => void;
}) {
  const router = usePreparedGroup(groupId);
  const {
    currentGroup,
    routeBack,
    currentUser,
    currentUserReady,
    state,
    onActiveChatContextChange,
  } = router;

  // 与单聊一致：向宿主上报前台群聊上下文，供通知抑制按 groupId 匹配。
  const groupChatVisible = !router.preparing && currentGroup?.id === groupId && currentUserReady;
  const foregroundOwnerId = `group:${groupId}`;

  useEffect(() => {
    if (!routeFocused) {
      return undefined;
    }
    onActiveChatContextChange?.({
      ownerId: foregroundOwnerId,
      aiId: null,
      sessionId: groupId,
      isChatVisible: groupChatVisible,
      conversationKind: 'group',
      groupId,
    });
    return () => {
      onActiveChatContextChange?.({
        ownerId: foregroundOwnerId,
        releaseOwner: true,
        aiId: null,
        sessionId: null,
        isChatVisible: false,
        conversationKind: 'group',
        groupId: null,
      });
    };
  }, [foregroundOwnerId, groupId, groupChatVisible, onActiveChatContextChange, routeFocused]);

  if (
    router.preparing
    || currentGroup?.id !== groupId
    || !currentUserReady
  ) {
    return <RouteLoading />;
  }

  return (
    <GroupChatDetail
      group={currentGroup}
      isActive={routeFocused && groupChatVisible}
      currentUser={currentUser}
      aiAssistants={state.aiList}
      onOpenAssistantProfile={onOpenAssistantProfile}
      onOpenFilePreview={(params) => router.openGroupFilePreview(groupId, params)}
      onOpenMenu={() => router.openGroupSubScreen(groupId, 'menu')}
      onGoBack={() => {
        // 群聊详情退出后会话列表要立刻看到新的 preview 与顺序，不等用户手动刷新。
        void router.refreshGroupChats().catch(() => undefined);
        routeBack();
      }}
    />
  );
}

export function GroupMenuRouteScreen({ groupId }: { groupId: string }) {
  const router = usePreparedGroup(groupId);
  const groupReady = !router.preparing && router.currentGroup?.id === groupId;
  const { details, setDetails, loadError } = useGroupRouteDetails(groupId, groupReady);

  if (loadError) {
    return (
      <GroupRouteUnavailable
        description={loadError}
        onBack={router.returnToConversations}
      />
    );
  }
  if (!groupReady || !details) {
    return <RouteLoading />;
  }

  const handleUpdateProfile = async (input: UpdateGroupChatProfileInput, draft?: import('@platform/device/DeviceMediaService').PersistentAvatarDraft | null) => {
    if (input.name !== undefined) await renameGroupChat(groupId, input.name);
    const updated = input.name !== undefined ? (await getGroupChat(groupId))!.group
      : draft ? await updateGroupChatAvatarFromDraft(groupId, draft) : await updateGroupChatProfile(groupId, input);
    setDetails((current) => current ? { ...current, group: updated } : current);
    router.groupUpdated(updated);
    return updated;
  };

  const handleDeleteGroup = async () => {
    try {
      const deleted = await deleteGroupChat(groupId);
      if (!deleted) {
        showAppDialog({ title: '删除失败', message: '群聊不存在或已经被删除', tone: 'error' });
        return;
      }

      router.groupDeleted(groupId);
      router.returnToConversations();
    } catch (error) {
      showAppDialog({ title: '删除失败', message: error instanceof Error ? error.message : '删除群聊失败', tone: 'error' });
    }
  };

  return (
    <GroupOptions
      groupId={groupId}
      groupDetails={details}
      chatBackgroundKey={`group:${groupId}`}
      onBack={router.routeBack}
      onAdminSettings={() => router.openGroupSubScreen(groupId, 'adminSettings')}
      onSummary={() => router.openGroupSubScreen(groupId, 'summary')}
      onSearchMessages={() => router.openGroupSubScreen(groupId, 'search')}
      onDeleteGroup={handleDeleteGroup}
      onUpdateProfile={handleUpdateProfile}
    />
  );
}

/** 群摘要页面沿用两级正文、编辑与诊断，只将会话身份交给同一摘要 owner。 */
export function GroupSummaryRouteScreen({ groupId, view, segmentId, taskId, onBack, onCreateSummary, onEditSummary, onEditSecondary, onTask, onSettings }: {
  groupId: string; view?: 'edit' | 'secondary' | 'settings'; segmentId?: string; taskId?: string; onBack(): void;
  onCreateSummary(): void; onEditSummary(id: string): void; onEditSecondary(): void; onTask(id: string): void; onSettings(): void;
}) {
  const router = usePreparedGroup(groupId);
  const ready = !router.preparing && router.currentGroup?.id === groupId;
  const { details, loadError } = useGroupRouteDetails(groupId, ready);
  if (loadError) return <GroupRouteUnavailable description={loadError} onBack={router.returnToConversations} />;
  if (!ready || !details) return <RouteLoading />;
  if (view === 'settings') return <ChatSummarySettingsScreen conversationId={groupId} group onBack={onBack} />;
  if (taskId) return <ChatSummaryTaskScreen conversationId={groupId} taskId={taskId} onBack={onBack} onSettings={onSettings}
    onEditSummary={onEditSummary} onEditSecondary={onEditSecondary} />;
  if (view === 'secondary') return <ChatSecondarySummaryScreen conversationId={groupId} onBack={onBack} onEditSource={onEditSummary} />;
  if (view === 'edit') return <ChatSummaryEditorScreen conversationId={groupId} segmentId={segmentId} onBack={onBack} onEditSource={onEditSummary} />;
  return <ChatSummaryScreen conversationId={groupId} onBack={onBack} onCreateSummary={onCreateSummary} onEditSummary={onEditSummary}
    onEditSecondary={onEditSecondary} onTask={onTask} onSettings={onSettings} />;
}

export function GroupAdminSettingsRouteScreen({ groupId }: { groupId: string }) {
  const router = usePreparedGroup(groupId);
  const groupReady = !router.preparing && router.currentGroup?.id === groupId;
  const { details, loadError, setDetails } = useGroupRouteDetails(groupId, groupReady);

  if (loadError) {
    return (
      <GroupRouteUnavailable
        description={loadError}
        onBack={router.returnToConversations}
      />
    );
  }
  if (!groupReady || !details) {
    return <RouteLoading />;
  }

  return (
    <GroupAdminSettings
      key={groupId}
      adminConfig={details.adminConfig}
      onUpdate={async (config) => {
        const updated = await updateGroupChatAdminConfig(groupId, config);
        if (!updated) throw new Error('管理员配置不存在');
        setDetails((current) => current ? { ...current, adminConfig: { ...current.adminConfig, ...config, updatedAt: updated.updatedAt } } : current);
      }}
      onBack={router.routeBack}
    />
  );
}

export function GroupFilePreviewRouteScreen({ groupId }: { groupId: string }) {
  const router = usePreparedGroup(groupId);
  const {
    currentGroup,
    routeBack,
    state,
  } = router;

  useSubScreenLifecycle(state.setCurrentSubScreen, 'filePreview', null);

  if (router.preparing || currentGroup?.id !== groupId) {
    return <RouteLoading />;
  }

  return (
    <FilePreview
      fileUri={state.filePreviewParams?.fileUri}
      fileName={state.filePreviewParams?.fileName}
      mimeType={state.filePreviewParams?.mimeType}
      onBack={() => {
        state.closeFilePreview();
        routeBack();
      }}
    />
  );
}
