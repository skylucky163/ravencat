/** 在无 UI 的 应用执行宿主 中处理 Together Listening 系统退出动作。 */

import {
  getTogetherListeningActivityById,
  leaveTogetherListeningByUser,
} from '@features/togetherListening';
import { ensureHostDatabaseReady } from '../composition/ensureHostDatabaseReady';

interface TogetherListeningNotificationActionTaskData {
  notificationAction?: string;
  activityId?: string;
  hostAiId?: string;
  chatSessionId?: string;
}

export async function executeTogetherListeningNotificationAction(
  data: TogetherListeningNotificationActionTaskData,
): Promise<void> {
  if (data.notificationAction !== 'leave') {
    return;
  }

  const activityId = data.activityId?.trim();
  const hostAiId = data.hostAiId?.trim();
  const chatSessionId = data.chatSessionId?.trim();
  if (!activityId || !hostAiId || !chatSessionId) {
    return;
  }

  await ensureHostDatabaseReady();
  const activity = await getTogetherListeningActivityById(activityId);
  if (
    !activity
    || activity.hostAiId !== hostAiId
    || activity.chatSessionId !== chatSessionId
  ) {
    return;
  }

  await leaveTogetherListeningByUser({
    activityId,
    source: 'system_capsule',
  });
}
