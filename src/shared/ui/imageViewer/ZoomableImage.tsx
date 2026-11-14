/** 图片按视口完整显示，缩放围绕手指中心，拖动限制在真实图片边缘。 */
import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View, type ImageSourcePropType, type ImageStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { cancelAnimation, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { getThemeById } from '@shared/theme';
import { clampPreviewOffset, fitPreviewImage } from './imagePreviewGeometry';

function createPreviewTap() {
  return Gesture.Tap()
    .maxDistance(8)
    .maxDuration(250)
    .onTouchesDown((event, manager) => {
      // 整段触摸只要出现第二根手指，就不再具有点击退出或双击缩放的资格。
      if (event.numberOfTouches > 1) manager.fail();
    });
}

interface ZoomableImageProps {
  source: ImageSourcePropType;
  /** 单击图片；双击与多指手势优先，未形成有效点击时不触发。 */
  onSingleTap: () => void;
}

export default function ZoomableImage({ source, onSingleTap }: ZoomableImageProps) {
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const fitted = imageSize
    ? fitPreviewImage(imageSize.width, imageSize.height, viewport.width, viewport.height)
    : viewport;
  const scale = useSharedValue(1);
  const offsetX = useSharedValue(0);
  const offsetY = useSharedValue(0);
  const startScale = useSharedValue(1);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const focalX = useSharedValue(0);
  const focalY = useSharedValue(0);

  const pinch = Gesture.Pinch()
    .enabled(imageSize !== null)
    .onStart((event) => {
      cancelAnimation(scale);
      cancelAnimation(offsetX);
      cancelAnimation(offsetY);
      startScale.value = scale.value;
      startX.value = offsetX.value;
      startY.value = offsetY.value;
      focalX.value = event.focalX - viewport.width / 2;
      focalY.value = event.focalY - viewport.height / 2;
    })
    .onUpdate((event) => {
      const nextScale = Math.max(1, Math.min(6, startScale.value * event.scale));
      const ratio = nextScale / startScale.value;
      scale.value = nextScale;
      offsetX.value = clampPreviewOffset(
        event.focalX - viewport.width / 2 - (focalX.value - startX.value) * ratio,
        fitted.width, viewport.width, nextScale,
      );
      offsetY.value = clampPreviewOffset(
        event.focalY - viewport.height / 2 - (focalY.value - startY.value) * ratio,
        fitted.height, viewport.height, nextScale,
      );
    });
  const pan = Gesture.Pan()
    .enabled(imageSize !== null)
    .maxPointers(1)
    .onStart(() => {
      cancelAnimation(scale);
      cancelAnimation(offsetX);
      cancelAnimation(offsetY);
      startX.value = offsetX.value;
      startY.value = offsetY.value;
    })
    .onUpdate((event) => {
      offsetX.value = clampPreviewOffset(startX.value + event.translationX, fitted.width, viewport.width, scale.value);
      offsetY.value = clampPreviewOffset(startY.value + event.translationY, fitted.height, viewport.height, scale.value);
    });
  // 工厂创建的手势无法被当前插件自动识别，点击回调显式声明 UI 线程归属。
  const doubleTap = createPreviewTap()
    .enabled(imageSize !== null)
    .numberOfTaps(2)
    .maxDelay(250)
    .onEnd((event, success) => {
      'worklet';
      if (!success) return;
      const nextScale = scale.value > 1 ? 1 : 3;
      offsetX.value = withTiming(clampPreviewOffset(
        -(event.x - viewport.width / 2) * (nextScale - 1), fitted.width, viewport.width, nextScale,
      ));
      offsetY.value = withTiming(clampPreviewOffset(
        -(event.y - viewport.height / 2) * (nextScale - 1), fitted.height, viewport.height, nextScale,
      ));
      scale.value = withTiming(nextScale);
    });
  const singleTap = createPreviewTap().onEnd((_event, success) => {
    'worklet';
    if (success) runOnJS(onSingleTap)();
  });
  // 缩放／拖动一旦激活，原生仲裁会取消点击；单击等待双击判定后才退出。
  const gesture = Gesture.Race(
    Gesture.Simultaneous(pinch, pan),
    Gesture.Exclusive(doubleTap, singleTap),
  );
  const animatedStyle = useAnimatedStyle<ImageStyle>(() => ({
    transform: [
      { translateX: offsetX.value },
      { translateY: offsetY.value },
      { scale: scale.value },
    ] as const,
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        style={styles.viewport}
        onLayout={({ nativeEvent: { layout } }) => {
          setViewport({ width: layout.width, height: layout.height });
          scale.value = 1;
          offsetX.value = 0;
          offsetY.value = 0;
        }}
      >
        <Animated.Image
          source={source}
          resizeMode="contain"
          style={[{ width: fitted.width, height: fitted.height }, animatedStyle]}
          onLoad={({ nativeEvent }) => {
            // 解码后的尺寸属于媒体边界；内置资源也可能不带宽高，缺一项就按损坏处理。
            const decoded = nativeEvent.source;
            if (!(decoded.width > 0) || !(decoded.height > 0)) {
              setFailed(true);
              return;
            }
            setImageSize({ width: decoded.width, height: decoded.height });
          }}
          onError={() => setFailed(true)}
        />
        {!imageSize && !failed ? <ActivityIndicator style={styles.state} color={viewerTheme.colors.text.primary} /> : null}
        {failed ? <View pointerEvents="none" style={styles.state}><Text style={styles.error}>图片加载失败</Text></View> : null}
      </View>
    </GestureDetector>
  );
}

const viewerTheme = getThemeById('default-dark');
const styles = StyleSheet.create({
  viewport: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  state: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  error: { color: viewerTheme.colors.text.primary, fontSize: 14 },
});
