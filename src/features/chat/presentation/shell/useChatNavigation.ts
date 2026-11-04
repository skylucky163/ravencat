/** 管理聊天 Shell 子页面与文件预览的导航状态及键盘收起。 */

import { useCallback, useState } from 'react';
import { Keyboard } from 'react-native';

import type { ChatSubScreen, FilePreviewParams } from './chatScreenTypes';

type StandardSubScreen = Exclude<ChatSubScreen, 'filePreview'>;

export function useChatNavigation() {
  const [currentSubScreen, setCurrentSubScreen] = useState<ChatSubScreen | null>(null);
  const [filePreviewParams, setFilePreviewParams] = useState<FilePreviewParams | null>(null);

  const openSubScreen = useCallback((subScreen: StandardSubScreen) => {
    Keyboard.dismiss();
    setCurrentSubScreen(subScreen);
  }, []);

  const handleOpenMenu = useCallback(() => {
    openSubScreen('menu');
  }, [openSubScreen]);

  const handleCloseMenu = useCallback(() => {
    setCurrentSubScreen(null);
  }, []);

  const handleBackToMenu = useCallback(() => {
    setCurrentSubScreen('menu');
  }, []);

  const openFilePreview = useCallback((params: FilePreviewParams) => {
    Keyboard.dismiss();
    setFilePreviewParams(params);
    setCurrentSubScreen('filePreview');
  }, []);

  const closeFilePreview = useCallback(() => {
    setCurrentSubScreen(null);
    setFilePreviewParams(null);
  }, []);

  return {
    currentSubScreen,
    filePreviewParams,
    setCurrentSubScreen,
    handleOpenMenu,
    handleCloseMenu,
    handleBackToMenu,
    openProtocol: () => openSubScreen('protocol'),
    openFilePreview,
    closeFilePreview,
  };
}
