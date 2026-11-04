/** AI 朋友圈展示 Assistants 的个人空间封面；用户封面仍由独立控制器拥有。 */
import React, { useMemo, useState } from 'react';
import { ImageBackground, StyleSheet, Text, TouchableOpacity, View, type ImageSourcePropType } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AIAvatar, UserAvatar } from '@shared/ui';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { GlassSurface, useTheme, type PresentationTheme } from '@shared/theme';
import { AssistantSpaceCover } from '@features/assistants';
import MomentsCoverPreviewModal from './MomentsCoverPreviewModal';
import { useMomentsCover } from './useMomentsCover';
import type { MomentProfileAssistant } from './MomentsTab';

interface MomentsHeaderProps {
  onCameraPress?: () => void;
  onSettingsPress?: () => void;
  assistant?: MomentProfileAssistant;
  onBack?: () => void;
}

function createStyles(theme: PresentationTheme) {
  return StyleSheet.create({
    container: { backgroundColor: theme.effects.glass.enabled ? 'transparent' : theme.colors.surface.default },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.lg },
    coverContainer: { height: 228, position: 'relative', marginTop: theme.effects.glass.enabled ? theme.spacing.sm : 0 },
    coverTouchable: { flex: 1 },
    coverBackground: { flex: 1, justifyContent: 'flex-end', backgroundColor: theme.colors.background.screen },
    coverImage: { resizeMode: 'cover' },
    userInfoContainer: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'flex-end', paddingHorizontal: theme.spacing.lg, paddingBottom: 16 },
    avatarWrapper: { width: 56, height: 56, borderRadius: theme.radius.sm },
    avatarBorder: { backgroundColor: theme.colors.brand.onPrimary, borderWidth: 2, borderColor: theme.colors.surface.default, ...theme.shadow.md },
    glassAvatar: { backgroundColor: theme.colors.brand.onPrimary },
    userTextContainer: { alignItems: 'flex-end', marginBottom: 6, marginRight: 12, maxWidth: 240 },
    userName: { fontSize: 18, fontWeight: '700', color: theme.colors.brand.onPrimary, textShadowColor: 'rgba(0,0,0,0.35)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },
  });
}

type CoverProps = {
  name: string;
  avatar: string | null;
} & ({
  isAI: true;
  mediaAssetId: string | null;
  source?: never;
  onPress?: never;
  onError?: never;
} | {
  isAI?: false;
  mediaAssetId?: never;
  source: ImageSourcePropType;
  onPress?: () => void;
  onError?: () => void;
});

function MomentsCover({ source, name, avatar, isAI, mediaAssetId, onPress, onError }: CoverProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const Avatar = isAI ? AIAvatar : UserAvatar;
  const avatarContent = <Avatar name={name} avatarUrl={avatar} size="medium"
    style={[styles.avatarWrapper, theme.effects.glass.enabled ? styles.glassAvatar : styles.avatarBorder]} />;
  const userInfo = <View style={styles.userInfoContainer}>
    <View style={styles.userTextContainer}><Text style={styles.userName} numberOfLines={1}>{name}</Text></View>
    {theme.effects.glass.enabled ? (
      <GlassSurface material={{ cornerRadius: theme.radius.sm }} style={styles.avatarWrapper}>
        {avatarContent}
      </GlassSurface>
    ) : avatarContent}
  </View>;
  const image = isAI
    ? <AssistantSpaceCover mediaAssetId={mediaAssetId} style={styles.coverBackground}>{userInfo}</AssistantSpaceCover>
    : <ImageBackground source={source} style={styles.coverBackground} imageStyle={styles.coverImage} onError={onError}>
      {userInfo}
    </ImageBackground>;
  return <View style={styles.coverContainer}>
    {onPress ? <TouchableOpacity style={styles.coverTouchable} onPress={onPress} activeOpacity={0.95}>{image}</TouchableOpacity> : image}
  </View>;
}

function UserMomentsHeader({ onCameraPress, onSettingsPress }: MomentsHeaderProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const cover = useMomentsCover();
  const [previewVisible, setPreviewVisible] = useState(false);
  const rightButton = (
    <View style={styles.headerActions}>
      <TouchableOpacity onPress={onSettingsPress} activeOpacity={0.7} accessibilityLabel="时刻设置">
        <Ionicons name="settings-outline" size={23} color={theme.colors.icon.primary} />
      </TouchableOpacity>
      <TouchableOpacity onPress={onCameraPress} activeOpacity={0.7} accessibilityLabel="发布时刻">
        <Ionicons name="camera" size={24} color={theme.colors.icon.primary} />
      </TouchableOpacity>
    </View>
  );
  return <View style={styles.container}>
    <NavigationHeader title="时刻" rightButton={rightButton} includeTopInset={theme.effects.glass.enabled} />
    <MomentsCover source={cover.coverSource} name={cover.currentUser.name} avatar={cover.currentUser.avatar}
      onPress={() => setPreviewVisible(true)} onError={cover.handleCoverError} />
    <MomentsCoverPreviewModal visible={previewVisible} coverSource={cover.coverSource}
      hasCustomCover={cover.hasCustomCover} isUpdating={cover.isUpdatingCover}
      onClose={() => setPreviewVisible(false)}
      onPickCover={() => { setPreviewVisible(false); void cover.pickCover(); }}
      onResetCover={() => { setPreviewVisible(false); void cover.resetCover(); }} />
  </View>;
}

export default function MomentsHeader({ assistant, onBack, ...props }: MomentsHeaderProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  if (!assistant) return <UserMomentsHeader {...props} />;
  return <View style={styles.container}>
    <NavigationHeader title="朋友圈" onGoBack={onBack} includeTopInset={theme.effects.glass.enabled} />
    <MomentsCover mediaAssetId={assistant.profileCoverMediaAssetId} name={assistant.name} avatar={assistant.avatar} isAI />
  </View>;
}
