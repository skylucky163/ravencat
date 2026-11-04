/**
 * KimiPhone 宿主组件，集中持有全局 Provider、启动流程、原生监听与跨路由运行时状态。
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { View, StyleSheet, AppState, type AppStateStatus } from 'react-native';
import { type Href, useNavigationContainerRef, usePathname, useRouter, useUnstableGlobalHref } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppBackground, ThemeProvider, WallpaperProvider } from '@shared/theme';
import { AppDialogHost } from '@shared/ui';
import { loadWallpaperState, setGlobalWallpaper, setConversationWallpaper, subscribeWallpaperChanged } from '@features/profile';

import * as SplashScreen from 'expo-splash-screen';

import { initDatabase } from '@platform/persistence';
import { leaveCallScreen } from '../../modules/kimiphone-notifications';
import {
  aiAssistantRepository,
} from '@features/assistants';
import {
  addNotificationResponseListener,
  consumePendingNotificationResponses,
  dismissConversationNotifications,
  initializeNotifications,
  getMessageArrivalSnapshot,
  reconcileBackgroundRuntime,
  type AppNotificationData,
} from '@platform/device';
import {
  acceptCall,
  CallRuntimeProvider,
  getActiveCall,
  getCallSession,
  reconcileInterruptedCallFromPreviousProcess,
  rejectCall,
  shouldRestoreCallScreen,
} from '@features/calls';
import {
  ChatRouterProvider,
  interruptAbandonedChatAgentActivities,
  conversationKeyOfDirect,
  conversationKeyOfGroup,
  getGroupChat,
  listGroupChats,
  markGroupConversationAsRead,
  subscribeAIMessageReceived,
  getAssistantMessageArrivalSnapshot,
  type AIMessageObserverPayload,
  type ChatSubScreen,
  type ConversationKind,
  type GroupChatSubScreen,
} from '@features/chat';
import {
  clearSessionTimelineCache,
  emitChatMessagesUpdated,
  emitChatMessagesReloadRequested,
  messageRepository,
  migrateLegacyChatAttachments,
  interruptAbandonedGroupSpeechPlans,
  setChatForegroundContext,
  applyAssistantMessageArrivalSnapshot,
  recoverTurnPresentationDisplays,
} from '@features/chat/composition';
import { configureHostRuntime } from './composition/configureHostRuntime';
import { completePendingBackupRestore } from './composition/completePendingBackupRestore';
import { migrateLegacyCanonicalAvatarReferences } from './composition/migrateLegacyAvatarReferences';
import { hasReportableLegacyMediaMigrationOutcome } from './media/LegacyMediaMigrationReporting';
import {
  cancelStartupRecoveryForReset,
  runStartupRecovery,
} from './runtime/StartupRecoveryCoordinator';
import { getConversationTurnCoordinator } from './runtime/ConversationTurnCoordinator';
import { isAIMessageConversationForeground } from './runtime/AIMessageDeliveryCoordinator';
import { setFloatingConversationDatabaseReady, syncFloatingConversation } from './runtime/FloatingConversationProjection';
import {
  resetConversationListReady,
  waitForConversationListReady,
} from '@shared/runtime/ConversationListReadySignal';
import { cancelActiveHostAgentRunsForReset, resumeHostAgentRunsAfterReset } from './composition/agent';
import HostErrorBoundary from './shell/HostErrorBoundary';
import MomentSharingBoundary from './navigation/MomentSharingBoundary';
import { ApplicationUpdateProvider } from './shell/ApplicationUpdateProvider';
import {
  drainAndCancelAIScheduleProjectionRepair,
  getCompanionNotificationDiagnostics,
  getNativeHealth,
  recoverAIScheduleClaims,
  reconcileAIScheduleProjections,
  reconcileProactiveNativeRuntimeState,
  recordProactiveAgentRunState,
  useCompanionFloatingBridge,
} from '@features/companion';
import {
  reconcileFloatingInteraction,
  setAppForeground,
} from '@features/floatingLayer';
import { reconcileDeviceControl } from '@features/deviceControl';
import {
  createCallNavigationTarget,
  createMessageNavigationTarget,
  createTogetherListeningNavigationTarget,
  getExternalNavigationKey,
  openMessageConversation,
  isOneShotExternalNavigationTarget,
  type ExternalNavigationTarget,
} from '@host/navigation/externalNavigation';
import { useRootNavigationReady } from '@host/navigation/useRootNavigationReady';
import { resetApplicationData } from './application/resetApplicationData';
import { stopLedgerAIReplyQueueForReset, resumeLedgerAIReplyQueueAfterReset } from '@features/wallet/composition';
import {
  initializeStickerAnnotationQueue,
  requestStickerAnnotationRun,
  setStickerAnnotationForegroundActive,
  stopStickerAnnotationQueueForReset,
} from './runtime/StickerAnnotationQueueCoordinator';
import {
  requestStickerEmbeddingRun,
  setStickerEmbeddingForegroundActive,
  stopStickerEmbeddingQueueForReset,
} from './runtime/StickerEmbeddingQueueCoordinator';
import { setMemoryEmbeddingForegroundActive, stopMemoryEmbeddingQueueForReset } from './runtime/MemoryEmbeddingQueueCoordinator';
import { setChatSummaryForegroundActive, stopChatSummaryQueueForReset } from './runtime/ChatSummaryQueueCoordinator';
import {
  getTogetherListeningActivityById,
  leaveTogetherListeningByUser,
  reconcileTogetherListeningSystemPresentation,
  TogetherListeningInAppIndicator,
} from '@features/togetherListening';


const wallpaperPersistence = {
  load: async () => { await initDatabase(); return loadWallpaperState(); },
  setGlobal: setGlobalWallpaper,
  setConversation: setConversationWallpaper,
  subscribe: subscribeWallpaperChanged,
};

configureHostRuntime();

interface ActiveChatContext {
  ownerId: string;
  releaseOwner?: boolean;
  aiId: string | null;
  sessionId: string | null;
  isChatVisible: boolean;
  /** 前台会话类型：单聊为 'direct' 或缺省，群聊路由上报 'group' */
  conversationKind?: ConversationKind;
  /** 前台群聊的 groupId */
  groupId?: string | null;
}

interface HostRouteRuntime {
  unreadCount: number;
  closeCallScreen: (callId: string) => void;
  minimizeCallScreen: (callId: string) => void;
  activateCallScreen: (callId: string) => (() => void) | undefined;
}

const HostRouteRuntimeContext = createContext<HostRouteRuntime | null>(null);

// 展示来源随 Headless 跨越 Activity 重建；每次从小窗进入前，以最近的 App 内页面更新来源。
// App 外来源由原生窗口记录，Host 只保留整理 App 路由所需的完整地址（含会话参数）。
let callScreenOrigin: { callId: string; href: Href } | null = null;

function useHostRouteRuntime(): HostRouteRuntime {
  const runtime = useContext(HostRouteRuntimeContext);

  if (!runtime) {
    throw new Error('宿主路由能力必须在 KimiPhoneHost 内使用');
  }

  return runtime;
}

export function useHostUnreadCount(): number {
  return useHostRouteRuntime().unreadCount;
}

export function useHostCallActions() {
  const { closeCallScreen, minimizeCallScreen, activateCallScreen } = useHostRouteRuntime();
  return { closeCallScreen, minimizeCallScreen, activateCallScreen };
}

SplashScreen.preventAutoHideAsync().catch(() => {
  // 开发环境可能重复触发，保留最后一次待处理通知即可。
});

async function settleCompanionRuntime(mode: 'cold_start' | 'foreground'): Promise<void> {
  await interruptAbandonedChatAgentActivities();
  try {
    const recovery = await recoverAIScheduleClaims(mode);
    if (recovery.recovered > 0 || recovery.skippedActive > 0) {
      console.info('[RavenCat] AI Schedule claimed recovery 执行完成：', recovery);
    }
  } catch (error) {
    console.warn(`[RavenCat] AI Schedule ${mode} claimed recovery 失败：`, error);
  }

  try {
    const projection = await reconcileAIScheduleProjections();
    if (projection.status === 'repair_pending') {
      console.warn('[RavenCat] AI Schedule 原生投影尚未完全恢复，已安排进程内有界重试：', {
        failedCount: projection.failedCount,
        failures: projection.failures,
      });
    }
  } catch (error) {
    console.warn(`[RavenCat] AI Schedule ${mode} 原生投影恢复失败：`, error);
  }
}

function HostLifecycle({
  children,
  onResetApplicationData,
}: {
  children: ReactNode;
  onResetApplicationData: () => void;
}) {
  const router = useRouter();
  const navigationContainerRef = useNavigationContainerRef();
  const pathname = usePathname();
  const currentHref = useUnstableGlobalHref();
  const rootNavigationReady = useRootNavigationReady();

  const [sessionRefreshTrigger, setSessionRefreshTrigger] = useState<number>(0);
  const [unreadMessages, setUnreadMessages] = useState<Record<string, number>>({});
  const unreadQueryRevisionsRef = useRef(new Map<string, number>());
  const [dbReady, setDbReady] = useState<boolean>(false);
  const [startupRecoveryTriggered, setStartupRecoveryTriggered] = useState(false);
  const [conversationListLoadEnabled, setConversationListLoadEnabled] = useState(false);
  const [notificationResponsesReady, setNotificationResponsesReady] = useState(false);
  const [pendingNotificationNavigation, setPendingNotificationNavigation] = useState<ExternalNavigationTarget | null>(null);
  const [isProcessingExternalNavigation, setIsProcessingExternalNavigation] = useState(false);
  const [minimizedCallId, setMinimizedCallId] = useState<string | null>(null);
  const [callRuntimeId, setCallRuntimeId] = useState<string | null>(null);
  useEffect(() => {
    if (callRuntimeId && !pathname.startsWith('/calls/')) {
      callScreenOrigin = { callId: callRuntimeId, href: currentHref as Href };
    }
  }, [callRuntimeId, currentHref, pathname]);
  const [interruptedCallId, setInterruptedCallId] = useState<string | null>(null);
  const [activeChatContext, setActiveChatContext] = useState<ActiveChatContext>({
    ownerId: 'none',
    aiId: null,
    sessionId: null,
    isChatVisible: false,
  });
  const reportActiveChatContext = useCallback((context: ActiveChatContext) => {
    setActiveChatContext((current) => {
      if (context.releaseOwner && current.ownerId !== context.ownerId) {
        return current;
      }
      return context.releaseOwner
        ? { ...context, releaseOwner: undefined }
        : context;
    });
  }, []);
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const splashHiddenRef = useRef<boolean>(false);
  const autoRestoreSuppressedCallIdRef = useRef<string | null>(null);
  const lastReconciledCompanionNotificationAtRef = useRef(0);
  const handledExternalNavigationKeysRef = useRef(new Set<string>());
  const pendingNotificationNavigationRef = useRef<ExternalNavigationTarget | null>(null);
  const processingExternalNavigationRef = useRef(false);
  const resettingApplicationDataRef = useRef(false);

  useEffect(() => {
    const reconcile = () => {
      if (AppState.currentState !== 'active' || resettingApplicationDataRef.current) return;
      void reconcileBackgroundRuntime().catch((error: unknown) => {
        console.warn('[Host] 持续后台运行未建立，可在权限与后台运行中查看状态', error);
      });
    };
    reconcile();
    const subscription = AppState.addEventListener('change', reconcile);
    return () => subscription.remove();
  }, []);
  const activeHostTasksRef = useRef(new Set<Promise<unknown>>());

  const trackHostTask = useCallback(<T,>(task: Promise<T>): Promise<T> => {
    activeHostTasksRef.current.add(task);

    // 用 then 双分支而不是 finally()：finally 派生的新 Promise 会继承失败，
    // void 后可能产生未处理 rejection 日志；双分支在成功/失败时都移除任务。
    void task.then(
      () => {
        activeHostTasksRef.current.delete(task);
      },
      () => {
        activeHostTasksRef.current.delete(task);
      },
    );

    return task;
  }, []);

  const drainHostTasksForReset = useCallback(async () => {
    while (activeHostTasksRef.current.size > 0) {
      await Promise.allSettled([...activeHostTasksRef.current]);
    }
  }, []);

  const queueExternalNavigation = useCallback((target: ExternalNavigationTarget | null) => {
    if (!target) {
      return;
    }

    const targetKey = getExternalNavigationKey(target);
    const oneShot = isOneShotExternalNavigationTarget(target);
    if (oneShot && handledExternalNavigationKeysRef.current.has(targetKey)) {
      return;
    }

    if (oneShot) {
      handledExternalNavigationKeysRef.current.add(targetKey);
      while (handledExternalNavigationKeysRef.current.size > 100) {
        const oldestKey = handledExternalNavigationKeysRef.current.values().next().value as string | undefined;
        if (!oldestKey) {
          break;
        }
        handledExternalNavigationKeysRef.current.delete(oldestKey);
      }
    }
    pendingNotificationNavigationRef.current = target;
    setPendingNotificationNavigation(target);
  }, []);

  const refreshUnreadCountForAI = useCallback(async (aiId: string | null) => {
    if (!aiId) {
      return 0;
    }

    try {
      const queryKey = conversationKeyOfDirect(aiId);
      const revision = (unreadQueryRevisionsRef.current.get(queryKey) ?? 0) + 1;
      unreadQueryRevisionsRef.current.set(queryKey, revision);
      const arrival = getAssistantMessageArrivalSnapshot();
      const unreadCount = await messageRepository.getUnreadCountByAI(aiId, arrival.pendingMessageIds);
      if (arrival !== getAssistantMessageArrivalSnapshot() || unreadQueryRevisionsRef.current.get(queryKey) !== revision) return unreadCount;
      setUnreadMessages((prev) => {
        if (prev[aiId] === unreadCount) {
          return prev;
        }

        return {
          ...prev,
          [aiId]: unreadCount,
        };
      });
      return unreadCount;
    } catch (error) {
      console.warn('[App] Failed to refresh unread count for AI:', aiId, error);
      return 0;
    }
  }, []);

  // 群未读与单聊共用 unreadMessages 表，key 为 groupId（会话列表按 unreadMessages[group.id] 渲染）。
  const refreshUnreadCountForGroup = useCallback(async (groupId: string) => {
    if (resettingApplicationDataRef.current) {
      return 0;
    }

    try {
      const queryKey = conversationKeyOfGroup(groupId);
      const revision = (unreadQueryRevisionsRef.current.get(queryKey) ?? 0) + 1;
      unreadQueryRevisionsRef.current.set(queryKey, revision);
      const arrival = getAssistantMessageArrivalSnapshot();
      const unreadCount = await messageRepository.getUnreadCountByGroup(groupId, arrival.pendingMessageIds);
      if (arrival !== getAssistantMessageArrivalSnapshot() || unreadQueryRevisionsRef.current.get(queryKey) !== revision) return unreadCount;
      setUnreadMessages((prev) => {
        if (prev[groupId] === unreadCount) {
          return prev;
        }

        return {
          ...prev,
          [groupId]: unreadCount,
        };
      });
      return unreadCount;
    } catch (error) {
      console.warn('[App] Failed to refresh unread count for group:', groupId, error);
      return 0;
    }
  }, []);

  const refreshAllUnreadCounts = useCallback(async () => {
    try {
      applyAssistantMessageArrivalSnapshot(await getMessageArrivalSnapshot());
      const arrival = getAssistantMessageArrivalSnapshot();
      const aiIds = await aiAssistantRepository.listIds();
      const groupChats = await listGroupChats();
      const unreadEntries: [string, number, string, number][] = [];

      for (const aiId of aiIds) {
        const key = conversationKeyOfDirect(aiId);
        const revision = (unreadQueryRevisionsRef.current.get(key) ?? 0) + 1;
        unreadQueryRevisionsRef.current.set(key, revision);
        const unreadCount = await messageRepository.getUnreadCountByAI(aiId, arrival.pendingMessageIds);
        unreadEntries.push([aiId, unreadCount, key, revision]);
      }

      // 群未读按 groupId 并入同一张表，底部 Tab 角标对全量求和自动计入。
      for (const group of groupChats) {
        const key = conversationKeyOfGroup(group.id);
        const revision = (unreadQueryRevisionsRef.current.get(key) ?? 0) + 1;
        unreadQueryRevisionsRef.current.set(key, revision);
        const unreadCount = await messageRepository.getUnreadCountByGroup(group.id, arrival.pendingMessageIds);
        unreadEntries.push([group.id, unreadCount, key, revision]);
      }

      const nextUnreadMessages = unreadEntries.reduce<Record<string, number>>((map, [aiId, count]) => {
        map[aiId] = count;
        return map;
      }, {});

      if (arrival === getAssistantMessageArrivalSnapshot()) {
        setUnreadMessages((prev) => Object.fromEntries(unreadEntries.map(([id, count, key, revision]) => [
          id,
          unreadQueryRevisionsRef.current.get(key) === revision ? count : prev[id] ?? 0,
        ])));
      }
      return nextUnreadMessages;
    } catch (error) {
      console.warn('[App] Failed to refresh all unread counts:', error);
      return {};
    }
  }, []);

  useEffect(() => {
    if (dbReady) void trackHostTask(refreshAllUnreadCounts());
  }, [dbReady, refreshAllUnreadCounts, trackHostTask]);

  const reconcileCompanionNotificationState = useCallback(async () => {
    if (resettingApplicationDataRef.current) {
      return;
    }

    if (!dbReady) {
      return;
    }

    const [nativeHealth, diagnostics] = await Promise.all([
      getNativeHealth(),
      getCompanionNotificationDiagnostics(),
    ]);
    await reconcileProactiveNativeRuntimeState({
      nativeHealth,
      notification: diagnostics,
    });

    if (
      !diagnostics.lastNotificationShown
      || diagnostics.lastNotificationAttemptAtEpochMs <= 0
      || diagnostics.lastNotificationAttemptAtEpochMs
        <= lastReconciledCompanionNotificationAtRef.current
    ) {
      return;
    }

    lastReconciledCompanionNotificationAtRef.current =
      diagnostics.lastNotificationAttemptAtEpochMs;
    setSessionRefreshTrigger((prev) => prev + 1);
    await refreshAllUnreadCounts();

    const sessionId = diagnostics.lastNotificationSessionId || null;
    if (sessionId) {
      clearSessionTimelineCache(sessionId);
      // 原生通知只意味着出现了新事实；已挂载页面增量补读，未挂载页面下次从 DB 重开。
      emitChatMessagesUpdated(sessionId);
    }

    await recordProactiveAgentRunState({
      lastNativeNotificationAt: new Date(
        diagnostics.lastNotificationAttemptAtEpochMs
      ).toISOString(),
      lastNativeNotificationShown: true,
      lastNativeNotificationAIId: diagnostics.lastNotificationAIId || null,
      lastNativeNotificationSessionId: sessionId,
      lastNativeNotificationError: diagnostics.lastNotificationError || null,
    });
  }, [dbReady, refreshAllUnreadCounts]);

  const markConversationAsRead = useCallback(async (sessionId: string | null | undefined, aiId: string | null | undefined) => {
    if (!sessionId || !aiId) {
      return 0;
    }

    try {
      await messageRepository.markMessagesAsRead(sessionId);
      return await refreshUnreadCountForAI(aiId);
    } catch (error) {
      console.warn('[App] Failed to mark conversation as read:', { sessionId, aiId, error });
      return 0;
    }
  }, [refreshUnreadCountForAI]);

  const markActiveConversationAsRead = useCallback(async (context: ActiveChatContext) => {
    if (!context.isChatVisible || !context.sessionId) {
      return;
    }

    if (context.conversationKind === 'group' && context.groupId) {
      await markGroupConversationAsRead(context.groupId);
      await refreshUnreadCountForGroup(context.groupId);
      return;
    }

    if (context.aiId) {
      await markConversationAsRead(context.sessionId, context.aiId);
    }
  }, [markConversationAsRead, refreshUnreadCountForGroup]);

  const chatRouteActiveRef = useRef<boolean>(true);
  useEffect(() => {
    chatRouteActiveRef.current = /^\/chat\/(?:groups\/)?[^/]+$/.test(pathname);
  }, [pathname]);

  const activeChatContextRef = useRef<ActiveChatContext>(activeChatContext);
  useEffect(() => {
    activeChatContextRef.current = activeChatContext;
  }, [activeChatContext]);

  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const setFloatingLayerAppForeground = useCallback((state: AppStateStatus): Promise<void> => {
    // 只有明确的 background/inactive 才允许展示；active、unknown、extension
    // 都保守建立前台 suppression，避免 native 上次的 background 真值泄漏出来。
    return setAppForeground(state === 'background' || state === 'inactive' ? false : true);
  }, []);

  useEffect(() => {
    const publishFloatingLayerAppState = (state: AppStateStatus) => {
      void trackHostTask(setFloatingLayerAppForeground(state).catch((error) => {
        console.warn('[RavenCat] Floating Layer AppState 下发失败：', error);
      }));
    };

    // 首次提交时先把 Host 已知的 AppState 投到 native；启动 pipeline 还会
    // 在 reconcile 前 await 同一命令，保证 Service 首次 attach 不会抢先显示窗口。
    appStateRef.current = AppState.currentState;
    publishFloatingLayerAppState(AppState.currentState);

    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      appStateRef.current = state;
      setAppState(state);
      publishFloatingLayerAppState(state);
    });

    return () => subscription.remove();
  }, [setFloatingLayerAppForeground, trackHostTask]);

  useEffect(() => {
    setChatForegroundContext({
      appActive: appState === 'active',
      chatRouteActive: /^\/chat\/(?:groups\/)?[^/]+$/.test(pathname),
      aiId: activeChatContext.aiId,
      sessionId: activeChatContext.sessionId,
      groupId: activeChatContext.groupId ?? null,
      isChatVisible: activeChatContext.isChatVisible,
    });
  }, [activeChatContext, appState, pathname]);

  useEffect(() => {
    const active = dbReady
      && appState === 'active'
      && !resettingApplicationDataRef.current;
    setStickerAnnotationForegroundActive(active);
    setStickerEmbeddingForegroundActive(active);
    setMemoryEmbeddingForegroundActive(active);
    setChatSummaryForegroundActive(active);
    if (!active) return;

    void trackHostTask(initializeStickerAnnotationQueue().then(() => {
      // 模型变更由各 Feature 的提交后信号唤醒；生命周期只负责启动和回前台。
      requestStickerAnnotationRun();
      // 只维护已由用户建立的当前索引；新模型不会在冷启动／回前台时偷偷重建。
      requestStickerEmbeddingRun();
    }).catch((error) => {
      console.warn('[Sticker] 初始化前台标注队列失败：', error);
    }));
  }, [appState, dbReady, trackHostTask]);

  useEffect(() => () => {
    setStickerAnnotationForegroundActive(false);
    setStickerEmbeddingForegroundActive(false);
    setMemoryEmbeddingForegroundActive(false);
    setChatSummaryForegroundActive(false);
  }, []);

  useEffect(() => () => {
    setChatForegroundContext({
      appActive: false,
      chatRouteActive: false,
      aiId: null,
      sessionId: null,
      groupId: null,
      isChatVisible: false,
    });
  }, []);

  useCompanionFloatingBridge({
    dbReady,
    appState,
  });

  useEffect(() => {
    setFloatingConversationDatabaseReady(dbReady);
    if (dbReady) {
      void syncFloatingConversation().catch((error) => {
        console.error('[Host] 同步悬浮会话失败：', error);
      });
    }
  }, [dbReady, appState]);

  // Device Control 首次启动必须来自正常可见 Host；Headless / Floating startup
  // 不承担 FGS 兜底。SQLite 业务真值在 application 用例内先归一化再下发。
  useEffect(() => {
    if (
      !dbReady
      || appState !== 'active'
      || resettingApplicationDataRef.current
    ) {
      return;
    }

    void trackHostTask(reconcileDeviceControl().then((result) => {
      const start = result.native.start;
      const reconcile = result.native.reconcile;
      if (
        result.active.length > 0
        && (
          (start && start.status !== 'started' && start.status !== 'already_running')
          || (reconcile && reconcile.status !== 'ok')
        )
      ) {
        console.warn('[RavenCat] Soft Lock startup reconcile 未建立 native 执行投影：', {
          start,
          reconcile,
        });
      }
    }).catch((error) => {
      console.warn('[RavenCat] Soft Lock startup reconcile 失败，将在下次前台恢复重试：', error);
    }));
  }, [appState, dbReady, trackHostTask]);

  useEffect(() => {
    let isMounted = true;

    const initializeDatabase = async () => {
      try {
        await initDatabase();
        await interruptAbandonedGroupSpeechPlans();
        if (!isMounted || resettingApplicationDataRef.current) return;
        resumeHostAgentRunsAfterReset();
        resumeLedgerAIReplyQueueAfterReset();
        getConversationTurnCoordinator().resumeTurnsAfterReset();
        try {
          await reconcileTogetherListeningSystemPresentation();
        } catch (presentationRecoveryError) {
          console.warn('[TogetherListening] 系统 presentation 启动对账失败：', presentationRecoveryError);
        }
        try {
          const interruptedCall = await reconcileInterruptedCallFromPreviousProcess();
          if (isMounted && interruptedCall) {
            autoRestoreSuppressedCallIdRef.current = interruptedCall.id;
            setInterruptedCallId(interruptedCall.id);
          }
        } catch (callRecoveryError) {
          console.warn('[Calls] 冷启动遗留通话收口失败：', callRecoveryError);
        }
        if (isMounted) {
          setDbReady(true);
        }
      } catch (error) {
        console.error('Failed to initialize database:', error);
      }
    };

    initializeDatabase();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!interruptedCallId || !rootNavigationReady) {
      return;
    }
    if (pathname === `/calls/${interruptedCallId}`) {
      router.replace('/conversations' as Href);
    }
    setInterruptedCallId(null);
  }, [interruptedCallId, pathname, rootNavigationReady, router]);

  // 启动恢复 pipeline：基于真实完成状态串联各阶段，不再 fire-and-forget。
  useEffect(() => {
    if (!dbReady || startupRecoveryTriggered) return;
    if (resettingApplicationDataRef.current) {
      return;
    }
    setStartupRecoveryTriggered(true);

    void trackHostTask(runStartupRecovery({
      restoreRavenCatSurface: async () => {
        try {
          // reconcile 可能启动 Overlay Service；必须先提交 AppState 真值，
          // 让 native 在 show window 前建立 APP_FOREGROUND suppression。
          await setFloatingLayerAppForeground(appStateRef.current);
          await reconcileFloatingInteraction();
          // Floating Service 的恢复晚于 DB ready；服务就绪后重新投影一次，
          // 让 active Together 在不主动启动悬浮层的前提下收敛到现有 Panel。
          await reconcileTogetherListeningSystemPresentation();
        } catch (error) {
          // 悬浮交互是可选投影，原生对账失败不得阻断 Chat 首屏。
          console.warn('[RavenCat] 悬浮交互投影对账失败：', error);
        } finally {
          setConversationListLoadEnabled(true);
        }
      },
      waitForConversationListReady,
      reconcileCompanionScheduleProjection: async () => {
        await settleCompanionRuntime('cold_start');
      },
      recoverRequiredRuntimeState: async () => {
        try {
          // Phase 5A：崩溃孤儿与从未 claim 的待回复区间在此恢复（只等启动，不等执行）。
          await recoverTurnPresentationDisplays();
          await getConversationTurnCoordinator().recoverConversationTurns();
        } catch (turnRecoveryError) {
          console.warn('[ConversationTurn] 启动恢复失败，将在下次启动重试：', turnRecoveryError);
        }
        try {
          await reconcileCompanionNotificationState();
        } catch (notificationRecoveryError) {
          console.warn('[RavenCat] 通知状态对账失败，将在下次启动重试：', notificationRecoveryError);
        }

        // M3a/M3b 不进入首屏启动关键路径：会话列表与必要 runtime
        // 恢复完成后再顺序 Hash，避免两批维护任务并发读取文件。M4 切换前每次
        // 冷启动可幂等重跑；单个阶段失败不阻断后续阶段。
        void trackHostTask((async () => {
          try {
            const result = await migrateLegacyChatAttachments();
            result.sessionIds.forEach((sessionId) => {
              clearSessionTimelineCache(sessionId);
              emitChatMessagesReloadRequested(sessionId);
            });

            if (result.unresolvedMessages > 0) {
              console.warn('[MediaAsset] Chat legacy 附件迁移存在未解决引用：', {
                unresolvedMessages: result.unresolvedMessages,
                issues: result.issues.slice(0, 20),
              });
            }
            // M3a 每次冷启动都幂等扫描一次；库里已无 legacy 引用时 scannedMessages 为 0，
            // 属于正常的“无事可做”，不打日志。只有真的迁移了内容或出现未解决引用才记录。
            if (hasReportableLegacyMediaMigrationOutcome(
              result.migratedMessages,
              result.unresolvedMessages,
            )) {
              console.info('[MediaAsset] Chat legacy 附件迁移完成：', {
                scannedMessages: result.scannedMessages,
                migratedMessages: result.migratedMessages,
                migratedAttachments: result.migratedAttachments,
                adoptedAssets: result.adoptedAssets,
              });
            }
          } catch (error) {
            // 数据库读取级错误留到下次冷启动重试，不能伪装成“零候选”。
            console.warn('[MediaAsset] Chat legacy 附件迁移失败，将在下次启动重试：', error);
          }

          try {
            const result = await migrateLegacyCanonicalAvatarReferences();
            if (result.unresolvedCanonicalAvatars > 0) {
              console.warn('[MediaAsset] M3b 头像迁移存在未解决引用：', {
                unresolvedCanonicalAvatars: result.unresolvedCanonicalAvatars,
                issues: result.issues.slice(0, 20),
              });
            }
            // 同 M3a：canonical 头像已全部迁移时无候选，不打印。
            if (hasReportableLegacyMediaMigrationOutcome(
              result.migratedCanonicalAvatars,
              result.unresolvedCanonicalAvatars,
            )) {
              console.info('[MediaAsset] M3b canonical 头像迁移完成：', {
                scannedCanonicalAvatars: result.scannedCanonicalAvatars,
                migratedCanonicalAvatars: result.migratedCanonicalAvatars,
                createdAssets: result.createdAssets,
                reusedAssets: result.reusedAssets,
              });
            }
          } catch (error) {
            console.warn('[MediaAsset] M3b canonical 头像迁移失败，将在下次启动重试：', error);
          }
        })());
      },
    }));
  }, [
    dbReady,
    setFloatingLayerAppForeground,
    startupRecoveryTriggered,
    reconcileCompanionNotificationState,
    trackHostTask,
  ]);

  const openCallScreen = useCallback((callId: string) => {
    if (!pathname.startsWith('/calls/')) {
      callScreenOrigin = { callId, href: currentHref as Href };
    }
    setCallRuntimeId(callId);
    // 显式打开也已处理这通电话；Router 尚未更新路径时，迟到的恢复查询不能再压入同一页。
    autoRestoreSuppressedCallIdRef.current = callId;
    setMinimizedCallId(null);
    router.push(`/calls/${encodeURIComponent(callId)}` as Href);
  }, [currentHref, pathname, router]);

  const returnFromStackRoute = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace('/' as Href);
  }, [router]);

  const returnFromCallScreen = useCallback((callId: string) => {
    const origin = callScreenOrigin?.callId === callId ? callScreenOrigin : null;
    if (origin) callScreenOrigin = null;
    void leaveCallScreen(callId).finally(() => {
      if (origin) {
        // 原页面仍在栈中就弹回；Activity 已重建时恢复这次进入前的位置。
        router.dismissTo(origin.href);
      } else {
        // 直接冷启动打开的通话链接没有 App 内来源，沿用普通栈退出语义。
        returnFromStackRoute();
      }
    }).catch(error => console.warn('[Calls] 退出原生通话展示失败', error));
  }, [returnFromStackRoute, router]);

  const refreshCallConversationTimeline = useCallback(async (callId: string) => {
    try {
      const call = await getCallSession(callId);
      if (!call) {
        return;
      }

      clearSessionTimelineCache(call.chatSessionId);
      emitChatMessagesUpdated(call.chatSessionId);
    } catch (error) {
      console.warn('[KimiPhoneHost] 通话返回时刷新聊天时间线失败：', error);
    }
  }, []);

  const closeCallScreen = useCallback((callId: string) => {
    autoRestoreSuppressedCallIdRef.current = callId;
    setMinimizedCallId(null);
    setCallRuntimeId((current) => current === callId ? null : current);
    void refreshCallConversationTimeline(callId);
    returnFromCallScreen(callId);
  }, [refreshCallConversationTimeline, returnFromCallScreen]);

  const activateCallScreen = useCallback((callId: string) => {
    if (!dbReady) return;
    let current = true;
    // 深链和开发重载可能恢复旧通话地址；在 Host 的数据库就绪边界按持久事实准入。
    // 终态已无媒体 runtime，不能让页面无限等待一个不会再创建的执行宿主。
    void trackHostTask(getCallSession(callId).then((call) => {
      if (!current) return;
      if (!call || !shouldRestoreCallScreen(call)) {
        closeCallScreen(callId);
        return;
      }
      autoRestoreSuppressedCallIdRef.current = callId;
      setCallRuntimeId(callId);
      setMinimizedCallId(null);
    })).catch(error => console.warn('[Calls] 通话路由准入失败：', error));
    return () => { current = false; };
  }, [closeCallScreen, dbReady, trackHostTask]);

  const minimizeCallScreen = useCallback((callId: string) => {
    setCallRuntimeId(callId);
    autoRestoreSuppressedCallIdRef.current = callId;
    setMinimizedCallId(callId);
    void refreshCallConversationTimeline(callId);
    returnFromCallScreen(callId);
  }, [refreshCallConversationTimeline, returnFromCallScreen]);

  const openAddAIScreen = useCallback(() => {
    router.push('/add-ai' as Href);
  }, [router]);

  const navigateToExternalTargetError = useCallback((
    reason: 'assistant-not-found' | 'session-not-found' | 'call-not-found' | 'group-not-found'
  ) => {
    router.navigate(`/navigation-error?reason=${reason}` as Href);
  }, [router]);

  const handleAINavigation = useCallback(async (target: ExternalNavigationTarget) => {
    if (target.type === 'ai-incoming-call' || target.type === 'together-listening') {
      return;
    }

    if (target.type === 'group-message') {
      // 群通知：只撤销该群的聚合通知，不碰单聊；群不存在走明确回退页。
      await dismissConversationNotifications(conversationKeyOfGroup(target.groupId));

      const group = await getGroupChat(target.groupId);
      if (!group) {
        navigateToExternalTargetError('group-not-found');
        return;
      }

      openMessageConversation(navigationContainerRef, target);
      setSessionRefreshTrigger((prev) => prev + 1);
      return;
    }

    const { aiId, sessionId } = target;

    await dismissConversationNotifications(conversationKeyOfDirect(aiId));

    if (sessionId) {
      clearSessionTimelineCache(sessionId);
      emitChatMessagesUpdated(sessionId);
    }

    openMessageConversation(navigationContainerRef, target);
  }, [navigateToExternalTargetError, navigationContainerRef]);

  const handleIncomingCallNotification = useCallback(async (payload: ExternalNavigationTarget) => {
    if (payload.type !== 'ai-incoming-call') {
      return;
    }

    const call = await getCallSession(payload.callId);
    if (!call || call.aiAssistantId !== payload.aiId || call.chatSessionId !== payload.sessionId) {
      navigateToExternalTargetError('call-not-found');
      return;
    }

    if (payload.notificationAction === 'reject') {
      await rejectCall(payload.callId, 'userRejected');
      clearSessionTimelineCache(call.chatSessionId);
      emitChatMessagesUpdated(call.chatSessionId);
      return;
    }

    let currentCall = call;
    if (payload.notificationAction === 'accept') {
      const accepted = await acceptCall(payload.callId);
      if (accepted.call.state !== 'active') {
        await leaveCallScreen(payload.callId);
        return;
      }
      currentCall = accepted.call;
    }

    // incoming requested/ringing 由原生来电 surface 独占：open/异常 action 不得打开 RN 页面；
    // accept 成功进入 active（或 outgoing 拨号流程）后才打开现有 CallScreen。
    if (!shouldRestoreCallScreen(currentCall)) {
      return;
    }

    if (pathname !== `/calls/${payload.callId}`) {
      openCallScreen(payload.callId);
    }
  }, [navigateToExternalTargetError, openCallScreen, pathname]);

  // Together ongoing surface：open 只导航到会话；leave 走 canonical leave，不导航、不启动 AI。
  // 两条路径都先按 payload 重新校验 Activity 身份，旧 Activity 的迟到响应不得误伤当前 Activity。
  const handleTogetherListeningNotification = useCallback(async (target: ExternalNavigationTarget) => {
    if (target.type !== 'together-listening') {
      return;
    }

    const activity = await getTogetherListeningActivityById(target.activityId);
    if (
      !activity
      || activity.hostAiId !== target.aiId
      || activity.chatSessionId !== target.sessionId
    ) {
      return;
    }

    if (target.notificationAction === 'leave') {
      await leaveTogetherListeningByUser({
        activityId: target.activityId,
        source: 'system_capsule',
      });
      return;
    }

    router.navigate(
      `/chat/${encodeURIComponent(target.aiId)}?sessionId=${encodeURIComponent(target.sessionId)}` as Href,
    );
  }, [router]);

  // 统一交付策略（通知抑制/系统通知）在 AIMessageDeliveryCoordinator；
  // Host 只维护 UI 关注：时间线缓存、前台已读、未读角标与会话列表刷新，共用同一条前台判定。
  const handleIncomingAIMessage = useCallback(async (payload: AIMessageObserverPayload) => {
    if (resettingApplicationDataRef.current) {
      return;
    }

    if (!payload?.sessionId) {
      return;
    }

    // 免交付事实（如通话状态条目）可能没有 AI 身份：仍刷新会话列表与时间线缓存。
    const hasAIIdentity = Boolean(payload.aiId && payload.aiName);
    const isVisibleChat = hasAIIdentity && isAIMessageConversationForeground(payload);

    if (!isVisibleChat) {
      clearSessionTimelineCache(payload.sessionId);
    }
    // 前台会话也会改变列表预览与顺序；时间线是否要重读不决定列表是否失效。
    setSessionRefreshTrigger((prev) => prev + 1);

    if (!hasAIIdentity) {
      return;
    }

    if (isVisibleChat) {
      // 群消息在前台群聊页真实呈现：按群维度标记已读；单聊维持会话标记。
      if (payload.conversationKind === 'group' && payload.groupId) {
        await markGroupConversationAsRead(payload.groupId);
        await refreshUnreadCountForGroup(payload.groupId);
      } else {
        await markConversationAsRead(payload.sessionId, payload.aiId);
      }
      return;
    }

    // 群未读走群维度刷新，群消息不得计到成员 AI 头上。
    if (payload.conversationKind === 'group' && payload.groupId) {
      await refreshUnreadCountForGroup(payload.groupId);
    } else {
      await refreshUnreadCountForAI(payload.aiId ?? null);
    }
  }, [
    markConversationAsRead,
    refreshUnreadCountForAI,
    refreshUnreadCountForGroup,
  ]);

  const handleConversationViewed = useCallback((aiId?: string | null) => {
    if (aiId) {
      void dismissConversationNotifications(conversationKeyOfDirect(aiId));
      return;
    }

    void dismissConversationNotifications();
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeAIMessageReceived((payload) => {
      void trackHostTask(handleIncomingAIMessage(payload));
    });

    return () => {
      unsubscribe?.();
    };
  }, [handleIncomingAIMessage, trackHostTask]);

  useEffect(() => {
    if (!/^\/chat\/(?:groups\/)?[^/]+$/.test(pathname)) {
      setActiveChatContext({
        ownerId: 'none',
        aiId: null,
        sessionId: null,
        isChatVisible: false,
        groupId: null,
      });
    }
  }, [pathname]);

  const restoreActiveCallScreen = useCallback(async () => {
    if (
      !dbReady
      || !notificationResponsesReady
      || !rootNavigationReady
      || pathname.startsWith('/calls/')
      || minimizedCallId
      || pendingNotificationNavigationRef.current
      || processingExternalNavigationRef.current
    ) {
      return;
    }

    const suppressedCallId = autoRestoreSuppressedCallIdRef.current;
    const activeCall = await getActiveCall();
    // 查询期间用户可能已打开、收起或结束另一通电话，不再执行旧导航意图。
    if (autoRestoreSuppressedCallIdRef.current !== suppressedCallId) return;
    // incoming requested/ringing 由原生来电 surface 独占，是否恢复 RN 通话页由 Calls 层语义判定。
    if (
      activeCall
      && shouldRestoreCallScreen(activeCall)
      && activeCall.id !== autoRestoreSuppressedCallIdRef.current
    ) {
      openCallScreen(activeCall.id);
    }
  }, [
    dbReady,
    minimizedCallId,
    notificationResponsesReady,
    openCallScreen,
    pathname,
    rootNavigationReady,
  ]);

  useEffect(() => {
    void restoreActiveCallScreen();
  }, [restoreActiveCallScreen]);

  useEffect(() => {
    if (!dbReady) {
      return undefined;
    }

    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (resettingApplicationDataRef.current) {
        return;
      }

      if (state === 'active') {
        // 恢复的是已到达数量，不补播后台已经完成的分段。
        void trackHostTask(refreshAllUnreadCounts());
        autoRestoreSuppressedCallIdRef.current = null;
        void restoreActiveCallScreen();
        void trackHostTask(reconcileCompanionNotificationState().catch((error) => {
          console.warn('[App] Failed to reconcile RavenCat state on foreground:', error);
        }));
        void trackHostTask(settleCompanionRuntime('foreground'));
        const activeContext = activeChatContextRef.current;
        if (activeContext.isChatVisible && activeContext.sessionId) {
          // UI runtime 在后台期间可能收不到 Headless runtime 的进程内事件。
          // 回前台只补读 lastMessageId 之后的新事实，不能清空并替换用户正在浏览的时间线窗口。
          emitChatMessagesUpdated(activeContext.sessionId);
          void trackHostTask(markActiveConversationAsRead(activeContext).catch((error) => {
            console.warn('[App] Failed to mark foreground conversation as read:', error);
          }));
        }
      }
    });

    return () => subscription.remove();
  }, [
    dbReady,
    markActiveConversationAsRead,
    refreshAllUnreadCounts,
    reconcileCompanionNotificationState,
    restoreActiveCallScreen,
    trackHostTask,
  ]);

  useEffect(() => {
    if (!dbReady || !activeChatContext.isChatVisible || !activeChatContext.sessionId) {
      return;
    }

    // 进入会话即撤销该会话的聚合通知：群按 group:<groupId>，单聊按 ai:<aiId>。
    const conversationKey = activeChatContext.conversationKind === 'group' && activeChatContext.groupId
      ? conversationKeyOfGroup(activeChatContext.groupId)
      : activeChatContext.aiId
        ? conversationKeyOfDirect(activeChatContext.aiId)
        : null;
    if (conversationKey) {
      void dismissConversationNotifications(conversationKey);
    }

    // 进入会话即标记已读；从后台回到仍在展示的会话时复用同一入口。
    void trackHostTask(markActiveConversationAsRead(activeChatContext).catch((error) => {
      console.warn('[App] Failed to mark active conversation as read:', error);
    }));
  }, [
    activeChatContext,
    dbReady,
    markActiveConversationAsRead,
    trackHostTask,
  ]);

  useEffect(() => {
    let isMounted = true;
    let subscription: any = null;

    const initializeDeviceNotifications = async () => {
      try {
        await initializeNotifications();
        if (!isMounted) {
          return;
        }

        subscription = addNotificationResponseListener((payload: AppNotificationData | null) => {
          if (payload?.type === 'ai-incoming-call') {
            queueExternalNavigation(createCallNavigationTarget({
              aiId: payload.aiId,
              sessionId: payload.sessionId,
              callId: payload.callId,
              notificationAction: payload.notificationAction || 'open',
              notificationId: payload.notificationId,
            }));
            return;
          }

          if (payload?.type === 'together-listening') {
            queueExternalNavigation(createTogetherListeningNavigationTarget({
              activityId: payload.activityId,
              aiId: payload.aiId,
              sessionId: payload.sessionId,
              notificationAction: payload.notificationAction,
              notificationId: payload.notificationId,
            }));
            return;
          }

          if (payload) {
            queueExternalNavigation(createMessageNavigationTarget({
              type: payload.type,
              aiId: payload.aiId,
              sessionId: payload.sessionId || null,
              notificationId: payload.notificationId,
              conversationKind: payload.conversationKind,
              groupId: payload.groupId,
            }));
          }
        });

        const pendingResponses = await consumePendingNotificationResponses();
        if (isMounted) {
          pendingResponses.forEach((response) => {
            if (response.type === 'ai-incoming-call') {
              queueExternalNavigation(createCallNavigationTarget({
                aiId: response.aiId,
                sessionId: response.sessionId,
                callId: response.callId,
                notificationAction: response.notificationAction || 'open',
                notificationId: response.notificationId,
              }));
            } else if (response.type === 'together-listening') {
              queueExternalNavigation(createTogetherListeningNavigationTarget({
                activityId: response.activityId,
                aiId: response.aiId,
                sessionId: response.sessionId,
                notificationAction: response.notificationAction,
                notificationId: response.notificationId,
              }));
            } else {
              queueExternalNavigation(createMessageNavigationTarget({
                type: response.type,
                aiId: response.aiId,
                sessionId: response.sessionId || null,
                notificationId: response.notificationId,
                conversationKind: response.conversationKind,
                groupId: response.groupId,
              }));
            }
          });
        }
      } catch (error) {
        console.warn('[App] Failed to initialize notifications:', error);
      } finally {
        if (isMounted) {
          setNotificationResponsesReady(true);
        }
      }
    };

    initializeDeviceNotifications();

    return () => {
      isMounted = false;
      subscription?.remove?.();
    };
  }, [queueExternalNavigation]);

  useEffect(() => {
    if (
      resettingApplicationDataRef.current
      || !dbReady
      || !rootNavigationReady
      || !pendingNotificationNavigation
      || isProcessingExternalNavigation
      || processingExternalNavigationRef.current
    ) {
      return;
    }

    const navigationKey = getExternalNavigationKey(pendingNotificationNavigation);
    processingExternalNavigationRef.current = true;
    setIsProcessingExternalNavigation(true);

    const handler = pendingNotificationNavigation.type === 'ai-incoming-call'
      ? handleIncomingCallNotification
      : pendingNotificationNavigation.type === 'together-listening'
        ? handleTogetherListeningNotification
        : handleAINavigation;

    handler(pendingNotificationNavigation)
      .catch((error) => {
        console.warn('[Navigation] 外部导航目标处理失败。', error);
      })
      .finally(() => {
        processingExternalNavigationRef.current = false;
        setPendingNotificationNavigation((current) => (
          current && getExternalNavigationKey(current) === navigationKey
            ? null
            : current
        ));
        if (
          pendingNotificationNavigationRef.current
          && getExternalNavigationKey(pendingNotificationNavigationRef.current) === navigationKey
        ) {
          pendingNotificationNavigationRef.current = null;
        }
        setIsProcessingExternalNavigation(false);
      });
  }, [
    dbReady,
    isProcessingExternalNavigation,
    pendingNotificationNavigation,
    handleAINavigation,
    handleIncomingCallNotification,
    handleTogetherListeningNotification,
    rootNavigationReady,
  ]);

  const hideSplashScreen = useCallback(async () => {
    if (splashHiddenRef.current) {
      return;
    }

    try {
      await SplashScreen.hideAsync();
      splashHiddenRef.current = true;
    } catch (error) {
      console.warn('[App] Failed to hide splash screen:', error);
    }
  }, []);

  useEffect(() => {
    if (!dbReady) {
      return;
    }

    void hideSplashScreen();
  }, [dbReady, hideSplashScreen]);

  const handleResetApplicationData = useCallback(async () => {
    if (resettingApplicationDataRef.current) {
      return;
    }
    resettingApplicationDataRef.current = true;

    let resetError: unknown = null;

    try {
      // 暂停数据库就绪与会话列表加载标记，避免清库期间触发加载。
      setDbReady(false);
      setConversationListLoadEnabled(false);
      setStartupRecoveryTriggered(false);
      setUnreadMessages({});
      setActiveChatContext({
        ownerId: 'none',
        aiId: null,
        sessionId: null,
        isChatVisible: false,
      });
      setMinimizedCallId(null);
      setCallRuntimeId(null);
      setInterruptedCallId(null);
      callScreenOrigin = null;
      setPendingNotificationNavigation(null);
      pendingNotificationNavigationRef.current = null;
      processingExternalNavigationRef.current = false;
      setIsProcessingExternalNavigation(false);
      handledExternalNavigationKeysRef.current.clear();
      lastReconciledCompanionNotificationAtRef.current = 0;

      // 先取消 StartupRecovery，再 drain，否则旧流程可能卡在等待会话列表。
      await cancelStartupRecoveryForReset();
      const executionShutdown = await Promise.allSettled([
        stopLedgerAIReplyQueueForReset(),
        getConversationTurnCoordinator().cancelActiveTurnsForReset(),
        cancelActiveHostAgentRunsForReset(),
      ]);
      const executionShutdownErrors = executionShutdown.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (executionShutdownErrors.length > 0) throw new AggregateError(executionShutdownErrors, '恢复出厂执行关闭失败');
      await stopStickerAnnotationQueueForReset();
      await stopStickerEmbeddingQueueForReset();
      await stopMemoryEmbeddingQueueForReset();
      await stopChatSummaryQueueForReset();
      await drainAndCancelAIScheduleProjectionRepair();
      await drainHostTasksForReset();
      await resetApplicationData();

    } catch (error) {
      resetError = error;
      console.error('[KimiPhoneHost] 恢复出厂失败：', error);
    } finally {
      clearSessionTimelineCache();
      resetConversationListReady();

      // 旧 Host 不再重新打开 reset gate：新挂载的 HostLifecycle 自带初始为 false 的新 ref。
      onResetApplicationData();
    }

    if (resetError) {
      throw resetError;
    }
  }, [drainHostTasksForReset, onResetApplicationData]);

  const hostRouteRuntime = useMemo<HostRouteRuntime>(() => ({
    unreadCount: Object.values(unreadMessages).reduce(
      (total, count) => total + count,
      0
    ),
    closeCallScreen,
    minimizeCallScreen,
    activateCallScreen,
  }), [activateCallScreen, closeCallScreen, minimizeCallScreen, unreadMessages]);

  return (
    <HostRouteRuntimeContext.Provider value={hostRouteRuntime}>
      <ChatRouterProvider
        dbReady={dbReady}
        conversationListLoadEnabled={conversationListLoadEnabled}
        onActiveChatContextChange={reportActiveChatContext}
        onAddAI={openAddAIScreen}
        onCallCreated={(call) => openCallScreen(call.id)}
        onConversationViewed={handleConversationViewed}
        onResetApplicationData={handleResetApplicationData}
        onOpenConversation={(aiId) => {
          router.navigate(`/chat/${encodeURIComponent(aiId)}` as Href);
        }}
        onOpenCreateGroup={() => router.push('/chat/groups/new' as Href)}
        onGroupCreated={(groupId) => {
          router.replace(`/chat/groups/${encodeURIComponent(groupId)}` as Href);
        }}
        onOpenGroup={(groupId) => {
          router.navigate(`/chat/groups/${encodeURIComponent(groupId)}` as Href);
        }}
        onOpenGroupFilePreview={(groupId) => {
          router.push(`/chat/groups/${encodeURIComponent(groupId)}/file-preview` as Href);
        }}
        onOpenGroupSubScreen={(groupId, screen: GroupChatSubScreen) => {
          const segments: Record<GroupChatSubScreen, string> = {
            search: 'search',
            menu: 'menu',
            adminSettings: 'admin-settings',
            summary: 'summary',
          };
          router.push(`/chat/groups/${encodeURIComponent(groupId)}/${segments[screen]}` as Href);
        }}
        onOpenSubScreen={(aiId, screen: ChatSubScreen) => {
          const segments: Record<ChatSubScreen, string> = {
            search: 'search',
            menu: 'menu',
            protocol: 'protocol',
            statistics: 'statistics',
            callHistory: 'call-history',
            filePreview: 'file-preview',
          };
          router.push(`/chat/${encodeURIComponent(aiId)}/${segments[screen]}` as Href);
        }}
        onOpenPromptCenter={(assistantId) => router.push({ pathname: '/prompt-center', params: assistantId ? { assistantId } : {} })}
        onRouteBack={returnFromStackRoute}
        onReturnToConversation={(aiId) => {
          router.dismissTo(`/chat/${encodeURIComponent(aiId)}` as Href);
        }}
        onReturnToConversations={() => {
          router.dismissTo('/conversations' as Href);
        }}
        sessionRefreshTrigger={sessionRefreshTrigger}
        unreadMessages={unreadMessages}
      >
        <View style={styles.container}>
          <CallRuntimeProvider
            callId={dbReady ? callRuntimeId : null}
            minimized={!pathname.startsWith('/calls/')}
            onMinimizedCallEnded={() => { callScreenOrigin = null; setMinimizedCallId(null); setCallRuntimeId(null); }}
          >
            <View style={styles.content}>
              <ApplicationUpdateProvider enabled={dbReady && appState === 'active'}>
                <MomentSharingBoundary>{children}</MomentSharingBoundary>
              </ApplicationUpdateProvider>
            </View>

            {dbReady ? (
              <TogetherListeningInAppIndicator
                appState={appState}
                bottomOffset={88}
                visible={!pathname.startsWith('/calls/')}
                onOpenConversation={(hostAiId, chatSessionId) => {
                  const target = createMessageNavigationTarget({
                    aiId: hostAiId,
                    sessionId: chatSessionId,
                  });
                  if (target && target.type !== 'ai-incoming-call' && target.type !== 'together-listening') {
                    openMessageConversation(navigationContainerRef, target);
                  }
                }}
              />
            ) : null}

          </CallRuntimeProvider>
        </View>
      </ChatRouterProvider>
    </HostRouteRuntimeContext.Provider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  content: {
    flex: 1,
  },
});

function BackupRestoreGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ ready: boolean; error: Error | null }>({
    ready: false,
    error: null,
  });

  useEffect(() => {
    void completePendingBackupRestore().then(
      () => setState({ ready: true, error: null }),
      (error) => setState({
        ready: false,
        error: error instanceof Error ? error : new Error(String(error)),
      }),
    );
  }, []);

  if (state.error) throw state.error;
  if (!state.ready) return null;
  return children;
}

export default function KimiPhoneHost({ children }: { children: ReactNode }) {
  // 恢复出厂成功后递增 revision，让 ThemeProvider/WallpaperProvider/HostLifecycle/
  // ChatRouterProvider/路由子树整体重新挂载，自然清空 Moments、Profile、GroupChat、
  // 单聊 currentAI/currentSession、Chat preload map、timeline presentation 等长驻 state。
  const [applicationResetRevision, setApplicationResetRevision] = useState(0);

  const handleResetApplicationData = useCallback(() => {
    setApplicationResetRevision((value) => value + 1);
  }, []);

  return (
    <HostErrorBoundary>
      <BackupRestoreGate>
        <ThemeProvider key={`application-runtime-${applicationResetRevision}`}>
          <WallpaperProvider persistence={wallpaperPersistence}>
            <SafeAreaProvider>
              <AppDialogHost />
              <AppBackground>
                <HostLifecycle onResetApplicationData={handleResetApplicationData}>
                  {children}
                </HostLifecycle>
              </AppBackground>
            </SafeAreaProvider>
          </WallpaperProvider>
        </ThemeProvider>
      </BackupRestoreGate>
    </HostErrorBoundary>
  );
}
