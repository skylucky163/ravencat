/** 提供朋友圈条目使用的操作、评论输入与 AI 管理弹窗。 */
import React, { useState, useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, Modal, TextInput, FlatList, Keyboard, StyleSheet } from 'react-native';
import { useTheme, ThemedSurface } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import { Button, ModalSheet, showAppDialog } from '@shared/ui';
import type { MomentComment } from '../useMoments';
import { canManageMomentAIComments } from './permissions';
import {
  describeMomentCommentFailure,
  describeMomentDeleteFailure,
} from '../momentActionFeedback';

function createModalStyles(theme: PresentationTheme) {
  return StyleSheet.create({
    modalOverlay: {
      flex: 1,
      backgroundColor: theme.effects.overlay.dim,
      justifyContent: 'center',
      alignItems: 'center',
    },
    menuContainer: {
      backgroundColor: theme.colors.surface.default,
      marginHorizontal: 40,
      borderRadius: theme.radius.lg,
      overflow: 'hidden',
      width: 240,
    },
    menuItem: {
      paddingVertical: 16,
      alignItems: 'center',
      borderBottomWidth: 0.5,
      borderBottomColor: theme.colors.border.light,
    },
    menuItemText: {
      fontSize: 16,
      color: theme.colors.text.primary,
    },
    menuItemTextDanger: {
      fontSize: 16,
      color: theme.colors.feedback.error,
      fontWeight: '500',
    },
    commentInputContainer: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.lg,
      paddingBottom: theme.spacing.lg,
    },
    commentInputRow: {
      minHeight: 40,
      maxHeight: 100,
      backgroundColor: theme.colors.surface.muted,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    commentInput: {
      fontSize: 15,
      color: theme.colors.text.primary,
      maxHeight: 80,
      textAlignVertical: 'top',
    },
    commentButtonRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: theme.spacing.md,
    },
    cancelButton: {
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.sm,
    },
    cancelButtonText: {
      fontSize: 15,
      color: theme.colors.text.secondary,
    },
    submitButton: {
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
    },
    submitButtonText: {
      fontSize: 14,
    },
    aiManagerContainer: {
      borderTopLeftRadius: theme.radius.xl,
      borderTopRightRadius: theme.radius.xl,
      maxHeight: '80%',
      paddingBottom: 34,
    },
    aiManagerHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.lg,
      paddingBottom: theme.spacing.md,
      borderBottomWidth: 0.5,
      borderBottomColor: theme.colors.border.light,
    },
    aiManagerTitle: {
      fontSize: 17,
      fontWeight: '600',
      color: theme.colors.text.primary,
    },
    aiManagerSubtitle: {
      fontSize: 13,
      color: theme.colors.text.secondary,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.surface.muted,
    },
    aiManagerClose: {
      padding: theme.spacing.sm,
    },
    aiManagerCloseText: {
      fontSize: 16,
      color: theme.colors.brand.primary,
      fontWeight: '500',
    },
    aiCommentItem: {
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
    },
    aiCommentHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 4,
    },
    aiCommentUser: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.brand.primary,
    },
    aiCommentHint: {
      fontSize: 12,
      color: theme.colors.text.tertiary,
    },
    aiCommentContent: {
      fontSize: 15,
      color: theme.colors.text.primary,
      lineHeight: 22,
    },
    aiCommentDivider: {
      height: 0.5,
      backgroundColor: theme.colors.border.light,
      marginLeft: theme.spacing.lg,
    },
    aiEmptyText: {
      fontSize: 15,
      color: theme.colors.text.secondary,
      textAlign: 'center',
      paddingVertical: theme.spacing.xl,
    },
  });
}

interface MoreMenuModalProps {
  visible: boolean;
  onClose: () => void;
  isOwnMoment: boolean;
  aiCommentsCount: number;
  onDeleteMoment: () => void;
  onOpenAIManager: () => void;
}

export function MoreMenuModal({
  visible,
  onClose,
  isOwnMoment,
  aiCommentsCount,
  onDeleteMoment,
  onOpenAIManager,
}: MoreMenuModalProps) {
  const theme = useTheme();
  const modalStyles = useMemo(() => createModalStyles(theme), [theme]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
        <TouchableOpacity style={modalStyles.modalOverlay} activeOpacity={1} onPress={onClose}>
        <ThemedSurface variant="modal" style={modalStyles.menuContainer}>
          {isOwnMoment && (
            <TouchableOpacity style={modalStyles.menuItem} onPress={onDeleteMoment} activeOpacity={0.7}>
              <Text style={modalStyles.menuItemTextDanger}>删除时刻</Text>
            </TouchableOpacity>
          )}
          {canManageMomentAIComments(isOwnMoment, aiCommentsCount) && (
            <TouchableOpacity style={modalStyles.menuItem} onPress={onOpenAIManager} activeOpacity={0.7}>
              <Text style={modalStyles.menuItemText}>管理评论 ({aiCommentsCount})</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={modalStyles.menuItem} onPress={onClose} activeOpacity={0.7}>
            <Text style={modalStyles.menuItemText}>取消</Text>
          </TouchableOpacity>
        </ThemedSurface>
      </TouchableOpacity>
    </Modal>
  );
}

interface CommentInputModalProps {
  visible: boolean;
  commentText: string;
  placeholder?: string;
  /** 提交按钮文案；回复场景用「回复」。 */
  submitLabel?: string;
  onChangeText: (text: string) => void;
  onClose: () => void;
  onCancel: () => void;
  /** 真实写入；只有 resolve 后才允许上层清空草稿并关闭弹窗。 */
  onSubmit: () => Promise<void>;
}

export function CommentInputModal({
  visible,
  commentText,
  placeholder = '评论...',
  submitLabel = '发表',
  onChangeText,
  onClose,
  onCancel,
  onSubmit,
}: CommentInputModalProps) {
  const theme = useTheme();
  const modalStyles = useMemo(() => createModalStyles(theme), [theme]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const hasText = !!commentText.trim();
  const handleClose = useCallback(() => {
    Keyboard.dismiss();
    onClose();
  }, [onClose]);

  /**
   * 提交必须 await 真实写入结果：
   *
   * - 成功：上层负责清空草稿、回复目标并关闭弹窗；
   * - 失败：弹窗保持打开、草稿与回复目标原样保留，只给出提示让用户重试。
   *
   * 这里不再用"下一帧就关"的乐观写法——那会在 DB 写入失败时先把用户输入
   * 丢掉，再让失败无处可去。
   */
  const handlePressSubmit = useCallback(async () => {
    if (!hasText || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onSubmit();
    } catch (error) {
      console.error('发表评论失败:', error);
      showAppDialog({ title: '发表失败', message: describeMomentCommentFailure(error), tone: 'error' });
    } finally {
      setIsSubmitting(false);
    }
  }, [hasText, isSubmitting, onSubmit]);

  return (
    <ModalSheet
      visible={visible}
      onClose={handleClose}
      style={modalStyles.commentInputContainer}
    >
      <View style={modalStyles.commentInputRow}>
        <TextInput
          style={modalStyles.commentInput}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.text.secondary}
          value={commentText}
          onChangeText={onChangeText}
          multiline
          autoFocus
          submitBehavior="newline"
        />
      </View>
      <View style={modalStyles.commentButtonRow}>
        <TouchableOpacity
          style={modalStyles.cancelButton}
          onPress={() => {
            Keyboard.dismiss();
            onCancel();
          }}
          activeOpacity={0.7}
        >
          <Text style={modalStyles.cancelButtonText}>取消</Text>
        </TouchableOpacity>
        <Button
          title={isSubmitting ? '发送中...' : submitLabel}
          onPress={() => { void handlePressSubmit(); }}
          disabled={!hasText || isSubmitting}
          style={modalStyles.submitButton}
          textStyle={modalStyles.submitButtonText}
        />
      </View>
    </ModalSheet>
  );
}

interface AIManagerModalProps {
  visible: boolean;
  aiComments: MomentComment[];
  onClose: () => void;
  /** 真实删除；reject 时由本弹窗提示并保持管理列表不变。 */
  onDeleteComment?: (commentId: string) => Promise<void> | void;
}

export function AIManagerModal({ visible, aiComments, onClose, onDeleteComment }: AIManagerModalProps) {
  const theme = useTheme();
  const modalStyles = useMemo(() => createModalStyles(theme), [theme]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={modalStyles.modalOverlay}>
        <ThemedSurface variant="modal" style={modalStyles.aiManagerContainer}>
          <View style={modalStyles.aiManagerHeader}>
            <Text style={modalStyles.aiManagerTitle}>管理评论</Text>
            <TouchableOpacity onPress={onClose} style={modalStyles.aiManagerClose}>
              <Text style={modalStyles.aiManagerCloseText}>完成</Text>
            </TouchableOpacity>
          </View>

          <Text style={modalStyles.aiManagerSubtitle}>长按评论可删除</Text>

          <FlatList
            data={aiComments}
            keyExtractor={(item, index) => `${item.id}:${index}`}
            renderItem={({ item: aiComment }) => (
              <TouchableOpacity
                style={modalStyles.aiCommentItem}
                onLongPress={() => {
                  showAppDialog({ title: '删除评论', message: `[${aiComment.userName}]: ${aiComment.content}`, buttons: [
                    { text: '取消', style: 'cancel' },
                    {
                      text: '删除',
                      style: 'destructive',
                      onPress: () => {
                        // 与 MomentItem 一致：await 真实删除，失败提示且不关闭管理弹窗。
                        void (async () => {
                          try {
                            await onDeleteComment?.(aiComment.id);
                            if (aiComments.length <= 1) onClose();
                          } catch (error) {
                            console.error('删除评论失败:', error);
                            showAppDialog({ title: '删除失败', message: describeMomentDeleteFailure(error), tone: 'error' });
                          }
                        })();
                      },
                    },
                  ] });
                }}
                activeOpacity={0.7}
              >
                <View style={modalStyles.aiCommentHeader}>
                  <Text style={modalStyles.aiCommentUser}>{aiComment.userName}</Text>
                  <Text style={modalStyles.aiCommentHint}>长按删除</Text>
                </View>
                <Text style={modalStyles.aiCommentContent}>{aiComment.content}</Text>
              </TouchableOpacity>
            )}
            ItemSeparatorComponent={() => <View style={modalStyles.aiCommentDivider} />}
            ListEmptyComponent={<Text style={modalStyles.aiEmptyText}>暂无 AI 评论</Text>}
          />
        </ThemedSurface>
      </View>
    </Modal>
  );
}
