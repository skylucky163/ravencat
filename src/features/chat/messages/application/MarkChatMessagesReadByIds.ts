/** Chat 对外精确已读命令；只有数据库实际变更后才刷新对应会话 UI。 */

import { getChatMessageRuntimeDependencies } from './ChatMessageRuntime';
import { emitChatMessagesUpdated } from '../events/ChatEvents';

export interface MarkChatMessagesReadByIdsParams {
  sessionId: string;
  messageIds: readonly string[];
  clientMessageIds?: readonly string[];
}

export async function markChatMessagesReadByIds(
  params: MarkChatMessagesReadByIdsParams,
): Promise<number> {
  const clientMessageIds = params.clientMessageIds ?? [];
  if (params.messageIds.length === 0 && clientMessageIds.length === 0) {
    return 0;
  }

  const changed = await getChatMessageRuntimeDependencies().messages
    .markMessagesAsReadByIds([...params.messageIds], [...clientMessageIds]);

  // DB 失败会直接抛出，因而不会触发 UI；幂等重复回执 changes=0 也不发刷新。
  if (changed > 0) {
    emitChatMessagesUpdated(params.sessionId);
  }

  return changed;
}
