/**
 * Moment 图片的大图查看与用户所有者 analysis 管理入口。
 *
 * 识别描述**不在查看器内直接展示**：长文本会遮挡图片，且压图白字可读性差。
 * 识别内容只在「编辑描述」弹窗中查看与修改；查看器只保留来源状态提示。
 */
import { showAppDialog } from '@shared/ui';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, StyleSheet, Text, TextInput, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MomentRecordMedia } from '../presentationFacade';
import { MediaAssetImage } from '@features/media';
import {
  retryMomentMediaAnalysis,
  saveMomentMediaAnalysis,
} from '../presentationFacade';

interface Props {
  visible: boolean;
  media: readonly MomentRecordMedia[];
  initialIndex: number;
  canManage: boolean;
  onClose: () => void;
  onUpdated: () => void;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#050505' },
  close: {
    position: 'absolute', right: 16, zIndex: 2, width: 40, height: 40,
    borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  page: { justifyContent: 'center', alignItems: 'center' },
  image: { width: '100%', height: '78%' },
  footer: { position: 'absolute', left: 16, right: 16, bottom: 24, alignItems: 'center' },
  pageText: { color: '#fff', marginBottom: 12 },
  status: { color: 'rgba(255,255,255,0.65)', fontSize: 13, marginBottom: 12 },
  actions: { flexDirection: 'row', gap: 12 },
  action: { backgroundColor: 'rgba(255,255,255,0.16)', borderRadius: 18, paddingHorizontal: 16, paddingVertical: 9 },
  actionText: { color: '#fff', fontWeight: '600' },
  editorBackdrop: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: 'rgba(0,0,0,0.72)' },
  editor: { borderRadius: 16, padding: 18, backgroundColor: '#202020' },
  editorTitle: { color: '#fff', fontWeight: '700', fontSize: 17, marginBottom: 12 },
  editorInput: { minHeight: 120, color: '#fff', backgroundColor: '#303030', borderRadius: 10, padding: 12, textAlignVertical: 'top' },
  editorActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 14 },
});

export default function MomentMediaViewerModal({
  visible, media, initialIndex, canManage, onClose, onUpdated,
}: Props) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(initialIndex);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList<MomentRecordMedia>>(null);

  useEffect(() => {
    if (!visible) return;
    setIndex(initialIndex);
    requestAnimationFrame(() => listRef.current?.scrollToIndex({ index: initialIndex, animated: false }));
  }, [initialIndex, visible]);

  const current = media[index] ?? null;
  const statusText = useMemo(() => {
    if (!current) return '';
    if (current.analysisStatus === 'pending') return '图片描述识别中';
    if (current.analysisStatus === 'failed') return '图片识别失败，当前没有可靠描述';
    return current.analysisSource === 'user' ? '用户编辑的图片描述' : '模型识别的图片描述';
  }, [current]);

  const retry = async () => {
    if (!current || busy) return;
    setBusy(true);
    try {
      const result = await retryMomentMediaAnalysis(current.id);
      if (result.success === false) showAppDialog({ title: '重新识别失败', message: `${result.errorMessage}\n\n原有的可靠描述（如有）已保留。`, tone: 'error' });
      onUpdated();
    } catch (error) {
      showAppDialog({ title: '重新识别失败', message: error instanceof Error ? error.message : '请稍后重试，原有描述未被修改。', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!current || !draft.trim() || busy) return;
    setBusy(true);
    try {
      await saveMomentMediaAnalysis(current.id, draft);
      setEditing(false);
      onUpdated();
    } catch {
      showAppDialog({ title: '保存失败', message: '图片描述不能为空，且最多 4000 个字符。', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.root}>
        <TouchableOpacity style={[styles.close, { top: insets.top + 10 }]} onPress={onClose}>
          <X color="#fff" size={24} />
        </TouchableOpacity>
        <FlatList
          ref={listRef}
          data={[...media]}
          horizontal
          pagingEnabled
          keyExtractor={(item) => item.id}
          initialScrollIndex={initialIndex}
          getItemLayout={(_, itemIndex) => ({ length: width, offset: width * itemIndex, index: itemIndex })}
          onMomentumScrollEnd={(event) => setIndex(Math.round(event.nativeEvent.contentOffset.x / width))}
          renderItem={({ item }) => (
            <View style={[styles.page, { width, height }]}>
              <MediaAssetImage mediaAssetId={item.mediaAssetId} style={styles.image} resizeMode="contain" color="rgba(255,255,255,0.65)" />
            </View>
          )}
        />
        {current ? (
          <View style={[styles.footer, { bottom: insets.bottom + 16 }]}>
            <Text style={styles.pageText}>{index + 1} / {media.length}</Text>
            <Text style={styles.status}>{statusText}</Text>
            {canManage ? (
              <View style={styles.actions}>
                {current.analysisStatus === 'failed' ? (
                  <TouchableOpacity
                    style={styles.action}
                    onPress={() => showAppDialog({
                      title: '图片识别失败',
                      message: current.analysisErrorMessage ?? '这条记录未保存具体原因，请重新识别以获取当前错误信息。',
                      tone: 'error',
                    })}
                  >
                    <Text style={styles.actionText}>失败原因</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity style={styles.action} onPress={retry} disabled={busy}>
                  {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.actionText}>重新识别</Text>}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.action}
                  onPress={() => { setDraft(current.analysisText ?? ''); setEditing(true); }}
                  disabled={busy}
                >
                  <Text style={styles.actionText}>编辑描述</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
      <Modal visible={editing} transparent animationType="fade" onRequestClose={() => setEditing(false)}>
        <View style={styles.editorBackdrop}>
          <View style={styles.editor}>
            <Text style={styles.editorTitle}>编辑图片描述</Text>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              style={styles.editorInput}
              multiline
              maxLength={4000}
              placeholder="准确描述图片内容"
              placeholderTextColor="rgba(255,255,255,0.45)"
            />
            <View style={styles.editorActions}>
              <TouchableOpacity style={styles.action} onPress={() => setEditing(false)}>
                <Text style={styles.actionText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.action} onPress={saveEdit} disabled={!draft.trim() || busy}>
                <Text style={styles.actionText}>保存</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </Modal>
  );
}
