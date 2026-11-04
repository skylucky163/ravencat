import React from 'react';
import { View } from 'react-native';
import { useTheme } from '@shared/theme';
import type { BubbleSkinConfig } from '../domain/ChatBubbleSkin';

/** 固定边框换算为实际 dp，在真实消息上标出可拉伸中心或文字安全区。 */
export function BubbleFrameGuides({ config, mode }: { config: BubbleSkinConfig; mode: 'slices' | 'padding' }) {
  const theme = useTheme();
  const insets = config[mode];
  const scale = mode === 'slices' ? config.scale : 1;
  return <View pointerEvents="none" accessible={false} style={{ position: 'absolute', zIndex: 3,
    left: insets.left * scale, right: insets.right * scale, top: insets.top * scale, bottom: insets.bottom * scale,
    borderWidth: 1, borderStyle: 'dashed', borderColor: theme.colors.brand.primary }} />;
}
