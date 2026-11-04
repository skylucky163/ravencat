/** 纸条主题专属：聊天底栏文字与图标的自定义设置，只在 paper-note 主题下挂载。 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, type TextInput, TouchableOpacity, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Pencil, Upload } from 'lucide-react-native';

import {
  PERSISTENT_IMAGE_CATEGORY,
  persistentImageStore,
} from '@platform/device';
import { copyPickedImageToAppStorage } from '@platform/device/DeviceMediaService';
import type { PresentationTheme } from '@shared/theme';
import { ThemedSurface, useTheme, useThemeContext, useThemedStyles } from '@shared/theme';
import { AppTextInput, Button, MimeAwareImage, ModalSheet, showAppDialog } from '@shared/ui';

const MAX_ICON_BYTES = 5 * 1024 * 1024;
const TEXT_MAX_LENGTH = 30;
const PREVIEW_ICON_SIZE = 40;

const createStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    card: { marginHorizontal: theme.spacing.lg, borderRadius: theme.radius.lg, overflow: 'hidden' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.md,
      paddingVertical: 14,
      paddingHorizontal: theme.spacing.lg,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.border.light,
      marginLeft: theme.spacing.lg,
    },
    previewSlot: {
      width: PREVIEW_ICON_SIZE + 16,
      height: PREVIEW_ICON_SIZE + 16,
      borderRadius: theme.radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.surface.muted,
    },
    info: { flex: 1 },
    title: { fontSize: 16, color: theme.colors.text.primary },
    value: { fontSize: 13, color: theme.colors.text.secondary, marginTop: 2 },
    hint: { marginTop: theme.spacing.sm, marginHorizontal: theme.spacing.lg, fontSize: 13, lineHeight: 19, color: theme.colors.text.secondary },
    actions: { flexDirection: 'row', gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md },
    actionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      minHeight: 36,
      paddingHorizontal: theme.spacing.md,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.surface.muted,
      justifyContent: 'center',
    },
    actionText: { fontSize: 13, color: theme.colors.brand.primary },
    renameSheet: { gap: theme.spacing.md },
    counter: {
      alignSelf: 'flex-end',
      fontSize: 12,
      color: theme.colors.text.tertiary,
      fontVariant: ['tabular-nums'],
    },
    counterOver: {
      color: theme.colors.feedback.error,
    },
    nameInput: {
      minHeight: 44,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      backgroundColor: theme.colors.surface.input,
      color: theme.colors.text.primary,
      fontSize: 16,
    },
  });

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}

function inferMimeType(fileName: string | null | undefined, fallback?: string | null): string {
  if (fallback === 'image/png' || fallback === 'image/jpeg' || fallback === 'image/svg+xml') {
    return fallback;
  }
  const extension = (fileName || '').split('.').pop()?.toLowerCase();
  if (extension === 'svg') return 'image/svg+xml';
  if (extension === 'png') return 'image/png';
  return 'image/jpeg';
}

export default function PaperNoteChatFooterSettings() {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const { chatFooter, setChatFooterText, setChatFooterImage } = useThemeContext();
  const [busy, setBusy] = useState(false);
  const [editingText, setEditingText] = useState(false);
  const [textDraft, setTextDraft] = useState('');
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const textInputRef = useRef<TextInput>(null);
  const imageRef = chatFooter.image;

  useEffect(() => {
    let active = true;
    if (!imageRef) {
      setPreviewUri(null);
      return;
    }
    persistentImageStore
      .resolveAssetStorageKey(imageRef.storageKey)
      .then((uri) => {
        if (active) setPreviewUri(uri);
      })
      .catch(() => {
        if (active) setPreviewUri(null);
      });
    return () => {
      active = false;
    };
  }, [imageRef]);

  const openTextEditor = useCallback(() => {
    setTextDraft(chatFooter.text ?? '');
    setEditingText(true);
  }, [chatFooter.text]);

  const focusTextEditor = useCallback(() => {
    // 弹窗展开后才请求键盘；每次打开只设置一次选区，后续点击和编辑交还给原生输入。
    textInputRef.current!.focus();
    textInputRef.current!.setSelection(0, textDraft.length);
  }, [textDraft.length]);

  const saveText = useCallback(async () => {
    setBusy(true);
    try {
      await setChatFooterText(textDraft.trim() || null);
      setEditingText(false);
    } catch (error) {
      showAppDialog({ title: '无法保存文字', message: toMessage(error) });
    } finally {
      setBusy(false);
    }
  }, [setChatFooterText, textDraft]);

  const uploadIcon = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: false,
        copyToCacheDirectory: true,
        type: ['image/svg+xml', 'image/png', 'image/jpeg'],
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      const info = await FileSystem.getInfoAsync(asset.uri);
      if (!info.exists || info.isDirectory) {
        throw new Error('所选文件不可用，请重新选择');
      }
      if ((info.size ?? 0) > MAX_ICON_BYTES) {
        throw new Error('图标不能超过 5MB');
      }
      const mimeType = inferMimeType(asset.name, asset.mimeType);
      const previous = chatFooter.image;
      const managedUri = await copyPickedImageToAppStorage({
        sourceUri: asset.uri,
        category: PERSISTENT_IMAGE_CATEGORY.chatFooterIcon,
        entityId: 'chat-footer',
      });
      const storageKey = persistentImageStore.toManagedStorageKey(managedUri);
      if (!storageKey) {
        throw new Error('图标保存位置无效，请重试');
      }
      await setChatFooterImage({ storageKey, mimeType });
      // 新引用已落盘后再清理旧文件；删除接口拥有文件生命周期队列，调用方不能重复排队。
      if (previous) {
        await persistentImageStore.deleteAssetStorageKey(previous.storageKey)
          .catch((error) => console.warn('[PaperNoteChatFooterSettings] 旧图标清理失败：', error));
      }
    } catch (error) {
      showAppDialog({ title: '无法上传图标', message: toMessage(error) });
    } finally {
      setBusy(false);
    }
  }, [busy, chatFooter.image, setChatFooterImage]);

  const resetIcon = useCallback(async () => {
    if (busy || !imageRef) return;
    setBusy(true);
    const previous = imageRef;
    try {
      await setChatFooterImage(null);
      await persistentImageStore.deleteAssetStorageKey(previous.storageKey)
        .catch((error) => console.warn('[PaperNoteChatFooterSettings] 自定义图标清理失败：', error));
    } catch (error) {
      showAppDialog({ title: '无法恢复默认图标', message: toMessage(error) });
    } finally {
      setBusy(false);
    }
  }, [busy, imageRef, setChatFooterImage]);

  return (
    <>
      <ThemedSurface variant="card" style={styles.card}>
        <TouchableOpacity style={styles.row} onPress={openTextEditor} accessibilityRole="button" accessibilityLabel="编辑聊天底栏文字">
          <View style={styles.info}>
            <Text style={styles.title}>底栏文字</Text>
            <Text style={styles.value} numberOfLines={1}>
              {chatFooter.text?.trim() || '默认'}
            </Text>
          </View>
          <Pencil size={18} color={theme.colors.text.secondary} />
        </TouchableOpacity>

        <View style={styles.divider} />

        <View style={styles.row}>
          <View style={styles.previewSlot}>
            <MimeAwareImage
              uri={previewUri}
              mimeType={imageRef?.mimeType}
              fallbackSource={require('../../../../assets/yaya.png')}
              width={PREVIEW_ICON_SIZE}
              height={PREVIEW_ICON_SIZE}
            />
          </View>
          <View style={styles.info}>
            <Text style={styles.title}>底栏图标</Text>
            <Text style={styles.value}>{imageRef ? '自定义' : '内置鸦鸦'}</Text>
          </View>
        </View>

        <View style={styles.actions}>
          <TouchableOpacity style={styles.actionButton} onPress={() => void uploadIcon()} disabled={busy} accessibilityRole="button" accessibilityLabel="上传底栏图标">
            {busy ? <ActivityIndicator size="small" color={theme.colors.brand.primary} /> : <Upload size={15} color={theme.colors.brand.primary} />}
            <Text style={styles.actionText}>上传图标</Text>
          </TouchableOpacity>
          {imageRef ? (
            <TouchableOpacity style={styles.actionButton} onPress={() => void resetIcon()} disabled={busy} accessibilityRole="button" accessibilityLabel="恢复默认底栏图标">
              <Text style={styles.actionText}>恢复默认</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </ThemedSurface>

      <Text style={styles.hint}>显示在聊天消息列表的最后，跟随页面滚动。支持 SVG / PNG / JPG，每张最多 5MB。</Text>

      <ModalSheet visible={editingText} onClose={() => setEditingText(false)} onOpened={focusTextEditor} title="底栏文字">
        <View style={styles.renameSheet}>
          <AppTextInput
            ref={textInputRef}
            style={styles.nameInput}
            value={textDraft}
            onChangeText={setTextDraft}
            placeholder="例如：Yaya is always here"
            placeholderTextColor={theme.colors.text.tertiary}
          />
          <Text style={[styles.counter, textDraft.length > TEXT_MAX_LENGTH && styles.counterOver]}>
            {textDraft.length}/{TEXT_MAX_LENGTH}
          </Text>
          <Button
            title="保存"
            onPress={() => void saveText()}
            disabled={busy || textDraft.length > TEXT_MAX_LENGTH}
          />
          {chatFooter.text?.trim() ? (
            <Button
              title="恢复默认"
              variant="text"
              onPress={() => {
                setEditingText(false);
                void setChatFooterText(null);
              }}
              disabled={busy}
            />
          ) : null}
        </View>
      </ModalSheet>
    </>
  );
}
