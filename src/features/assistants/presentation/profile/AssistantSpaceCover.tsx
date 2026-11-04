/** AI 个人空间只有一份封面；主页、朋友圈与图片工具共用资源和媒体身份。 */
import React, { type ReactNode } from 'react';
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { MediaAssetImage } from '@features/media';

export const DEFAULT_ASSISTANT_SPACE_COVER_SOURCE = require('../../../../../assets/stars.jpg');

interface Props {
  mediaAssetId: string | null;
  style: StyleProp<ViewStyle>;
  children?: ReactNode;
}

const styles = StyleSheet.create({
  // 内置资源会注入原图宽高，必须显式跟随封面容器，避免越界铺到正文。
  bundledImage: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
});

export default function AssistantSpaceCover({ mediaAssetId, style, children }: Props) {
  return <View style={style}>
    {mediaAssetId === null
      ? <Image source={DEFAULT_ASSISTANT_SPACE_COVER_SOURCE} style={styles.bundledImage} resizeMode="cover" />
      : <MediaAssetImage mediaAssetId={mediaAssetId} style={StyleSheet.absoluteFillObject} resizeMode="cover" />}
    {children}
  </View>;
}
