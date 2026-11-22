import { CHAT_TEXT_ATTACHMENT_MAX_LENGTH } from '../../../messages/domain/ChatAttachment';

export const DEFAULT_CHAT_LONG_PASTE_THRESHOLD = 5_000;

export function isChatLongPasteThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= CHAT_TEXT_ATTACHMENT_MAX_LENGTH;
}
