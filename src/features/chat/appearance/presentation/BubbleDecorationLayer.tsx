/** 装饰独立于九宫格，按气泡实际尺寸收敛；正式消息不参与命中，只有预览允许拖动。 */
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Image, StyleSheet, View, type ImageStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useTheme } from '@shared/theme';
import type { BubbleDecoration, BubbleDecorationConfig } from '../domain/ChatBubbleSkin';
import { reportBubbleSkinLoadError } from '../application/ChatBubbleSkinRuntime';

export type BubbleDecorationVisual = Pick<BubbleDecoration, 'id' | 'width' | 'height' | 'config'> & { uri: string | null };
export interface BubbleDecorationEditing {
  selectedId: string | null; disabled: boolean; onSelect: (id: string) => void;
  onChange: (id: string, config: BubbleDecorationConfig) => void;
}
interface BubbleBounds { width: number; height: number }

/** size 是长消息上的最大尺寸，负偏移随实际显示比例一起收敛，不改变保存的创作参数。 */
function decorationGeometry({ width, height, config }: { width: number; height: number; config: BubbleDecorationConfig }, bounds: BubbleBounds) {
  const requestedRatio = config.size / Math.max(width, height);
  const ratio = Math.min(requestedRatio, bounds.width / width, bounds.height / height);
  const scale = ratio / requestedRatio;
  return { width: width * ratio, height: height * ratio, scale, offsetX: config.offsetX * scale, offsetY: config.offsetY * scale };
}

export function bubbleDecorationStyle(decoration: { width: number; height: number; config: BubbleDecorationConfig }, bounds: BubbleBounds): ImageStyle {
  const { width, height, config } = decoration;
  const geometry = decorationGeometry({ width, height, config }, bounds);
  return { position: 'absolute', width: geometry.width, height: geometry.height,
    ...(config.anchor.endsWith('left') ? { left: geometry.offsetX } : { right: geometry.offsetX }),
    ...(config.anchor.startsWith('top') ? { top: geometry.offsetY } : { bottom: geometry.offsetY }) };
}

export interface BubbleDecorationOverflow { top: number; bottom: number }

/** 只预留垂直占位，既保留破形落点，也不让横向留白反过来缩窄气泡。 */
export function bubbleDecorationOverflow(decorations: readonly BubbleDecorationVisual[], bounds: BubbleBounds): BubbleDecorationOverflow {
  let top = 0;
  let bottom = 0;
  for (const decoration of decorations) {
    if (!decoration.uri) continue;
    const geometry = decorationGeometry(decoration, bounds);
    const y = decoration.config.anchor.startsWith('top') ? geometry.offsetY : bounds.height - geometry.offsetY - geometry.height;
    top = Math.max(top, -y);
    bottom = Math.max(bottom, y + geometry.height - bounds.height);
  }
  return { top: Math.ceil(top), bottom: Math.ceil(bottom) };
}

/** 最近角只决定长短消息中的跟随基准，换算偏移时保留落点和破形范围。 */
function placeBubbleDecoration(decoration: BubbleDecorationVisual, bounds: BubbleBounds, x: number, y: number): BubbleDecorationConfig {
  const { config } = decoration;
  const { width: w, height: h, scale, offsetX, offsetY } = decorationGeometry(decoration, bounds);
  const left = (config.anchor.endsWith('left') ? offsetX : bounds.width - offsetX - w) + x;
  const top = (config.anchor.startsWith('top') ? offsetY : bounds.height - offsetY - h) + y;
  const followsLeft = left + w / 2 < bounds.width / 2;
  const followsTop = top + h / 2 < bounds.height / 2;
  return { ...config, anchor: `${followsTop ? 'top' : 'bottom'}-${followsLeft ? 'left' : 'right'}`,
    offsetX: (followsLeft ? left : bounds.width - left - w) / scale,
    offsetY: (followsTop ? top : bounds.height - top - h) / scale };
}

function DraggableDecoration({ decoration, bounds, selected, disabled, onSelect, onChange }: {
  decoration: BubbleDecorationVisual & { uri: string }; selected: boolean; disabled: boolean;
  bounds: BubbleBounds;
  onSelect: (id: string) => void; onChange: (id: string, config: BubbleDecorationConfig) => void;
}) {
  const theme = useTheme();
  const [translation, setTranslation] = useState({ x: 0, y: 0 });
  const latest = useRef({ decoration, bounds, onSelect, onChange });
  latest.current = { decoration, bounds, onSelect, onChange };
  const start = useRef(decoration);
  const ready = !disabled && bounds.width > 0 && bounds.height > 0;
  const gesture = useMemo(() => Gesture.Pan().enabled(ready).minDistance(0).runOnJS(true)
    .onStart(() => { start.current = latest.current.decoration; latest.current.onSelect(start.current.id); })
    .onUpdate(event => { setTranslation({ x: event.translationX, y: event.translationY }); })
    .onEnd((event, success) => {
      if (success && (event.translationX !== 0 || event.translationY !== 0)) {
        latest.current.onChange(start.current.id, placeBubbleDecoration(start.current, latest.current.bounds, event.translationX, event.translationY));
      }
    })
    .onFinalize(() => { setTranslation({ x: 0, y: 0 }); }), [ready]);
  return <GestureDetector gesture={gesture}>
    <Image source={{ uri: decoration.uri }} resizeMode="contain" fadeDuration={0}
      style={[bubbleDecorationStyle(decoration, bounds), { transform: [{ translateX: translation.x }, { translateY: translation.y }] },
        selected && { borderWidth: 1, borderColor: theme.colors.brand.primary }]}
      accessibilityLabel="拖动装饰，自由放置并跟随最近的角" />
  </GestureDetector>;
}

export function BubbleDecorationLayer({ decorations, editing, onOverflowChange }: {
  decorations: readonly BubbleDecorationVisual[];
  editing?: BubbleDecorationEditing;
  onOverflowChange?: (overflow: BubbleDecorationOverflow) => void;
}) {
  const layer = useRef<View>(null);
  const [bounds, setBounds] = useState<BubbleBounds | null>(null);
  const measure = () => {
    if (decorations.length === 0) return;
    layer.current!.measure((_x, _y, width, height) => {
      setBounds(before => before?.width === width && before.height === height ? before : { width, height });
      onOverflowChange?.(bubbleDecorationOverflow(decorations, { width, height }));
    });
  };
  // Fabric 在布局阶段同步测量；占位与装饰在首次绘制前一起就绪，避免消息出现后才补高。
  // 每次提交读取当前节点，覆盖列表回收和正文增长；迟到的 onLayout 也不采用旧事件里的尺寸。
  useLayoutEffect(measure);
  if (decorations.length === 0) return null;
  return <View pointerEvents={editing ? 'box-none' : 'none'} accessible={false}
    ref={layer} collapsable={false} onLayout={measure}
    style={[StyleSheet.absoluteFill, { zIndex: 2, overflow: 'visible' }]}>
    {bounds && decorations.map(decoration => !decoration.uri ? null : editing
      ? <DraggableDecoration key={decoration.id} decoration={{ ...decoration, uri: decoration.uri }}
        bounds={bounds} selected={editing.selectedId === decoration.id} disabled={editing.disabled} onSelect={editing.onSelect} onChange={editing.onChange} />
      : <Image key={decoration.id} accessible={false} source={{ uri: decoration.uri }}
        resizeMode="contain" fadeDuration={0} style={bubbleDecorationStyle(decoration, bounds)}
        onError={() => reportBubbleSkinLoadError(decoration.uri!, '小装饰图片无法读取，请重新导入')} />)}
  </View>;
}
