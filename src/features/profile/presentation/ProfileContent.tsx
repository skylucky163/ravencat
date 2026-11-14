import React, { useMemo } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Database, RefreshCw, Star, UserRound, type LucideIcon } from 'lucide-react-native';
import type { UserProfile } from '../domain/UserProfile';
import { UserAvatar } from '@shared/ui';
import { ThemedSurface, useTheme } from '@shared/theme';
import { getInstalledApplicationInfo } from '@platform/device/DeviceStatus';
import { version as sourceVersion } from '../../../../package.json';
import { createProfileStyles } from './ProfileTab.styles';

function ProfileSettingsMenuItem({ title, onPress, icon: Icon,
  detail, hasNotice = false, disabled = false }: {
  title: string; onPress(): void; icon: LucideIcon;
  detail?: string; hasNotice?: boolean; disabled?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createProfileStyles(theme), [theme]);
  const color = theme.colors.text.primary;
  return <TouchableOpacity style={styles.menuItem} onPress={onPress} activeOpacity={0.7}
    disabled={disabled} accessibilityRole="button" accessibilityState={{ disabled }}
    accessibilityLabel={[title, detail, hasNotice ? '有新版本' : null].filter(Boolean).join('，')}>
    <Icon size={20} color={color} style={styles.menuItemIcon} />
    <Text style={[styles.menuItemText, { color }]}>{title}</Text>
    {detail ? <Text style={styles.menuItemDetail}>{detail}</Text> : null}
    {hasNotice ? <View style={styles.updateDot} accessible={false} /> : null}
  </TouchableOpacity>;
}

export function ProfileContent({ profile, hasLoadedProfile, onOpenProfile, onOpenFavorites, onOpenDataManagement,
  checkingUpdates, availableUpdateVersion, updateProgress, updateDownloaded, onCheckUpdates }: {
  profile: UserProfile; hasLoadedProfile: boolean;
  onOpenProfile(): void; onOpenFavorites(): void; onOpenDataManagement(): void;
  checkingUpdates: boolean; availableUpdateVersion: string | null; onCheckUpdates(): void;
  updateProgress: number | null; updateDownloaded: boolean;
}) {
  const appInfo = useMemo(() => getInstalledApplicationInfo(), []);
  const theme = useTheme();
  const styles = useMemo(() => createProfileStyles(theme), [theme]);
  return <>
    <ThemedSurface nativeGlass variant="card" style={styles.userInfoSection}>
      <View style={styles.userAvatarContainer}>
        {hasLoadedProfile ? <UserAvatar name={profile.name} avatarUrl={profile.avatar} size="medium" style={styles.userAvatar} />
          : <View style={styles.userAvatarSkeleton} />}
      </View>
      <View style={styles.userInfo}>
        {hasLoadedProfile ? <Text style={styles.userName}>{profile.name}</Text> : <View style={styles.userNameSkeleton} />}
      </View>
    </ThemedSurface>
    <ThemedSurface nativeGlass variant="card" style={styles.menuSection}>
      <ProfileSettingsMenuItem title="个人" icon={UserRound} onPress={onOpenProfile} />
      <ProfileSettingsMenuItem title="收藏" icon={Star} onPress={onOpenFavorites} />
    </ThemedSurface>
    <ThemedSurface nativeGlass variant="card" style={styles.menuSection}>
      <ProfileSettingsMenuItem title="数据管理" icon={Database} onPress={onOpenDataManagement} />
      <ProfileSettingsMenuItem title="检查更新" icon={RefreshCw} onPress={onCheckUpdates}
        disabled={checkingUpdates} hasNotice={availableUpdateVersion !== null}
        detail={updateProgress !== null ? `下载 ${Math.floor(updateProgress * 100)}%`
          : updateDownloaded ? '已下载，点击安装' : checkingUpdates ? '正在检查…'
            : availableUpdateVersion ? `v${availableUpdateVersion}` : __DEV__ ? '开发版' : undefined} />
    </ThemedSurface>
    <View style={styles.versionSection}>
      {__DEV__ ? <>
        <Text style={styles.versionText}>{appInfo.name} · 开发源码 v{sourceVersion}</Text>
        <Text style={styles.versionText}>安装包 v{appInfo.version} ({appInfo.buildNumber})</Text>
      </> : <Text style={styles.versionText}>{appInfo.name} v{appInfo.version} ({appInfo.buildNumber})</Text>}
    </View>
  </>;
}
