/** 作品库只展示明确收纳的网页版本；用户或作者 AI 移出不删除原消息或源码。 */
import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import { BookmarkMinus, Globe2, ImagePlus } from 'lucide-react-native';
import { pickCroppedImage } from '@platform/device/DeviceMediaService';
import { ThemedSurface, useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import { NavigationHeader, showAppDialog } from '@shared/ui';
import { chatCodeCoverUri, listChatCodeLibrary, setChatCodeInLibrary, subscribeChatCodeLibraryChanged, updateChatCodeCover } from '../../messages/application/ChatCodePreview';
import type { ChatCodeLibraryItem } from '../../messages/domain/ChatCodePreview';
import { useOpenChatCodePreview } from './components/ChatCodeNavigation';

export default function ChatCodeLibraryScreen({ aiId, onBack }: { aiId: string; onBack: () => void }) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const openPreview = useOpenChatCodePreview();
  const [items, setItems] = useState<ChatCodeLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const [uploading, setUploading] = useState<ReadonlySet<string>>(new Set());
  const generation = useRef(0);
  const active = useRef(false);
  const windowWidth = useWindowDimensions().width;
  // 双列网格固定卡宽，避免奇数项被拉伸占满整行。
  const cardWidth = (windowWidth - 16 * 2 - 12) / 2;
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = await listChatCodeLibrary(aiId);
      if (generation.current === request) setItems(next);
    } catch (failure) {
      if (generation.current === request) setError(failure instanceof Error ? failure.message : '读取作品库失败');
    } finally {
      if (generation.current === request) setLoading(false);
    }
  }, [aiId]);
  useFocusEffect(useCallback(() => {
    active.current = true;
    const unsubscribe = subscribeChatCodeLibraryChanged(() => { void load(); });
    void load();
    return () => { unsubscribe(); active.current = false; ++generation.current; };
  }, [load]));

  const remove = async (item: ChatCodeLibraryItem) => {
    setRemoving(current => new Set(current).add(item.id));
    try {
      await setChatCodeInLibrary(item.id, false);
      if (!active.current) return;
      setItems(current => current.filter(value => value.id !== item.id));
    } catch (failure) {
      if (active.current) showAppDialog({ title: '移出作品库失败', message: failure instanceof Error ? failure.message : '请稍后再试', tone: 'error' });
    } finally {
      setRemoving(current => { const next = new Set(current); next.delete(item.id); return next; });
    }
  };
  const changeCover = async (item: ChatCodeLibraryItem) => {
    setUploading(current => new Set(current).add(item.id));
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        if (active.current) showAppDialog({ title: '需要权限', message: '请允许访问相册以更换作品封面', tone: 'warning' });
        return;
      }
      const asset = await pickCroppedImage({ aspect: [4, 3] });
      if (!asset) return;
      await updateChatCodeCover(item.id, asset.uri, asset.width);
    } catch (failure) {
      if (active.current) showAppDialog({ title: '更换封面失败', message: failure instanceof Error ? failure.message : '请稍后再试', tone: 'error' });
    } finally {
      setUploading(current => { const next = new Set(current); next.delete(item.id); return next; });
    }
  };
  return <SafeAreaView style={styles.page} edges={['top', 'bottom', 'left', 'right']}>
    <NavigationHeader title="作品库" onGoBack={onBack} />
    <Text style={styles.hint}>这里收纳你从这位 AI 的网页预览中选中的作品与版本。</Text>
    {error ? <Pressable accessibilityRole="button" onPress={() => { void load(); }} style={styles.notice}>
      <Text style={styles.meta}>{error} · 点击重试</Text>
    </Pressable> : null}
    <FlatList data={items} keyExtractor={item => item.id} numColumns={2}
      columnWrapperStyle={styles.row} contentContainerStyle={styles.list}
      renderItem={({ item }) => {
        const coverUri = chatCodeCoverUri(item.coverFile);
        return <ThemedSurface variant="card" nativeGlass={false} style={[styles.card, { width: cardWidth }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={`打开作品：${item.title}`} onPress={() => openPreview(item.id)}>
            <View style={styles.cover}>
              {coverUri ? <Image source={{ uri: coverUri }} resizeMode="cover" style={styles.coverImage} />
                : <Globe2 size={30} color={theme.colors.text.secondary} />}
            </View>
            <View style={styles.body}>
              <Text numberOfLines={1} style={styles.title}>{item.title}</Text>
              <Text style={styles.meta}>生成于 {new Date(item.createdAt).toLocaleDateString()}</Text>
            </View>
          </Pressable>
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" accessibilityLabel={`更换作品封面：${item.title}`} disabled={uploading.has(item.id)}
              accessibilityState={{ disabled: uploading.has(item.id), busy: uploading.has(item.id) }} onPress={() => { void changeCover(item); }} style={styles.action}>
              <ImagePlus size={14} color={theme.colors.text.secondary} /><Text style={styles.meta}>{uploading.has(item.id) ? '正在更换' : '换封面'}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`移出作品库：${item.title}`} disabled={removing.has(item.id)}
              accessibilityState={{ disabled: removing.has(item.id) }} onPress={() => { void remove(item); }} style={[styles.action, styles.actionDivider]}>
              <BookmarkMinus size={14} color={theme.colors.text.secondary} /><Text style={styles.meta}>{removing.has(item.id) ? '正在移出' : '移出'}</Text>
            </Pressable>
          </View>
        </ThemedSurface>;
      }}
      ListEmptyComponent={!loading && !error ? <View style={styles.empty}><Globe2 size={34} color={theme.colors.text.secondary} />
        <Text style={styles.emptyTitle}>还没有收纳的作品</Text><Text style={styles.emptyHint}>打开喜欢的网页，点击预览页右上角的书签图标。</Text></View> : null}
      ListFooterComponent={loading ? <ActivityIndicator style={styles.notice} color={theme.colors.brand.primary} /> : null} />
  </SafeAreaView>;
}

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.colors.background.screen },
  hint: { color: theme.colors.text.secondary, fontSize: 12, lineHeight: 19, paddingHorizontal: 20, paddingVertical: 14 },
  list: { paddingHorizontal: 16, paddingBottom: 20, gap: 12 },
  row: { gap: 12 },
  card: { borderRadius: theme.radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border.light, overflow: 'hidden' },
  cover: { aspectRatio: 4 / 3, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.background.screen },
  coverImage: { width: '100%', height: '100%' },
  body: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6, gap: 2 },
  title: { color: theme.colors.text.primary, fontSize: 14, fontWeight: '600' },
  meta: { color: theme.colors.text.secondary, fontSize: 11, lineHeight: 18 },
  actions: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.light },
  action: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 8 },
  actionDivider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.colors.border.light },
  empty: { alignItems: 'center', padding: 32, gap: 14 },
  emptyTitle: { color: theme.colors.text.primary, fontSize: 15, fontWeight: '600' },
  emptyHint: { color: theme.colors.text.secondary, fontSize: 13, lineHeight: 21, textAlign: 'center' },
  notice: { padding: 20 },
});
