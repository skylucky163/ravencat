/** 用户表情处理的唯一详情页；两个入口共用重试、人工标注和索引维护。 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, FlatList, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ThemedSurface } from '@shared/theme';
import { InputField, ModalSheet, NavigationHeader, showAppDialog } from '@shared/ui';
import { completeStickerAnnotationManually, retryStickerAnnotation } from '../../application/StickerCommands';
import { backfillMissingStickerEmbeddings, rebuildStickerEmbeddingIndex } from '../../application/StickerEmbeddings';
import type { StickerProcessingItem, StickerVectorStatus } from '../../domain/StickerProcessing';
import { useStickerProcessingProgress } from './useStickerProcessingProgress';
import { useStickerProcessingStyles } from './processingStyles';
import { getStickerAnnotationStatusText } from './StickerAnnotationStatus';
import { StickerThumbnail } from './StickerThumbnail';

const stickerVectorStatusText: Record<StickerVectorStatus, string> = {
  waiting_annotation: '等待完成识别', unconfigured: '未启用向量索引', unavailable: '向量模型不可用',
  pending_rebuild: '待手动重建索引', pending: '待向量化', processing: '向量化中', failed: '向量化失败', ready: '向量索引可用',
};

function ElapsedTime({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <Text> · 已等待 {Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000))} 秒</Text>;
}

export default function StickerProcessingScreen({ onBack }: { onBack: () => void }) {
  const styles = useStickerProcessingStyles();
  const { progress, error } = useStickerProcessingProgress();
  const annotationText = (item: StickerProcessingItem) => getStickerAnnotationStatusText({
    status: item.sticker.annotationStatus,
    automaticRecognitionEnabled: progress?.automaticRecognitionEnabled ?? null,
    manuallyRequested: item.manuallyRequested,
  }) ?? '可用';
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [emotion, setEmotion] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const nameError = name.trim() ? undefined : '请填写表情名称';
  const descriptionError = description.trim() ? undefined : '请填写含义或使用语境，才能完成手动识别';
  const [busy, setBusy] = useState(false);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const rebuildController = useRef<AbortController | null>(null);
  useFocusEffect(useCallback(() => () => rebuildController.current?.abort(), []));

  const selected = progress?.items.find(item => item.sticker.id === selectedId) ?? null;
  const items = progress?.items ?? [];
  const processingItems = items.filter(item => item.sticker.annotationStatus !== 'ready'
    || item.vectorStatus === 'pending_rebuild' || item.vectorStatus === 'pending'
    || item.vectorStatus === 'processing' || item.vectorStatus === 'failed');
  const ready = items.filter(item => item.sticker.annotationStatus === 'ready').length;
  const pending = items.filter(item => item.sticker.annotationStatus === 'pending').length;
  const failed = items.filter(item => item.sticker.annotationStatus === 'failed').length;
  const manual = items.filter(item => item.sticker.annotationStatus === 'manual_required').length;
  const current = items.find(item => item.sticker.annotationStatus === 'processing');
  const vectors = items.filter(item => item.hasEmbedding).length;
  const vectorFailed = items.filter(item => item.embeddingError !== null).length;
  const activity = progress?.embeddingActivity;

  const perform = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try { await operation(); }
    catch (cause) { showAppDialog({ title: '操作未完成', message: cause instanceof Error ? cause.message : String(cause), tone: 'error' }); }
    finally { setBusy(false); }
  };
  const startRebuild = () => showAppDialog({
    title: '重建全部索引',
    message: '将请求当前模型生成全部可用表情的新向量，可能产生 API 费用。全部成功后才替换旧索引；失败或取消保留旧数据。离开此页会取消本次重建。',
    buttons: [{ text: '取消', style: 'cancel' }, { text: '重建', onPress: () => {
      const controller = new AbortController();
      rebuildController.current = controller;
      void perform(async () => {
        try {
          await rebuildStickerEmbeddingIndex(controller.signal);
          showAppDialog({ title: '索引已更新', message: '全部新向量已完整发布。', tone: 'success' });
        } catch (cause) {
          if (!controller.signal.aborted) throw cause;
        } finally { rebuildController.current = null; }
      });
    } }],
  });
  const openDetails = (item: StickerProcessingItem) => {
    setSelectedId(item.sticker.id); setEditing(false);
    setShowErrors(false);
    setName(item.sticker.name); setDescription(item.sticker.description ?? '');
    setTags(item.sticker.tags.join('、')); setEmotion(item.sticker.emotion ?? '');
  };

  const button = (label: string, onPress: () => void, disabled = false) => (
    <TouchableOpacity accessibilityRole="button" disabled={disabled} onPress={onPress}
      style={[styles.button, disabled && styles.disabled]}><Text style={styles.buttonText}>{label}</Text></TouchableOpacity>
  );

  return <SafeAreaView style={styles.container} edges={['top', 'left', 'right', 'bottom']}>
    <NavigationHeader title="表情处理进度" onGoBack={onBack} help={{ sections: [
      { title: '两项独立进度', body: '识别生成表情含义，语义索引通过向量化支持按含义搜索。识别完成不代表索引已齐全；向量化失败不影响发送和关键词搜索。索引进度只统计已完成识别的表情。' },
      { title: '识别与手动填写', body: '自动识别仅在 App 前台空闲时运行，切到后台会暂停。关闭后仍可请求单张识别；动态图需手动填写含义。识别失败可点开表情查看原因、重新识别或手动填写。' },
      { title: '补齐与重建', body: '已有匹配索引时可补齐缺失项；向量化失败项保留原因，手动补齐或重建后才再次请求。重建全部索引会请求当前模型重新向量化，全部成功后才替换旧索引，失败或取消保留旧数据；离开此页会取消本页发起的重建。' },
    ] }} />
    <FlatList data={onlyFailed ? processingItems.filter(item => item.sticker.annotationStatus === 'failed' || item.embeddingError) : processingItems}
      keyExtractor={item => item.sticker.id} contentContainerStyle={styles.content}
      ListHeaderComponent={<View style={{ gap: 12 }}>
        {error && <Text style={styles.error}>进度加载失败：{error}</Text>}
        {!progress && !error && <ActivityIndicator />}
        {progress && <>
          <ThemedSurface variant="card" style={styles.card}>
            <Text style={styles.title}>识别</Text>
            {progress.automaticRecognitionEnabled ? <>
              <Text style={styles.secondary}>已完成 {ready} / {items.length} 张 · 剩余 {pending + (current ? 1 : 0)} 张 · 失败 {failed} · 待手填 {manual}</Text>
              <View style={styles.track}><View style={[styles.fill, { width: `${items.length ? ready / items.length * 100 : 0}%` }]} /></View>
            </> : <Text style={styles.secondary}>自动识别已关闭</Text>}
            {current ? <Text style={styles.secondary}>{current.manuallyRequested ? '手动单张识别' : '正在识别'}：{current.sticker.name}
              {current.annotationStartedAt && <ElapsedTime startedAt={current.annotationStartedAt} />}</Text>
              : pending > 0 && (progress.automaticRecognitionEnabled || items.some(item => item.manuallyRequested)) ? <Text style={styles.secondary}>{progress.recognitionModel.status === 'unconfigured' ? '未配置视觉识别模型，队列已暂停'
                : progress.recognitionModel.status !== 'active' ? '所选视觉识别模型不可用，队列已暂停'
                  : progress.automaticRecognitionEnabled ? '等待前台空闲时继续识别' : '手动单张请求等待处理'}</Text> : null}
          </ThemedSurface>
          <ThemedSurface variant="card" style={styles.card}>
            <Text style={styles.title}>语义索引</Text>
            <Text style={styles.secondary}>有效 {vectors} / {ready} 张 · 待建立 {ready - vectors} 张 · 最近失败 {vectorFailed} 张</Text>
            {progress.embeddingModel.status === 'unconfigured' ? <Text style={styles.secondary}>未配置向量化模型，当前使用关键词搜索。</Text>
              : progress.embeddingModel.status !== 'active' ? <Text style={styles.error}>所选向量模型不可用，请在表情包系统中修改配置。</Text>
                : !progress.embeddingCanBackfill ? <Text style={styles.secondary}>当前模型没有匹配索引，请手动重建；旧索引数据保留。</Text>
                  : vectors < ready && <Text style={styles.secondary}>已有匹配索引仍然有效，只需补齐其余 {ready - vectors} 张。</Text>}
            {activity && <Text style={styles.secondary}>{activity.kind === 'rebuild' ? `重建中 ${activity.completed} / ${activity.total}，全部成功后发布` : `正在向量化 ${activity.total} 张`}
              <ElapsedTime key={activity.startedAt} startedAt={activity.startedAt} /></Text>}
            <View style={styles.actions}>
              {button('补齐索引', () => { void perform(() => backfillMissingStickerEmbeddings()); }, busy || !progress.embeddingCanBackfill)}
              {button('重建全部索引', startRebuild, busy || progress.embeddingModel.status !== 'active')}
              {rebuildController.current && button('取消重建', () => rebuildController.current!.abort())}
            </View>
          </ThemedSurface>
          <View style={styles.actions}>{button(onlyFailed ? '查看待处理' : '只看失败', () => setOnlyFailed(value => !value))}</View>
        </>}
      </View>}
      ListEmptyComponent={progress ? <Text style={styles.secondary}>{onlyFailed ? '没有失败项' : '当前没有待处理项，成功的表情可在图库中查看。'}</Text> : null}
      renderItem={({ item }) => <TouchableOpacity accessibilityRole="button" onPress={() => openDetails(item)}>
        <ThemedSurface variant="card" style={[styles.card, styles.row]}>
          <StickerThumbnail sticker={item.sticker} style={styles.thumbnail} />
          <View style={styles.flex}>
            <Text style={styles.title} numberOfLines={1}>{item.sticker.name}</Text>
            <Text style={item.sticker.annotationStatus === 'failed' ? styles.error : styles.secondary}>
              {annotationText(item)}
              {item.annotationStartedAt && <ElapsedTime startedAt={item.annotationStartedAt} />}</Text>
            {item.sticker.annotationStatus === 'ready' && <Text style={styles.secondary}>
              {stickerVectorStatusText[item.vectorStatus]}{item.vectorStatus === 'failed' ? ' · 不影响发送' : ''}</Text>}
          </View>
        </ThemedSurface>
      </TouchableOpacity>} />
    <ModalSheet visible={selected !== null} onClose={() => { setSelectedId(null); setEditing(false); }}
      title={selected?.sticker.name ?? '表情详情'}>
      {selected && <ScrollView style={styles.detailsScroll} contentContainerStyle={styles.fields} keyboardShouldPersistTaps="handled">
        <StickerThumbnail sticker={selected.sticker} style={styles.preview} />
        <Text style={styles.title}>{annotationText(selected)}</Text>
        {selected.sticker.annotationError && <Text selectable style={styles.error}>{selected.sticker.annotationError}</Text>}
        {selected.sticker.annotationStatus === 'ready' && <Text style={styles.secondary}>{stickerVectorStatusText[selected.vectorStatus]} · 向量状态不影响发送和关键词搜索</Text>}
        {selected.embeddingError && <Text selectable style={styles.error}>最近一次向量请求失败：{selected.embeddingError}{selected.hasEmbedding ? '\n已有有效索引仍可使用。' : ''}</Text>}
        <View style={styles.actions}>
          {selected.sticker.annotationStatus !== 'ready' && selected.sticker.annotationStatus !== 'processing' && !selected.sticker.isAnimated && button(selected.sticker.annotationStatus === 'failed' ? '重新识别' : '识别此张', () => {
            void perform(() => retryStickerAnnotation(selected.sticker.id));
          }, busy || selected.manuallyRequested)}
          {(selected.sticker.annotationStatus === 'failed' || selected.sticker.annotationStatus === 'manual_required' || selected.sticker.annotationStatus === 'pending') && button('手动填写含义', () => setEditing(true), busy)}
          {selected.sticker.annotationStatus === 'ready' && !selected.hasEmbedding && progress?.embeddingCanBackfill && button('补齐此张向量', () => {
            void perform(() => backfillMissingStickerEmbeddings(selected.sticker.id));
          }, busy || selected.vectorStatus === 'processing')}
        </View>
        {editing && <View style={{ marginTop: 16 }}>
          <InputField label="名称（必填）" value={name} onChangeText={setName} maxLength={120} error={showErrors ? nameError : undefined} />
          <InputField label="含义与使用语境（必填）" value={description} onChangeText={setDescription} multiline autoGrow
            hint="填写画面含义或使用场景，才能完成手动识别。" error={showErrors ? descriptionError : undefined} />
          <InputField label="标签（选填，顿号分隔）" value={tags} onChangeText={setTags} />
          <InputField label="情绪（选填）" value={emotion} onChangeText={setEmotion} />
          {button('保存含义', () => {
            setShowErrors(true);
            if (nameError || descriptionError) return;
            void perform(async () => {
              await completeStickerAnnotationManually(selected.sticker.id, { name, description,
                tags: tags.split(/[、,，]/).map(tag => tag.trim()).filter(Boolean), emotion });
              setEditing(false);
            });
          }, busy)}
        </View>}
      </ScrollView>}
    </ModalSheet>
  </SafeAreaView>;
}
