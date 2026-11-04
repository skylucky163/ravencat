/** 通用底部弹窗组件。 */

import type { ReactNode } from 'react';
import type { ViewStyle } from 'react-native';
import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  TouchableWithoutFeedback,
  Dimensions,
} from 'react-native';
import { useTheme, useThemedStyles, ThemedSurface } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import KeyboardAvoidingContainer from './KeyboardAvoidingContainer';

const SCREEN_HEIGHT = Dimensions.get('window').height;

export interface ModalSheetProps {
  visible: boolean;
  onClose: () => void;
  /** 入场动画完成且窗口可交互后调用，供表单请求焦点；内容更新不会重新触发。 */
  onOpened?: () => void;
  title?: string;
  titleAccessory?: ReactNode;
  children: ReactNode;
  style?: ViewStyle;
  /** 弹层浮在深色场景上（玻璃底透出深色背景）时，标题与关闭改用亮色。 */
  onDark?: boolean;
}

const createStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.surface.overlay,
    },
    windowContent: {
      flex: 1,
      justifyContent: 'flex-end',
    },
    sheet: {
      borderTopLeftRadius: theme.components.modalSheet.radius,
      borderTopRightRadius: theme.components.modalSheet.radius,
      paddingBottom: 32,
      maxHeight: theme.components.modalSheet.maxHeight,
      overflow: 'hidden',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.lg,
      borderBottomWidth: 0.5,
      borderBottomColor: theme.colors.border.light,
    },
    titleGroup: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
    title: {
      ...theme.typography.title,
      color: theme.colors.text.primary,
      flexShrink: 1,
    },
    titleOnDark: { color: theme.colors.text.inverse },
    closeBtn: {
      padding: theme.spacing.sm,
      marginRight: -theme.spacing.sm,
    },
    closeText: {
      ...theme.typography.body,
      color: theme.colors.text.secondary,
    },
    closeTextOnDark: { color: theme.colors.text.inverse, opacity: 0.65 },
  });

export default function ModalSheet({
  visible,
  onClose,
  onOpened,
  title,
  titleAccessory,
  children,
  style,
  onDark = false,
}: ModalSheetProps) {
  const [internalVisible, setInternalVisible] = useState(visible);
  const [windowShown, setWindowShown] = useState(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (visible) {
      setInternalVisible(true);
      // 等原生 Modal 窗口显示后再入场；完成回调可据此安全请求键盘焦点。
      if (!windowShown) return;
      const animation = Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
      ]);
      animation.start(({ finished }) => {
        if (finished) onOpenedRef.current?.();
      });
      return () => animation.stop();
    } else if (windowShown) {
      const animation = Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: SCREEN_HEIGHT,
          duration: 250,
          useNativeDriver: true,
        }),
      ]);
      animation.start(({ finished }) => {
        if (finished) {
          setInternalVisible(false);
          setWindowShown(false);
        }
      });
      return () => animation.stop();
    }
  }, [fadeAnim, slideAnim, visible, windowShown]);

  if (!internalVisible) {
    return null;
  }

  return (
    <Modal
      visible={internalVisible}
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      animationType="none"
      onShow={() => setWindowShown(true)}
      onRequestClose={onClose}
    >
      <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
        <KeyboardAvoidingContainer style={styles.windowContent} enabled={visible} fillsNativeWindow>
          <TouchableWithoutFeedback onPress={onClose}>
            <View style={StyleSheet.absoluteFill} />
          </TouchableWithoutFeedback>

          <Animated.View
            style={[
              styles.sheet,
              { paddingBottom: Math.max(32, insets.bottom) },
              style,
              { transform: [{ translateY: slideAnim }] },
            ]}
          >
            <ThemedSurface
              nativeGlass
              variant="modal"
              backgroundColor={theme.components.modalSheet.backgroundColor}
              style={StyleSheet.absoluteFill}
            />
            {title ? (
              <View style={styles.header}>
                <View style={styles.titleGroup}>
                  <Text style={[styles.title, onDark && styles.titleOnDark]}>{title}</Text>
                  {titleAccessory}
                </View>
                <TouchableOpacity
                  onPress={onClose}
                  style={styles.closeBtn}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.closeText, onDark && styles.closeTextOnDark]}>关闭</Text>
                </TouchableOpacity>
              </View>
            ) : null}
            {children}
          </Animated.View>
        </KeyboardAvoidingContainer>
      </Animated.View>
    </Modal>
  );
}
