import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useThemedStyles } from '@shared/theme';
import { Button, InputField, ModalSheet } from '@shared/ui';
import NavigationHeader from '@shared/ui/NavigationHeader';
import ColorPickerModal from '@shared/ui/ColorPickerModal';
import Slider from '@shared/ui/Slider';
import { DEFAULT_BUBBLE_TEXT_COLORS, bubblePaddingOutsideFrame, parseBubbleSkinConfig, type BubbleDecorationConfig, type BubbleSkinRole } from '../domain/ChatBubbleSkin';
import { BubbleFrameGuides } from './BubbleFrameGuides';
import { BubbleDecorationControls } from './BubbleDecorationControls';
import { BubbleSkinPreview } from './BubbleSkinPreview';
import { BubbleSkinSaveSheet } from './BubbleSkinSaveSheet';
import { useBubbleSkinEditor, type BubbleEditorNavigationState } from './useBubbleSkinEditor';
import { createBubbleSkinEditorStyles } from './BubbleSkinEditor.styles';
import type { BubbleAppearancePreview } from './BubbleSkinDrawing';

const sideNames = { left: '左', right: '右', top: '上', bottom: '下' };
const sides = ['left', 'right', 'top', 'bottom'] as const;
const opposite = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' } as const;
const tabs = [['slices', '拉伸区域'], ['padding', '文字留白'], ['decorations', '装饰']] as const;
const help = { sections: [
  { title: '预览与文字留白', body: '点击编辑预览文本，可以尝试单字、空格、空内容或长文本，预览不会保存到组合。三个页签共用预览，整页可以上下滑动。新底图的拉伸区域四边初始为 0，文字留白与默认气泡一致：左右 10 dp、上下 8 dp。拉伸区域决定底图哪些部分保持形状，文字留白独立决定文字与四边的距离。调整切线后，可按需使用文字避开边框，补足留白。' },
  { title: '装饰', body: '最多上传四张静态 PNG，每张不超过 2 MiB，导入时等比适配至最长边 512 像素。拖动后保留落点，自动选择跟随最近的角，允许伸出气泡。最大尺寸决定显示上限；短气泡会等比缩小装饰和偏移，长气泡恢复至上限，不裁剪装饰或撑大气泡；上下溢出会预留消息占位，避开 Token 和相邻消息。' },
  { title: '保存与文字颜色', body: '底图、装饰和留白修改留在草稿中，保存时可以修改组合名称，并启用到当前这一侧。文字颜色属于各自的组合，深浅主题共用一份；外观主题页编辑当前启用组合的同一字色，已保存组合改色立即生效，新组合随首次保存生效。我的组合与 AI 的组合各自独立，选择默认不会删除组合。' },
] };

export function ChatBubbleSkinEditorScreen({ role, presetId, onBack, onNavigationStateChange }: {
  role: BubbleSkinRole; presetId: string | null; onBack(): void;
  onNavigationStateChange(state: BubbleEditorNavigationState): void;
}) {
  const styles = useThemedStyles(createBubbleSkinEditorStyles);
  const editor = useBubbleSkinEditor(role, presetId);
  const { draft, update, busy, error, selectedId, setSelectedId, requestLeave, dirty } = editor;
  const [mode, setMode] = useState<typeof tabs[number][0]>('slices');
  const [editingColor, setEditingColor] = useState(false);
  const [editingPreviewText, setEditingPreviewText] = useState(false);
  const [previewText, setPreviewText] = useState('这是一条预览消息。\n文字换行后，气泡也会跟着长高。');
  useEffect(() => { onNavigationStateChange({ dirty: dirty || busy, requestLeave }); }, [dirty, busy, requestLeave, onNavigationStateChange]);
  const changeDecoration = useCallback((id: string, config: BubbleDecorationConfig) => update(before => ({ ...before,
    decorations: before.decorations.map(item => item.id === id ? { ...item, config } : item) })), [update]);
  const appearance = useMemo((): BubbleAppearancePreview => ({
    skin: draft?.image ? { uri: draft.image.uri, textColor: editor.textColor!, config: draft.config, decorations: draft.decorations } : null,
    editing: mode === 'decorations' ? { selectedId, disabled: busy, onSelect: setSelectedId, onChange: changeDecoration } : undefined,
    guides: draft?.image && mode !== 'decorations' ? <BubbleFrameGuides config={draft.config} mode={mode} /> : undefined,
  }), [draft, editor.textColor, mode, selectedId, busy, changeDecoration, setSelectedId]);
  let valid = false;
  if (draft?.image) {
    try { parseBubbleSkinConfig(draft.config, draft.image.width, draft.image.height); valid = true; }
    catch { /* 用户编辑边界：无效配置保留在草稿中，不允许提交。 */ }
  }
  const safePadding = draft ? bubblePaddingOutsideFrame(draft.config) : null;
  const canIncreasePadding = draft !== null && sides.some(side => safePadding![side] > draft.config.padding[side]);
  return <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={styles.screen}>
    <NavigationHeader title={role === 'user' ? '编辑我的气泡' : '编辑 AI 气泡'} onGoBack={onBack} help={help}
      rightButton={<Button title="保存" variant="text" style={styles.compactButton} disabled={busy || !valid}
        onPress={() => { void editor.requestSave().then(saved => { if (saved) onBack(); }); }} />} />
    {draft ? <>
      <ScrollView style={styles.body} contentContainerStyle={styles.pageContent} keyboardShouldPersistTaps="handled">
        <View style={styles.imageRow}>
          <Button title="编辑预览文本" variant="text" style={styles.compactButton} disabled={busy} onPress={() => setEditingPreviewText(true)} />
          <Button title={draft.image ? '更换底图' : '上传底图'} variant="secondary" disabled={busy}
            onPress={() => { void editor.importImage(null); }} />
        </View>
        <BubbleSkinPreview role={role} text={previewText} appearance={appearance} />
        <View style={styles.tabRow}>{tabs.map(([value, label]) => <Pressable key={value}
          style={[styles.tab, mode === value && styles.tabSelected]} onPress={() => setMode(value)}
          accessibilityRole="tab" accessibilityState={{ selected: mode === value }}>
          <Text style={[styles.tabText, mode === value && styles.tabSelectedText]}>{label}</Text>
        </Pressable>)}</View>
        {error && <Text style={styles.error}>{error}</Text>}
        {draft.image && !valid && <Text style={styles.error}>固定区域过大，请减小拉伸区域中的边距。</Text>}
        <View style={styles.controlContent}>
          {mode === 'decorations' ? <BubbleDecorationControls decorations={draft.decorations} selectedId={selectedId} busy={busy || !draft.image}
            onSelect={setSelectedId} onChange={changeDecoration} onAdd={slot => void editor.importImage(slot)}
            onRemove={id => { update(before => ({ ...before, decorations: before.decorations.filter(item => item.id !== id) })); setSelectedId(null); }} /> : <>
            {sides.map(side => {
              const horizontal = side === 'left' || side === 'right';
              // 刻度只取决于底图与固定显示比例，对侧变化只约束可拖动终点。
              const max = mode === 'padding' ? 256 : draft.image ? Math.min(
                (horizontal ? draft.image.width : draft.image.height) - 1,
                Math.floor((horizontal ? 160 : 240) / draft.config.scale)) : 1;
              const limit = mode === 'slices' ? Math.max(0, max - draft.config.slices[opposite[side]]) : max;
              return <View key={side}>
                <View style={styles.parameterHeading}>
                  <Text style={styles.label}>{sideNames[side]}</Text>
                  <Text style={styles.value}>{draft.config[mode][side]} {mode === 'slices' ? 'px' : 'dp'}</Text>
                </View>
                <Slider value={draft.config[mode][side]} min={0} max={max} upperLimit={limit} step={1} disabled={busy || !draft.image || limit === 0}
                  accessibilityLabel={`${sideNames[side]}${mode === 'slices' ? '固定边框' : '文字留白'}`}
                  onValueChange={value => update(before => ({ ...before,
                    config: { ...before.config, [mode]: { ...before.config[mode], [side]: value } } }))} />
              </View>;
            })}
            {mode === 'padding' && <View style={styles.row}>
              <Button title="文字避开边框" variant="secondary" style={styles.compactButton} disabled={busy || !valid || !canIncreasePadding}
                onPress={() => update(before => ({ ...before, config: { ...before.config, padding: bubblePaddingOutsideFrame(before.config) } }))} />
              <Button title="文字颜色" variant="text" style={styles.compactButton}
                disabled={busy} onPress={() => setEditingColor(true)} />
            </View>}
          </>}
        </View>
      </ScrollView>
      <ModalSheet visible={editingPreviewText} title="编辑预览文本" onClose={() => setEditingPreviewText(false)}>
        <View style={styles.saveContent}>
          <InputField label="预览文本" value={previewText} onChangeText={setPreviewText} multiline autoGrow maxLength={10000}
            hint="可输入单字、空格、长文本或清空，仅用于当前预览。" />
          <Button title="完成" onPress={() => setEditingPreviewText(false)} />
        </View>
      </ModalSheet>
      <BubbleSkinSaveSheet mode={editor.savePrompt} name={editor.saveName} onNameChange={editor.setSaveName}
        busy={busy} error={error} canSave={valid} onSave={() => { void editor.confirmSave(); }}
        onCancel={editor.cancelSave} onDiscard={editor.discardChanges} />
      <ColorPickerModal visible={editingColor} title={role === 'user' ? '用户文字颜色' : 'AI 文字颜色'} currentColor={editor.textColor!}
        defaultColor={DEFAULT_BUBBLE_TEXT_COLORS[role]} onClose={() => setEditingColor(false)}
        onConfirm={color => { void editor.setTextColor(color); }}
        onReset={() => { void editor.setTextColor(DEFAULT_BUBBLE_TEXT_COLORS[role]); }} />
    </> : <View style={styles.loading}>{error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator />}</View>}
  </SafeAreaView>;
}
