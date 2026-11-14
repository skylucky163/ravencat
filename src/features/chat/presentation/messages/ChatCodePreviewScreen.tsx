/** 页面只运行当前打开的网页；源码视图与预览共用同一份持久快照。 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { captureRef } from 'react-native-view-shot';
import { BookmarkCheck, BookmarkPlus, Code2, Globe2 } from 'lucide-react-native';
import { useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import { NavigationHeader, showAppDialog } from '@shared/ui';
import { getChatCodePreview, setChatCodeInLibrary } from '../../messages/application/ChatCodePreview';
import type { ChatCodePreview } from '../../messages/domain/ChatCodePreview';
import ChatCodeSourceView from './ChatCodeSourceView';
import { allowChatCodePreviewNavigation, buildChatCodePreviewDocument } from './chatCodePreviewDocument';

export default function ChatCodePreviewScreen({ previewId, onBack }: { previewId: string; onBack: () => void }) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const [state, setState] = useState<{ id: string; preview: ChatCodePreview | null; error: string | null }>({ id: '', preview: null, error: null });
  const [sourceVisible, setSourceVisible] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [webError, setWebError] = useState<string | null>(null);
  const [savingLibrary, setSavingLibrary] = useState(false);
  const webContainerRef = useRef<View>(null);
  useEffect(() => {
    let active = true;
    setSourceVisible(false);
    setWebError(null);
    void getChatCodePreview(previewId).then(preview => {
      if (active) setState({ id: previewId, preview, error: preview ? null : '这份代码已不存在' });
    }).catch((error: unknown) => {
      if (active) setState({ id: previewId, preview: null, error: error instanceof Error ? error.message : '读取代码失败' });
    });
    return () => { active = false; };
  }, [previewId]);
  const preview = state.id === previewId ? state.preview : null;
  // 收纳只改变书架关系，不能让 WebView 收到新的 source 对象而重载正在操作的网页。
  const htmlSource = preview?.canRender ? preview.source : null;
  const document = useMemo(() => htmlSource === null ? undefined : { html: buildChatCodePreviewDocument(htmlSource) }, [htmlSource]);
  const showingSource = sourceVisible || (preview !== null && !preview.canRender);
  const SourceIcon = showingSource ? Globe2 : Code2;
  const LibraryIcon = preview?.inLibrary ? BookmarkCheck : BookmarkPlus;
  const changeLibrary = async (included: boolean) => {
    setSavingLibrary(true);
    try {
      // 收纳瞬间给作品拍封面；正在看源码时 WebView 不可见，截不到就跳过。
      let cover: string | null = null;
      let captureFailure: string | null = null;
      if (included && !showingSource && webContainerRef.current) {
        try { cover = await captureRef(webContainerRef, { format: 'jpg', quality: 0.8, result: 'tmpfile' }); }
        catch (error) {
          captureFailure = error instanceof Error ? error.message : String(error);
          console.warn('[Chat] 作品封面截图失败：', error);
        }
      }
      await setChatCodeInLibrary(previewId, included, cover);
      // 原生截图模块缺失（例如安装包未重建）时，收纳仍成功，但失败原因必须可见。
      if (captureFailure !== null) showAppDialog({ title: '封面截图失败',
        message: `${captureFailure}\n作品已收纳，可在作品库里手动上传封面。`, tone: 'warning' });
      setState(current => current.id === previewId && current.preview
        ? { ...current, preview: { ...current.preview, inLibrary: included } } : current);
    } catch (error) {
      showAppDialog({ title: included ? '加入作品库失败' : '移出作品库失败', message: error instanceof Error ? error.message : '无法更新作品库', tone: 'error' });
    } finally {
      setSavingLibrary(false);
    }
  };
  return <View style={[styles.page, { paddingBottom: insets.bottom }]}>
    <NavigationHeader includeTopInset sideWidth={88} title={showingSource ? '查看源码' : preview?.title ?? '网页预览'} onGoBack={onBack}
      rightButton={preview?.canRender ? <View style={styles.headerActions}>
        <Pressable accessibilityRole="button" accessibilityLabel={showingSource ? '返回网页' : '查看源码'}
          onPress={() => setSourceVisible(value => !value)} style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}>
          <SourceIcon size={22} color={theme.colors.brand.primary} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={preview.inLibrary ? '移出作品库' : '加入作品库'}
          accessibilityHint={preview.inLibrary ? '只移出作品库，消息和源码仍保留' : '收纳当前网页版本'}
          accessibilityState={{ selected: preview.inLibrary, disabled: savingLibrary, busy: savingLibrary }} disabled={savingLibrary}
          onPress={() => { void changeLibrary(!preview.inLibrary); }}
          style={({ pressed }) => [styles.headerButton, pressed && styles.pressed, savingLibrary && styles.disabled]}>
          <LibraryIcon size={22} color={preview.inLibrary ? theme.colors.brand.primary : theme.colors.text.secondary} />
        </Pressable>
      </View> : undefined} />
    {!preview ? <View style={styles.center}>{state.id === previewId && state.error
      ? <Text style={styles.error}>{state.error}</Text> : <ActivityIndicator color={theme.colors.brand.primary} />}</View> : <>
      {document && focused && <View ref={webContainerRef} collapsable={false} style={[styles.web, showingSource && styles.hidden]}>
        {webError ? <View style={styles.center}><Text style={styles.error}>{webError}</Text>
          <Pressable onPress={() => { setWebError(null); setReloadKey(value => value + 1); }}><Text style={styles.action}>重新加载</Text></Pressable></View>
          : <WebView key={reloadKey} source={document} style={styles.web} originWhitelist={['*']}
            onShouldStartLoadWithRequest={request => allowChatCodePreviewNavigation(request.url)}
            javaScriptEnabled domStorageEnabled={false} incognito cacheEnabled={false}
            allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
            mixedContentMode="never" thirdPartyCookiesEnabled={false} geolocationEnabled={false}
            javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows onOpenWindow={() => {}}
            onError={event => setWebError(event.nativeEvent.description)}
            onRenderProcessGone={() => setWebError('网页运行已停止，可以重新加载')}
          />}
      </View>}
      {showingSource && <ChatCodeSourceView source={preview.source} language={preview.language} />}
    </>}
  </View>;
}

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.colors.background.screen },
  web: { flex: 1, backgroundColor: '#ffffff' },
  hidden: { display: 'none' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  error: { color: theme.colors.text.secondary, textAlign: 'center', fontSize: 14, lineHeight: 22 },
  action: { color: theme.colors.brand.primary, fontSize: 13 },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  headerButton: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.45 },
});
