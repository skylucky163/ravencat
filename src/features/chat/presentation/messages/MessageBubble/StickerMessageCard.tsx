/** 渲染独立 Sticker 消息卡；媒体通过 MediaAsset resolver 解析，不走普通图片附件链。 */

import React, { useContext, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { resolveMediaAsset } from '@features/media';
import type { StickerMessageSnapshot } from '@features/chat/messages/domain';
import { useTheme, useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import { ChatMediaResolutionCacheContext } from '../components/chatMediaResolutionCache';

interface StickerMessageCardProps {
  sticker: StickerMessageSnapshot;
}

const CARD_WIDTH = 130;
const DEFAULT_CARD_HEIGHT = 104;

function clampHeight(height: number): number {
  return Math.max(72, Math.min(height, 130));
}

type StickerResolutionState =
  | { status: 'loading' | 'unavailable' }
  | { status: 'ready'; localUri: string };

export default function StickerMessageCard({ sticker }: StickerMessageCardProps) {
  // FlashList 会复用外层卡片；素材更换时重建内容，使旧原生回调与异步解析只拥有旧状态。
  return <StickerMessageContent key={sticker.mediaAssetId} sticker={sticker} />;
}

function StickerMessageContent({ sticker }: StickerMessageCardProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const mediaCache = useContext(ChatMediaResolutionCacheContext)?.stickers;
  const [resolution, setResolution] = useState<StickerResolutionState>(
    () => {
      const localUri = mediaCache?.get(sticker.mediaAssetId);
      return localUri ? { status: 'ready', localUri } : { status: 'loading' };
    },
  );

  useEffect(() => {
    if (resolution.status !== 'loading') return;
    let isMounted = true;

    void resolveMediaAsset(sticker.mediaAssetId)
      .then((resolved) => {
        mediaCache?.set(sticker.mediaAssetId, resolved.localUri);
        if (isMounted) {
          setResolution({ status: 'ready', localUri: resolved.localUri });
        }
      })
      .catch((error: unknown) => {
        // backing 缺失是可展示的历史消息状态，卡片保留占位而不改写消息事实。
        if (isMounted) {
          console.warn('[StickerMessageCard] 表情素材解析失败', {
            stickerId: sticker.stickerId, mediaAssetId: sticker.mediaAssetId,
            mimeType: sticker.mimeType, stage: 'resolve', error,
          });
          setResolution({ status: 'unavailable' });
        }
      });

    return () => {
      isMounted = false;
    };
  }, [sticker.mediaAssetId, sticker.stickerId, sticker.mimeType, mediaCache, resolution.status]);

  const imageStyle = useMemo(() => {
    const width = sticker.width || 0;
    const height = sticker.height || 0;
    if (!width || !height) {
      return styles.imageFixed;
    }

    return {
      ...styles.imageFixed,
      height: clampHeight((CARD_WIDTH * height) / width),
    };
  }, [sticker.height, sticker.width, styles.imageFixed]);

  return (
    <View style={styles.container}>
      {resolution.status === 'ready' ? (
        <Image
          key={resolution.localUri}
          source={{ uri: resolution.localUri }}
          style={imageStyle}
          resizeMode="contain"
          onError={(event) => {
            console.warn('[StickerMessageCard] 表情图片加载失败', {
              stickerId: sticker.stickerId, mediaAssetId: sticker.mediaAssetId,
              mimeType: sticker.mimeType, localUri: resolution.localUri,
              stage: 'image', error: event.nativeEvent.error,
            });
            setResolution({ status: 'unavailable' });
          }}
        />
      ) : (
        <View style={[imageStyle, styles.placeholder]}>
          {resolution.status === 'loading' ? (
            <ActivityIndicator color={theme.colors.icon.secondary} accessibilityLabel="表情包加载中" />
          ) : (
            <>
              <Ionicons name="happy-outline" size={28} color={theme.colors.icon.secondary} />
              <Text style={styles.placeholderText}>表情包不可用</Text>
            </>
          )}
        </View>
      )}
    </View>
  );
}

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  container: {
    width: CARD_WIDTH,
    alignItems: 'flex-start',
  },
  imageFixed: {
    width: CARD_WIDTH,
    height: DEFAULT_CARD_HEIGHT,
    borderRadius: theme.radius.sm,
    backgroundColor: 'transparent',
  },
  placeholder: {
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.border.light + '55',
  },
  placeholderText: {
    fontSize: 12,
    color: theme.colors.text.secondary,
  },
});
