/** 像素场复用已安装的 WebView；原图、计时和业务请求始终留在 RN。 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { processColor, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import { useTheme } from '@shared/theme';
import { createImageGenerationPixelDocument } from './imageGenerationPixelDocument';

interface Props {
  reveal: boolean;
  reducedMotion: boolean;
  hasPreview: boolean;
  onFinished(): void;
}

export default function ImageGenerationPixelEffect({ reveal, reducedMotion, hasPreview, onFinished }: Props) {
  const theme = useTheme();
  const background = processColor(theme.colors.surface.input) as number;
  const dark = theme.mode === 'dark';
  const document = useMemo(() => ({ html: createImageGenerationPixelDocument(dark, reducedMotion, [
    (background >> 16 & 255) / 255, (background >> 8 & 255) / 255, (background & 255) / 255,
  ]) }), [background, dark, reducedMotion]);
  const web = useRef<WebView>(null);
  const [readyDocument, setReadyDocument] = useState<typeof document | null>(null);
  useEffect(() => {
    if (readyDocument === document && reveal) web.current!.injectJavaScript('window.revealImage(); true;');
  }, [document, readyDocument, reveal]);
  const failed = () => { console.warn('[ImageGeneration] 本地像素动效不可用'); onFinished(); };

  return <WebView ref={web} source={document} style={[styles.web, hasPreview && styles.preview]}
    originWhitelist={['*']} onShouldStartLoadWithRequest={request => request.url === 'about:blank'}
    javaScriptEnabled domStorageEnabled={false} scrollEnabled={false} showsVerticalScrollIndicator={false}
    allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
    mixedContentMode="never" thirdPartyCookiesEnabled={false} geolocationEnabled={false}
    javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows onOpenWindow={() => {}}
    onMessage={event => {
      // WebView 是消息边界，只接受这份本地文档的三个绘制事件。
      switch (event.nativeEvent.data) {
        case 'ready': setReadyDocument(document); break;
        case 'revealed': onFinished(); break;
        case 'failed': failed(); break;
      }
    }} onError={failed} onRenderProcessGone={failed} />;
}

const styles = StyleSheet.create({
  web: { ...StyleSheet.absoluteFillObject, backgroundColor: 'transparent' },
  preview: { opacity: 0.35 },
});
