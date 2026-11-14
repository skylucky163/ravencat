/**
 * 定义聊天时间线唯一排序规则。
 *
 * 同一 canonical Agent turnRunId 内，turnItemIndex 是 timeline 的持久顺序事实；
 * 同一 run 会以 turnItemIndex=1 的首项位置作为整体锚点，组内再按 itemIndex 排列。
 *
 * 工具执行期间由业务层直接写入的 durable 卡片（如 Together Listening 邀请卡）
 * 携带同一 turnRunId 但 turnItemIndex 为空，作为 run-associated external item
 * 参与该 run 的组内排序：槽位取「createdAt 不晚于自身的最后一个 run 成员」之后
 * （effective index = 该成员 turnItemIndex + 0.5；没有则为 0.5），同槽位按
 * 数据库 id（写入先后）排列。external item 不参与锚点候选；其所属 run 没有任何
 * 已提交成员时（run 失败/取消/非 canonical），回退为自身历史键，等同普通消息。
 *
 * 不同 run 或普通消息之间仍按各自真实提交时间、同毫秒 SQLite id 排序。
 * 该规则不按 senderType 推断语义，也不使用数据库 id 代替 run 内顺序。
 * SQLite 侧 timelineOrderedMessagesCte 必须与本规则保持同一语义。
 */

import type { ChatMessage } from './ChatMessage';

export type ChatTimelineSortableMessage = Pick<ChatMessage, 'id' | 'createdAt'>
  & Partial<Pick<ChatMessage, 'turnRunId' | 'turnItemIndex' | 'timelineAnchor'>>;

function parseCreatedAtEpochMs(createdAt: string): number {
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareHistoricalMessageOrder(
  left: Pick<ChatMessage, 'id' | 'createdAt'>,
  right: Pick<ChatMessage, 'id' | 'createdAt'>,
): number {
  return (
    parseCreatedAtEpochMs(left.createdAt) - parseCreatedAtEpochMs(right.createdAt)
    || left.id - right.id
  );
}

interface TimelineAnchor {
  createdAt: string;
  id: number;
}

interface RunMemberOrderFact {
  createdAtEpochMs: number;
  itemIndex: number;
}

interface ChatTimelineOrderContext {
  readonly anchors: ReadonlyMap<ChatTimelineSortableMessage, TimelineAnchor>;
  /** 每个 run 已加载的 canonical timeline 成员（仅整数 turnItemIndex）；external 槽位计算时全扫取 max。 */
  readonly runMembers: ReadonlyMap<string, readonly RunMemberOrderFact[]>;
}

/**
 * 为批量排序建立 run 的首项锚点与成员表；分页片段缺首项时使用已加载的最早成员。
 * turnItemIndex 为空的 run-associated external item 不作为锚点候选。
 */
function createChatTimelineOrderContext(
  messages: readonly ChatTimelineSortableMessage[],
): ChatTimelineOrderContext {
  const anchorsByRun = new Map<string, TimelineAnchor>();
  const firstLoadedItemsByRun = new Map<string, ChatTimelineSortableMessage>();
  const membersByRun = new Map<string, RunMemberOrderFact[]>();
  for (const message of messages) {
    if (!message.turnRunId || !Number.isInteger(message.turnItemIndex)) {
      continue;
    }
    const members = membersByRun.get(message.turnRunId) ?? [];
    members.push({
      createdAtEpochMs: parseCreatedAtEpochMs(message.createdAt),
      itemIndex: message.turnItemIndex!,
    });
    membersByRun.set(message.turnRunId, members);
    if (message.timelineAnchor) {
      anchorsByRun.set(message.turnRunId, message.timelineAnchor);
      continue;
    }
    if (message.turnItemIndex === 1) {
      anchorsByRun.set(message.turnRunId, {
        createdAt: message.createdAt,
        id: message.id,
      });
      continue;
    }
    const firstLoaded = firstLoadedItemsByRun.get(message.turnRunId);
    if (!firstLoaded || message.turnItemIndex! < firstLoaded.turnItemIndex!) {
      firstLoadedItemsByRun.set(message.turnRunId, message);
    }
  }
  for (const [runId, firstLoaded] of firstLoadedItemsByRun) {
    if (!anchorsByRun.has(runId)) {
      anchorsByRun.set(runId, {
        createdAt: firstLoaded.createdAt,
        id: firstLoaded.id,
      });
    }
  }

  const anchors = new Map<ChatTimelineSortableMessage, TimelineAnchor>();
  for (const message of messages) {
    if (message.turnRunId) {
      const anchor = anchorsByRun.get(message.turnRunId);
      if (anchor) {
        anchors.set(message, anchor);
      }
    }
  }
  return { anchors, runMembers: membersByRun };
}

function resolveTimelineAnchor(
  message: ChatTimelineSortableMessage,
  context?: ChatTimelineOrderContext,
): TimelineAnchor {
  return context?.anchors.get(message) ?? {
    createdAt: message.createdAt,
    id: message.id,
  };
}

/**
 * run 内排序键：canonical 成员即持久 turnItemIndex；external item 按其真实
 * createdAt 落到「不晚于自身的最后一个成员」之后的半槽位，既不抢占 1..N
 * 整数空间，也与 commit 前（成员尚未落库/加载）的自身历史键回退兼容。
 */
function resolveRunItemOrderKey(
  message: ChatTimelineSortableMessage,
  context?: ChatTimelineOrderContext,
): number {
  if (Number.isInteger(message.turnItemIndex)) {
    return message.turnItemIndex!;
  }
  const members = (message.turnRunId && context?.runMembers.get(message.turnRunId)) || [];
  const createdAtEpochMs = parseCreatedAtEpochMs(message.createdAt);
  let slotBase = 0;
  for (const member of members) {
    if (member.createdAtEpochMs <= createdAtEpochMs && member.itemIndex > slotBase) {
      slotBase = member.itemIndex;
    }
  }
  return slotBase + 0.5;
}

function compareChatTimelineMessages(
  left: ChatTimelineSortableMessage,
  right: ChatTimelineSortableMessage,
  context?: ChatTimelineOrderContext,
): number {
  if (
    left.turnRunId !== null
    && left.turnRunId !== undefined
    && left.turnRunId === right.turnRunId
  ) {
    const orderKeyDiff = resolveRunItemOrderKey(left, context) - resolveRunItemOrderKey(right, context);
    // 同一槽位只可能是多个 external item：按写入先后（数据库 id）稳定排列。
    return orderKeyDiff || left.id - right.id;
  }

  // pairwise 调用没有完整集合上下文时，退回当前消息的历史键；
  // production timeline 必须使用 sortChatTimelineMessages 取得 run 锚点。
  return compareHistoricalMessageOrder(
    resolveTimelineAnchor(left, context),
    resolveTimelineAnchor(right, context),
  );
}

export function sortChatTimelineMessages<T extends ChatTimelineSortableMessage>(
  messages: readonly T[],
): T[] {
  const context = createChatTimelineOrderContext(messages);
  return [...messages].sort((left, right) => (
    compareChatTimelineMessages(left, right, context)
  ));
}
