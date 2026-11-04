/** 表情原图缩略：处理进度与图库共用同一套 MediaAsset 解析与失败占位。 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Text, View, type ImageStyle, type StyleProp } from 'react-native';
import { useTheme } from '@shared/theme';
import { resolveStickerMedia } from '../../application/StickerQueries';
import type { Sticker } from '../../domain/Sticker';

export function StickerThumbnail({
  sticker,
  style,
}: {
  sticker: Sticker;
  style: StyleProp<ImageStyle>;
}) {
  const theme = useTheme();
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let mounted = true;
    setUri(null);
    setError(false);
    void resolveStickerMedia(sticker.id).then((media) => {
      if (mounted) setUri(media.localUri);
    }).catch(() => {
      if (mounted) setError(true);
    });
    return () => { mounted = false; };
  }, [sticker.id, sticker.mediaAssetId]);

  if (uri && !error) {
    return (
      <Image
        source={{ uri }}
        style={style}
        resizeMode="contain"
        onError={() => setError(true)}
      />
    );
  }
  return (
    <View style={[style, { alignItems: 'center', justifyContent: 'center' }]}>
      {error
        ? <Text style={{ fontSize: 12, color: theme.colors.text.secondary }}>图片不可用</Text>
        : <ActivityIndicator size="small" />}
    </View>
  );
}
