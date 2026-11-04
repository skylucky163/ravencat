/** 原生手势滑杆：调用方持有当前值和保存节奏，组件只负责把手势量化为数值。 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useThemedStyles, type PresentationTheme } from '@shared/theme';

export interface SliderProps {
  value: number | null;
  min: number;
  max: number;
  /** 固定刻度内实际可达到的上限，不参与刻度比例计算。 */
  upperLimit?: number;
  step: number;
  onValueChange(value: number): void;
  /** 松手或已激活的手势中断时通知最终值，不在组件内执行持久化。 */
  onSlidingComplete?: (value: number) => void;
  accessibilityLabel: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** 手指导轨内的惰性区间：横向越过它才算调整数值，纵向越过它就把这次触摸让给父容器。 */
const ACTIVATION_OFFSET = 8;

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  touchArea: { height: 44, justifyContent: 'center', marginHorizontal: 12 },
  track: { height: 4, borderRadius: 2, backgroundColor: theme.colors.border.light, overflow: 'hidden' },
  fill: { height: 4, backgroundColor: theme.colors.brand.primary },
  thumb: { position: 'absolute', top: 10, width: 24, height: 24, borderRadius: 12, marginLeft: -12, backgroundColor: theme.colors.brand.primary },
  disabled: { opacity: 0.45 },
});

export default function Slider({ value, min, max, upperLimit = max, step, onValueChange, onSlidingComplete,
  accessibilityLabel, disabled = false, style,
}: SliderProps) {
  const styles = useThemedStyles(createStyles);
  const [trackWidth, setTrackWidth] = useState(0);
  const lastValue = useRef(value ?? min);
  useEffect(() => { lastValue.current = value ?? min; }, [value, min]);

  const quantize = useCallback((next: number) => {
    // 去掉步长计算产生的浮点尾数，避免 0.1 的倍数显示成 0.30000000000000004。
    const snapped = Number((min + Math.round((next - min) / step) * step).toPrecision(12));
    return Math.max(min, Math.min(upperLimit, snapped));
  }, [min, upperLimit, step]);
  const update = useCallback((next: number) => {
    lastValue.current = next;
    onValueChange(next);
    return next;
  }, [onValueChange]);
  const move = useCallback((x: number) => {
    const position = Math.max(0, Math.min(1, x / trackWidth));
    return update(quantize(min + position * (max - min)));
  }, [trackWidth, min, max, quantize, update]);
  // 仲裁交给原生层：横向越过阈值才激活拖动，纵向越过阈值直接失败，把这次触摸让给父 ScrollView。
  // 未激活就结束的手势不会收到 onEnd，因此不会有「凭结束坐标改值」的路径；
  // 激活后才可能中断（success=false），此时提交最后有效值，不回退到调整前的数值。
  const gesture = useMemo(() => {
    const ready = !disabled && trackWidth > 0;
    const drag = Gesture.Pan()
      .enabled(ready)
      .activeOffsetX([-ACTIVATION_OFFSET, ACTIVATION_OFFSET])
      .failOffsetY([-ACTIVATION_OFFSET, ACTIVATION_OFFSET])
      .runOnJS(true)
      .onStart((event) => { move(event.x); })
      .onUpdate((event) => { move(event.x); })
      .onEnd((event, success) => {
        // 松开采样终点；系统中断提交最后有效值，不回退到调整前的数值。
        // 先算出终值再上报，避免「有没有完成回调」反过来决定终点坐标是否生效。
        const finalValue = success ? move(event.x) : lastValue.current;
        onSlidingComplete?.(finalValue);
      });
    // 轻点轨道仍然直接跳到该位置；手指移动超过同一阈值即失败，不与拖动和父滚动争抢。
    const tap = Gesture.Tap()
      .enabled(ready)
      .maxDistance(ACTIVATION_OFFSET)
      .runOnJS(true)
      .onEnd((event, success) => {
        if (!success) return;
        // 先算出终值再上报：缺少完成回调时点击也要落到数值上。
        const next = move(event.x);
        onSlidingComplete?.(next);
      });
    return Gesture.Race(drag, tap);
  }, [disabled, trackWidth, move, onSlidingComplete]);
  const percentage = value === null ? null : (value - min) / (max - min) * 100;

  return (
    <GestureDetector gesture={gesture}>
      <View
        style={[styles.touchArea, disabled && styles.disabled, style]}
        onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={value === null ? { min, max: upperLimit, text: '未设置' } : { min, max: upperLimit, now: value }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        accessibilityState={{ disabled }}
        onAccessibilityAction={(event) => {
          if (disabled) return;
          const next = update(quantize(lastValue.current + (event.nativeEvent.actionName === 'increment' ? step : -step)));
          onSlidingComplete?.(next);
        }}
      >
        <View pointerEvents="none" style={styles.track}>
          {value !== null && <View style={[styles.fill, { width: `${percentage}%` }]} />}
        </View>
        {value !== null && <View pointerEvents="none" style={[styles.thumb, { left: `${percentage}%` }]} />}
      </View>
    </GestureDetector>
  );
}
