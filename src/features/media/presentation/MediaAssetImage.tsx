/** 可见图片拥有资源解析与解码状态；刷新社交事实不会重新加载同一份图片。 */
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, Image, StyleSheet, Text, View,
  type StyleProp, type ViewStyle,
} from 'react-native';
import { resolveMediaAsset } from '../application/MediaAssetRuntime';
import { useTheme } from '@shared/theme';

interface MediaAssetImageUriCache {
  get(mediaAssetId: string): string | undefined;
  set(mediaAssetId: string, localUri: string): void;
  delete(mediaAssetId: string): void;
}

interface Props {
  mediaAssetId: string;
  style: StyleProp<ViewStyle>;
  resizeMode: 'cover' | 'contain';
  color?: string;
  /** 由展示容器持有的地址缓存；组件回收不撤销文件引用，也不持有位图。 */
  uriCache?: MediaAssetImageUriCache;
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', justifyContent: 'center' },
  placeholder: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
});

function ResolvedMediaAssetImage({ mediaAssetId, style, resizeMode, color, uriCache }: Props) {
  const theme = useTheme();
  const [uri, setUri] = useState<string | null>(() => uriCache?.get(mediaAssetId) ?? null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>(() => uri === null ? 'loading' : 'ready');

  useEffect(() => {
    if (uri !== null) return;
    let active = true;
    void resolveMediaAsset(mediaAssetId).then(({ localUri }) => {
      // 解析结果属于容器；即使本实例已被回收，后来挂载的同一资产仍可复用地址。
      uriCache?.set(mediaAssetId, localUri);
      if (active) setUri(localUri);
    }).catch((error: unknown) => {
      if (!active) return;
      console.warn('[Media] 图片资产解析失败：', { mediaAssetId, error });
      setStatus('unavailable');
    });
    return () => { active = false; };
  }, [mediaAssetId, uriCache, uri]);

  return (
    <View style={[styles.container, style]}>
      {uri !== null && status !== 'unavailable' ? (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFillObject}
          resizeMode={resizeMode}
          onLoad={() => setStatus('ready')}
          onError={() => {
            uriCache?.delete(mediaAssetId);
            setStatus('unavailable');
          }}
        />
      ) : null}
      {status === 'loading' ? (
        <View style={styles.placeholder} pointerEvents="none">
          <ActivityIndicator color={color ?? theme.colors.brand.primary} accessibilityLabel="图片加载中" />
        </View>
      ) : null}
      {status === 'unavailable' ? (
        <Text style={{ color: color ?? theme.colors.text.secondary }}>图片不可用</Text>
      ) : null}
    </View>
  );
}

export default function MediaAssetImage(props: Props) {
  // 资产身份变化时同时重置原生 Image 与异步状态，旧资源的回调不能覆盖新图片。
  return <ResolvedMediaAssetImage key={props.mediaAssetId} {...props} />;
}
