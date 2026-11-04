/** 首页与聊天面板消费同一进度快照，失败只以安静的状态提示呈现。 */
import React from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { ThemedSurface, useTheme } from '@shared/theme';
import type { StickerProcessingProgress } from '../../domain/StickerProcessing';
import { useStickerProcessingStyles } from './processingStyles';

export function StickerProcessingSummary({ progress, error, onPress, compact = false }: {
  progress: StickerProcessingProgress | null;
  error: string | null;
  onPress: () => void;
  compact?: boolean;
}) {
  const styles = useStickerProcessingStyles();
  const theme = useTheme();
  const ready = progress?.items.filter(item => item.sticker.annotationStatus === 'ready').length ?? 0;
  const pending = progress?.items.filter(item => item.sticker.annotationStatus === 'pending').length ?? 0;
  const failed = progress?.items.filter(item => item.sticker.annotationStatus === 'failed').length ?? 0;
  const manual = progress?.items.filter(item => item.sticker.annotationStatus === 'manual_required').length ?? 0;
  const running = progress?.items.filter(item => item.sticker.annotationStatus === 'processing').length ?? 0;
  const vectors = progress?.items.filter(item => item.hasEmbedding).length ?? 0;
  const vectorFailed = progress?.items.filter(item => item.vectorStatus === 'failed').length ?? 0;
  const automaticEnabled = progress?.automaticRecognitionEnabled === true;
  const manualPending = progress?.items.filter(item => item.manuallyRequested && item.sticker.annotationStatus === 'pending').length ?? 0;
  const manualRunning = progress?.items.some(item => item.manuallyRequested && item.sticker.annotationStatus === 'processing') ?? false;
  const recognitionStatus = !progress ? '' : !automaticEnabled ? '自动识别已关闭'
    : progress.items.length === 0 ? '暂无表情包'
    : running ? '正在识别' : pending ? (progress.recognitionModel.status === 'active' ? '等待识别' : '识别已暂停')
      : failed ? '有表情识别失败' : manual ? '有表情待填写含义' : '识别完成';
  const activity = progress?.embeddingActivity;
  const vectorStatus = !progress ? '' : activity ? (activity.kind === 'rebuild'
    ? `重建中 ${activity.completed} / ${activity.total}` : `向量化中 · 当前 ${activity.total} 张`)
    : progress.embeddingModel.status === 'unconfigured' ? '未启用，使用关键词搜索'
      : progress.embeddingModel.status !== 'active' ? '向量模型不可用'
        : ready === 0 ? '等待完成识别'
          : !progress.embeddingCanBackfill ? '待手动重建'
            : vectors < ready ? `待建立 ${ready - vectors} 张` : '已齐全';
  return <TouchableOpacity accessibilityRole="button" accessibilityLabel="查看表情处理进度"
    onPress={onPress}>
    <ThemedSurface variant="card" cornerRadius={compact ? 0 : undefined} style={[styles.summary, compact && styles.compactSummary]}>
      {(running > 0 || activity) && <ActivityIndicator size="small" color={theme.colors.brand.primary} />}
      <View style={styles.flex}>
        <Text style={styles.title}>{error ? '进度加载失败' : !progress ? '正在加载进度…' : '表情处理进度'}</Text>
        {error ? <Text style={styles.secondary}>{error}</Text> : progress && <>
          <Text style={styles.secondary}>识别：{recognitionStatus}
            {automaticEnabled && (compact
              ? pending + running > 0 ? ` · 剩余 ${pending + running} 张` : ` · ${ready} / ${progress.items.length} 张`
              : ` · 已完成 ${ready} / ${progress.items.length} 张 · 剩余 ${pending + running} 张 · 失败 ${failed} · 待手填 ${manual}`)}</Text>
          {!automaticEnabled && (manualRunning || manualPending > 0) && <Text style={styles.secondary}>
            {manualRunning ? '手动单张识别中' : `手动单张待处理 ${manualPending} 张`}</Text>}
          <Text style={styles.secondary}>语义索引：有效 {vectors} / {ready} 张 · {vectorStatus}</Text>
          {vectorFailed > 0 && <Text style={styles.secondary}>{vectorFailed} 张向量化失败，需手动补齐或重建</Text>}
        </>}
      </View>
      <ChevronRight size={16} color={theme.colors.text.secondary} />
    </ThemedSurface>
  </TouchableOpacity>;
}
