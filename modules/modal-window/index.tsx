/** 只能挂在独立 RN Modal 的全屏根内容中；窗口及 IME 高度由 Android 原生层提交给 Fabric。 */
import React from 'react';
import { requireNativeViewManager } from 'expo-modules-core';
import { StyleSheet, type ViewProps } from 'react-native';

const NativeModalWindow = requireNativeViewManager<ViewProps>('ModalWindow');
const styles = StyleSheet.create({ window: { alignSelf: 'stretch', flexGrow: 0, flexShrink: 0 } });

export function ModalWindow({ style, ...props }: ViewProps) {
  return <NativeModalWindow {...props} style={[styles.window, style]} collapsable={false} />;
}
