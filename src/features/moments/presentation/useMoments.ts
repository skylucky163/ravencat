// 朋友圈界面数据 Hook。

import { useCallback, useEffect, useRef, useState } from 'react';

import { SELF_USER_PROFILE_ID, type UserProfile } from '@features/profile';
import {
  createUserMomentComment,
  createUserMomentLike,
  getCurrentMomentUserProfile,
  listMomentRecords,
  removeMomentCommentById,
  removeMomentRecord,
  removeUserMomentLike,
  type MomentRecord as MomentRecordData,
  type MomentRecordComment,
} from '../presentationFacade';
import type { MomentPageCursor } from '../domain/MomentRepository';
import { subscribeMomentMediaAnalysisUpdated } from '../application/MomentMediaAnalysis';

export type MomentComment = MomentRecordComment;

export type MomentRecord = MomentRecordData;

const INITIAL_MOMENTS_LIMIT = 5;
const MOMENTS_PAGE_SIZE = 10;

/**
 * 已加载 item → 下一页 cursor。
 *
 * 只允许使用**最后一个真正显示的 item**：`limit + 1` 那条只是判断 hasMore 的 sentinel，
 * 把它当 cursor 会让下一页从错误位置开始。
 */
function toPageCursor(record: MomentRecordData | undefined): MomentPageCursor | null {
  return record ? { createdAt: record.createdAt, id: record.id } : null;
}

export default function useMoments(authorAgentId?: string) {
  const [moments, setMoments] = useState<MomentRecordData[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreMoments, setHasMoreMoments] = useState(true);
  const [currentUserProfile, setCurrentUserProfile] = useState<UserProfile | null>(null);
  const nextCursorRef = useRef<MomentPageCursor | null>(null);
  const loadedCountRef = useRef(0);
  const hasLoadedRef = useRef(false);
  /**
   * in-flight gate 必须是 ref 而不是 `loadingMore` state：`onEndReached` 在同一个事件
   * 窗口内连续触发两次时，state 还没重渲染，用 state 挡不住第二个请求。
   */
  const loadMoreInFlightRef = useRef(false);
  /**
   * read model generation。full reload / refresh 会 +1，loadMore 捕获当时的值；结果回来时
   * generation 不匹配就丢弃，避免「refresh 之后的旧 page2 追加到新列表」。
   */
  const generationRef = useRef(0);

  useEffect(() => {
    loadedCountRef.current = moments.length;
  }, [moments.length]);

  const getCurrentUserProfile = useCallback(async () => {
    try {
      const profile = await getCurrentMomentUserProfile();
      setCurrentUserProfile(profile);
      return profile;
    } catch (error) {
      console.error('Failed to load current user profile for moments:', error);
      return null;
    }
  }, []);

  const fetchMomentPage = useCallback(
    async (profile: UserProfile | null, limit: number, cursor: MomentPageCursor | null) => {
      const records = await listMomentRecords(profile, {
        limit: limit + 1, cursor,
        ...(authorAgentId ? { author: { actorType: 'ai' as const, actorId: authorAgentId } } : {}),
      });
      const items = records.slice(0, limit);

      return {
        items,
        hasMore: records.length > limit,
        nextCursor: toPageCursor(items[items.length - 1]),
      };
    },
    [authorAgentId]
  );

  /** 完整重载当前窗口的顶部 N 条，并重建 items / hasMore / nextCursor。 */
  const loadMoments = useCallback(async (limit = INITIAL_MOMENTS_LIMIT) => {
    generationRef.current += 1;
    const generation = generationRef.current;
    if (hasLoadedRef.current) {
      setRefreshing(true);
    } else {
      setInitialLoading(true);
    }
    try {
      const profile = await getCurrentUserProfile();
      const page = await fetchMomentPage(profile, limit, null);
      if (generation !== generationRef.current) return;
      setMoments(page.items);
      setHasMoreMoments(page.hasMore);
      nextCursorRef.current = page.nextCursor;
      hasLoadedRef.current = true;
    } catch (error) {
      if (generation === generationRef.current) {
        console.error('Failed to load moments:', error);
      }
    } finally {
      // 已经被更新的 reload 接管的请求不得清掉新一轮的 loading 状态。
      if (generation === generationRef.current) {
        setInitialLoading(false);
        setRefreshing(false);
      }
    }
  }, [fetchMomentPage, getCurrentUserProfile]);

  const reloadLoadedMoments = useCallback(async () => {
    const loadedLimit = Math.max(loadedCountRef.current, INITIAL_MOMENTS_LIMIT);
    await loadMoments(loadedLimit);
  }, [loadMoments]);

  const loadMoreMoments = useCallback(async () => {
    if (!hasMoreMoments || initialLoading || refreshing || loadMoreInFlightRef.current) {
      return;
    }
    const cursor = nextCursorRef.current;
    if (!cursor) return;

    loadMoreInFlightRef.current = true;
    setLoadingMore(true);
    const generation = generationRef.current;
    try {
      const profile = currentUserProfile ?? await getCurrentUserProfile();
      const page = await fetchMomentPage(profile, MOMENTS_PAGE_SIZE, cursor);
      if (generation !== generationRef.current) return;
      setMoments((currentMoments) => {
        const currentIds = new Set(currentMoments.map((moment) => moment.id));
        return [...currentMoments, ...page.items.filter((moment) => !currentIds.has(moment.id))];
      });
      nextCursorRef.current = page.nextCursor;
      setHasMoreMoments(page.hasMore);
    } catch (error) {
      if (generation === generationRef.current) {
        console.error('Failed to load more moments:', error);
      }
    } finally {
      loadMoreInFlightRef.current = false;
      if (generation === generationRef.current) {
        setLoadingMore(false);
      }
    }
  }, [
    currentUserProfile,
    fetchMomentPage,
    getCurrentUserProfile,
    hasMoreMoments,
    initialLoading,
    refreshing,
  ]);

  // commit 后 one-shot 每完成一张就刷新当前窗口；事件不承担任务调度或自动重试。
  // 刷新会重建 nextCursor，因此后续 loadMore 不会因为旧 cursor 错页。
  useEffect(() => subscribeMomentMediaAnalysisUpdated(() => {
    void reloadLoadedMoments();
  }), [reloadLoadedMoments]);

  const addComment = useCallback(
    async (
      momentId: string,
      content: string,
      parentCommentId: string | null = null
    ) => {
      try {
        const comment = await createUserMomentComment(
          momentId,
          content,
          parentCommentId
        );
        await reloadLoadedMoments();
        return comment;
      } catch (error) {
        console.error('Failed to add comment:', error);
        throw error;
      }
    },
    [reloadLoadedMoments]
  );

  const addLike = useCallback(
    async (momentId: string) => {
      try {
        const like = await createUserMomentLike(momentId);
        await reloadLoadedMoments();
        return like;
      } catch (error) {
        console.error('Failed to add like:', error);
        throw error;
      }
    },
    [reloadLoadedMoments]
  );

  const removeMoment = useCallback(async (momentId: string) => {
    try {
      await removeMomentRecord(momentId);
      // 删除后重建窗口：后面的数据自然补位，不需要乐观删除。
      await reloadLoadedMoments();
      return true;
    } catch (error) {
      console.error('Failed to remove moment:', error);
      throw error;
    }
  }, [reloadLoadedMoments]);

  const removeLike = useCallback(
    async (momentId: string) => {
      try {
        await removeUserMomentLike(momentId);
        await reloadLoadedMoments();
        return true;
      } catch (error) {
        console.error('Failed to remove like:', error);
        throw error;
      }
    },
    [reloadLoadedMoments]
  );

  const removeComment = useCallback(async (commentId: string) => {
    try {
      await removeMomentCommentById(commentId);
      await reloadLoadedMoments();
      return true;
    } catch (error) {
      console.error('Failed to remove comment:', error);
      throw error;
    }
  }, [reloadLoadedMoments]);

  return {
    moments,
    initialLoading,
    refreshing,
    loadingMore,
    hasMoreMoments,
    currentUserProfile,
    currentUserId: SELF_USER_PROFILE_ID,
    loadMoments,
    loadMoreMoments,
    reloadLoadedMoments,
    addComment,
    addLike,
    removeMoment,
    removeLike,
    removeComment,
  };
}
