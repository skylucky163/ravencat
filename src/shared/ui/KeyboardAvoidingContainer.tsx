/** 同一个原生窗口内只由一处容器负责避让；输入控件不移动页面。 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, StyleSheet, View, type LayoutChangeEvent, type ViewProps } from 'react-native';

export interface KeyboardAvoidingContainerProps extends ViewProps {
  enabled?: boolean;
  keyboardVerticalOffset?: number;
  /** 铺满独立原生窗口时直接使用屏幕键盘顶边，不读取会被系统平移污染的窗口原点。 */
  fillsNativeWindow?: boolean;
}

export default function KeyboardAvoidingContainer({
  enabled = true,
  keyboardVerticalOffset = 0,
  fillsNativeWindow = false,
  style,
  onLayout,
  ...props
}: KeyboardAvoidingContainerProps) {
  const viewRef = useRef<View>(null);
  const keyboardFrameRef = useRef(Keyboard.metrics());
  const measurementState = useRef({ revision: 0 }).current;
  const [availableHeight, setAvailableHeight] = useState<number | null>(null);
  const setNativeView = useCallback((view: View | null) => {
    // 原生窗口可先于 React effect 退场；ref 的接入/脱离就是测量的有效期边界。
    measurementState.revision++;
    viewRef.current = view;
  }, [measurementState]);

  const updateKeyboardBoundary = useCallback(() => {
    const revision = ++measurementState.revision;
    const keyboard = keyboardFrameRef.current;
    if (!enabled || !keyboard) {
      setAvailableHeight(null);
      return;
    }
    // 容器底边直接落在键盘顶边；原生窗口是否同时缩放不再参与第二次高度计算。
    if (fillsNativeWindow) {
      setAvailableHeight(Math.max(0, keyboard.screenY - keyboardVerticalOffset));
      return;
    }
    const view = viewRef.current;
    if (view === null) return;
    view.measureInWindow((_x, y) => {
      if (revision !== measurementState.revision) return;
      setAvailableHeight(Math.max(0, keyboard.screenY - y - keyboardVerticalOffset));
    });
  }, [enabled, fillsNativeWindow, keyboardVerticalOffset, measurementState]);

  useEffect(() => {
    keyboardFrameRef.current = Keyboard.metrics();
    updateKeyboardBoundary();
    if (!enabled) return;
    const show = Keyboard.addListener('keyboardDidShow', (event) => {
      keyboardFrameRef.current = event.endCoordinates;
      updateKeyboardBoundary();
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      keyboardFrameRef.current = undefined;
      updateKeyboardBoundary();
    });
    return () => {
      // 原生测量可能晚于隐藏、窗口切换或卸载返回，旧结果不能恢复已清除的留白。
      measurementState.revision++;
      show.remove();
      hide.remove();
    };
  }, [enabled, updateKeyboardBoundary, measurementState]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    updateKeyboardBoundary();
    onLayout?.(event);
  }, [onLayout, updateKeyboardBoundary]);

  return <View {...props} ref={setNativeView} collapsable={false} onLayout={handleLayout}
    style={StyleSheet.compose(style, enabled && availableHeight !== null ? { height: availableHeight, flex: 0 } : null)} />;
}
