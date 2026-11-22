/** 展示待发送附件的缩略图、处理状态与移除操作。 */

import React from 'react';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { X } from 'lucide-react-native';

import type { AttachmentDraftItem } from '@features/chat/messages/domain';
import { formatFileSize } from '@features/chat/messages/domain';
import { useTheme, useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';

interface ChatAttachmentComposerTrayProps {
  attachments: AttachmentDraftItem[];
  onRemove?: (id: string) => void;
}

function getStatusText(attachment: AttachmentDraftItem): string {
  switch (attachment.status) {
    case 'preparing':
      return '准备中…';
    case 'persisting':
      return '保存中…';
    case 'parsing':
      return '解析中…';
    case 'failed':
      return attachment.errorMessage || '处理失败';
    case 'ready':
    default:
      if (attachment.type === 'image') {
        return '图片已就绪';
      }
      if (attachment.parseStatus === 'success') {
        return '文件已解析';
      }
      if (attachment.parseStatus === 'skipped') {
        return '文件已就绪（暂不解析）';
      }
      if (attachment.parseStatus === 'failed') {
        return attachment.parseError || '文件解析失败，将按文件发送';
      }
      return '文件已就绪';
  }
}

export default function ChatAttachmentComposerTray({
  attachments,
  onRemove,
}: ChatAttachmentComposerTrayProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);

  if (attachments.length === 0) {
    return null;
  }

  return (
    <View style={styles.container}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.cards}>
        {attachments.map((attachment) => {
          const isImage = attachment.type === 'image';
          const previewUri = attachment.thumbnailUri || attachment.localUri || attachment.originalUri;
          return (
            <View key={attachment.id} style={isImage ? styles.imageCard : styles.card}>
              {isImage ? (
                <View accessibilityLabel={attachment.status === 'ready' ? '待发送图片' : getStatusText(attachment)}>
                  {previewUri ? (
                    <Image source={{ uri: previewUri }} style={[styles.imagePreview, styles.photoPreview]} resizeMode="cover" resizeMethod="resize" />
                  ) : (
                    <View style={[styles.imagePreview, styles.imagePlaceholder]}>
                      <Ionicons name="image-outline" size={20} color={theme.colors.icon.secondary} />
                    </View>
                  )}
                  {attachment.status !== 'ready' ? (
                    <View style={styles.imageStatus}>
                      {attachment.status === 'failed'
                        ? <Text numberOfLines={2} style={styles.imageError}>处理失败</Text>
                        : <ActivityIndicator size="small" color={theme.colors.brand.onPrimary} />}
                    </View>
                  ) : null}
                </View>
              ) : (
                <View style={styles.fileIconWrap}>
                  <Ionicons name="document-text-outline" size={24} color={theme.colors.icon.primary} />
                </View>
              )}

              {!isImage ? <View style={styles.content}>
                <Text numberOfLines={1} style={styles.fileName}>
                  {attachment.fileName || '未命名文件'}
                </Text>
                <Text numberOfLines={2} style={[
                  styles.statusText,
                  attachment.status === 'failed' ? styles.statusTextError : null,
                ]}>
                  {getStatusText(attachment)}
                </Text>
                <Text numberOfLines={1} style={styles.metaText}>
                  {`${formatFileSize(attachment.fileSize)}${attachment.previewText ? ` · ${attachment.previewText}` : ''}`}
                </Text>
              </View> : null}

              <TouchableOpacity
                style={isImage ? styles.imageRemoveButton : styles.removeButton}
                hitSlop={8}
                onPress={() => onRemove?.(attachment.id)}
                accessibilityRole="button"
                accessibilityLabel={`移除${attachment.fileName}`}
              >
                <X size={isImage ? 14 : 20} color={isImage ? theme.colors.text.primary : theme.colors.icon.secondary} />
              </TouchableOpacity>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  container: {
    // 待发送内容直接浮在会话背景上，不延伸输入栏的整条底色。
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  card: {
    width: 280,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface.default,
    borderRadius: 10,
    borderWidth: 0.5,
    borderColor: theme.colors.border.default,
    padding: 10,
  },
  cards: {
    gap: 16,
    paddingTop: 8,
    paddingBottom: 12,
    paddingRight: 8,
  },
  imageCard: {
    width: 72,
    height: 72,
  },
  imagePreview: {
    width: 72,
    height: 72,
    borderRadius: theme.radius.lg,
  },
  photoPreview: {
    ...theme.shadow.sm,
  },
  imagePlaceholder: {
    backgroundColor: theme.colors.surface.muted,
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageStatus: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.effects.overlay.strong,
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageError: {
    fontSize: 11,
    color: theme.colors.brand.onPrimary,
  },
  imageRemoveButton: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: theme.colors.surface.raised,
    ...theme.shadow.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fileIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 8,
    backgroundColor: theme.colors.surface.muted,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  content: {
    flex: 1,
  },
  fileName: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.colors.text.primary,
    marginBottom: 2,
  },
  statusText: {
    fontSize: 12,
    color: theme.colors.text.secondary,
    marginBottom: 2,
  },
  statusTextError: {
    color: theme.colors.feedback.error,
  },
  metaText: {
    fontSize: 11,
    color: theme.colors.text.tertiary,
  },
  removeButton: {
    paddingLeft: 8,
    alignSelf: 'flex-start',
  },
});
