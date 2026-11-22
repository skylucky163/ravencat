/** Host 组合 Chat 真值与悬浮展示；每次替换最近消息窗口，不累计历史或轮询数据库。 */
import { getAssistantDisplayName, aiAssistantRepository, subscribeAIAssistantUpdated, subscribeAssistantLifecycleChanged } from '@features/assistants';
import {
  getCanonicalChatConversation,
  listRecentChatPreviewMessages,
  markChatMessagesReadByIds,
  subscribeAIMessageReceived,
  subscribeAssistantMessageArrival,
  subscribeToPublicChatSessionDeleted,
} from '@features/chat';
import { setChatEventBus } from '@features/chat/composition';
import { dismissReadMessageNotifications } from '@platform/device';
import {
  addConversationRefreshListener,
  addConversationDisplayedListener,
  updateConversationPreview,
  updateTargetPreview,
} from '@features/floatingLayer';

const PREVIEW_MESSAGE_LIMIT = 6;
let configured = false;
let databaseReady = false;
let revision = 0;
let syncing: Promise<void> | null = null;

export function setFloatingConversationDatabaseReady(ready: boolean): void {
  databaseReady = ready;
  revision++;
}

export function syncFloatingConversation(): Promise<void> {
  revision++;
  if (!databaseReady) return Promise.resolve();
  if (syncing) return syncing;

  syncing = (async () => {
    let readRevision: number;
    do {
      readRevision = revision;
      const ai = await aiAssistantRepository.getHostAI();
      const session = ai && !ai.isBlocked ? await getCanonicalChatConversation(ai.id) : null;
      const messages = session
        ? await listRecentChatPreviewMessages({ sessionId: session.id, limit: PREVIEW_MESSAGE_LIMIT })
        : [];
      // 读取途中有新的 commit、到达或宿主重置时，旧结果不能覆盖新的投影。
      if (!databaseReady) return;
      if (readRevision !== revision) continue;
      await updateConversationPreview({ sessionId: session?.id ?? null, messages });
      await updateTargetPreview(session && ai ? {
        title: `To ${getAssistantDisplayName(ai)}`,
        subtitle: session.name?.trim() || 'Active session',
        status: 'ready',
      } : {
        title: '未选择主理 AI',
        subtitle: ai?.isBlocked ? '当前主理 AI 已被限制' : '请在 App 中设置可用的主理 AI',
        status: 'disabled',
      });
    } while (databaseReady && readRevision !== revision);
  })().finally(() => { syncing = null; });
  return syncing;
}

function requestSync(): void {
  void syncFloatingConversation().catch((error) => {
    console.error('[FloatingConversationProjection] 同步会话失败：', error);
  });
}

/** 每个页面 / Headless runtime 只装配一次，消息 commit 是数据库已就绪的证据。 */
export function configureFloatingConversationProjection(): void {
  if (configured) return;
  configured = true;
  setChatEventBus({ emit: (eventName) => {
    if (eventName === 'messagesUpdated' || eventName === 'messagesPatched' || eventName === 'messagesDeleted' || eventName === 'messagesReloadRequested') {
      databaseReady = true;
      requestSync();
    }
  } });
  subscribeAIMessageReceived(() => { databaseReady = true; requestSync(); });
  subscribeAssistantMessageArrival(() => { if (databaseReady) requestSync(); });
  subscribeAIAssistantUpdated(() => { if (databaseReady) requestSync(); });
  subscribeAssistantLifecycleChanged(() => { if (databaseReady) requestSync(); });
  subscribeToPublicChatSessionDeleted(() => { if (databaseReady) requestSync(); });
  addConversationRefreshListener(requestSync);
  addConversationDisplayedListener((event) => {
    // 原生 View 拥有可见性事实；Host 只把精确身份交给 Chat，不按整个会话批量已读。
    void markChatMessagesReadByIds(event).then(() => dismissReadMessageNotifications(event)).catch((error) => {
      console.error('[FloatingConversationProjection] 同步悬浮消息已读失败：', error);
    });
  });
}
