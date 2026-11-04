/** 聊天选择只准备自己的快照，窗口状态和发送复用公共分享流程。 */
import { useCallback } from 'react';
import { createChatShareSnapshot } from '../../../messages/application/ShareChatMessages';
import { useChatContentShare } from './useChatContentShare';

export function useChatMessageShare({ sessionId, sourceName, assistantId, isActive, onShared }: {
  sessionId?: string; sourceName: string; assistantId?: string; isActive: boolean; onShared: () => void;
}) {
  const share = useChatContentShare({ ownerKey: sessionId, isActive, onShared });
  const openContentShare = share.open;
  const open = useCallback((anchorMessageIds: readonly number[]) => openContentShare(async () => ({
    kind: 'chat_record', record: await createChatShareSnapshot({ sessionId: sessionId!, name: sourceName, assistantId }, anchorMessageIds),
  }), { excludeTarget: assistantId ? { kind: 'direct', id: assistantId } : { kind: 'group', id: sessionId! } }), [openContentShare, sessionId, sourceName, assistantId]);
  return { ...share, open };
}
