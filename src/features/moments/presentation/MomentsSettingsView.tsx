/** 时刻设置：Moments-owned 图片理解模型 binding 与 Profile-owned 封面入口。 */
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { BackgroundPickerCard, ModelPickerModal, showAppDialog } from '@shared/ui';
import { useTheme, type PresentationTheme } from '@shared/theme';
import type {
  MomentImageAnalysisModelRef,
  MomentImageAnalysisModelSelection,
} from '../domain/MomentImageAnalysis';
import {
  getMomentImageAnalysisModelSelection,
  listMomentImageAnalysisModelCandidates,
  setMomentImageAnalysisModel,
} from '../application/MomentSettings';
import MomentsCoverPreviewModal from './MomentsCoverPreviewModal';
import { useMomentsCover } from './useMomentsCover';

interface Props { onClose: () => void }

function createStyles(theme: PresentationTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.colors.background.app },
    content: { padding: theme.spacing.lg, gap: theme.spacing.xl },
    section: { backgroundColor: theme.colors.surface.default, borderRadius: theme.radius.lg, padding: theme.spacing.lg },
    title: { fontSize: 17, fontWeight: '700', color: theme.colors.text.primary, marginBottom: theme.spacing.md },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: theme.spacing.md },
    label: { color: theme.colors.text.primary, fontSize: 15 },
    value: { color: theme.colors.text.secondary, fontSize: 14, maxWidth: '60%', textAlign: 'right' },
    note: { color: theme.colors.text.tertiary, fontSize: 12, lineHeight: 18, marginTop: theme.spacing.sm },

  });
}

function selectionLabel(selection: MomentImageAnalysisModelSelection | null): string {
  if (!selection || selection.status === 'unconfigured') return '未配置';
  if (selection.status === 'active') return selection.name ?? selection.model ?? '当前模型';
  return '已失效';
}

export default function MomentsSettingsView({ onClose }: Props) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const cover = useMomentsCover();
  const [selection, setSelection] = useState<MomentImageAnalysisModelSelection | null>(null);
  const [candidates, setCandidates] = useState<MomentImageAnalysisModelRef[]>([]);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [coverPreviewVisible, setCoverPreviewVisible] = useState(false);

  const reloadSelection = async () => setSelection(await getMomentImageAnalysisModelSelection());
  useEffect(() => { void reloadSelection(); }, []);

  const openPicker = async () => {
    try {
      setCandidates(await listMomentImageAnalysisModelCandidates());
      setPickerVisible(true);
    } catch { showAppDialog({ title: '加载失败', message: '无法读取图片理解模型列表', tone: 'error' }); }
  };
  const selectModel = async (id: string | null) => {
    try {
      await setMomentImageAnalysisModel(id);
      await reloadSelection();
      setPickerVisible(false);
    } catch { showAppDialog({ title: '保存失败', message: '所选模型当前不可用', tone: 'error' }); }
  };

  // 独立 push 页面：安全区由本组件自己负责（此前由 MomentsTab 内嵌渲染时代管）。
  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <NavigationHeader title="时刻设置" onGoBack={onClose} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.section}>
          <Text style={styles.title}>图片理解模型</Text>
          <TouchableOpacity style={styles.row} onPress={openPicker}>
            <Text style={styles.label}>当前模型</Text>
            <Text style={styles.value}>{selectionLabel(selection)}</Text>
          </TouchableOpacity>
          <Text style={styles.note}>只影响新发布图片和手动重新识别；不会自动重新识别已有图片。</Text>
        </View>
        <BackgroundPickerCard
          title="时刻封面"
          description="展示在时刻页顶部；点缩略图可预览实际效果。"
          previewSource={cover.coverSource}
          previewTitle={cover.hasCustomCover ? '自定义封面' : '默认封面'}
          previewSubtitle={cover.hasCustomCover ? '已选择自定义图片' : '跟随应用默认封面'}
          isPicking={cover.isUpdatingCover}
          pickLabel="更换封面"
          resetDisabled={!cover.hasCustomCover}
          onPick={() => void cover.pickCover()}
          onReset={() => void cover.resetCover()}
          onPreviewPress={() => setCoverPreviewVisible(true)}
        />
      </ScrollView>

      <ModelPickerModal visible={pickerVisible} onClose={() => setPickerVisible(false)} title="选择图片理解模型"
        models={candidates} selectedModel={selection?.modelConfigId} onSelect={id => { void selectModel(id); }}
        onClear={() => { void selectModel(null); }} />
      <MomentsCoverPreviewModal
        visible={coverPreviewVisible}
        coverSource={cover.coverSource}
        hasCustomCover={cover.hasCustomCover}
        isUpdating={cover.isUpdatingCover}
        onClose={() => setCoverPreviewVisible(false)}
        onPickCover={() => { setCoverPreviewVisible(false); void cover.pickCover(); }}
        onResetCover={() => { setCoverPreviewVisible(false); void cover.resetCover(); }}
      />
    </SafeAreaView>
  );
}
