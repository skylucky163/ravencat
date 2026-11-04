/** 设置悬浮球大小与两种形态；整页共用外层的纵向滚动。 */
import { ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import { Button, MimeAwareImage, ModalSheet, Slider, showAppDialog } from '@shared/ui';
import * as DocumentPicker from 'expo-document-picker';
import { Check, Minus, Pencil, Plus, Trash2, Upload } from 'lucide-react-native';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, PixelRatio, Text, TextInput, TouchableOpacity, View } from 'react-native';

import {
  deleteBubbleSkin,
  importBubbleSkin,
  listBubbleSkins,
  renameBubbleSkin,
  selectBubbleSkin,
  setBubbleSize,
  updateBubbleSkinImage,
} from '../application';
import type { BubbleSkin } from '../domain/BubbleSkin';
import { createBubbleSkinStyles } from './BubbleSkinSettings.styles';

const MIN_SIZE = 32;
const MAX_SIZE = 96;
const DEFAULT_SIZE = 56;

export function BubbleSkinSettings() {
  const theme = useTheme();
  const styles = useThemedStyles(createBubbleSkinStyles);
  const [skins, setSkins] = useState<BubbleSkin[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [renamingSkin, setRenamingSkin] = useState<BubbleSkin | null>(null);
  const [nameDraft, setNameDraft] = useState('');

  const refresh = useCallback(async () => {
    setSkins(await listBubbleSkins());
  }, []);

  useEffect(() => {
    void refresh()
      .catch((error) => showAppDialog({ title: '无法读取外观设置', message: toMessage(error) }))
      .finally(() => setLoading(false));
  }, [refresh]);

  const selectSkin = useCallback(async (skin: BubbleSkin) => {
    if (busy || skin.selected) return;
    setBusy(true);
    try {
      await selectBubbleSkin(skin.id);
      await refresh();
    } catch (error) {
      showAppDialog({ title: '无法更换装扮', message: toMessage(error) });
    } finally {
      setBusy(false);
    }
  }, [busy, refresh]);

  const uploadImage = useCallback(async (skin?: BubbleSkin, form: 'normal' | 'docked' = 'normal') => {
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
      const image = { uri: asset.uri, fileName: asset.name, mimeType: asset.mimeType };
      if (skin) {
        await updateBubbleSkinImage({ ...image, id: skin.id, form });
      } else {
        await importBubbleSkin({ ...image, name: initialSkinName(asset.name) });
      }
      await refresh();
    } catch (error) {
      showAppDialog({ title: '无法上传图片', message: toMessage(error) });
    } finally {
      setBusy(false);
    }
  }, [busy, refresh]);

  const changeSize = useCallback(async (id: string, nextSize: number) => {
    setBusy(true);
    try {
      const updated = await setBubbleSize(id, nextSize);
      setSkins((current) => current.map((skin) => skin.id === id ? updated : skin));
    } finally {
      setBusy(false);
    }
  }, []);

  const saveRename = useCallback(async () => {
    if (!renamingSkin || busy) return;
    setBusy(true);
    try {
      await renameBubbleSkin(renamingSkin, nameDraft);
      setRenamingSkin(null);
      await refresh();
    } catch (error) {
      showAppDialog({ title: '无法修改名称', message: toMessage(error) });
    } finally {
      setBusy(false);
    }
  }, [busy, nameDraft, refresh, renamingSkin]);

  const confirmDelete = useCallback((skin: BubbleSkin) => {
    showAppDialog({ title: '删除自定义装扮', message: `确定删除“${skin.name}”及它的两种形态吗？`, buttons: [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => {
        setBusy(true);
        void deleteBubbleSkin(skin).then(refresh).catch((error) => showAppDialog({ title: '无法删除装扮', message: toMessage(error) })).finally(() => setBusy(false));
      } },
    ] });
  }, [refresh]);

  const selectedSkin = skins.find((skin) => skin.selected);
  return (
    <>
      <Text style={styles.sectionTitle}>悬浮球外观</Text>
      <ThemedSurface variant="card" style={styles.card}>
        {loading ? <ActivityIndicator style={styles.loading} color={theme.colors.brand.primary} /> : (
          <>
            {selectedSkin ? <BubbleSizeEditor key={selectedSkin.id} skin={selectedSkin} disabled={busy} onSave={changeSize} /> : null}
            <Text style={styles.description}>贴边图可不上传，默认使用正面图。靠左自动镜像，靠右保持原方向。</Text>
            <View style={styles.skinList}>
              {skins.map((skin) => (
                <View key={skin.id} style={[styles.skinCard, skin.selected && styles.selectedCard]}>
                  <TouchableOpacity style={styles.skinSelect} onPress={() => void selectSkin(skin)} disabled={busy} accessibilityRole="button" accessibilityLabel={`选择装扮${skin.name}`} accessibilityState={{ selected: skin.selected }}>
                    <View style={styles.skinHeading}>
                      <View style={styles.sizeInfo}><Text style={styles.skinName} numberOfLines={1}>{skin.name}</Text><Text style={styles.hint}>{skin.source === 'builtin' ? '内置' : '自定义'} · 大小 {skin.sizeDp}</Text></View>
                      {skin.selected ? <Check size={20} color={theme.colors.brand.primary} /> : <View style={styles.unselectedCircle} />}
                    </View>
                    <View style={styles.previewRow}>
                      <View style={styles.previewSlot}><SkinPreview skin={skin} /><Text style={styles.hint}>正面</Text></View>
                      <View style={styles.previewSlot}><SkinPreview skin={skin} docked mirror /><Text style={styles.hint}>贴左</Text></View>
                      <View style={styles.previewSlot}><SkinPreview skin={skin} docked /><Text style={styles.hint}>贴右</Text></View>
                    </View>
                  </TouchableOpacity>
                  {skin.source === 'user' ? (
                    <View style={styles.skinActions}>
                      <TouchableOpacity style={styles.uploadButton} onPress={() => void uploadImage(skin, 'normal')} disabled={busy} accessibilityLabel={`上传${skin.name}正面图片`}><Upload size={15} color={theme.colors.brand.primary} /><Text style={styles.actionText}>正面</Text></TouchableOpacity>
                      <TouchableOpacity style={styles.uploadButton} onPress={() => void uploadImage(skin, 'docked')} disabled={busy} accessibilityLabel={`上传${skin.name}贴边图片`}><Upload size={15} color={theme.colors.brand.primary} /><Text style={styles.actionText}>贴边</Text></TouchableOpacity>
                      <TouchableOpacity style={styles.iconButton} onPress={() => { setRenamingSkin(skin); setNameDraft(skin.name); }} disabled={busy} accessibilityLabel={`重命名${skin.name}`}><Pencil size={18} color={theme.colors.text.secondary} /></TouchableOpacity>
                      <TouchableOpacity style={styles.iconButton} onPress={() => confirmDelete(skin)} disabled={busy} accessibilityLabel={`删除${skin.name}`}><Trash2 size={18} color={theme.colors.feedback.error} /></TouchableOpacity>
                    </View>
                  ) : null}
                </View>
              ))}
              <TouchableOpacity style={styles.importCard} onPress={() => void uploadImage()} disabled={busy} accessibilityRole="button" accessibilityLabel="上传正面图片，新增自定义装扮">
                {busy ? <ActivityIndicator color={theme.colors.brand.primary} /> : <Plus size={24} color={theme.colors.brand.primary} />}
                <View style={styles.sizeInfo}><Text style={styles.importText}>新增自定义装扮</Text><Text style={styles.hint}>先上传正面 · SVG / PNG / JPG · 每张最多 5MB</Text></View>
              </TouchableOpacity>
            </View>
          </>
        )}
      </ThemedSurface>
      <ModalSheet visible={renamingSkin !== null} onClose={() => setRenamingSkin(null)} title="修改装扮名称">
        <View style={styles.renameSheet}>
          <TextInput style={styles.nameInput} value={nameDraft} onChangeText={setNameDraft} maxLength={30} autoFocus selectTextOnFocus placeholder="输入装扮名称" placeholderTextColor={theme.colors.text.tertiary} />
          <Button title="保存" onPress={() => void saveRename()} disabled={busy || nameDraft.trim().length === 0} />
        </View>
      </ModalSheet>
    </>
  );
}

function SkinPreview({ skin, docked = false, mirror = false, size = 52 }: { skin: BubbleSkin; docked?: boolean; mirror?: boolean; size?: number }) {
  const uri = docked && skin.dockedUri ? skin.dockedUri : skin.uri;
  const mimeType = docked && skin.dockedUri ? skin.dockedMimeType : skin.mimeType;
  return (
    <View style={{ width: size, height: size, transform: [{ scaleX: mirror ? -1 : 1 }] }}>
      <MimeAwareImage
        uri={skin.source === 'builtin' ? null : uri}
        mimeType={mimeType}
        fallbackSource={require('../../../../assets/yaya.png')}
        width={size}
        height={size}
      />
    </View>
  );
}

const PREVIEW_FORMS = [
  { id: 'normal', label: '正面' },
  { id: 'left', label: '贴左' },
  { id: 'right', label: '贴右' },
] as const;
const PREVIEW_HEIGHT = MAX_SIZE + 40;

function BubbleSizeEditor({ skin, disabled, onSave }: {
  skin: BubbleSkin;
  disabled: boolean;
  onSave: (id: string, size: number) => Promise<void>;
}) {
  const styles = useThemedStyles(createBubbleSkinStyles);
  const theme = useTheme();
  const [draft, setDraft] = useState(skin.sizeDp);
  const [form, setForm] = useState<'normal' | 'left' | 'right'>('normal');

  useEffect(() => {
    setDraft(skin.sizeDp);
  }, [skin.sizeDp]);

  const save = useCallback(async (size: number) => {
    setDraft(size);
    if (size === skin.sizeDp) return;
    try {
      await onSave(skin.id, size);
    } catch (error) {
      setDraft(skin.sizeDp);
      showAppDialog({ title: '无法调整大小', message: toMessage(error) });
    }
  }, [onSave, skin.id, skin.sizeDp]);
  // 与 Android Window 的 dp→px 取整及贴边露出比例一致，预览不缩成手机模型。
  const density = PixelRatio.get();
  const sizePx = Math.floor(draft * density);
  const actualSize = sizePx / density;
  const hiddenSize = (sizePx - Math.round(sizePx * 0.6)) / density;
  const position = form === 'left' ? { left: -hiddenSize } : { right: form === 'right' ? -hiddenSize : 16 };

  return (
    <View style={styles.sizeEditor}>
      <View style={styles.sizeRow}>
        <View style={styles.sizeInfo}>
          <Text style={styles.settingTitle} numberOfLines={1}>{skin.name} · 大小 {draft}</Text>
          <Text style={styles.hint}>只调整当前皮肤，切换后各自保留</Text>
        </View>
        <TouchableOpacity style={styles.iconButton} onPress={() => void save(Math.max(MIN_SIZE, draft - 1))} disabled={disabled || draft <= MIN_SIZE} accessibilityLabel="缩小当前皮肤">
          <Minus size={20} color={theme.colors.text.primary} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconButton} onPress={() => void save(Math.min(MAX_SIZE, draft + 1))} disabled={disabled || draft >= MAX_SIZE} accessibilityLabel="放大当前皮肤">
          <Plus size={20} color={theme.colors.text.primary} />
        </TouchableOpacity>
      </View>
      <Slider value={draft} min={MIN_SIZE} max={MAX_SIZE} step={1}
        onValueChange={setDraft} onSlidingComplete={save} disabled={disabled}
        accessibilityLabel="当前皮肤大小" />
      <View style={styles.sizeRow}>
        <Text style={styles.hint}>{MIN_SIZE}</Text>
        <TouchableOpacity style={styles.resetButton} onPress={() => void save(DEFAULT_SIZE)} disabled={disabled || draft === DEFAULT_SIZE}>
          <Text style={styles.actionText}>恢复默认 {DEFAULT_SIZE}</Text>
        </TouchableOpacity>
        <Text style={styles.hint}>{MAX_SIZE}</Text>
      </View>
      <Text style={styles.settingTitle}>实际大小预览</Text>
      <View style={styles.previewTabs}>
        {PREVIEW_FORMS.map((mode) => (
          <TouchableOpacity key={mode.id} style={[styles.previewTab, form === mode.id && styles.activePreviewTab]} onPress={() => setForm(mode.id)} accessibilityRole="button" accessibilityState={{ selected: form === mode.id }}>
            <Text style={form === mode.id ? styles.actionText : styles.hint}>{mode.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={[styles.previewScreen, { height: PREVIEW_HEIGHT }]}>
        <View pointerEvents="none" style={styles.previewPage}>
          <Text style={styles.hint}>页面内容</Text>
          <View style={styles.previewPageLine} />
          <View style={[styles.previewPageLine, styles.shortPreviewLine]} />
        </View>
        <View pointerEvents="none" style={[styles.actualBubble, position, { top: (PREVIEW_HEIGHT - actualSize) / 2 }]}>
          <SkinPreview skin={skin} size={actualSize} docked={form !== 'normal'} mirror={form === 'left'} />
        </View>
      </View>
      <Text style={styles.hint}>按当前屏幕 1:1 显示，保留图片透明留白；贴边露出约 60%。</Text>
    </View>
  );
}

function initialSkinName(fileName: string): string { return (fileName.replace(/\.[^.]+$/, '').trim() || '我的装扮').slice(0, 30); }
function toMessage(error: unknown): string { return error instanceof Error ? error.message : '操作失败，请稍后重试。'; }
