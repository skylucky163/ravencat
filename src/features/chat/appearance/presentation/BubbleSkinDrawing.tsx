/** 正式气泡与编辑预览共享同一背景及固定边框布局。 */
import React from 'react';
import type { ReactNode } from 'react';
import type { ViewStyle } from 'react-native';
import { MessageBubbleBackground } from '@platform/device/MessageBubbleBackground';
import { reportBubbleSkinLoadError } from '../application/ChatBubbleSkinRuntime';
import type { BubbleSkinConfig } from '../domain/ChatBubbleSkin';
import type { BubbleDecorationEditing, BubbleDecorationVisual } from './BubbleDecorationLayer';

/** 草稿只覆写外观，仍由真正的消息组件决定排版、正文和头像。 */
export interface BubbleAppearancePreview {
  skin: { uri: string | null; textColor: string; config: BubbleSkinConfig; decorations: readonly BubbleDecorationVisual[] } | null;
  editing?: BubbleDecorationEditing;
  guides?: ReactNode;
}

export function bubbleSkinFrameStyle(config: BubbleSkinConfig): ViewStyle {
  const { padding, slices, scale } = config;
  return { backgroundColor: 'transparent', borderRadius: 0, borderWidth: 0, overflow: 'visible',
    paddingLeft: padding.left, paddingRight: padding.right, paddingTop: padding.top, paddingBottom: padding.bottom,
    minWidth: Math.ceil((slices.left + slices.right) * scale) + 1,
    minHeight: Math.ceil((slices.top + slices.bottom) * scale) + 1 };
}

export function BubbleSkinDrawing({ skin }: { skin: { uri: string; config: BubbleSkinConfig } }) {
  return <MessageBubbleBackground source={{ uri: skin.uri, ...skin.config.slices, scale: skin.config.scale }}
    onLoadError={event => reportBubbleSkinLoadError(event.nativeEvent.uri, event.nativeEvent.message)} />;
}
