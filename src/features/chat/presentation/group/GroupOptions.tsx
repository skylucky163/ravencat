/** 群聊信息页：群头像、群名称、成员、管理员入口、聊天背景与删除群聊。 */

import React, { useCallback, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Camera, ChevronRight, Pencil } from 'lucide-react-native';
import { useTheme, useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { GroupAvatar, KeyboardAvoidingContainer, showAppDialog } from '@shared/ui';
import {
  PERSISTENT_IMAGE_CATEGORY,
  usePersistentAvatarDraft,
  type PersistentAvatarDraft,
} from '@platform/device/DeviceMediaService';
import ChatWallpaperSettings from '../messages/components/ChatWallpaperSettings';
import { LongPasteToggle } from '../messages/components/LongPasteToggle';
import GroupMembersSection from './GroupMembersSection';
import type {
  GroupChatDetails,
  GroupChat,
  UpdateGroupChatProfileInput,
} from '../../group/domain/GroupChat';

interface GroupOptionsProps {
  groupId: string;
  groupDetails?: GroupChatDetails | null;
  chatBackgroundKey: string;
  onBack?: () => void;
  onAdminSettings?: () => void;
  onSummary(): void;
  onSearchMessages(): void;
  onDeleteGroup?: () => void | Promise<void>;
  onUpdateProfile?: (input: UpdateGroupChatProfileInput, draft?: PersistentAvatarDraft | null) => Promise<GroupChat>;
}

const createStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background.screen,
    },
    scrollView: {
      flex: 1,
    },
    heroCard: {
      alignItems: 'center',
      backgroundColor: theme.colors.surface.default,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.xl,
      paddingBottom: theme.spacing.lg,
      marginBottom: theme.spacing.md,
    },
    avatarWrapper: {
      position: 'relative',
    },
    avatarEditBadge: {
      position: 'absolute',
      right: -2,
      bottom: -2,
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: theme.colors.brand.primary,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
      borderColor: theme.colors.surface.default,
    },
    nameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: theme.spacing.md,
      gap: 6,
    },
    groupName: {
      fontSize: 17,
      fontWeight: '600',
      color: theme.colors.text.primary,
    },
    nameInput: {
      marginTop: theme.spacing.md,
      minWidth: 160,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 6,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.brand.primary,
      fontSize: 17,
      fontWeight: '600',
      color: theme.colors.text.primary,
      textAlign: 'center',
    },
    menuItem: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface.default,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: 16,
      marginBottom: theme.spacing.md,
    },
    menuItemTitle: {
      flex: 1,
      fontSize: 16,
      color: theme.colors.text.primary,
    },
    dangerItem: {
      justifyContent: 'center',
    },
    dangerTitle: {
      flex: 0,
      color: theme.colors.feedback.error,
    },
    // 壁纸组件自带 marginTop 与上下 8px 分隔带，在本页与其他分区节奏叠加会显得缝隙过大
    wallpaperSection: {
      marginTop: 0,
      borderTopWidth: 0,
      borderBottomWidth: 0,
      marginBottom: theme.spacing.md,
    },
  });

export default function GroupOptions({
  groupId,
  groupDetails,
  chatBackgroundKey,
  onBack,
  onAdminSettings,
  onSummary,
  onSearchMessages,
  onDeleteGroup,
  onUpdateProfile,
}: GroupOptionsProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);

  const group = groupDetails?.group;
  const groupName = group?.name || '群聊';

  const {
    avatarUri,
    isPickingAvatar,
    isCommittingAvatar,
    pickAvatar,
    resetAvatar,
    discardAvatarDraft,
    commitAvatar,
  } = usePersistentAvatarDraft({
    category: PERSISTENT_IMAGE_CATEGORY.groupAvatar,
    entityId: groupId,
    committedUri: group?.avatar ?? null,
  });
  const avatarBusy = isPickingAvatar || isCommittingAvatar;

  const [isEditingName, setIsEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  // 名称只在失焦时提交；ref 同时防止重复 blur 产生第二次写入。
  const nameEditingRef = useRef(false);
  const nameInputRef = useRef<TextInput>(null);

  const persistProfile = useCallback(async (input: UpdateGroupChatProfileInput, draft?: PersistentAvatarDraft | null) => {
    if (!onUpdateProfile) {
      throw new Error('群聊资料更新能力不可用');
    }
    return onUpdateProfile(input, draft);
  }, [onUpdateProfile]);

  const showProfileUpdateError = useCallback((error: unknown) => {
    showAppDialog({ title: '错误', message: error instanceof Error ? error.message : '更新群聊信息失败', tone: 'error' });
  }, []);

  const handleChangeAvatar = useCallback(async () => {
    try {
      const result = await pickAvatar();
      if (result.status === 'permission-denied') {
        showAppDialog({ title: '需要权限', message: '请允许访问相册以选择群头像', tone: 'warning' });
        return;
      }
      if (result.status !== 'selected') {
        return;
      }
      await commitAvatar((uri, draft) => persistProfile({ avatar: uri }, draft), (group) => group.avatar);
    } catch (error) {
      await discardAvatarDraft();
      showProfileUpdateError(error);
    }
  }, [commitAvatar, discardAvatarDraft, persistProfile, pickAvatar, showProfileUpdateError]);

  const handleResetAvatar = useCallback(async () => {
    try {
      const reset = await resetAvatar();
      if (!reset) {
        return;
      }
      await commitAvatar((uri) => persistProfile({ avatar: uri }), (group) => group.avatar);
    } catch (error) {
      await discardAvatarDraft();
      showProfileUpdateError(error);
    }
  }, [commitAvatar, discardAvatarDraft, persistProfile, resetAvatar, showProfileUpdateError]);

  const handleAvatarPress = useCallback(() => {
    if (!onUpdateProfile || avatarBusy) {
      return;
    }
    showAppDialog({ title: '群聊头像', message: '你可以从相册选择群头像，或恢复默认头像。', buttons: [
      { text: '取消', style: 'cancel' as const },
      ...(avatarUri
        ? [{ text: '恢复默认', onPress: () => void handleResetAvatar() }]
        : []),
      { text: '从相册选择', onPress: () => void handleChangeAvatar() },
    ] });
  }, [avatarBusy, avatarUri, handleChangeAvatar, handleResetAvatar, onUpdateProfile]);

  const startEditingName = useCallback(() => {
    if (!onUpdateProfile) {
      return;
    }
    setNameDraft(group?.name || '');
    nameEditingRef.current = true;
    setIsEditingName(true);
  }, [group?.name, onUpdateProfile]);

  const commitName = useCallback(() => {
    if (!nameEditingRef.current) {
      return;
    }
    nameEditingRef.current = false;
    setIsEditingName(false);

    const nextName = nameDraft.trim();
    if (!nextName || nextName === group?.name) {
      return;
    }
    void persistProfile({ name: nextName }).catch(showProfileUpdateError);
  }, [group?.name, nameDraft, persistProfile, showProfileUpdateError]);

  const finishNameEditing = useCallback(() => {
    if (!nameEditingRef.current) {
      return;
    }
    nameInputRef.current?.blur();
  }, []);

  const handleDeleteGroup = () => {
    if (!onDeleteGroup) return;

    showAppDialog({
      title: '删除群聊',
      message: `删除「${groupName}」将清空该群聊的所有消息和设置，确定吗？`,
      buttons: [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: onDeleteGroup,
        },
      ],
    });
  };

  return (
    <SafeAreaView
      style={styles.container}
      edges={['top', 'left', 'right']}
      onTouchStart={finishNameEditing}
    >
      <NavigationHeader title="群聊信息" onGoBack={onBack} />

      <KeyboardAvoidingContainer style={styles.scrollView}>
        <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <View style={styles.heroCard}>
            <TouchableOpacity
              style={styles.avatarWrapper}
              activeOpacity={0.8}
              onPress={handleAvatarPress}
              disabled={avatarBusy}
            >
              <GroupAvatar
                name={groupName}
                avatarUrl={avatarUri}
                size="large"
              />
              <View style={styles.avatarEditBadge}>
                <Camera size={13} color={theme.colors.brand.onPrimary} />
              </View>
            </TouchableOpacity>

            {isEditingName ? (
              <TextInput
                ref={nameInputRef}
                style={styles.nameInput}
                value={nameDraft}
                onChangeText={setNameDraft}
                autoFocus
                maxLength={30}
                blurOnSubmit
                returnKeyType="done"
                onTouchStart={(event) => event.stopPropagation()}
                onSubmitEditing={finishNameEditing}
                onBlur={commitName}
              />
            ) : (
              <View style={styles.nameRow}>
                <Text style={styles.groupName}>{groupName}</Text>
                <TouchableOpacity
                  onPress={startEditingName}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Pencil size={15} color={theme.colors.text.secondary} />
                </TouchableOpacity>
              </View>
            )}
          </View>

          <GroupMembersSection groupId={groupId} members={groupDetails?.members ?? []} />

          <TouchableOpacity style={styles.menuItem} activeOpacity={0.7} onPress={onSearchMessages}>
            <Text style={styles.menuItemTitle}>搜索聊天记录</Text>
            <ChevronRight size={18} color={theme.colors.text.tertiary} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.menuItem}
            activeOpacity={0.7}
            onPress={onAdminSettings}
          >
            <Text style={styles.menuItemTitle}>管理员设置</Text>
            <ChevronRight size={18} color={theme.colors.text.tertiary} />
          </TouchableOpacity>

          <TouchableOpacity style={styles.menuItem} activeOpacity={0.7} onPress={onSummary}>
            <Text style={styles.menuItemTitle}>聊天摘要</Text>
            <ChevronRight size={18} color={theme.colors.text.tertiary} />
          </TouchableOpacity>

          <View style={styles.menuItem}>
            <LongPasteToggle style={{ flex: 1, paddingVertical: 0 }} />
          </View>
          <ChatWallpaperSettings
            chatKey={chatBackgroundKey}
            style={styles.wallpaperSection}
          />

          <TouchableOpacity
            style={[styles.menuItem, styles.dangerItem]}
            activeOpacity={0.7}
            onPress={handleDeleteGroup}
          >
            <Text style={[styles.menuItemTitle, styles.dangerTitle]}>删除群聊</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingContainer>
    </SafeAreaView>
  );
}
