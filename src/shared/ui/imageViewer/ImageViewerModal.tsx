/**
 * 统一的全屏看图弹窗：单击退出、双击缩放、多图左右翻页。
 * 业务操作（如时刻的图片描述管理）由调用方通过 footer 注入，弹窗只负责媒体与手势。
 */
import React, { useState } from 'react';
import {
  ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View,
  useWindowDimensions, type ImageSourcePropType, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { getThemeById } from '@shared/theme';
import ZoomableImage from './ZoomableImage';

/** null 仍在解析；'unavailable' 表示媒体身份已解析失败。 */
export type ImageViewerSource = ImageSourcePropType | null | 'unavailable';

export interface ImageViewerModalProps {
  visible: boolean;
  sources: readonly ImageViewerSource[];
  initialIndex?: number;
  onClose: () => void;
  /** 多图页码；默认仅在多图时显示。 */
  showPager?: boolean;
  /** 图片下方的业务操作区，index 为当前页。 */
  footer?: (index: number) => React.ReactNode;
}

type ViewerContentProps = Omit<ImageViewerModalProps, 'visible'>;

function renderPage(source: ImageViewerSource, onClose: () => void) {
  if (source === null) {
    return <View style={styles.single}><ActivityIndicator color={viewerTheme.colors.text.primary} /></View>;
  }
  if (source === 'unavailable') {
    return <View style={styles.single}><Text style={styles.error}>图片不可用</Text></View>;
  }
  return <ZoomableImage source={source} onSingleTap={onClose} />;
}

function ViewerContent({ sources, initialIndex = 0, onClose, showPager, footer }: ViewerContentProps) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [index, setIndex] = useState(initialIndex);
  const current = Math.min(index, Math.max(0, sources.length - 1));
  const pagerVisible = (showPager ?? sources.length > 1) && sources.length > 1;

  const onScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setIndex(Math.max(0, Math.round(event.nativeEvent.contentOffset.x / width)));
  };

  return (
    <GestureHandlerRootView style={styles.root}>
      {sources.length > 1 ? (
        <FlatList
          data={[...sources]}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          keyExtractor={(_item, pageIndex) => String(pageIndex)}
          initialScrollIndex={initialIndex}
          getItemLayout={(_data, pageIndex) => ({ length: width, offset: width * pageIndex, index: pageIndex })}
          onMomentumScrollEnd={onScrollEnd}
          renderItem={({ item }) => (
            <View style={[styles.page, { width, height }]}>
              {renderPage(item, onClose)}
            </View>
          )}
        />
      ) : sources.length === 1 ? (
        renderPage(sources[0], onClose)
      ) : null}

      <View pointerEvents="box-none" style={[styles.controls, { top: insets.top + 8, right: insets.right + 16 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭图片预览"
          hitSlop={8}
          style={styles.closeButton}
          onPress={onClose}
        >
          <X size={24} color={viewerTheme.colors.text.primary} />
        </Pressable>
      </View>

      <View pointerEvents="box-none" style={[styles.footer, { bottom: insets.bottom + 16 }]}>
        {pagerVisible ? <Text style={styles.pager}>{current + 1} / {sources.length}</Text> : null}
        {footer?.(current)}
      </View>
    </GestureHandlerRootView>
  );
}

export default function ImageViewerModal({ visible, ...props }: ImageViewerModalProps) {
  // 关闭即销毁缩放状态，下次打开从原始比例开始。
  return (
    <Modal
      visible={visible}
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      hardwareAccelerated
      onRequestClose={props.onClose}
    >
      {visible ? <ViewerContent key={`${props.initialIndex ?? 0}:${props.sources.length}`} {...props} /> : null}
    </Modal>
  );
}

// 看图使用共享深色主题的黑底白字，不随页面配色改变对比度。
const viewerTheme = getThemeById('default-dark');
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: viewerTheme.colors.background.app },
  page: { alignItems: 'center', justifyContent: 'center' },
  single: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  controls: { position: 'absolute' },
  closeButton: {
    width: 44,
    height: 44,
    borderRadius: viewerTheme.radius.round,
    backgroundColor: viewerTheme.effects.overlay.dim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  pager: { color: viewerTheme.colors.text.primary, marginBottom: 12 },
  error: { color: viewerTheme.colors.text.primary, fontSize: 14 },
});
