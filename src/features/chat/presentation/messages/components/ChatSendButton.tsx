/** 各主题共用实心圆发送按钮，输入栏决定圆的直径及触控范围。 */

import React from 'react';
import { TouchableOpacity, View, type StyleProp, type ViewStyle } from 'react-native';
import { ArrowUp, LoaderCircle } from 'lucide-react-native';

import type { PresentationTheme } from '@shared/theme';

/** 箭头与圆的直径比沿用 Moon Kimi 的 16/23：换直径时箭头同比例缩放，圆环厚度才保持一致。 */
const GLYPH_RATIO = 16 / 23;

interface ChatSendButtonProps {
  /** 可见圆的直径；调用方只决定尺寸与间距，不自己画圆。 */
  size: number;
  isDisabled: boolean;
  isPreparing: boolean;
  onPress: () => void;
  /** 不可发送时仍接受点击：用于给出提示或交给上层挡重复提交。 */
  keepPressableWhenDisabled?: boolean;
  style?: StyleProp<ViewStyle>;
  theme: PresentationTheme;
}

export function ChatSendButton({
  size,
  isDisabled,
  isPreparing,
  onPress,
  keepPressableWhenDisabled = false,
  style,
  theme,
}: ChatSendButtonProps) {
  const glyphSize = Math.round(size * GLYPH_RATIO);
  const buttonColor = isDisabled ? theme.colors.icon.disabled : theme.colors.text.primary;
  const glyphColor = theme.colors.icon.inverse;

  return (
    <TouchableOpacity
      style={[
        {
          width: size,
          height: size,
          justifyContent: 'center',
          alignItems: 'center',
        },
        style,
      ]}
      onPress={onPress}
      disabled={isDisabled && !keepPressableWhenDisabled}
      accessibilityRole="button"
      accessibilityLabel="发送"
      accessibilityState={{ disabled: isDisabled, busy: isPreparing }}
    >
      <View style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: buttonColor,
        justifyContent: 'center',
        alignItems: 'center',
      }}>
        {isPreparing ? (
          <LoaderCircle size={glyphSize} strokeWidth={2} color={glyphColor} />
        ) : (
          <ArrowUp size={glyphSize} strokeWidth={2} color={glyphColor} />
        )}
      </View>
    </TouchableOpacity>
  );
}
