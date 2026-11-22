import { ToastAndroid } from 'react-native';
import { copyTextToClipboard } from '@platform/device';
import { showAppDialog } from '@shared/ui';
import { readChatCodeBlock } from '../../../messages/domain/ChatCodeBlock';

export function copyChatMessageText(text: string): void {
  try {
    copyTextToClipboard(readChatCodeBlock(text)?.source ?? text);
    ToastAndroid.show('复制成功', ToastAndroid.SHORT);
  } catch (error) {
    showAppDialog({ title: '复制失败', message: error instanceof Error ? error.message : '无法写入剪贴板', tone: 'error' });
  }
}
