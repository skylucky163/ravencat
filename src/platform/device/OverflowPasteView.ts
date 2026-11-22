import { requireNativeViewManager } from 'expo-modules-core';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';

export const OverflowPasteView = requireNativeViewManager<ViewProps & {
  inlineLimit: number;
  attachmentLimit: number;
  onOverflowPaste: (event: NativeSyntheticEvent<{ text?: string }>) => void;
}>('NativeTextSelection', 'OverflowPasteView');
