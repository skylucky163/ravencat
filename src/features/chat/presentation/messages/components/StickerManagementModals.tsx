/** Sticker 面板的收藏项与管理弹窗。 */

import { InputField, KeyboardAvoidingContainer, showAppDialog } from '@shared/ui';
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  StickerProcessingSummary,
  type Sticker,
  type StickerGroup,
  type StickerProcessingProgress,
} from '@features/stickers';
import { ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import {
  STICKER_MODAL_CARD_RADIUS,
  createStickerManagementModalStyles,
} from './stickerManagementModalStyles';

export interface StickerManagementInput {
  name: string;
  description: string;
  tags: string[];
  emotion: string;
  groupId: string | null;
}

interface StickerManagementModalsProps {
  sticker: Sticker | null;
  groups: StickerGroup[];
  progress: StickerProcessingProgress | null;
  progressError: string | null;
  stickerVisible: boolean;
  managementVisible: boolean;
  onStickerClose: () => void;
  onStickerSave: (input: StickerManagementInput) => Promise<void>;
  onStickerDelete: () => Promise<void>;
  onToggleFavorite: () => Promise<void>;
  onManagementClose: () => void;
  onProgressPress: () => void;
  onGroupCreate: (name: string) => Promise<void>;
  onGroupRename: (groupId: string, name: string) => Promise<void>;
  onGroupDelete: (groupId: string) => Promise<void>;
}

function StickerEditorModal({
  sticker,
  groups,
  visible,
  onStickerClose: onClose,
  onStickerSave: onSave,
  onStickerDelete: onDelete,
  onToggleFavorite,
}: Pick<
  StickerManagementModalsProps,
  'sticker' | 'groups' | 'onStickerClose' | 'onStickerSave' | 'onStickerDelete' | 'onToggleFavorite'
> & { visible: boolean }) {
  const theme = useTheme();
  const styles = useThemedStyles(createStickerManagementModalStyles);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [emotion, setEmotion] = useState('');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const descriptionRequired = sticker?.annotationStatus === 'failed' || sticker?.annotationStatus === 'manual_required';
  const nameError = name.trim() ? undefined : '请填写表情名称';
  const descriptionError = descriptionRequired && !description.trim() ? '请填写含义/描述，才能完成手动识别' : undefined;

  useEffect(() => {
    if (!sticker) {
      return;
    }
    setName(sticker.name);
    setDescription(sticker.description || '');
    setTags(sticker.tags.join(' '));
    setEmotion(sticker.emotion || '');
    setGroupId(sticker.groupId);
    setShowErrors(false);
  }, [sticker]);

  const handleSave = useCallback(async () => {
    if (!sticker || isSaving) {
      return;
    }
    setShowErrors(true);
    if (nameError || descriptionError) return;
    setIsSaving(true);
    try {
      await onSave({
        name,
        description,
        tags: tags.split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean),
        emotion,
        groupId,
      });
      onClose();
    } catch (error) {
      showAppDialog({ title: '保存失败', message: error instanceof Error ? error.message : '保存表情包信息失败', tone: 'error' });
    } finally {
      setIsSaving(false);
    }
  }, [description, descriptionError, emotion, groupId, isSaving, name, nameError, onClose, onSave, sticker, tags]);

  const handleDelete = useCallback(() => {
    if (!sticker || isSaving) {
      return;
    }
    showAppDialog({
      title: '删除表情包',
      message: `确定从收藏库删除“${sticker.name}”吗？已发送的历史消息不会被改写。`,
      buttons: [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            setIsSaving(true);
            void onDelete()
              .then(onClose)
              .catch((error) => {
                showAppDialog({ title: '删除失败', message: error instanceof Error ? error.message : '删除表情包失败', tone: 'error' });
              })
              .finally(() => setIsSaving(false));
          },
        },
      ],
    });
  }, [isSaving, onClose, onDelete, sticker]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingContainer style={{ flex: 1 }}>
        <Pressable style={styles.overlay} onPress={onClose}>
          <Pressable style={[styles.card, { maxHeight: '100%' }]} onPress={() => undefined}>
            {/* 弹窗自己拥有材质：玻璃主题下靠原生玻璃提供底色，避免卡片直接铺半透明染色时透出底层文字。 */}
            <ThemedSurface
              variant="modal"
              cornerRadius={STICKER_MODAL_CARD_RADIUS}
              backgroundColor={theme.colors.surface.default}
              style={StyleSheet.absoluteFill}
            />
            <View style={styles.header}>
              <Text style={styles.title}>编辑表情包</Text>
              <TouchableOpacity onPress={onClose} hitSlop={8}>
                <Ionicons name="close" size={22} color={theme.colors.icon.primary} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled">
              <InputField label="名称（必填）" value={name} onChangeText={setName} maxLength={120}
                error={showErrors ? nameError : undefined} style={{ marginBottom: 9 }} inputStyle={[styles.input, { marginBottom: 0 }]} />
              <InputField label={descriptionRequired ? '含义/描述（必填）' : '含义/描述（选填）'}
                hint={descriptionRequired ? '填写画面含义或使用场景，才能完成手动识别。'
                  : sticker?.annotationStatus !== 'ready' ? '留空会保存为待手动填写；补充含义后可完成标注。' : '可说明画面含义和适合使用的场景。'}
                value={description} onChangeText={setDescription} multiline autoGrow maxLength={500}
                error={showErrors ? descriptionError : undefined} style={{ marginBottom: 9 }} inputStyle={[styles.input, { marginBottom: 0 }]} />
              <InputField label="标签（选填，空格或逗号分隔）" value={tags} onChangeText={setTags} maxLength={300}
                style={{ marginBottom: 9 }} inputStyle={[styles.input, { marginBottom: 0 }]} />
              <InputField label="情绪（选填）" value={emotion} onChangeText={setEmotion} maxLength={80}
                style={{ marginBottom: 9 }} inputStyle={[styles.input, { marginBottom: 0 }]} />
              <Text style={styles.sectionLabel}>分组</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipList}>
                <TouchableOpacity style={[styles.chip, groupId === null && styles.activeChip]} onPress={() => setGroupId(null)}>
                  <Text style={[styles.chipText, groupId === null && styles.activeChipText]}>未分组</Text>
                </TouchableOpacity>
                {groups.map((group) => (
                  <TouchableOpacity key={group.id} style={[styles.chip, groupId === group.id && styles.activeChip]} onPress={() => setGroupId(group.id)}>
                    <Text style={[styles.chipText, groupId === group.id && styles.activeChipText]}>{group.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </ScrollView>
            <View style={styles.actions}>
              <TouchableOpacity style={styles.secondaryButton} onPress={() => void onToggleFavorite()} disabled={isSaving}>
                <Text style={styles.secondaryButtonText}>{sticker?.isFavorite ? '取消收藏' : '收藏'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.deleteButton} onPress={handleDelete} disabled={isSaving}>
                <Text style={styles.deleteButtonText}>删除</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.primaryButton} onPress={() => void handleSave()} disabled={isSaving}>
                <Text style={styles.primaryButtonText}>{isSaving ? '保存中…' : '保存'}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingContainer>
    </Modal>
  );
}

function ManagementModal({
  groups,
  progress,
  progressError,
  visible,
  onManagementClose: onClose,
  onProgressPress,
  onGroupCreate: onCreate,
  onGroupRename: onRename,
  onGroupDelete: onDelete,
}: Pick<
  StickerManagementModalsProps,
  'groups' | 'progress' | 'progressError' | 'onManagementClose' | 'onProgressPress' | 'onGroupCreate' | 'onGroupRename' | 'onGroupDelete'
> & { visible: boolean }) {
  const theme = useTheme();
  const styles = useThemedStyles(createStickerManagementModalStyles);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setSelectedGroupId(null);
      setName('');
    }
  }, [visible]);

  const handleSubmit = useCallback(async () => {
    if (isSaving || !name.trim()) {
      return;
    }
    setIsSaving(true);
    try {
      if (selectedGroupId) {
        await onRename(selectedGroupId, name);
      } else {
        await onCreate(name);
      }
      setSelectedGroupId(null);
      setName('');
    } catch (error) {
      showAppDialog({ title: '分组保存失败', message: error instanceof Error ? error.message : '保存 Sticker 分组失败', tone: 'error' });
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, name, onCreate, onRename, selectedGroupId]);

  const handleDelete = useCallback((group: StickerGroup) => {
    if (isSaving) {
      return;
    }
    showAppDialog({
      title: '删除分组',
      message: `确定删除“${group.name}”吗？组内表情包会移到未分组。`,
      buttons: [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            setIsSaving(true);
            void onDelete(group.id)
              .then(() => {
                if (selectedGroupId === group.id) {
                  setSelectedGroupId(null);
                  setName('');
                }
              })
              .catch((error) => {
                showAppDialog({ title: '删除失败', message: error instanceof Error ? error.message : '删除 Sticker 分组失败', tone: 'error' });
              })
              .finally(() => setIsSaving(false));
          },
        },
      ],
    });
  }, [isSaving, onDelete, selectedGroupId]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingContainer style={{ flex: 1 }}>
        <Pressable style={styles.overlay} onPress={onClose}>
          <Pressable style={[styles.card, styles.managementCard]} onPress={() => undefined}>
            {/* 弹窗自己拥有材质：玻璃主题下靠原生玻璃提供底色，避免卡片直接铺半透明染色时透出底层文字。 */}
            <ThemedSurface
              variant="modal"
              cornerRadius={STICKER_MODAL_CARD_RADIUS}
              backgroundColor={theme.colors.surface.default}
              style={StyleSheet.absoluteFill}
            />
            <View style={styles.header}>
              <Text style={styles.title}>管理表情包</Text>
              <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel="关闭管理">
                <Ionicons name="close" size={22} color={theme.colors.icon.primary} />
              </TouchableOpacity>
            </View>
            <InputField
              label="分组名称"
              value={name}
              onChangeText={setName}
              placeholder={selectedGroupId ? '输入新的分组名称' : '输入新分组名称'}
              maxLength={80}
              style={styles.groupNameField}
              inputStyle={[styles.input, { marginBottom: 0 }]}
            />
            <ScrollView style={styles.groupList} keyboardShouldPersistTaps="handled">
              {groups.map((group) => (
                <View key={group.id} style={styles.groupRow}>
                  <TouchableOpacity
                    style={styles.groupSelect}
                    onPress={() => {
                      setSelectedGroupId(group.id);
                      setName(group.name);
                    }}
                  >
                    <Text style={styles.groupName} numberOfLines={1}>{group.name}</Text>
                    {selectedGroupId === group.id ? <Ionicons name="checkmark-circle" size={18} color={theme.colors.brand.primary} /> : null}
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => handleDelete(group)} hitSlop={8} accessibilityLabel={`删除分组${group.name}`}>
                    <Ionicons name="trash-outline" size={18} color={theme.colors.feedback.error} />
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>
            <View style={styles.actions}>
              {selectedGroupId ? (
                <TouchableOpacity style={styles.secondaryButton} onPress={() => { setSelectedGroupId(null); setName(''); }}>
                  <Text style={styles.secondaryButtonText}>新建分组</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity style={styles.primaryButton} onPress={() => void handleSubmit()} disabled={isSaving || !name.trim()}>
                <Text style={styles.primaryButtonText}>{isSaving ? '保存中…' : selectedGroupId ? '重命名' : '创建'}</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.progressSection}>
              <StickerProcessingSummary progress={progress} error={progressError} onPress={onProgressPress} />
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingContainer>
    </Modal>
  );
}

export default function StickerManagementModals(props: StickerManagementModalsProps) {
  return (
    <>
      <StickerEditorModal
        sticker={props.sticker}
        groups={props.groups}
        visible={props.stickerVisible}
        onStickerClose={props.onStickerClose}
        onStickerSave={props.onStickerSave}
        onStickerDelete={props.onStickerDelete}
        onToggleFavorite={props.onToggleFavorite}
      />
      <ManagementModal
        groups={props.groups}
        progress={props.progress}
        progressError={props.progressError}
        visible={props.managementVisible}
        onManagementClose={props.onManagementClose}
        onProgressPress={props.onProgressPress}
        onGroupCreate={props.onGroupCreate}
        onGroupRename={props.onGroupRename}
        onGroupDelete={props.onGroupDelete}
      />
    </>
  );
}
