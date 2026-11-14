/**
 * Moment 图片的大图查看与本机用户的描述管理入口，不区分发布者。
 *
 * 观看与手势复用共享 ImageViewerModal：单击图片即退出。业务操作只在 footer 中出现。
 * 识别描述**不在查看器内直接展示**：长文本会遮挡图片，且压图白字可读性差。
 */
import { ImageViewerModal, showAppDialog, type ImageViewerSource } from '@shared/ui';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, Modal, StyleSheet, Text, TextInput, TouchableOpacity, View, type ImageSourcePropType,
} from 'react-native';
import { resolveMediaAsset } from '@features/media';
import type { MomentRecordMedia } from '../presentationFacade';
import {
  retryMomentMediaAnalysis,
  saveMomentMediaAnalysis,
} from '../presentationFacade';

interface Props {
  visible: boolean;
  media: readonly MomentRecordMedia[];
  initialIndex: number;
  onClose: () => void;
  onUpdated: () => void;
}

const styles = StyleSheet.create({
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

function statusTextOf(media: MomentRecordMedia): string {
  if (media.analysisStatus === 'pending') return '图片描述识别中';
  if (media.analysisStatus === 'failed') return '图片识别失败，当前没有可靠描述';
  return media.analysisSource === 'user' ? '用户编辑的图片描述' : '模型识别的图片描述';
}

export default function MomentMediaViewerModal({
  visible, media, initialIndex, onClose, onUpdated,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<MomentRecordMedia | null>(null);
  const [draft, setDraft] = useState('');
  const [sources, setSources] = useState<readonly ImageViewerSource[]>(() => media.map(() => null));

  // 查看器只认已解析的本地地址；解析失败由查看器展示不可用态。
  useEffect(() => {
    let active = true;
    setSources(media.map(() => null));
    void Promise.all(media.map(item => resolveMediaAsset(item.mediaAssetId)
      .then(resolved => ({ uri: resolved.localUri }) as ImageSourcePropType)
      .catch(() => 'unavailable' as const)))
      .then(resolved => { if (active) setSources(resolved); });
    return () => { active = false; };
  }, [media]);

  const retry = async (item: MomentRecordMedia) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await retryMomentMediaAnalysis(item.id);
      if (result.success === false) showAppDialog({ title: '重新识别失败', message: `${result.errorMessage}\n\n原有的可靠描述（如有）已保留。`, tone: 'error' });
      onUpdated();
    } catch (error) {
      showAppDialog({ title: '重新识别失败', message: error instanceof Error ? error.message : '请稍后重试，原有描述未被修改。', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editing || !draft.trim() || busy) return;
    setBusy(true);
    try {
      await saveMomentMediaAnalysis(editing.id, draft);
      setEditing(null);
      onUpdated();
    } catch {
      showAppDialog({ title: '保存失败', message: '图片描述不能为空，且最多 4000 个字符。', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ImageViewerModal
        visible={visible}
        sources={sources}
        initialIndex={initialIndex}
        onClose={onClose}
        footer={(index) => {
          const item = media[index];
          if (!item) return null;
          return (
            <>
              <Text style={styles.status}>{statusTextOf(item)}</Text>
              <View style={styles.actions}>
                {item.analysisStatus === 'failed' ? (
                  <TouchableOpacity
                    style={styles.action}
                    onPress={() => showAppDialog({
                      title: '图片识别失败',
                      message: item.analysisErrorMessage ?? '这条记录未保存具体原因，请重新识别以获取当前错误信息。',
                      tone: 'error',
                    })}
                  >
                    <Text style={styles.actionText}>失败原因</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity style={styles.action} onPress={() => void retry(item)} disabled={busy}>
                  {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.actionText}>重新识别</Text>}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.action}
                  onPress={() => { setDraft(item.analysisText ?? ''); setEditing(item); }}
                  disabled={busy}
                >
                  <Text style={styles.actionText}>编辑描述</Text>
                </TouchableOpacity>
              </View>
            </>
          );
        }}
      />
      {editing ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => setEditing(null)}>
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
                <TouchableOpacity style={styles.action} onPress={() => setEditing(null)}>
                  <Text style={styles.actionText}>取消</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.action} onPress={() => void saveEdit()} disabled={!draft.trim() || busy}>
                  <Text style={styles.actionText}>保存</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      ) : null}
    </>
  );
}
