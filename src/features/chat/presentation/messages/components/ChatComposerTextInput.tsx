import React, { forwardRef, useLayoutEffect, useRef } from 'react';
import { StyleSheet, type TextInput } from 'react-native';
import { OverflowPasteView } from '@platform/device/OverflowPasteView';
import { AppTextInput } from '@shared/ui';
import type { AppTextInputProps } from '@shared/ui/AppTextInput';
import { CHAT_TEXT_ATTACHMENT_MAX_LENGTH } from '../../../messages/domain/ChatAttachment';
import { useLongPastePreference } from './longPastePreference';

export type OverflowPasteHandler = (text: string | null) => void;

type TextSelection = { start: number; end: number };

// 键盘剪贴板可以像打字一样直接提交文字。只识别单次大段插入，避免低阈值误转换候选词。
const MIN_KEYBOARD_BULK_INSERT_LENGTH = 256;
const LOW_SURROGATE = /[\uDC00-\uDFFF]/;

function findKeyboardBulkInsertion(previous: string, next: string, selection: TextSelection | null): string | null {
  const growth = next.length - previous.length;
  if (selection) {
    const { start, end } = selection;
    const insertedLength = growth + end - start;
    // 已确认的替换区间可以保住粘贴内容与选区恰好相同的前后缀。
    if (insertedLength >= MIN_KEYBOARD_BULK_INSERT_LENGTH && end <= previous.length
      && next.startsWith(previous.slice(0, start)) && next.endsWith(previous.slice(end))) {
      return next.slice(start, start + insertedLength);
    }
  }

  // 输入连接也可以在当前选区外提交文字，例如替换尚未结束的输入法组合区。
  if (growth < MIN_KEYBOARD_BULK_INSERT_LENGTH) return null;
  let start = 0;
  while (start < previous.length && previous[start] === next[start]) start++;
  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (previousEnd > start && previous[previousEnd - 1] === next[nextEnd - 1]) {
    previousEnd--;
    nextEnd--;
  }
  // 相同的半个 emoji 不能被当成保留的上下文。
  if (start > 0 && LOW_SURROGATE.test(next.charAt(start))) start--;
  if (LOW_SURROGATE.test(next.charAt(nextEnd))) nextEnd++;
  return next.slice(start, nextEnd);
}

export const ChatComposerTextInput = forwardRef<TextInput, AppTextInputProps & {
  value: string;
  onChangeText: (text: string) => void;
  onOverflowPaste?: OverflowPasteHandler;
}>(function ChatComposerTextInput({ onOverflowPaste, style, ...props }, ref) {
  const preference = useLongPastePreference();
  const selection = useRef<TextSelection | null>(null);
  const lastAcceptedText = useRef(props.value);
  useLayoutEffect(() => { lastAcceptedText.current = props.value; }, [props.value]);
  if (!preference?.enabled || !onOverflowPaste) {
    return <AppTextInput {...props} ref={ref} style={style} />;
  }
  // 外层占据输入栏原来的位置，原生 TextInput 保持自身的内容测量和增长。
  const { flex, marginRight, ...inputStyle } = StyleSheet.flatten(style) ?? {};
  return (
    <OverflowPasteView style={{ flex, marginRight }} inlineLimit={preference.threshold}
      attachmentLimit={CHAT_TEXT_ATTACHMENT_MAX_LENGTH}
      onOverflowPaste={(event) => onOverflowPaste(event.nativeEvent.text ?? null)}>
      <AppTextInput {...props} ref={ref} style={inputStyle}
        onSelectionChange={(event) => {
          selection.current = event.nativeEvent.selection;
          props.onSelectionChange?.(event);
        }}
        onChangeText={(text) => {
          const insertion = text.length > preference.threshold
            ? findKeyboardBulkInsertion(lastAcceptedText.current, text, selection.current)
            : null;
          if (insertion === null) {
            lastAcceptedText.current = text;
            props.onChangeText(text);
            return;
          }
          // 保留受控 value，让 RN 恢复原草稿；文件只承接这次插入。
          onOverflowPaste(insertion.length <= CHAT_TEXT_ATTACHMENT_MAX_LENGTH ? insertion : null);
        }} />
    </OverflowPasteView>
  );
});
