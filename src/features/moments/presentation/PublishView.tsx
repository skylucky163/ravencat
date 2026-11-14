// 时刻发布界面：正文、图片、可选地点与可见范围。
// 发布时刻页面 - 简洁风格

import { AppTextInput, KeyboardAvoidingContainer, showAppDialog } from '@shared/ui';
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, BackHandler, Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { ChevronRight, ImagePlus, MapPin, X } from 'lucide-react-native';

import { useTheme } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import {
  MAX_MOMENT_MEDIA_COUNT,
  type MomentMediaDraft,
} from '../application/CreateUserMomentWithMedia';
import { MAX_MOMENT_LOCATION_LABEL_LENGTH } from '../domain/MomentLocation';
import type { MomentAudience } from '../domain/MomentRepository';
import type { MomentEditDraft, MomentEditorMedia } from '../application/EditMoment';
import { MediaAssetImage } from '@features/media';
import { listMomentAudienceCandidates } from '../presentationFacade';
import MomentAudienceSelectorModal from './MomentAudienceSelectorModal';
import { describeMomentEditFailure, describeMomentPublishFailure } from './momentActionFeedback';
import {
  DEFAULT_MOMENT_AUDIENCE_DRAFT,
  describeMomentAudienceDraft,
  toMomentAudience,
  type MomentAudienceCandidate,
  type MomentAudienceDraft,
} from './MomentAudienceDraft';

/** 发布页交给调用方的完整 draft；结构化传参，不依赖参数顺序。 */
export interface PublishMomentDraft {
  content: string;
  media: readonly MomentMediaDraft[];
  locationLabel: string | null;
  audience: MomentAudience;
}

type PublishMomentScreenProps = {
  onCancel: () => void;
} & ({
  mode?: 'create';
  initialDraft?: never;
  onPublish: (draft: PublishMomentDraft) => Promise<void> | void;
} | {
  mode: 'edit';
  initialDraft: MomentEditDraft;
  onPublish: (draft: MomentEditDraft) => Promise<void> | void;
});

function createPublishStyles(theme: PresentationTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background.app,
    },
    keyboardView: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.lg,
      paddingTop: 8,
      paddingBottom: theme.spacing.md,
      borderBottomWidth: 0.5,
      borderBottomColor: theme.colors.border.default,
      backgroundColor: theme.colors.surface.default,
    },
    cancelButton: {
      fontSize: 16,
      color: theme.colors.text.primary,
      fontWeight: '400',
    },
    headerTitle: {
      fontSize: 17,
      fontWeight: '600',
      color: theme.colors.text.primary,
    },
    publishButton: {
      backgroundColor: theme.colors.brand.primary,
      paddingHorizontal: 16,
      paddingVertical: 6,
      borderRadius: theme.radius.sm,
      minWidth: 60,
      alignItems: 'center',
    },
    publishButtonDisabled: {
      backgroundColor: theme.colors.text.tertiary,
      opacity: 0.6,
    },
    publishButtonText: {
      color: theme.colors.brand.onPrimary,
      fontSize: 14,
      fontWeight: '600',
    },
    inputContainer: {
      padding: theme.spacing.lg,
    },
    textInput: {
      minHeight: 144,
      maxHeight: 320,
      fontSize: 16,
      color: theme.colors.text.primary,
      lineHeight: 24,
      textAlignVertical: 'top',
    },
    charCount: {
      fontSize: 12,
      color: theme.colors.text.tertiary,
      textAlign: 'right',
      marginTop: theme.spacing.sm,
    },
    mediaSection: {
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: theme.spacing.lg,
    },
    mediaGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    mediaTile: {
      width: 92,
      height: 92,
      borderRadius: theme.radius.md,
      overflow: 'hidden',
      backgroundColor: theme.colors.surface.muted,
    },
    mediaImage: { width: '100%', height: '100%' },
    removeMedia: {
      position: 'absolute',
      top: 4,
      right: 4,
      width: 24,
      height: 24,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.65)',
    },
    addMedia: {
      width: 92,
      height: 92,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: theme.colors.border.default,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
    },
    addMediaText: { fontSize: 12, color: theme.colors.text.secondary },
    metaSection: {
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: theme.spacing.lg,
      gap: theme.spacing.sm,
    },
    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      minHeight: 44,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.surface.muted,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    metaIcon: { marginTop: 2 },
    metaInput: {
      flex: 1,
      fontSize: 15,
      color: theme.colors.text.primary,
      paddingVertical: 0,
    },
    metaPlaceholder: {
      flex: 1,
      fontSize: 15,
      color: theme.colors.text.tertiary,
    },
    metaRowLabel: {
      fontSize: 15,
      color: theme.colors.text.primary,
    },
    metaRowValue: {
      flex: 1,
      fontSize: 15,
      color: theme.colors.text.secondary,
      textAlign: 'right',
    },
    clearMeta: {
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 2,
    },
  });
}

export default function PublishMomentScreen(props: PublishMomentScreenProps) {
  const { initialDraft, onCancel } = props;
  const theme = useTheme();
  const styles = useMemo(() => createPublishStyles(theme), [theme]);
  const [content, setContent] = useState(initialDraft?.content ?? '');
  const [publishing, setPublishing] = useState(false);
  const [media, setMedia] = useState<MomentEditorMedia[]>(() => [...(initialDraft?.media ?? [])]);
  const [locationLabel, setLocationLabel] = useState(initialDraft?.locationLabel ?? '');
  const [audienceDraft, setAudienceDraft] = useState<MomentAudienceDraft>(
    initialDraft ? { mode: initialDraft.audience.mode, viewerAgentIds: initialDraft.audience.mode === 'all' ? [] : initialDraft.audience.viewerAgentIds } : DEFAULT_MOMENT_AUDIENCE_DRAFT
  );
  const [audienceCandidates, setAudienceCandidates] = useState<MomentAudienceCandidate[]>([]);
  const [audienceCandidatesLoading, setAudienceCandidatesLoading] = useState(false);
  const [showAudienceSelector, setShowAudienceSelector] = useState(false);

  // 候选身份来自 Assistant 目录的稳定 agentId；UI 不用名称或下标表示可见范围。
  useEffect(() => {
    let active = true;
    setAudienceCandidatesLoading(true);
    void listMomentAudienceCandidates()
      .then((candidates) => {
        if (active) setAudienceCandidates(candidates);
      })
      .catch((error: unknown) => {
        console.error('Failed to load moment audience candidates:', error);
      })
      .finally(() => {
        if (active) setAudienceCandidatesLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const canPublish = !!content.trim() && !publishing;

  const handlePublish = async () => {
    if (!canPublish) return;
    setPublishing(true);
    try {
      const draft = {
        content: content.trim(),
        media,
        locationLabel: locationLabel.trim() || null,
        audience: toMomentAudience(audienceDraft),
      };
      if (props.mode === 'edit') await props.onPublish(draft);
      else {
        // 发布模式没有初始资产引用，图片只可能来自本页相册选择。
        await props.onPublish({ ...draft, media: media as MomentMediaDraft[] });
      }
    } catch (error) {
      // 失败时保留正文 / 图片 / 地点 / 可见范围，用户可以直接改完重试。
      showAppDialog({ title: initialDraft ? '保存失败' : '发布失败', message: initialDraft ? describeMomentEditFailure(error) : describeMomentPublishFailure(error), tone: 'error' });
    } finally {
      setPublishing(false);
    }
  };

  const handlePickMedia = async () => {
    const remaining = MAX_MOMENT_MEDIA_COUNT - media.length;
    if (remaining <= 0) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      showAppDialog({ title: '需要权限', message: '请允许访问相册以选择时刻图片', tone: 'warning' });
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: remaining,
      quality: 1,
    });
    if (result.canceled) return;
    const selected = result.assets.map((asset) => ({
      uri: asset.uri,
      fileName: asset.fileName ?? null,
      mimeType: asset.mimeType ?? 'image/jpeg',
      width: asset.width ?? null,
      height: asset.height ?? null,
    }));
    setMedia((current) => {
      const uris = new Set(current.flatMap((item) => 'uri' in item ? [item.uri] : []));
      return [...current, ...selected.filter((item) => !uris.has(item.uri))]
        .slice(0, MAX_MOMENT_MEDIA_COUNT);
    });
  };

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!publishing) onCancel();
      return true;
    });
    return () => subscription.remove();
  }, [onCancel, publishing]);

  // 独立 push 页面：安全区由本组件自己负责（此前由 MomentsTab 内嵌渲染时代管）。
  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingContainer
        style={styles.keyboardView}
      >
        <View style={styles.header}>
          <TouchableOpacity onPress={onCancel} disabled={publishing} activeOpacity={0.7}>
            <Text style={styles.cancelButton}>取消</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{initialDraft ? '编辑时刻' : '发布时刻'}</Text>
          <TouchableOpacity
            onPress={handlePublish}
            disabled={!canPublish}
            style={[styles.publishButton, !canPublish && styles.publishButtonDisabled]}
            activeOpacity={0.7}
          >
            {publishing ? (
              <ActivityIndicator size="small" color={theme.colors.brand.onPrimary} />
            ) : (
              <Text style={styles.publishButtonText}>{initialDraft ? '保存' : '发布'}</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* 正文和附加选项共享滚动空间，键盘出现时不再互相挤压高度。 */}
        <ScrollView style={styles.keyboardView} pointerEvents={publishing ? 'none' : 'auto'}
          keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          <View style={styles.inputContainer}>
            <AppTextInput
              style={styles.textInput}
              autoGrow
              placeholder="这一刻的想法..."
              placeholderTextColor={theme.colors.text.tertiary}
              value={content}
              onChangeText={setContent}
              submitBehavior="newline"
              autoFocus
              maxLength={2000}
              textAlignVertical="top"
            />
            <Text style={styles.charCount}>{content.length}/2000</Text>
          </View>

          <View style={[styles.mediaSection, styles.mediaGrid]}>
            {media.map((item, index) => (
              <View key={'mediaAssetId' in item ? item.mediaAssetId : item.uri} style={styles.mediaTile}>
                {'mediaAssetId' in item ? <MediaAssetImage mediaAssetId={item.mediaAssetId} style={styles.mediaImage} resizeMode="cover" />
                  : <Image source={{ uri: item.uri }} style={styles.mediaImage} resizeMode="cover" />}
                <TouchableOpacity
                  style={styles.removeMedia}
                  onPress={() => setMedia((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                >
                  <X size={15} color="#fff" />
                </TouchableOpacity>
              </View>
            ))}
            {media.length < MAX_MOMENT_MEDIA_COUNT ? (
              <TouchableOpacity style={styles.addMedia} onPress={handlePickMedia}>
                <ImagePlus size={25} color={theme.colors.icon.secondary} />
                <Text style={styles.addMediaText}>{media.length}/{MAX_MOMENT_MEDIA_COUNT}</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          <View style={styles.metaSection}>
            <View style={styles.metaRow}>
              <MapPin size={17} color={theme.colors.icon.secondary} style={styles.metaIcon} />
              <AppTextInput
                style={styles.metaInput}
                placeholder="添加地点（可选）"
                placeholderTextColor={theme.colors.text.tertiary}
                value={locationLabel}
                onChangeText={setLocationLabel}
                maxLength={MAX_MOMENT_LOCATION_LABEL_LENGTH}
                returnKeyType="done"
                submitBehavior="blurAndSubmit"
              />
              {locationLabel.length > 0 ? (
                <TouchableOpacity
                  style={styles.clearMeta}
                  onPress={() => setLocationLabel('')}
                  accessibilityLabel="清除地点"
                >
                  <X size={15} color={theme.colors.icon.secondary} />
                </TouchableOpacity>
              ) : null}
            </View>

            <TouchableOpacity
              style={styles.metaRow}
              onPress={() => setShowAudienceSelector(true)}
              activeOpacity={0.7}
            >
              <Text style={styles.metaRowLabel}>谁可以看</Text>
              <Text style={styles.metaRowValue} numberOfLines={1}>
                {describeMomentAudienceDraft(audienceDraft)}
              </Text>
              <ChevronRight size={16} color={theme.colors.icon.secondary} />
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingContainer>

      <MomentAudienceSelectorModal
        visible={showAudienceSelector}
        draft={audienceDraft}
        candidates={audienceCandidates}
        candidatesLoading={audienceCandidatesLoading}
        onConfirm={(next) => {
          setAudienceDraft(next);
          setShowAudienceSelector(false);
        }}
        onCancel={() => setShowAudienceSelector(false)}
      />
    </SafeAreaView>
  );
}
