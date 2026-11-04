import { showAppDialog } from '@shared/ui';
import { useCallback, useRef, useState } from 'react';

import { PERSISTENT_IMAGE_CATEGORY, usePersistentAvatarDraft } from '@platform/device/DeviceMediaService';
import { updateCurrentUserAvatarFromDraft, updateCurrentUserProfile } from '../composition';
import type { UserProfile } from '../domain/UserProfile';

/** 头像仍由媒体草稿 owner 提交，返回先等本次选择与引用事务完成。 */
export function useProfileAvatar(profile: UserProfile) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<Promise<void> | null>(null);
  const dirty = useRef(false);
  const { avatarUri, pickAvatar, resetAvatar, discardAvatarDraft, commitAvatar } = usePersistentAvatarDraft({
    category: PERSISTENT_IMAGE_CATEGORY.userAvatar, entityId: profile.id, committedUri: profile.avatar,
  });
  const save = useCallback(async () => {
    await commitAvatar((uri, draft) => draft ? updateCurrentUserAvatarFromDraft(draft) : updateCurrentUserProfile({ avatar: uri }),
      (next) => next.avatar);
    dirty.current = false;
    setError(null);
  }, [commitAvatar]);
  const run = useCallback((action: () => Promise<void>) => {
    if (pending.current) return pending.current;
    setBusy(true);
    const operation = action().catch((cause: unknown) => {
      console.error('[个人资料] 头像提交失败', cause);
      setError('头像修改未能完成，请重试或恢复已保存值。');
    }).finally(() => { pending.current = null; setBusy(false); });
    pending.current = operation;
    return operation;
  }, []);
  const pick = useCallback(() => run(async () => {
    const result = await pickAvatar();
    if (result.status === 'permission-denied') { showAppDialog({ title: '需要权限', message: '请允许访问相册以选择头像', tone: 'warning' }); return; }
    if (result.status !== 'selected') return;
    dirty.current = true;
    await save();
  }), [pickAvatar, run, save]);
  const onPress = useCallback(() => {
    showAppDialog({ title: '头像', message: '选择新头像，或恢复默认头像。', buttons: [
      { text: '取消', style: 'cancel' },
      { text: '从相册选择', onPress: () => void pick() },
      { text: '恢复默认', onPress: () => void run(async () => {
        if (!await resetAvatar()) return;
        dirty.current = true;
        await save();
      }) },
    ] });
  }, [pick, resetAvatar, run, save]);
  const flush = useCallback(async () => { if (pending.current) await pending.current; return !dirty.current; }, []);
  const restore = useCallback(() => run(async () => {
    await discardAvatarDraft(); dirty.current = false; setError(null);
  }), [discardAvatarDraft, run]);
  return { avatarUri, busy, error, dirty: busy || !!error, onPress, flush, restore,
    retry: () => { if (dirty.current) void run(save); else void pick(); } };
}
