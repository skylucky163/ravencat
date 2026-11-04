/** 渲染图片附件缩略图，检查资源可用性并提供全屏预览。 */

import React, { useContext, useEffect, useMemo } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRecyclingState } from '@shopify/flash-list';

import type { ChatAttachment } from '@features/chat/messages/domain';
import {
  resolveChatImageAttachmentUris,
  type ChatAttachmentMediaReference,
  type ResolvedChatImageAttachmentUris,
} from '../../../messages/application/ResolveChatAttachmentMedia';
import { useTheme, useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import ImagePreviewModal from './ImagePreviewModal';
import { ChatMediaResolutionCacheContext } from '../components/chatMediaResolutionCache';

interface ImageAttachmentCardProps {
  attachment: ChatAttachment;
  isMe: boolean;
  thumbnail?: boolean;
  onLongPress?: (position: { x: number; y: number }) => void;
}

function clampHeight(height: number): number {
  return Math.max(120, Math.min(height, 260));
}

type ImageResolutionState =
  | { status: 'loading' | 'unavailable' }
  | { status: 'ready'; uris: ResolvedChatImageAttachmentUris };

export default function ImageAttachmentCard({
  attachment,
  isMe: _isMe,
  thumbnail = false,
  onLongPress,
}: ImageAttachmentCardProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const mediaCache = useContext(ChatMediaResolutionCacheContext)?.images;
  const { mediaAssetId, thumbnailMediaAssetId, localUri, thumbnailUri } = attachment;
  // 只在媒体引用变化时重新解析，正文、识别结果与 metadata 对象换代不影响图片展示。
  const mediaReference = useMemo((): ChatAttachmentMediaReference => {
    if (typeof mediaAssetId === 'string') {
      return { mediaAssetId, thumbnailMediaAssetId };
    }
    return { localUri, thumbnailUri };
  }, [mediaAssetId, thumbnailMediaAssetId, localUri, thumbnailUri]);
  const mediaKey = JSON.stringify(mediaReference);
  const [previewVisible, setPreviewVisible] = useRecyclingState(false, [attachment.id, mediaKey]);
  const [resolution, setResolution] = useRecyclingState<ImageResolutionState>(
    () => {
      const uris = mediaCache?.get(mediaKey);
      return uris ? { status: 'ready', uris } : { status: 'loading' };
    },
    [mediaCache, mediaKey],
  );
  const resolvedUris = resolution.status === 'ready' ? resolution.uris : null;

  useEffect(() => {
    if (resolution.status !== 'loading') return;
    let isMounted = true;

    void resolveChatImageAttachmentUris(mediaReference).then((uris) => {
      if (uris) mediaCache?.set(mediaKey, uris);
      if (isMounted) {
        setResolution(uris ? { status: 'ready', uris } : { status: 'unavailable' });
      }
    });

    return () => {
      isMounted = false;
    };
  }, [mediaReference, mediaCache, mediaKey, resolution.status, setResolution]);

  const imageStyle = useMemo(() => {
    if (thumbnail) return { ...styles.imageFixed, ...styles.imageThumbnail };
    const width = attachment.width || 0;
    const height = attachment.height || 0;
    if (!width || !height) {
      return styles.imageFixed;
    }

    return {
      ...styles.imageFixed,
      height: clampHeight((220 * height) / width),
    };
  }, [attachment.height, attachment.width, styles.imageFixed, styles.imageThumbnail, thumbnail]);

  return (
    <>
      <Pressable
        style={[styles.container, thumbnail && styles.thumbnailContainer]}
        onLongPress={onLongPress ? (event) => onLongPress({
          x: event.nativeEvent.pageX,
          y: event.nativeEvent.pageY,
        }) : undefined}
        onPress={() => {
          if (resolvedUris) {
            setPreviewVisible(true);
          }
        }}
      >
        <Image
          source={resolvedUris ? { uri: resolvedUris.previewUri } : undefined}
          style={imageStyle}
          resizeMode="cover"
        />
        {resolution.status !== 'ready' ? (
          <View style={[StyleSheet.absoluteFill, styles.placeholder]} pointerEvents="none">
            {resolution.status === 'loading' ? (
              <ActivityIndicator color={theme.colors.icon.secondary} accessibilityLabel="图片加载中" />
            ) : (
              <>
                <Ionicons name="image-outline" size={28} color={theme.colors.icon.secondary} />
                <Text style={styles.placeholderText}>图片不可用</Text>
              </>
            )}
          </View>
        ) : null}
      </Pressable>

      <ImagePreviewModal
        visible={previewVisible}
        imageUri={resolvedUris?.fullSizeUri || null}
        onClose={() => setPreviewVisible(false)}
      />
    </>
  );
}

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  container: {
    width: 220,
  },
  imageFixed: {
    width: 220,
    height: 160,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.border.light,
  },
  thumbnailContainer: {
    width: 72,
  },
  imageThumbnail: {
    width: 72,
    height: 72,
  },
  placeholder: {
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
  },
  placeholderText: {
    fontSize: 12,
    color: theme.colors.text.secondary,
  },
});
