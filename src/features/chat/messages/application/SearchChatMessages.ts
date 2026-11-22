/** 用户与模型的检索输入在应用边界归一化；仓储统一裁决可见范围和模型权限。 */
import { getChatMessageRuntimeDependencies } from './ChatMessageRuntime';
import { ChatMessageSearchInputError, type ChatMessageSearchInput } from '../domain/ChatMessageSearch';

export function searchChatMessages(assistantId: string, input: ChatMessageSearchInput) {
  const { messages, callTranscriptSearch } = getChatMessageRuntimeDependencies();
  return messages.searchMessagesForAssistant(assistantId, normalizeSearchInput(input), callTranscriptSearch);
}

export function searchConversationMessages(input: ChatMessageSearchInput) {
  const { messages, callTranscriptSearch } = getChatMessageRuntimeDependencies();
  return messages.searchMessagesForUser(normalizeSearchInput(input), callTranscriptSearch);
}

function normalizeSearchInput(input: ChatMessageSearchInput): ChatMessageSearchInput {
  const keywords = [...new Set(input.keywords.map(keyword => keyword.trim()).filter(Boolean))];
  if (keywords.length === 0) throw new ChatMessageSearchInputError('请提供至少一个非空关键词');
  const normalizeDate = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw new ChatMessageSearchInputError('聊天记录查询时间无效，请提供 ISO 8601 时间');
    return new Date(time).toISOString();
  };
  const from = normalizeDate(input.from), to = normalizeDate(input.to);
  if (from !== undefined && to !== undefined && from > to) throw new ChatMessageSearchInputError('查询开始时间不能晚于结束时间');
  return { ...input, keywords, from, to };
}
