/** 分享窗口只负责选择、预览和附言交互；目标目录、内容与提交由业务层持有。 */
import React, { useEffect, useRef, type ReactNode } from 'react';
import { ActivityIndicator, Keyboard, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import AppTextInput from './AppTextInput';
import KeyboardAvoidingContainer from './KeyboardAvoidingContainer';

export interface ShareSheetTarget {
  key: string;
  name: string;
  description: string;
}

interface Props<T extends ShareSheetTarget> {
  visible: boolean;
  targets: readonly T[];
  target: T | null;
  loading: boolean;
  sending: boolean;
  error: string | null;
  comment: string;
  ready: boolean;
  canChooseTarget?: boolean;
  selectionHint?: string;
  preview: ReactNode;
  footer?: ReactNode;
  onClose(): void;
  onChoose(target: T | null): void;
  onCommentChange(comment: string): void;
  onSend(): void;
}

export default function ShareSheet<T extends ShareSheetTarget>({ visible, targets, target, loading, sending, error, comment, ready, canChooseTarget = true, selectionHint, preview, footer, onClose, onChoose, onCommentChange, onSend }: Props<T>) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const input = useRef<TextInput>(null);
  useEffect(() => {
    if (!visible) return;
    const subscription = Keyboard.addListener('keyboardDidHide', () => input.current?.blur());
    return () => subscription.remove();
  }, [visible]);
  return <Modal visible={visible} animationType="slide" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
    <KeyboardAvoidingContainer enabled={visible} style={styles.page}>
      <View style={[styles.page, { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 8) }]}>
        <View style={styles.header}>
          <TouchableOpacity disabled={sending} onPress={target && canChooseTarget ? () => onChoose(null) : onClose} style={styles.button}><Text style={styles.link}>{target && canChooseTarget ? '返回' : '取消'}</Text></TouchableOpacity>
          <Text numberOfLines={1} style={styles.title}>{target ? `分享给${target.name}` : '选择分享对象'}</Text>
          <View style={styles.button} />
        </View>
        {loading ? <ActivityIndicator style={styles.loading} color={theme.colors.brand.primary} /> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {ready && !target ? <ScrollView keyboardShouldPersistTaps="handled">
          {selectionHint ? <Text style={styles.hint}>{selectionHint}</Text> : null}
          {targets.length === 0 ? <Text style={styles.hint}>还没有可分享的对象</Text> : null}
          {targets.map(item => <TouchableOpacity key={item.key} accessibilityRole="button" onPress={() => onChoose(item)} style={styles.destination}><Text style={styles.text}>{item.name}</Text><Text style={styles.hint}>{item.description}</Text></TouchableOpacity>)}
        </ScrollView> : null}
        {ready && target ? <>
          <ScrollView keyboardShouldPersistTaps="handled" pointerEvents={sending ? 'none' : 'auto'}>{preview}</ScrollView>
          {footer}
          <AppTextInput ref={input} editable={!sending} accessibilityLabel="分享附言" placeholder="附言（可选，作为单独消息发送）" placeholderTextColor={theme.colors.text.secondary} autoGrow value={comment} onChangeText={onCommentChange} style={styles.input} />
          <TouchableOpacity accessibilityRole="button" disabled={sending} accessibilityState={{ disabled: sending }} onPress={onSend} style={[styles.send, sending && styles.disabled]}><Text style={styles.sendText}>{sending ? '分享中…' : '确认分享'}</Text></TouchableOpacity>
        </> : null}
      </View>
    </KeyboardAvoidingContainer>
  </Modal>;
}

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.colors.background.screen },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 52 },
  button: { width: 64, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600', color: theme.colors.text.primary },
  text: { flex: 1, fontSize: 16, color: theme.colors.text.primary }, link: { color: theme.colors.brand.primary },
  hint: { paddingHorizontal: 16, paddingVertical: 10, color: theme.colors.text.secondary, fontSize: 12 },
  loading: { margin: 32 }, error: { color: theme.colors.feedback.error, padding: 16 },
  destination: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border.light },
  input: { color: theme.colors.text.primary, backgroundColor: theme.colors.surface.default, borderColor: theme.colors.border.light, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, marginHorizontal: 16, marginBottom: 12, padding: 12, maxHeight: 100 },
  send: { marginHorizontal: 16, borderRadius: 8, backgroundColor: theme.colors.brand.primary, padding: 14, alignItems: 'center' },
  sendText: { color: theme.colors.brand.onPrimary, fontSize: 16, fontWeight: '600' }, disabled: { opacity: 0.5 },
});
