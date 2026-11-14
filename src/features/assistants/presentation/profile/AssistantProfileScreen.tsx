/** 身份与朋友圈是主页主体，模型、上下文和摘要归入次级管理区域。 */
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View, type ImageSourcePropType } from 'react-native';
import { SquarePen } from 'lucide-react-native';
import { AVATAR_SHAPE } from '@shared/avatar/avatarConstants';
import { ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import { AIAvatar, Button, ImageViewerModal, showAppDialog } from '@shared/ui';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { resolveMediaAsset } from '@features/media';
import AssistantProfilePage from './AssistantProfilePage';
import AssistantSettingsEntries from './AssistantSettingsEntries';
import { createAssistantProfileStyles } from './AssistantProfile.styles';
import AssistantSpaceCover, { DEFAULT_ASSISTANT_SPACE_COVER_SOURCE } from './AssistantSpaceCover';

interface Props {
  aiId: string;
  onBack(): void;
  onEdit(): void;
  onSendMessage(): void;
  onOpenMoments(): void;
  onOpenModelSettings(): void;
  onOpenContextSettings(): void;
  onOpenSummary(): void;
  onOpenCodeLibrary(): void;
}

export default function AssistantProfileScreen({ aiId, onBack, onEdit, onSendMessage, onOpenMoments,
  onOpenModelSettings, onOpenContextSettings, onOpenSummary, onOpenCodeLibrary }: Props) {
  const styles = useThemedStyles(createAssistantProfileStyles);
  const theme = useTheme();
  const [coverPreview, setCoverPreview] = useState<ImageSourcePropType | null>(null);
  const openCover = (mediaAssetId: string | null) => {
    if (mediaAssetId === null) { setCoverPreview(DEFAULT_ASSISTANT_SPACE_COVER_SOURCE); return; }
    void resolveMediaAsset(mediaAssetId)
      .then(resolved => setCoverPreview({ uri: resolved.localUri }))
      .catch(() => showAppDialog({ title: '无法预览封面', message: '封面图片暂时不可用', tone: 'error' }));
  };
  return <AssistantProfilePage aiId={aiId} title="AI 个人主页" onBack={onBack}>
    {assistant => <>
      <NavigationHeader title={`${assistant.name}的主页`} onGoBack={onBack} />
      <ScrollView style={styles.profileScroll} contentContainerStyle={[styles.content, styles.profileContent]} showsVerticalScrollIndicator={false}>
        <Pressable accessibilityRole="button" accessibilityLabel="查看封面" onPress={() => openCover(assistant.profileCoverMediaAssetId)}>
          <AssistantSpaceCover mediaAssetId={assistant.profileCoverMediaAssetId} style={styles.cover} />
        </Pressable>

        <View style={styles.profileBody}>
          <View style={styles.profileAvatar}>
            <AIAvatar name={assistant.name} avatarUrl={assistant.avatar} size="large" shape={AVATAR_SHAPE.circle} />
          </View>
          <View style={styles.nameRow}>
            <Text selectable style={styles.name}>{assistant.name}{assistant.nickname ?
              <Text style={styles.nickname}>（{assistant.nickname}）</Text> : null}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="编辑资料" style={styles.editProfile} onPress={onEdit}>
              <SquarePen size={16} color={theme.colors.brand.primary} />
            </Pressable>
          </View>
          <Text selectable style={assistant.systemPrompt ? styles.persona : styles.empty} numberOfLines={2}>
            {assistant.systemPrompt || '还没有填写设定'}
          </Text>
        </View>

        <View style={styles.profileSections}>
          <ThemedSurface variant="card" style={styles.momentsCard}>
            <Pressable accessibilityRole="button" accessibilityLabel="查看时刻" onPress={onOpenMoments} style={styles.momentsEntry}>
              <Text style={styles.entryTitle}>时刻</Text>
            </Pressable>
          </ThemedSurface>

          <ThemedSurface variant="card" style={styles.momentsCard}>
            <Pressable accessibilityRole="button" accessibilityLabel="打开作品库" onPress={onOpenCodeLibrary} style={styles.momentsEntry}>
              <Text style={styles.entryTitle}>作品库</Text>
            </Pressable>
          </ThemedSurface>

          <AssistantSettingsEntries onOpenModelSettings={onOpenModelSettings}
            onOpenContextSettings={onOpenContextSettings} onOpenSummary={onOpenSummary} />
        </View>
      </ScrollView>

      <ThemedSurface variant="inputBar" cornerRadius={0} style={styles.footer}>
        <Button title="发消息" onPress={onSendMessage} />
      </ThemedSurface>

      <ImageViewerModal visible={coverPreview !== null} sources={[coverPreview]}
        onClose={() => setCoverPreview(null)} />
    </>}
  </AssistantProfilePage>;
}
