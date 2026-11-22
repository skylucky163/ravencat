/** 定义 AI 消息持久交付后的事件与统一系统交付契约，区分 UI 观察者和唯一交付处理器。 */
import type { ConversationKind } from '../../conversation/domain/ConversationRef';

export type AIMessageDeliveryKind = 'passive' | 'proactive';

/** AI 消息持久交付后的统一系统交付结果；UI 投影观察者不参与该回执。 */
export type AIMessageDeliveryStatus =
  | 'shown'
  | 'suppressed_foreground'
  | 'suppressed_unavailable'
  | 'handled_by_consumer'
  | 'failed';

export interface AIMessageDeliveryReceipt {
  status: AIMessageDeliveryStatus;
  errorCategory: string | null;
}

/**
 * UI 观察者投影通知：免交付事实（如通话状态条目）可能缺少 AI 身份，
 * 只携带 sessionId 也能驱动会话列表/时间线缓存刷新。
 */
export interface AIMessageObserverPayload {
  sessionId: string;
  aiId?: string | null;
  agentId?: string | null;
  aiName?: string | null;
  /** 已提交消息的稳定数据库 ID。 */
  committedMessageId?: number;
  triggerSource?: string | null;
  /** 会话类型，缺省视为 'direct'（单聊）。 */
  conversationKind?: ConversationKind;
  /** 群聊会话的群 id（群聊 sessionId = groupId） */
  groupId?: string | null;
}

interface AIMessageReceivedDetails {
  turnRunId?: string;
  aiId: string;
  agentId?: string | null;
  aiName: string;
  aiAvatar?: string | null;
  sessionId: string;
  message: string;
  logicalMessageId?: string | null;
  segmentIndex?: number;
  segmentTotal?: number;
  deliveryKind: AIMessageDeliveryKind;
  triggerSource?: string | null;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  /** 原生通知诊断分域；仅交付协调器向 platform 透传。 */
  notificationScope?: string | null;
  /** 原始请求身份，仅用于悬浮输入区收口对应的等待状态。 */
  requestCorrelationId?: string;
  /** 会话类型，缺省视为 'direct'（单聊）；群聊回复必须显式填 'group' */
  conversationKind?: ConversationKind;
  /** 群聊会话的群 id（群聊 sessionId = groupId） */
  groupId?: string | null;
  /** 群名，供群聊通知标题使用 */
  groupName?: string | null;
}

/** 正式消息或已持久交付的运行正文；运行正文不伪造 canonical 数据库 ID。 */
export type AIMessageDeliveryIdentity =
  | { committedMessageId: number; clientMessageId?: string; arrivalAlreadyScheduled?: boolean }
  | { committedMessageId?: never; clientMessageId: string; arrivalAlreadyScheduled: true; turnRunId: string };

export type AIMessageReceivedPayload = AIMessageReceivedDetails & AIMessageDeliveryIdentity;

export type AIMessageReceivedListener = (
  payload: AIMessageObserverPayload
) => void | Promise<void>;

/** 唯一系统交付所有者；普通 UI 观察者不能返回该回执。 */
export type AIMessageDeliveryHandler = (
  payload: AIMessageReceivedPayload
) => AIMessageDeliveryReceipt | Promise<AIMessageDeliveryReceipt>;

const aiMessageListeners = new Set<AIMessageReceivedListener>();
let aiMessageDeliveryHandler: AIMessageDeliveryHandler | null = null;

/** 注册唯一交付处理器；UI 观察者仍通过 subscribe 保持 fire-and-forget。 */
export function configureAIMessageDeliveryHandler(
  handler: AIMessageDeliveryHandler,
): void {
  if (aiMessageDeliveryHandler && aiMessageDeliveryHandler !== handler) {
    throw new Error('AI 消息交付处理器只能注册一次');
  }
  aiMessageDeliveryHandler = handler;
}

export function subscribeAIMessageReceived(
  listener: AIMessageReceivedListener
): () => void {
  if (typeof listener !== 'function') {
    return () => {};
  }

  aiMessageListeners.add(listener);

  return () => {
    aiMessageListeners.delete(listener);
  };
}

/** 仅向 UI 观察者扇出投影事实；不触发唯一交付处理器。 */
function dispatchToAIMessageObservers(payload: AIMessageObserverPayload): void {
  // UI 观察者只负责投影/刷新，不得阻塞 T3 或 Headless 交付生命周期。
  for (const listener of Array.from(aiMessageListeners)) {
    let result: void | Promise<void>;
    try {
      result = listener(payload);
    } catch (error) {
      console.error('[AIMessageEvents] Failed to deliver ai message event:', error);
      continue;
    }
    Promise.resolve(result).catch((error) => {
      console.error('[AIMessageEvents] Failed to deliver ai message event:', error);
    });
  }
}

/**
 * 通知 UI 观察者刷新会话列表/未读等投影，但不走系统交付。
 * 供免交付的已提交事实（如通话文本 delivery: 'none'、通话状态条目）复用：
 * 消息已由消费方在自有 surface 呈现，但列表投影仍需及时刷新。
 */
export function notifyAIMessageObservers(payload: AIMessageObserverPayload): void {
  if (!payload?.sessionId) {
    return;
  }

  dispatchToAIMessageObservers(payload);
}

export function resolveAIMessageDeliveryKind(
  triggerSource?: string | null
): AIMessageDeliveryKind {
  return triggerSource === 'chat' || !triggerSource ? 'passive' : 'proactive';
}

export function emitAIMessageReceived(
  payload: AIMessageReceivedPayload
): Promise<AIMessageDeliveryReceipt> {
  return (async () => {
    if (!aiMessageDeliveryHandler) {
      dispatchToAIMessageObservers(payload);
      console.error('[AIMessageEvents] AI 消息交付处理器尚未注册');
      return {
        status: 'failed',
        errorCategory: 'delivery_handler_not_configured',
      };
    }

    try {
      return await aiMessageDeliveryHandler(payload);
    } catch (error) {
      console.error('[AIMessageEvents] Failed to deliver ai message:', error);
      return {
        status: 'failed',
        errorCategory: 'delivery_handler_error',
      };
    } finally {
      dispatchToAIMessageObservers(payload);
    }
  })();
}
