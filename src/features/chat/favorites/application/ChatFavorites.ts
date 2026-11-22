/** 收藏读取当下的 canonical 单条消息，快照和媒体引用在同一事务成立。 */
import { randomUUID } from 'expo-crypto';
import { databaseCoordinator } from '@platform/persistence';
import { releaseMediaAssetCandidates } from '@features/media';
import { getAssistantDisplayName } from '@features/assistants';
import { getChatDetailAvailableAssistants, getChatDetailCurrentUser } from '../../conversation/application/ChatPresentation';
import { listGroupChats } from '../../group/application/GroupChatManagement';
import { getChatMessageRuntimeDependencies } from '../../messages/application/ChatMessageRuntime';
import { prepareChatAttachments } from '../../messages/application/PrepareChatAttachments';
import { getChatMessageActions } from '../../messages/domain/ChatMessageActions';
import { getMessageAttachments, getMessageSticker, getMessageVoice, parseMessageMetadata } from '../../messages/domain/chatMessageMetadata';
import type { StoredChatAttachment } from '../../messages/domain/ChatAttachment';
import type { ChatFavorite, ChatFavoriteCategory, ChatFavoriteCursor, ChatFavoriteRef, ChatFavoriteSnapshot } from '../domain/ChatFavorite';
import { getChatFavoriteCategory } from '../domain/ChatFavorite';
import { getChatFavoriteRepository } from './ChatFavoriteRuntime';

export async function listChatFavorites(category: ChatFavoriteCategory | null, cursor: ChatFavoriteCursor | null = null, query = '') {
  const [assistants, groups, user] = await Promise.all([getChatDetailAvailableAssistants(), listGroupChats(), getChatDetailCurrentUser()]);
  const text = query.trim().toLowerCase();
  const matchedAssistants = assistants.filter(item => item.name.toLowerCase().includes(text)
    || getAssistantDisplayName(item).toLowerCase().includes(text));
  const page = await getChatFavoriteRepository().list(category, cursor, text ? {
    text, sourceAssistantIds: matchedAssistants.map(item => item.id), authorAgentIds: matchedAssistants.map(item => item.agentId),
    sourceGroupIds: groups.filter(item => item.name.toLowerCase().includes(text)).map(item => item.id),
    includeUserAuthor: user.name.toLowerCase().includes(text),
  } : null);
  const byId = new Map(assistants.map(item => [item.id, item]));
  const byAgent = new Map(assistants.map(item => [item.agentId, item]));
  const byGroup = new Map(groups.map(item => [item.id, item]));
  return { ...page, items: page.items.map(item => {
    const { snapshot } = item;
    const source = snapshot.sourceAssistantId ? byId.get(snapshot.sourceAssistantId) : undefined;
    const group = snapshot.sourceGroupId ? byGroup.get(snapshot.sourceGroupId) : undefined;
    const author = snapshot.authorAgentId ? byAgent.get(snapshot.authorAgentId) : undefined;
    // 展示名读取当前资料；AI 或群聊删除后保留收藏时的归属，不改写内容快照。
    return { ...item, sourceName: source ? getAssistantDisplayName(source) : group?.name ?? snapshot.sourceName,
      authorName: snapshot.authorKind === 'user' ? user.name : author ? getAssistantDisplayName(author) : snapshot.authorName };
  }) };
}

export function getChatFavoriteByMessage(messageId: number): Promise<ChatFavorite | null> {
  return getChatFavoriteRepository().getBySource(messageId);
}

/** 列表一次取回多行收藏身份；正文快照不参与展示状态。 */
export function listChatFavoriteRefs(messageIds: readonly number[]): Promise<ChatFavoriteRef[]> {
  return getChatFavoriteRepository().listRefsBySources(messageIds);
}

export async function createChatFavorite(input: { messageId: number; sourceName: string; assistantId?: string }): Promise<ChatFavorite> {
  const messages = getChatMessageRuntimeDependencies().messages;
  const original = await messages.getMessageById(input.messageId);
  if (!original) throw new Error('这条消息已被删除');
  if (!getChatMessageActions(original).favorite) throw new Error('这条消息不能收藏');
  const [assistants, user] = await Promise.all([getChatDetailAvailableAssistants(), getChatDetailCurrentUser()]);
  const prepared = await prepareChatAttachments(getMessageAttachments(original));
  let inserted = false;
  try {
    const result = await databaseCoordinator.transaction({ name: 'chat.favorite', feature: 'chat', priority: 'interactive' }, async transaction => {
      const repository = getChatFavoriteRepository();
      const existing = await repository.getBySourceInTransaction(transaction, input.messageId);
      if (existing) return { favorite: existing, inserted: false };
      const message = await messages.getMessageByIdInTransaction(transaction, input.messageId);
      if (!message) throw new Error('这条消息已被删除');
      if (!getChatMessageActions(message).favorite) throw new Error('这条消息不能收藏');
      if (prepared && message.metadataJson !== original.metadataJson) throw new Error('消息附件已变化，请重新收藏');
      const metadata = parseMessageMetadata(message);
      const sticker = getMessageSticker(message);
      const voice = getMessageVoice(message);
      // 收藏只修改自己持有的数组，消息查询返回值可能共享空附件列表。
      const attachments = prepared ? await prepared.materializeAttachments(transaction)
        : [...getMessageAttachments(message)] as StoredChatAttachment[];
      if (sticker) attachments.push({ id: `sticker:${sticker.stickerId}`, type: 'image', source: 'gallery',
        mediaAssetId: sticker.mediaAssetId, fileName: sticker.sourceFileName ?? sticker.name,
        mimeType: sticker.mimeType, width: sticker.width, height: sticker.height });
      const assistant = assistants.find(item => message.agentId ? item.agentId === message.agentId : item.id === input.assistantId);
      const sourceAssistant = assistants.find(item => item.id === input.assistantId);
      const snapshot: ChatFavoriteSnapshot = { sourceAssistantId: input.assistantId ?? null, sourceGroupId: input.assistantId ? null : message.sessionId,
          authorAgentId: message.senderType === 'user' ? null : message.agentId ?? assistant?.agentId ?? null,
          sourceName: sourceAssistant ? getAssistantDisplayName(sourceAssistant) : input.sourceName,
          authorName: message.senderType === 'user' ? metadata?.groupChat?.actorName ?? user.name : assistant ? getAssistantDisplayName(assistant) : metadata?.actorName ?? 'AI',
          authorKind: message.senderType as 'user' | 'assistant', messageCreatedAt: message.createdAt,
          text: sticker ? '' : message.text, replyToText: message.replyToText ?? null, attachments, voice };
      const category = getChatFavoriteCategory(snapshot);
      if (category === 'text' && message.senderType === 'assistant' && message.logicalMessageId) {
        // 二级分段共享同一模型回复的逻辑身份；不展开整轮，也不借相邻消息推断思维链。
        const related = await messages.getMessagesByLogicalMessageId(message.sessionId, message.logicalMessageId, transaction);
        const reasoningText = related.filter(item => item.senderType === 'reasoning' && item.status === 'sent'
          && item.deliveryStatus !== 'cancelled').map(item => item.text).join('\n\n');
        if (reasoningText) snapshot.reasoningText = reasoningText;
      }
      const favorite: ChatFavorite = {
        id: randomUUID(), sourceMessageId: message.id, savedAt: new Date().toISOString(),
        category, snapshot,
      };
      await repository.createInTransaction(transaction, favorite);
      return { favorite, inserted: true };
    });
    inserted = result.inserted;
    return result.favorite;
  } finally {
    await prepared?.finish(inserted);
  }
}

export async function removeChatFavorite(id: string): Promise<void> {
  const candidates = await databaseCoordinator.transaction({ name: 'chat.unfavorite', feature: 'chat', priority: 'interactive' },
    transaction => getChatFavoriteRepository().removeInTransaction(transaction, id));
  await releaseMediaAssetCandidates(candidates);
}
