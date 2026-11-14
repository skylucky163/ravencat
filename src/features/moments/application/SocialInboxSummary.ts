/** Social Inbox 的统一结构化摘要；Prompt 与 Tool 只负责选择展示上限。 */

import type {
  IMomentRepository,
  MomentSocialDelivery,
  MomentSocialDeliveryEventType,
} from '../domain/MomentRepository';
import { loadMomentActorDirectory } from './MomentActorResolver';

export interface MomentSocialInboxSummaryEntry {
  eventType: MomentSocialDeliveryEventType;
  momentId: string;
  commentId: string | null;
  actorNames: string[];
  eventCount: number;
  /** 事件发生时间；合并点赞时取最新 deliverySeq 对应的点赞时间。 */
  createdAt: string;
}

export interface MomentSocialInboxSummary {
  entries: MomentSocialInboxSummaryEntry[];
  totalUnreadCount: number;
  remainingUnreadCount: number;
  nextCursor: number | null;
}

export async function loadSocialInboxSummary(
  repository: IMomentRepository,
  recipientAgentId: string,
  options: { groupLimit: number; beforeDeliverySeq?: number }
): Promise<MomentSocialInboxSummary> {
  const deliveries = await repository.listUnreadSocialDeliveries(recipientAgentId);
  if (deliveries.length === 0) {
    return { entries: [], totalUnreadCount: 0, remainingUnreadCount: 0, nextCursor: null };
  }

  const directory = await loadMomentActorDirectory();
  const displayName = (delivery: MomentSocialDelivery) => directory.resolve({
    actorType: delivery.actorType,
    actorId: delivery.actorId,
    nameSnapshot: delivery.actorNameSnapshot,
  }).displayName;

  const grouped: { latestSeq: number; entry: MomentSocialInboxSummaryEntry }[] = [];
  const likeGroups = new Map<string, typeof grouped[number]>();
  for (const delivery of deliveries) {
    if (delivery.eventType === 'like_on_your_moment') {
      let group = likeGroups.get(delivery.sourceMomentId);
      if (!group) {
        group = {
          latestSeq: delivery.deliverySeq,
          entry: {
            eventType: delivery.eventType,
            momentId: delivery.sourceMomentId,
            commentId: null,
            actorNames: [],
            eventCount: 0,
            createdAt: delivery.createdAt,
          },
        };
        likeGroups.set(delivery.sourceMomentId, group);
        grouped.push(group);
      }
      if (delivery.deliverySeq > group.latestSeq) {
        group.latestSeq = delivery.deliverySeq;
        group.entry.createdAt = delivery.createdAt;
      }
      group.entry.eventCount += 1;
      const name = displayName(delivery);
      if (!group.entry.actorNames.includes(name) && group.entry.actorNames.length < 3) {
        group.entry.actorNames.push(name);
      }
      continue;
    }

    grouped.push({
      latestSeq: delivery.deliverySeq,
      entry: {
        eventType: delivery.eventType,
        momentId: delivery.sourceMomentId,
        commentId: delivery.sourceCommentId,
        actorNames: [displayName(delivery)],
        eventCount: 1,
        createdAt: delivery.createdAt,
      },
    });
  }

  grouped.sort((left, right) => right.latestSeq - left.latestSeq);
  const page = options.beforeDeliverySeq === undefined
    ? grouped : grouped.filter((group) => group.latestSeq < options.beforeDeliverySeq!);
  const visible = page.slice(0, options.groupLimit);
  const remainingUnreadCount = page.slice(options.groupLimit).reduce((count, { entry }) => count + entry.eventCount, 0);
  return {
    entries: visible.map(({ entry }) => entry),
    totalUnreadCount: deliveries.length,
    remainingUnreadCount,
    nextCursor: remainingUnreadCount > 0 ? visible[visible.length - 1].latestSeq : null,
  };
}

export function formatSocialInboxSummary(summary: MomentSocialInboxSummary): string {
  const lines = summary.entries.map((entry) => {
    const actor = entry.actorNames[0]!;
    const time = new Date(entry.createdAt).toLocaleString('zh-CN', {
      hour12: false,
      timeZoneName: 'longOffset',
    });
    switch (entry.eventType) {
      case 'moment_published':
        return `【${actor} 发了一条新时刻（发布时间: ${time}，momentId: ${entry.momentId}）】`;
      case 'comment_on_your_moment':
        return `【${actor} 评论了你的时刻（评论时间: ${time}，momentId: ${entry.momentId}，commentId: ${entry.commentId}）】`;
      case 'reply_to_your_comment':
        return `【${actor} 回复了你的一条评论（回复时间: ${time}，momentId: ${entry.momentId}，commentId: ${entry.commentId}）】`;
      case 'like_on_your_moment': {
        const names = entry.actorNames.join('、');
        const actors = entry.eventCount === 1
          ? names
          : entry.eventCount > entry.actorNames.length
            ? `${names} 等 ${entry.eventCount} 位`
            : `${names} 共 ${entry.eventCount} 位`;
        return `【${actors}给你的时刻点了赞（最近点赞时间: ${time}，momentId: ${entry.momentId}）】`;
      }
    }
  });
  if (summary.remainingUnreadCount > 0) {
    lines.push(`还有 ${summary.remainingUnreadCount} 条未读事件未展开。`);
  }
  return lines.join('\n');
}
