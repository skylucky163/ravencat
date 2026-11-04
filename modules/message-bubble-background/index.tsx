/** Android 九宫格背景只绘制，不拥有正文、布局测量或触摸。 */
import React from 'react';
import { requireNativeModule, requireNativeViewManager } from 'expo-modules-core';
import { StyleSheet, type NativeSyntheticEvent, type ViewProps } from 'react-native';

export interface BubbleBackgroundSource {
  uri: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** 一个源像素对应的 dp；不依赖当前设备密度猜测素材比例。 */
  scale: number;
}

interface BackgroundProps extends ViewProps {
  source: BubbleBackgroundSource;
  onLoadError?: (event: NativeSyntheticEvent<{ uri: string; message: string }>) => void;
}

const NativeBackground = requireNativeViewManager<BackgroundProps>('MessageBubbleBackground');
const nativeModule = requireNativeModule<{
  prepare(uri: string): Promise<{ width: number; height: number }>;
}>('MessageBubbleBackground');

export const prepareBubbleImage = (uri: string) => nativeModule.prepare(uri);

export function MessageBubbleBackground({ source, onLoadError }: Pick<BackgroundProps, 'source' | 'onLoadError'>) {
  return <NativeBackground source={source} onLoadError={onLoadError} style={StyleSheet.absoluteFill}
    pointerEvents="none" accessible={false} importantForAccessibility="no-hide-descendants" collapsable={false} />;
}
