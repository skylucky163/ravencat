// 单条朋友圈内容及互动区域。

import { showAppDialog } from '@shared/ui';
import React, { useState, useCallback, useMemo, useRef, memo } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { MapPin, Share2 } from 'lucide-react-native';
import { useMomentNavigation } from './MomentNavigation';

import { SELF_USER_PROFILE_ID } from '@features/profile';
import type { MomentComment, MomentRecord } from './useMoments';
import { ThemedSurface, useTheme } from '@shared/theme';
import { formatTime, getLikesText } from './momentItem/formatters';
import { Avatar, CommentIcon, HeartIcon, MoreIcon } from './momentItem/icons';
import { AIManagerModal, CommentInputModal, MoreMenuModal } from './momentItem/modals';
import { createMomentItemStyles } from './momentItem/styles';
import {
  canDeleteMomentCommentFromUserUI,
  hasMomentLevelUserActions,
} from './momentItem/permissions';
import { describeMomentDeleteFailure } from './momentActionFeedback';
import { describeMomentVisibility } from './MomentAudienceDraft';
import MomentMediaViewerModal from './MomentMediaViewerModal';
import { MediaAssetImage } from '@features/media';

interface MomentItemProps {
  detail?: boolean;
  item: MomentRecord;
  currentUserId?: string;
  onLike?: (momentId: string) => void;
  onUnlike?: (momentId: string) => void;
  /** 评论/回复的真实写入；reject 时必须保留草稿与回复目标，不吞错误。 */
  onComment?: (
    momentId: string,
    content: string,
    parentCommentId?: string | null
  ) => Promise<void>;
  /** 删除自己的时刻；reject 时由本组件给出反馈并保留当前 UI。 */
  onDelete?: (momentId: string) => Promise<void> | void;
  onDeleteComment?: (commentId: string) => Promise<void> | void;
  onMediaUpdated?: () => void;
}

type RenderedMomentComment = MomentComment & {
  parentUserName?: string | null;
};

function MomentItem({
  detail = false,
  item,
  currentUserId = SELF_USER_PROFILE_ID,
  onLike,
  onUnlike,
  onComment,
  onDelete,
  onDeleteComment,
  onMediaUpdated,
}: MomentItemProps) {
  const navigation = useMomentNavigation();
  const theme = useTheme();
  const styles = useMemo(() => createMomentItemStyles(theme), [theme]);
  const [showCommentInput, setShowCommentInput] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showAIManager, setShowAIManager] = useState(false);
  const [replyTarget, setReplyTarget] = useState<MomentComment | null>(null);
  const [mediaViewerIndex, setMediaViewerIndex] = useState<number | null>(null);
  const commentTextRef = useRef('');

  // 身份判断必须同时比较 actorType + actorId：只比 id 会让同名/同值的其他 actor 命中。
  const hasLiked = item.likes.some(
    (like) => like.actorType === 'user' && like.actorId === currentUserId
  );
  const isOwnMoment = item.actorType === 'user' && item.actorId === currentUserId;
  const ownership = { isOwnMoment };
  const showMoreButton = hasMomentLevelUserActions(ownership);
  // 可见范围只是给作者自己的轻量提示；M6 不提供任何编辑入口（audience 创建后不可变）。
  const visibilityHint = isOwnMoment ? describeMomentVisibility(item.audienceMode) : null;
  const renderedComments = useMemo<RenderedMomentComment[]>(() => {
    const commentById = new Map(item.comments.map((comment) => [comment.id, comment]));

    return item.comments.flatMap((comment) => {
      const parentComment = comment.parentCommentId
        ? commentById.get(comment.parentCommentId)
        : null;
      const content = comment.content.trim();

      return content ? [{
        ...comment,
        content,
        parentUserName: parentComment?.userName || null,
      }] : [];
    });
  }, [item.comments]);
  const aiComments = renderedComments.filter((comment) => comment.actorType === 'ai');
  const { assistantId } = item;
  const authorAvatar = <Avatar actorType={item.actorType} name={item.userName} avatarUrl={item.avatar} />;
  const mediaColumns = item.media.length === 1 ? 1 : item.media.length <= 4 ? 2 : 3;
  const mediaWidth = mediaColumns === 1 ? '100%' : mediaColumns === 2 ? '49%' : '32%';

  const handleLike = useCallback(() => {
    if (hasLiked) {
      onUnlike?.(item.id);
      return;
    }
    onLike?.(item.id);
  }, [hasLiked, item.id, onLike, onUnlike]);

  const handleComment = useCallback(() => {
    setReplyTarget(null);
    setShowCommentInput(true);
  }, []);

  const handleReplyToAIComment = useCallback((comment: MomentComment) => {
    setReplyTarget(comment);
    setShowCommentInput(true);
  }, []);

  const handleCommentTextChange = useCallback((text: string) => {
    commentTextRef.current = text;
    setCommentText(text);
  }, []);

  /**
   * 评论/回复提交：只有真实写入成功才清空草稿、回复目标并关闭弹窗。
   *
   * reject 时什么都不动——草稿与 reply target 必须留给用户重试，弹窗也保持打开；
   * 错误由 CommentInputModal 统一反馈。
   */
  const handleSubmitComment = useCallback(async () => {
    const finalText = commentTextRef.current.trim();
    if (!finalText) return;

    await onComment?.(item.id, finalText, replyTarget?.id || null);
    commentTextRef.current = '';
    setCommentText('');
    setReplyTarget(null);
    setShowCommentInput(false);
  }, [item.id, onComment, replyTarget?.id]);

  const handleCancelComment = useCallback(() => {
    commentTextRef.current = '';
    setCommentText('');
    setReplyTarget(null);
    setShowCommentInput(false);
  }, []);

  const handleDeleteMoment = useCallback(() => {
    setShowMoreMenu(false);
    showAppDialog({ title: '删除时刻', message: '确定删除这条时刻吗？', buttons: [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          // 必须 await 真实删除并给出失败反馈；成功后由 useMoments 重载当前窗口。
          void (async () => {
            try {
              await onDelete?.(item.id);
            } catch (error) {
              console.error('删除时刻失败:', error);
              showAppDialog({ title: '删除失败', message: describeMomentDeleteFailure(error), tone: 'error' });
            }
          })();
        },
      },
    ] });
  }, [item.id, onDelete]);

  const handleDeleteComment = useCallback(
    (commentId: string) => {
      showAppDialog({ title: '删除评论', message: '确定删除这条评论吗？', buttons: [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await onDeleteComment?.(commentId);
              } catch (error) {
                console.error('删除评论失败:', error);
                showAppDialog({ title: '删除失败', message: describeMomentDeleteFailure(error), tone: 'error' });
              }
            })();
          },
        },
      ] });
    },
    [onDeleteComment]
  );

  return (
    <ThemedSurface variant="card" style={styles.container}>
      <View style={styles.avatarContainer}>
        {assistantId ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`打开${item.userName}的个人主页`}
            onPress={() => navigation.openAssistantProfile(assistantId)}
            activeOpacity={0.7}
          >
            {authorAvatar}
          </TouchableOpacity>
        ) : authorAvatar}
      </View>

      <View style={styles.contentContainer}>
        <View style={styles.headerRow}>
          <Text style={styles.userName}>{item.userName}</Text>
          {showMoreButton ? (
            <TouchableOpacity onPress={() => setShowMoreMenu(true)} style={styles.moreButton} activeOpacity={0.7}>
              <MoreIcon />
            </TouchableOpacity>
          ) : null}
        </View>

        {item.createdAt ? (
          <Text style={styles.timeText}>
            {formatTime(item.createdAt)}
            {visibilityHint ? ` · ${visibilityHint}` : ''}
          </Text>
        ) : null}

        {detail ? <Text style={styles.content}>{item.content}</Text> : <TouchableOpacity onPress={() => navigation.openMoment(item.id)} activeOpacity={0.8}><Text style={styles.content}>{item.content}</Text></TouchableOpacity>}

        {item.media.length > 0 ? (
          <View style={styles.mediaGrid}>
            {item.media.map((media, index) => (
              <TouchableOpacity
                key={media.id}
                style={[styles.mediaTile, { width: mediaWidth }]}
                onPress={() => setMediaViewerIndex(index)}
                activeOpacity={0.9}
              >
                <MediaAssetImage mediaAssetId={media.mediaAssetId} style={styles.mediaImage} resizeMode="cover" />
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {item.locationLabel ? (
          <View style={styles.locationRow}>
            <MapPin size={13} color={theme.colors.icon.secondary} />
            <Text style={styles.locationText} numberOfLines={1}>{item.locationLabel}</Text>
          </View>
        ) : null}

        {(item.likes.length > 0 || item.comments.length > 0) && (
          <View style={styles.interactionContainer}>
            {item.likes.length > 0 && (
              <View style={styles.likesRow}>
                <HeartIcon filled />
                <Text style={styles.likesText}>{getLikesText(item.likes)}</Text>
              </View>
            )}

            {renderedComments.length > 0 && (
              <View style={styles.commentsContainer}>
                {item.likes.length > 0 ? <View style={styles.divider} /> : null}

                {renderedComments.map((comment) => {
                  const isOwnComment = comment.actorType === 'user'
                    && comment.actorId === currentUserId;
                  const isAIComment = comment.actorType === 'ai';
                  const canDelete = canDeleteMomentCommentFromUserUI({
                    isOwnMoment,
                    isOwnComment,
                    commentActorType: comment.actorType,
                  });

                  return (
                    <View key={comment.id} style={styles.commentRow}>
                      <TouchableOpacity
                        style={styles.commentContentWrapper}
                        onPress={() => isAIComment && handleReplyToAIComment(comment)}
                        onLongPress={() => canDelete && handleDeleteComment(comment.id)}
                        activeOpacity={0.9}
                      >
                        <Text style={styles.commentText}>
                          <Text style={styles.commentUserName}>{comment.userName}</Text>
                          {comment.parentUserName ? (
                            <>
                              <Text style={styles.commentColon}> 回复 </Text>
                              <Text style={styles.commentUserName}>{comment.parentUserName}</Text>
                            </>
                          ) : null}
                          <Text style={styles.commentColon}>: </Text>
                          <Text style={styles.commentContentText}>{comment.content}</Text>
                        </Text>
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        )}

        <View style={styles.actionBar}>
          <TouchableOpacity
            style={[styles.actionButton, hasLiked && styles.actionButtonActive]}
            onPress={handleLike}
            activeOpacity={0.7}
          >
            <HeartIcon filled={hasLiked} />
          </TouchableOpacity>

          <TouchableOpacity style={styles.actionButton} onPress={handleComment} activeOpacity={0.7}>
            <CommentIcon />
          </TouchableOpacity>

          <TouchableOpacity accessibilityRole="button" accessibilityLabel="分享时刻" style={[styles.actionButton, styles.shareButton]} onPress={() => navigation.shareMoment(item.id)} activeOpacity={0.7}>
            <Share2 size={16} strokeWidth={1.5} color={theme.colors.icon.secondary} />
          </TouchableOpacity>
        </View>
      </View>

      <MoreMenuModal
        visible={showMoreMenu}
        onClose={() => setShowMoreMenu(false)}
        isOwnMoment={isOwnMoment}
        aiCommentsCount={aiComments.length}
        onDeleteMoment={handleDeleteMoment}
        onOpenAIManager={() => {
          setShowMoreMenu(false);
          setShowAIManager(true);
        }}
      />

      <CommentInputModal
        visible={showCommentInput}
        commentText={commentText}
        placeholder={replyTarget ? `回复 ${replyTarget.userName}...` : '评论...'}
        submitLabel={replyTarget ? '回复' : '发表'}
        onChangeText={handleCommentTextChange}
        onClose={() => setShowCommentInput(false)}
        onCancel={handleCancelComment}
        onSubmit={handleSubmitComment}
      />

      <AIManagerModal
        visible={showAIManager && isOwnMoment}
        aiComments={aiComments}
        onClose={() => setShowAIManager(false)}
        onDeleteComment={onDeleteComment}
      />

      {mediaViewerIndex !== null ? (
        <MomentMediaViewerModal
          visible
          media={item.media}
          initialIndex={mediaViewerIndex}
          canManage={isOwnMoment}
          onClose={() => setMediaViewerIndex(null)}
          onUpdated={() => onMediaUpdated?.()}
        />
      ) : null}
    </ThemedSurface>
  );
}

export default memo(MomentItem);
