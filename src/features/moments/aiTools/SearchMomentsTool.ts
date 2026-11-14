/**
 * @fileoverview 搜索可见时刻动态的 AI 工具
 * @module features/moments/aiTools/SearchMomentsTool
 */

import type { MomentToolContext } from './MomentToolContext';
import type { Moment, MomentPageCursor, MomentQueryRequest } from '../domain/MomentRepository';
import { loadMomentActorDirectory } from '../application/MomentActorResolver';

/**
 * 工具参数接口
 */
interface SearchMomentsArgs {
  author?: string;
  keyword?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  cursor?: MomentPageCursor;
  onlyMyComments?: boolean;
  commentKeyword?: string;
}

/**
 * 工具执行结果接口
 */
interface SearchMomentsResult {
  success: boolean;
  message?: string;
  error?: string;
  data?: Moment[];
  hasMore?: boolean;
  nextCursor?: MomentPageCursor | null;
}

/**
 * 工具定义（JSON Schema）
 */
export const definition = {
  name: 'searchMoments',
  description: '列出或搜索对你可见的时刻（含已读和未读）；不传筛选条件即列出全部。列表是摘要，互动前用 getMomentDetail 读完整内容；结果直接给出 commentId。',
  parameters: {
    type: 'object' as const,
    properties: {
      author: { type: 'string' as const, description: '发布者：self=你自己，user=本机用户，也可用 AI 的稳定 agentId 或当前准确名称；重名时使用结果中的 agentId' },
      keyword: { type: 'string' as const, description: '搜索关键词，匹配时刻内容、地点或作者名称' },
      startDate: { type: 'string' as const, description: '发布开始日期 YYYY-MM-DD，含当日，按设备本地日期' },
      endDate: { type: 'string' as const, description: '发布结束日期 YYYY-MM-DD，含当日，按设备本地日期' },
      onlyMyComments: { type: 'boolean' as const, description: '只列出你评论过的时刻，包含已读记录' },
      commentKeyword: { type: 'string' as const, description: '评论内容关键词；与 onlyMyComments 同用时只匹配你自己的评论' },
      limit: { type: 'integer' as const, description: '每页数量，默认10，最多50', default: 10, minimum: 1, maximum: 50 },
      cursor: {
        type: 'object' as const,
        description: '下一页原样传回上次的 nextCursor，并保持筛选条件一致；首轮省略',
        properties: {
          createdAt: { type: 'string' as const, description: '游标返回的 ISO 发布时间' },
          id: { type: 'string' as const, minLength: 1, description: '游标返回的 momentId' },
        },
        required: ['createdAt', 'id'],
        additionalProperties: false,
      },
    },
    required: [],
    additionalProperties: false,
  },
};

/**
 * 执行工具
 * @param args - 工具参数
 * @param context - 工具执行上下文
 * @returns 执行结果
 */
export async function execute(
  args: SearchMomentsArgs,
  context: MomentToolContext
): Promise<SearchMomentsResult> {
  const { startDate, endDate, limit = 10 } = args;
  const keyword = args.keyword?.trim();

  const currentAgentId = context.getAgentId()?.trim() || null;
  if (!currentAgentId) {
    return { success: false, error: 'AI 身份缺少不可变 agentId，无法搜索时刻' };
  }

  const start = startDate ? calendarDay(startDate) : null;
  const end = endDate ? calendarDay(endDate) : null;
  if ((startDate && !start) || (endDate && !end)) {
    return { success: false, error: '日期必须是有效的 YYYY-MM-DD 本地日期。' };
  }
  if (start && end && start > end) return { success: false, error: '开始日期不能晚于结束日期。' };
  if (args.cursor && (!Number.isFinite(Date.parse(args.cursor.createdAt))
    || new Date(args.cursor.createdAt).toISOString() !== args.cursor.createdAt)) {
    return { success: false, error: 'cursor 必须原样使用上次返回的 nextCursor。' };
  }
  if (end) end.setDate(end.getDate() + 1);

  try {
    const directory = await loadMomentActorDirectory();
    const options: MomentQueryRequest = {
      limit: limit + 1,
      cursor: args.cursor,
      keyword,
      keywordAuthors: keyword ? directory.actors.filter((actor) => (
        actor.displayName.toLowerCase().includes(keyword.toLowerCase())
      )) : [],
      currentAuthors: directory.actors,
      createdAtFrom: start?.toISOString(),
      createdAtBefore: end?.toISOString(),
      onlyMyComments: args.onlyMyComments,
      commentKeyword: args.commentKeyword?.trim(),
    };
    const author = args.author?.trim();
    if (author === 'self') options.author = { actorType: 'ai', actorId: currentAgentId };
    else if (author === 'user') options.author = directory.actors.find((actor) => actor.actorType === 'user')!;
    else if (author) {
      const byId = directory.actors.find((actor) => actor.actorId === author);
      const byName = directory.actors.filter((actor) => actor.displayName === author);
      if (!byId && byName.length > 1) {
        return { success: false, error: `发布者名称重名，请使用稳定 ID：${byName.map((actor) => `${actor.displayName}=${actor.actorId}`).join('；')}` };
      }
      options.author = byId ?? byName[0] ?? { actorType: 'ai', actorId: author };
    }
    // 筛选、ACL 和游标都在 SQL 中执行，不能先截取最新一页再筛选旧内容。
    const rows = await context.repositories.moment!.queryVisibleMomentsForAgent(currentAgentId, options);
    const entries = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = entries[entries.length - 1];
    const nextCursor = hasMore ? { createdAt: last.createdAt, id: last.id } : null;
    const summary = entries.map((moment, index) => {
      const actor = directory.resolve({ actorType: moment.authorType, actorId: moment.authorId, nameSnapshot: moment.authorNameSnapshot });
      return [
        `${index + 1}. [${new Date(moment.createdAt).toLocaleString('zh-CN')}] ${actor.displayName}（${moment.authorType}，authorId: ${moment.authorId}）`,
        moment.editedAt ? `已编辑，最后编辑时间: ${new Date(moment.editedAt).toLocaleString('zh-CN')}` : '未编辑',
        `momentId: ${moment.id}\n正文摘要: ${moment.content.substring(0, 120)}${moment.content.length > 120 ? '…' : ''}`,
        ...moment.ownComments.map((comment) => `你自己的评论（commentId: ${comment.id}，parentCommentId: ${comment.parentCommentId ?? 'null'}）: ${comment.content}`),
      ].join('\n');
    }).join('\n\n');

    return {
      success: true,
      message: [
        `当前 AI agentId: ${currentAgentId}。查询包含已读和未读；完整内容与评论区请用 getMomentDetail。`,
        `发布者目录: ${directory.actors.map((actor) => `${actor.displayName}（${actor.actorType}，authorId: ${actor.actorId}）`).join('；')}`,
        entries.length ? `本页找到 ${entries.length} 条时刻:\n${summary}` : '没有找到匹配的时刻动态。keyword 匹配正文、地点或作者名称；查评论内容请使用 commentKeyword。只记得看过但尚未评论时，不要加 onlyMyComments；也可省略筛选条件浏览可见时刻。',
        `hasMore: ${hasMore}\nnextCursor: ${JSON.stringify(nextCursor)}`,
        hasMore ? '还有下一页，请保持筛选条件并原样使用 nextCursor 继续查询。' : '当前查询已到末页。',
        '自己的评论 ID 已随列表提供；删除或回复时直接使用工具返回的 ID，不要让用户查找。',
      ].join('\n\n'),
      data: entries,
      hasMore,
      nextCursor,
    };
  } catch (error) {
    console.error('[SearchMomentsTool] Failed:', error);
    return { success: false, error: '搜索时刻失败' };
  }
}

/**
 * 工具对象（定义 + 执行）
 */
export const SearchMomentsTool = {
  name: definition.name,
  definition,
  execute,
};

/** 模型日期在工具边界转为本地日界，SQL 只比较规范的 UTC 时间。 */
function calendarDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const day = new Date(`${value}T00:00:00`);
  return Number.isFinite(day.getTime())
    && day.getFullYear() === Number(value.slice(0, 4))
    && day.getMonth() + 1 === Number(value.slice(5, 7))
    && day.getDate() === Number(value.slice(8, 10)) ? day : null;
}
