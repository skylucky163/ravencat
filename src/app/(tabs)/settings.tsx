/** 设置 Tab。 */
import { type Href, useRouter } from 'expo-router';
import { ProfileTab } from '@features/profile';
import { useApplicationUpdates } from '@host/shell/ApplicationUpdateProvider';

export default function SettingsRoute() {
  const router = useRouter();
  const updates = useApplicationUpdates();
  return (
    <ProfileTab
      onOpenProfile={() => router.push('/profile')}
      onOpenFavorites={() => router.push('/favorites')}
      onOpenDataManagement={() => router.push('/data-management' as Href)}
      checkingUpdates={updates.checking || (updates.download !== null && updates.download.uri === null)}
      availableUpdateVersion={updates.available?.version ?? null}
      updateProgress={updates.download && !updates.download.uri ? updates.download.progress : null}
      updateDownloaded={Boolean(updates.download?.uri)}
      onCheckUpdates={updates.checkManually}
    />
  );
}
