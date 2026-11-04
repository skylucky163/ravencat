// 朋友圈主界面。发布与时刻设置是独立 push 路由，不再是本组件的内嵌视图。

import { showAppDialog } from '@shared/ui';
import React, { useCallback, useEffect, useMemo } from 'react';
import { ActivityIndicator, FlatList, ListRenderItem, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { useTheme } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import useMoments, { type MomentRecord } from './useMoments';
import MomentItem from './MomentItem';
import MomentsHeader from './MomentsHeader';
import { describeMomentLikeFailure, describeMomentUnlikeFailure } from './momentActionFeedback';

const keyExtractor = (item: MomentRecord) => item.id;

interface MomentsTabBaseProps {
  /**
   * 保活路由的焦点刷新版本（host 提供）：从发布 / 设置等独立页面返回、
   * 或从其他 Tab 切回时 +1。首次聚焦保持 0，首屏加载由挂载 effect 负责。
   */
  refreshRevision: number;
}

export interface MomentProfileAssistant {
  agentId: string;
  name: string;
  avatar: string | null;
  profileCoverMediaAssetId: string | null;
}

type MomentsTabProps = MomentsTabBaseProps & ({
  assistant: MomentProfileAssistant;
  onBack: () => void;
  onPublishPress?: never;
  onSettingsPress?: never;
} | {
  assistant?: never;
  onBack?: never;
  onPublishPress: () => void;
  onSettingsPress: () => void;
});

function createMomentsTabStyles(theme: PresentationTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background.app,
    },
    listContent: {
      paddingBottom: 80,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    emptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      marginTop: -100,
    },
    emptyText: {
      fontSize: 16,
      color: theme.colors.text.secondary,
      marginBottom: theme.spacing.xl,
    },
    profileEmptyContainer: { padding: 32, alignItems: 'center' },
    publishButton: {
      backgroundColor: theme.colors.brand.primary,
      paddingHorizontal: 32,
      paddingVertical: 12,
      borderRadius: theme.radius.md,
    },
    publishButtonText: {
      color: theme.colors.brand.onPrimary,
      fontSize: 16,
      fontWeight: '600',
    },
    footerContainer: {
      alignItems: 'center',
      paddingTop: 8,
      paddingBottom: 16,
    },
    footerText: {
      fontSize: 12,
      color: theme.colors.text.tertiary,
    },
    footerSpacer: {
      height: 16,
    },
  });
}

export default function MomentsTab({
  refreshRevision,
  onPublishPress,
  onSettingsPress,
  assistant,
  onBack,
}: MomentsTabProps) {
  const theme = useTheme();
  const styles = useMemo(() => createMomentsTabStyles(theme), [theme]);
  const safeAreaEdges: Edge[] = theme.effects.glass.enabled ? ['left', 'right'] : ['top', 'left', 'right'];
  if (assistant) safeAreaEdges.push('bottom');
  const {
    moments,
    initialLoading,
    refreshing,
    loadingMore,
    hasMoreMoments,
    currentUserId,
    loadMoments,
    loadMoreMoments,
    reloadLoadedMoments,
    addLike,
    addComment,
    removeMoment,
    removeLike,
    removeComment,
  } = useMoments(assistant?.agentId);

  /**
   * 点赞 / 取消点赞：必须自己吞掉 reject。
   *
   * like 写命令失败会重新 throw：把返回的 promise 直接丢弃（不做处理的 fire-and-forget）
   * 会变成 unhandled rejection，而且用户完全看不到反馈。这里 catch → 安全提示；
   * 不做 optimistic like state，当前 UI 事实由下一次 reload（或当前 DB 状态）决定。
   */
  const handleLike = useCallback((momentId: string) => {
    addLike(momentId).catch((error: unknown) => {
      console.error('点赞失败:', error);
      showAppDialog({ title: '点赞失败', message: describeMomentLikeFailure(error), tone: 'error' });
    });
  }, [addLike]);

  const handleUnlike = useCallback((momentId: string) => {
    removeLike(momentId).catch((error: unknown) => {
      console.error('取消点赞失败:', error);
      showAppDialog({ title: '取消点赞失败', message: describeMomentUnlikeFailure(error), tone: 'error' });
    });
  }, [removeLike]);

  /**
   * 评论/回复：把真实写入结果交回 MomentItem / CommentInputModal。
   * 这里不吞错误——失败必须让弹窗保留草稿与 reply target。
   */
  const handleComment = useCallback((
    momentId: string,
    content: string,
    parentCommentId?: string | null
  ): Promise<void> => addComment(momentId, content, parentCommentId || null).then(() => undefined),
  [addComment]);

  // 删除同样把 reject 交给 MomentItem，由它提示并保留当前 UI。
  const handleDelete = useCallback((momentId: string): Promise<void> =>
    removeMoment(momentId).then(() => undefined), [removeMoment]);

  const handleDeleteComment = useCallback((commentId: string): Promise<void> =>
    removeComment(commentId).then(() => undefined), [removeComment]);

  const renderMomentItem = useCallback<ListRenderItem<MomentRecord>>(
    ({ item }) => (
      <MomentItem
        item={item}
        currentUserId={currentUserId}
        onLike={handleLike}
        onUnlike={handleUnlike}
        onComment={handleComment}
        onDelete={handleDelete}
        onDeleteComment={handleDeleteComment}
        onMediaUpdated={reloadLoadedMoments}
      />
    ),
    [currentUserId, handleComment, handleDelete, handleDeleteComment, handleLike, handleUnlike, reloadLoadedMoments]
  );

  useEffect(() => {
    void loadMoments();
  }, [loadMoments]);

  // 本页在导航栈中保活：从发布 / 设置页返回或从其他 Tab 切回时，重载当前窗口。
  useEffect(() => {
    if (refreshRevision === 0) return;
    void reloadLoadedMoments();
  }, [refreshRevision, reloadLoadedMoments]);

  const handleRefresh = useCallback(() => loadMoments(), [loadMoments]);

  const handleLoadMore = useCallback(() => {
    void loadMoreMoments();
  }, [loadMoreMoments]);

  // 传入元素，避免导航回调变化被列表识别为新组件类型并重置封面状态。
  const header = (
    <MomentsHeader
      assistant={assistant}
      onBack={onBack}
      onCameraPress={onPublishPress}
      onSettingsPress={onSettingsPress}
    />
  );

  const renderFooter = useCallback(() => {
    if (loadingMore) {
      return (
        <View style={styles.footerContainer}>
          <ActivityIndicator size="small" color={theme.colors.brand.primary} />
        </View>
      );
    }

    if (!hasMoreMoments || moments.length === 0) {
      return <View style={styles.footerSpacer} />;
    }

    return (
      <View style={styles.footerContainer}>
        <Text style={styles.footerText}>继续下滑可加载更早内容</Text>
      </View>
    );
  }, [hasMoreMoments, loadingMore, moments.length, styles, theme.colors.brand.primary]);

  if (initialLoading && moments.length === 0) {
    return (
      <SafeAreaView style={styles.container} edges={safeAreaEdges}>
        {assistant && header}
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.colors.brand.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const renderEmptyState = () => (
    <View style={assistant ? styles.profileEmptyContainer : styles.emptyContainer}>
      <Text style={styles.emptyText}>{assistant ? 'TA 还没有发布朋友圈' : '还没有时刻'}</Text>
      {onPublishPress && <TouchableOpacity
        style={styles.publishButton}
        onPress={onPublishPress}
        activeOpacity={0.7}
      >
        <Text style={styles.publishButtonText}>去发布</Text>
      </TouchableOpacity>}
    </View>
  );

  if (moments.length === 0 && !assistant) {
    return (
      <SafeAreaView style={styles.container} edges={safeAreaEdges}>
        {header}
        {renderEmptyState()}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={safeAreaEdges}>
      {/* 评论弹窗仍在列表项的 React 子树中，按钮点击应直接交给子组件处理。 */}
      <FlatList
        data={moments}
        renderItem={renderMomentItem}
        keyExtractor={keyExtractor}
        maxToRenderPerBatch={10}
        windowSize={10}
        removeClippedSubviews
        ListHeaderComponent={header}
        ListEmptyComponent={renderEmptyState()}
        ListFooterComponent={renderFooter}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshing={refreshing}
        onRefresh={handleRefresh}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.35}
      />
    </SafeAreaView>
  );
}
