/** 在不拉起界面的 应用执行宿主 中处理来电通知拒绝动作。 */

import { getCallSession, rejectCall } from '@features/calls';
import { ensureHostDatabaseReady } from '../composition/ensureHostDatabaseReady';

interface CallNotificationActionTaskData {
  notificationAction?: string;
  callId?: string;
  aiId?: string;
  sessionId?: string;
}

export async function executeCallNotificationAction(
  data: CallNotificationActionTaskData
): Promise<void> {
  if (data.notificationAction !== 'reject') {
    return;
  }

  const callId = data.callId?.trim();
  const aiId = data.aiId?.trim();
  const sessionId = data.sessionId?.trim();
  if (!callId || !aiId || !sessionId) {
    return;
  }

  await ensureHostDatabaseReady();
  const call = await getCallSession(callId);
  if (
    !call
    || call.aiAssistantId !== aiId
    || call.chatSessionId !== sessionId
  ) {
    return;
  }

  await rejectCall(call.id, 'userRejected');
}
