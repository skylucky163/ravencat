/** 单张识别状态统一按开关和显式请求展示，待识别记录不等于正在排队。 */
import React from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import type { Sticker } from '../../domain/Sticker';

interface StatusProps {
  status: Sticker['annotationStatus'];
  automaticRecognitionEnabled: boolean | null;
  manuallyRequested: boolean;
}

export function getStickerAnnotationStatusText({ status, automaticRecognitionEnabled, manuallyRequested }: StatusProps): string | null {
  switch (status) {
    case 'pending':
      return manuallyRequested ? '单张识别排队中' : automaticRecognitionEnabled === null ? '状态加载中'
        : automaticRecognitionEnabled ? '排队中' : '自动识别已关闭';
    case 'processing': return manuallyRequested ? '单张识别中' : '识别中';
    case 'failed': return '识别失败';
    case 'manual_required': return '需手动填写含义';
    case 'ready': return null;
  }
}

export function StickerAnnotationStatus({ style, numberOfLines, ...status }: StatusProps & {
  style?: StyleProp<TextStyle>; numberOfLines?: number;
}) {
  const text = getStickerAnnotationStatusText(status);
  return text ? <Text style={style} numberOfLines={numberOfLines}>{text}</Text> : null;
}
