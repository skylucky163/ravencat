import React, { useMemo } from 'react';
import { ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { AutoSaveErrors } from '@shared/ui/AutoSaveErrors';
import { useFloatingTabBarScrollPadding, showAppDialog } from '@shared/ui';
import { useTheme } from '@shared/theme';
import { createProfileStyles } from './ProfileTab.styles';
import { ProfileContent } from './ProfileContent';
import { useCurrentUserProfile } from './useCurrentUserProfile';
import { DEFAULT_USER_PROFILE } from '../domain/UserProfile';

interface ProfileTabProps {
  onOpenProfile(): void;
  onOpenFavorites(): void;
  onOpenBackup(): void;
  onClearData(): void | Promise<void>;
  checkingUpdates: boolean;
  availableUpdateVersion: string | null;
  updateProgress: number | null;
  updateDownloaded: boolean;
  onCheckUpdates(): void;
}

export default function ProfileTab({ onOpenProfile, onOpenFavorites, onOpenBackup, onClearData,
  checkingUpdates, availableUpdateVersion, updateProgress, updateDownloaded, onCheckUpdates }: ProfileTabProps) {
  const theme = useTheme();
  const styles = useMemo(() => createProfileStyles(theme), [theme]);
  const bottomPadding = useFloatingTabBarScrollPadding();
  const { profile, error, reload } = useCurrentUserProfile();
  const clear = () => showAppDialog({ title: '清空数据', message: '确定要清空所有数据吗？此操作不可恢复。', buttons: [
    { text: '取消', style: 'cancel' },
    { text: '确定', style: 'destructive', onPress: async () => {
      try { await onClearData(); reload(); }
      catch (error) { console.error('[个人资料] 清空失败', error); showAppDialog({ title: '错误', message: '清空数据失败', tone: 'error' }); }
    } },
  ] });
  return <SafeAreaView style={styles.tabContainer} edges={theme.effects.glass.enabled ? ['left', 'right'] : ['top', 'left', 'right']}>
    <NavigationHeader title="我" includeTopInset={theme.effects.glass.enabled} />
    <ScrollView style={styles.settingsContainer} contentContainerStyle={{ paddingBottom: theme.effects.glass.enabled ? bottomPadding : 0 }}>
      <ProfileContent profile={profile ?? DEFAULT_USER_PROFILE} hasLoadedProfile={!!profile}
        onOpenProfile={onOpenProfile}
        onOpenFavorites={onOpenFavorites}
        onBackupPress={onOpenBackup} onClearAllData={clear}
        checkingUpdates={checkingUpdates} availableUpdateVersion={availableUpdateVersion}
        updateProgress={updateProgress} updateDownloaded={updateDownloaded}
        onCheckUpdates={onCheckUpdates} />
      <AutoSaveErrors error={error} blocked={false} retry={reload} />
    </ScrollView>
  </SafeAreaView>;
}
