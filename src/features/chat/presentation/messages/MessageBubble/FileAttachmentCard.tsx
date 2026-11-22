/** 渲染文件附件卡片，并把点击交给聊天 Shell 的统一预览 owner。 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { ChatAttachment } from '@features/chat/messages/domain';
import { formatFileSize } from '@features/chat/messages/domain';
import { resolveChatAttachmentPrimaryUri } from '../../../messages/application/ResolveChatAttachmentMedia';
import { useTheme, useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';

interface FileAttachmentCardProps {
  attachment: ChatAttachment;
  isMe: boolean;
  compact?: boolean;
  onLongPress?: (position: { x: number; y: number }) => void;
  onPreview: (params: { fileUri: string; fileName: string; mimeType?: string | null }) => void;
}

export default function FileAttachmentCard({
  attachment,
  isMe,
  compact = false,
  onPreview,
  onLongPress,
}: FileAttachmentCardProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const [resolvedUri, setResolvedUri] = useState<string | null>(null);
  const canOpen = Boolean(resolvedUri);
  const iconColor = isMe ? theme.colors.brand.primary : theme.colors.icon.primary;

  useEffect(() => {
    let isMounted = true;
    setResolvedUri(null);

    void resolveChatAttachmentPrimaryUri(attachment).then(
      (uri) => {
        if (isMounted) {
          setResolvedUri(uri.trim() || null);
        }
      },
      () => {
        if (isMounted) {
          setResolvedUri(null);
        }
      },
    );

    return () => {
      isMounted = false;
    };
  }, [attachment]);

  const metaParts = [
    formatFileSize(attachment.fileSize),
    attachment.unavailable ? '文件不可用' : '',
  ].filter(Boolean);

  const handlePress = useCallback(() => {
    if (!canOpen) return;

    onPreview({
      fileUri: resolvedUri,
      fileName: attachment.fileName || '未命名文件',
      mimeType: attachment.mimeType,
    });
  }, [attachment.fileName, attachment.mimeType, canOpen, onPreview, resolvedUri]);

  return (
    <Pressable
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.card,
        isMe ? styles.cardMe : null,
        compact ? styles.compactCard : null,
        pressed ? styles.cardPressed : null,
        !canOpen ? styles.cardUnavailable : null,
      ]}
      onPress={handlePress}
      onLongPress={onLongPress ? event => onLongPress({ x: event.nativeEvent.pageX, y: event.nativeEvent.pageY }) : undefined}
      disabled={!canOpen && !onLongPress}
    >
      <View style={[styles.iconWrap, isMe ? styles.iconWrapMe : null, compact ? styles.compactIconWrap : null]}>
        <Ionicons
          name={canOpen ? 'document-text-outline' : 'document-outline'}
          size={compact ? 16 : 24}
          color={iconColor}
        />
      </View>

      <View style={styles.content}>
        <Text style={[styles.fileName, isMe ? styles.fileNameMe : null]} numberOfLines={compact ? 1 : 2}>
          {attachment.fileName || '未命名文件'}
        </Text>
        {!compact ? <Text style={[styles.metaText, isMe ? styles.metaTextMe : null]} numberOfLines={1}>
          {metaParts.join(' · ') || '文件'}
        </Text> : null}
      </View>
    </Pressable>
  );
}

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  card: {
    width: 220,
    minHeight: 64,
    borderRadius: 2,
    backgroundColor: theme.colors.surface.default,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardMe: {
    backgroundColor: theme.colors.surface.default,
  },
  compactCard: {
    width: 160,
    maxWidth: '100%',
    minHeight: 24,
    padding: 0,
    backgroundColor: 'transparent',
  },
  cardPressed: {
    opacity: 0.88,
  },
  cardUnavailable: {
    opacity: 0.72,
  },
  iconWrap: {
    width: 36,
    height: 40,
    borderRadius: 2,
    backgroundColor: theme.colors.surface.muted,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  iconWrapMe: {
    backgroundColor: theme.colors.brand.primary + '15',
  },
  compactIconWrap: {
    width: 20,
    height: 20,
    marginRight: 4,
    backgroundColor: 'transparent',
  },
  content: {
    flex: 1,
  },
  fileName: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.text.primary,
  },
  fileNameMe: {
    color: theme.colors.text.primary,
  },
  metaText: {
    fontSize: 11,
    color: theme.colors.text.secondary,
    marginTop: 4,
  },
  metaTextMe: {
    color: theme.colors.text.secondary,
  },
});
