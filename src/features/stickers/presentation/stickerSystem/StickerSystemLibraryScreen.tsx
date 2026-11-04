/** 表情包图库：全部收藏项的浏览与基础 metadata 管理。 */

import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ThemedSurface, useTheme } from '@shared/theme';
import { EmptyState, InputField, ModalSheet, showAppDialog } from '@shared/ui';
import {
  deleteStickerFromLibrary,
  editStickerMetadata,
  toggleStickerFavorite,
} from '../../application/StickerCommands';
import { listStickerGroups, listStickers } from '../../application/StickerQueries';
import type { Sticker, StickerGroup } from '../../domain/Sticker';
import { useStickerSystemStyles } from './styles';
import { StickerAnnotationStatus } from './StickerAnnotationStatus';
import { StickerThumbnail } from './StickerThumbnail';
import { useStickerProcessingProgress } from './useStickerProcessingProgress';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function StickerSystemLibraryScreen() {
  const styles = useStickerSystemStyles();
  const theme = useTheme();
  const { progress } = useStickerProcessingProgress();
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [groups, setGroups] = useState<StickerGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Sticker | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftTags, setDraftTags] = useState('');
  const [draftEmotion, setDraftEmotion] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const nameError = draftName.trim() ? undefined : '请填写表情名称';

  const reload = useCallback(async () => {
    const [items, groupRows] = await Promise.all([
      listStickers({ mode: 'all' }),
      listStickerGroups(),
    ]);
    setStickers(items);
    setGroups(groupRows);
  }, []);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    reload().catch((error) => {
      showAppDialog({ title: '加载失败', message: getErrorMessage(error), tone: 'error' });
    }).finally(() => {
      if (mounted) setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, [reload]);

  const groupNameById = new Map(groups.map((group) => [group.id, group.name]));

  const openEditor = useCallback((sticker: Sticker) => {
    setEditing(sticker);
    setDraftName(sticker.name);
    setDraftDescription(sticker.description ?? '');
    setDraftTags(sticker.tags.join('、'));
    setDraftEmotion(sticker.emotion ?? '');
    setShowErrors(false);
  }, []);

  const handleSaveMetadata = useCallback(async () => {
    if (!editing) return;
    setShowErrors(true);
    if (nameError) return;
    try {
      await editStickerMetadata(editing.id, {
        name: draftName,
        description: draftDescription,
        tags: draftTags.split(/[、,，]/).map((tag) => tag.trim()).filter(Boolean),
        emotion: draftEmotion,
      });
      setEditing(null);
      await reload();
    } catch (error) {
      showAppDialog({ title: '保存失败', message: getErrorMessage(error), tone: 'error' });
    }
  }, [draftDescription, draftEmotion, draftName, draftTags, editing, nameError, reload]);

  const handleDelete = useCallback((sticker: Sticker) => {
    showAppDialog({
      title: '删除表情包',
      message: `确定从收藏库删除「${sticker.name}」吗？历史聊天消息不受影响。`,
      buttons: [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            deleteStickerFromLibrary(sticker.id).then(() => reload()).catch((error) => {
              showAppDialog({ title: '删除失败', message: getErrorMessage(error), tone: 'error' });
            });
          },
        },
      ],
    });
  }, [reload]);

  return (
    <View style={styles.container}>
      {loading ? (
        <Text style={styles.stateText}>正在加载…</Text>
      ) : stickers.length === 0 ? (
        <EmptyState title="还没有表情包" description="在聊天输入面板中导入表情包后，会出现在这里。" />
      ) : (
        <FlatList
          data={stickers}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.sm }}
          renderItem={({ item }) => (
            <ThemedSurface variant="card" nativeGlass={false} style={[styles.card, { marginHorizontal: 0, marginBottom: theme.spacing.sm }]}>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`编辑「${item.name}」`}
                activeOpacity={0.7}
                style={[styles.row, { borderBottomWidth: 0 }]}
                onPress={() => openEditor(item)}
              >
                <StickerThumbnail sticker={item} style={styles.thumbnail} />
                <View style={{ flex: 1, marginLeft: theme.spacing.md }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <StickerAnnotationStatus
                    status={progress?.items.find(row => row.sticker.id === item.id)?.sticker.annotationStatus ?? item.annotationStatus}
                    automaticRecognitionEnabled={progress?.automaticRecognitionEnabled ?? null}
                    manuallyRequested={progress?.items.find(row => row.sticker.id === item.id)?.manuallyRequested ?? false}
                    style={styles.rowSubtitle} />
                  <Text style={styles.rowSubtitle} numberOfLines={1}>
                    {[
                      item.groupId ? groupNameById.get(item.groupId) ?? '未知分组' : '未分组',
                      item.emotion ?? null,
                      item.tags.slice(0, 3).join('、') || null,
                    ].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <TouchableOpacity
                  accessibilityLabel={item.isFavorite ? '取消收藏' : '收藏'}
                  style={styles.rowIconButton}
                  onPress={() => {
                    toggleStickerFavorite(item.id).then(reload).catch((error) => {
                      showAppDialog({ title: '操作失败', message: getErrorMessage(error), tone: 'error' });
                    });
                  }}
                >
                  <Ionicons
                    name={item.isFavorite ? 'star' : 'star-outline'}
                    size={20}
                    color={theme.colors.text.secondary}
                  />
                </TouchableOpacity>
              </TouchableOpacity>
            </ThemedSurface>
          )}
        />
      )}

      <ModalSheet
        visible={editing !== null}
        onClose={() => setEditing(null)}
        title="编辑表情信息"
      >
        <ScrollView style={styles.editorScroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.hint}>名称必填，其他信息选填。修改含义后，原向量需要更新。</Text>
          <View style={{ paddingHorizontal: theme.spacing.lg }}>
            {editing && <StickerThumbnail sticker={editing} style={styles.preview} />}
            <InputField label="名称（必填）" value={draftName} onChangeText={setDraftName} maxLength={120} error={showErrors ? nameError : undefined} />
            <InputField label="含义/描述（选填）" value={draftDescription} onChangeText={setDraftDescription} multiline autoGrow
              hint={editing?.annotationStatus !== 'ready' ? '留空仅保存其他信息；补充含义后可完成手动标注。' : undefined} />
            <InputField label="标签（选填，用顿号分隔）" value={draftTags} onChangeText={setDraftTags} />
            <InputField label="情绪（选填）" value={draftEmotion} onChangeText={setDraftEmotion} />
          </View>
        </ScrollView>
        <View style={styles.actionRow}>
          <TouchableOpacity
            accessibilityLabel={`从收藏库删除「${editing?.name ?? ''}」`}
            style={styles.actionButton}
            onPress={() => {
              if (!editing) return;
              const target = editing;
              setEditing(null);
              handleDelete(target);
            }}
          >
            <Text style={[styles.actionButtonText, styles.dangerActionText]}>删除</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionButton} onPress={() => setEditing(null)}>
            <Text style={styles.actionButtonText}>取消</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => void handleSaveMetadata()}
          >
            <Text style={styles.actionButtonText}>保存</Text>
          </TouchableOpacity>
        </View>
      </ModalSheet>
    </View>
  );
}
