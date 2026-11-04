/** 表情包系统稳定页面外壳与首页：安全区、导航栏和内部返回层级由外壳拥有。 */

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ListItem, ModelPickerModal, NavigationHeader, ToggleField, showAppDialog } from '@shared/ui';
import { ThemedSurface, useTheme } from '@shared/theme';
import {
  listStickerModelCandidates,
  setStickerEmbeddingModel,
  setStickerRecognitionModel,
  setStickerAutomaticRecognitionEnabled,
} from '../../application/StickerSystemModels';
import type {
  StickerModelConfigRef,
  StickerModelSelection,
} from '../../domain/StickerSystemConfig';
import { useStickerSystemStyles } from './styles';
import StickerSystemGroupsScreen from './StickerSystemGroupsScreen';
import StickerSystemLibraryScreen from './StickerSystemLibraryScreen';
import { StickerProcessingSummary } from './StickerProcessingSummary';
import { useStickerProcessingProgress } from './useStickerProcessingProgress';

type PickerKind = 'recognition' | 'embedding';

type StickerSystemView = 'system' | 'library' | 'groups';

interface StickerSystemHomeScreenProps {
  onOpenLibrary: () => void;
  onOpenGroups: () => void;
  onOpenProgress: () => void;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 绑定模型的副标题。展示状态来自 application query，与 picker candidate list 无关：
 * 只有当前模型确实存在、连接完整且 capability 匹配时才显示真实模型名称，
 * 其余失效原因（incomplete / deleted / capability 不匹配）统一显示不可用。
 */
function modelSelectionSubtitle(
  selection: StickerModelSelection | null,
  unconfiguredText: string,
): string {
  if (!selection || selection.status === 'unconfigured') return unconfiguredText;
  if (selection.status === 'active' && selection.name) return selection.name;
  return '所选模型不可用';
}

export default function StickerSystemScreen({ onBack, onOpenProgress }: { onBack: () => void; onOpenProgress: () => void }) {
  const styles = useStickerSystemStyles();
  const [view, setView] = useState<StickerSystemView>('system');
  const returnToSystem = useCallback(() => setView('system'), []);

  useFocusEffect(useCallback(() => {
    if (view === 'system') return;
    // 内部视图不占导航栈记录；失焦后交还系统返回事件所有权。
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      returnToSystem();
      return true;
    });
    return () => subscription.remove();
  }, [returnToSystem, view]));

  const title = view === 'library' ? '全部表情包' : view === 'groups' ? '分组管理' : '表情包系统';

  // 内部切换只替换内容，保留原生安全区和导航栏，避免重新挂载时的布局跳动。
  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <NavigationHeader
        title={title}
        onGoBack={view === 'system' ? onBack : returnToSystem}
        help={view === 'system' ? { sections: [
          { title: '选择模型', body: '模型在辅助模型中心统一管理，这里只选择表情包系统使用的模型。' },
          { title: '自动识别', body: '默认关闭，仍可在处理进度中手动识别单张。开启后在 App 前台空闲时逐张识别，切到后台会暂停；手动填写过的内容不会被自动覆盖。动态图需手动填写含义。' },
          { title: '识别与语义索引', body: '识别生成表情含义，完成后即可发送和关键词搜索。语义索引由向量化模型另行建立，用于按含义搜索；识别完成不代表索引已齐全。未配置向量模型或向量化失败不影响发送和关键词搜索，失败项需手动补齐或重建。' },
          { title: '切换与维护索引', body: '切换模型保留旧向量；切回同一模型版本可继续使用匹配索引，新增项可在处理进度中补齐。没有匹配索引的新模型需手动重建；全部成功后才替换旧索引，失败或取消保留旧数据。' },
        ] } : undefined}
      />
      {view === 'library' ? (
        <StickerSystemLibraryScreen />
      ) : view === 'groups' ? (
        <StickerSystemGroupsScreen />
      ) : (
        <StickerSystemHomeScreen
          onOpenProgress={onOpenProgress}
          onOpenLibrary={() => setView('library')}
          onOpenGroups={() => setView('groups')}
        />
      )}
    </SafeAreaView>
  );
}

function StickerSystemHomeScreen({
  onOpenLibrary,
  onOpenGroups,
  onOpenProgress,
}: StickerSystemHomeScreenProps) {
  const styles = useStickerSystemStyles();
  const theme = useTheme();
  const { progress: processing, error: processingError, refresh } = useStickerProcessingProgress();
  const [pickerKind, setPickerKind] = useState<PickerKind | null>(null);
  const [candidates, setCandidates] = useState<StickerModelConfigRef[]>([]);
  const [working, setWorking] = useState(false);
  const loading = processing === null && processingError === null;

  useEffect(() => {
    if (processing === null && processingError !== null) {
      showAppDialog({ title: '加载失败', message: processingError, tone: 'error' });
    }
  }, [processing, processingError]);

  const openPicker = useCallback(async (kind: PickerKind) => {
    setPickerKind(kind);
    setCandidates([]);
    try {
      const models = await listStickerModelCandidates(kind === 'recognition' ? 'ocr' : 'embedding');
      setCandidates(models);
    } catch (error) {
      showAppDialog({ title: '加载失败', message: getErrorMessage(error), tone: 'error' });
    }
  }, []);

  const handleSelectModel = useCallback(async (modelConfigId: string | null) => {
    if (!pickerKind) return;
    setWorking(true);
    try {
      if (pickerKind === 'recognition') {
        await setStickerRecognitionModel(modelConfigId);
      } else {
        await setStickerEmbeddingModel(modelConfigId);
      }
      setPickerKind(null);
      await refresh();
    } catch (error) {
      showAppDialog({ title: '保存失败', message: getErrorMessage(error), tone: 'error' });
    } finally {
      setWorking(false);
    }
  }, [pickerKind, refresh]);

  // picker 的选中标记只看当前 picker 对应的那一个绑定，两个 picker 互不干扰。
  const boundModelConfigId = pickerKind === 'recognition'
    ? processing?.recognitionModel.modelConfigId
    : processing?.embeddingModel.modelConfigId;

  return (
    <View style={styles.container}>
      {loading ? (
        <ActivityIndicator style={{ marginTop: 80 }} size="large" />
      ) : (
        <ScrollView showsVerticalScrollIndicator={false}>
          <Text style={styles.sectionTitle}>模型配置</Text>
          <ThemedSurface variant="card" style={styles.card}>
            <ToggleField label="自动识别新表情" layout="inline" rowStyle={styles.row}
              value={processing?.automaticRecognitionEnabled ?? false} disabled={working || processing === null}
              onValueChange={enabled => {
                setWorking(true);
                void setStickerAutomaticRecognitionEnabled(enabled).then(refresh).catch(error => {
                  showAppDialog({ title: '保存失败', message: getErrorMessage(error), tone: 'error' });
                }).finally(() => setWorking(false));
              }} />
            <ListItem
              title="视觉识别模型"
              subtitle={processing ? modelSelectionSubtitle(
                processing.recognitionModel,
                '未配置视觉识别模型',
              ) : '状态读取失败'}
              rightContent={<Ionicons name="chevron-forward" size={16} color={theme.colors.text.secondary} />}
              onPress={() => void openPicker('recognition')}
            />
            <ListItem
              title="向量化模型"
              subtitle={processing ? modelSelectionSubtitle(
                processing.embeddingModel,
                '未配置向量化模型，当前使用文本搜索',
              ) : '状态读取失败'}
              rightContent={<Ionicons name="chevron-forward" size={16} color={theme.colors.text.secondary} />}
              onPress={() => void openPicker('embedding')}
            />
          </ThemedSurface>
          <Text style={styles.sectionTitle}>处理进度</Text>
          <View style={{ marginHorizontal: theme.spacing.lg }}>
            <StickerProcessingSummary progress={processing} error={processingError} onPress={onOpenProgress} />
          </View>

          <Text style={styles.sectionTitle}>图库与分组</Text>
          <ThemedSurface variant="card" style={styles.card}>
            <ListItem
              title="全部表情包"
              rightContent={<Ionicons name="chevron-forward" size={16} color={theme.colors.text.secondary} />}
              onPress={onOpenLibrary}
            />
            <ListItem
              title="分组管理"
              rightContent={<Ionicons name="chevron-forward" size={16} color={theme.colors.text.secondary} />}
              onPress={onOpenGroups}
            />
          </ThemedSurface>

          <View style={{ height: 32 }} />
        </ScrollView>
      )}

      <ModelPickerModal visible={pickerKind !== null} onClose={() => setPickerKind(null)}
        title={pickerKind === 'recognition' ? '选择视觉识别模型' : '选择向量化模型'}
        models={candidates} selectedModel={boundModelConfigId} disabled={working}
        onSelect={id => { void handleSelectModel(id); }} onClear={() => { void handleSelectModel(null); }}
        emptyText="暂无可选模型，请先到辅助模型中心添加配置。" />
    </View>
  );
}
