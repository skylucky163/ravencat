/** Chat 的分享提交仅区分真实内容类型，界面和发送状态不依赖内容内部结构。 */
import type { SharedChatRecord } from './SharedChatRecord';
import type { SharedMoment } from './SharedMoment';

export type SharedContent = { kind: 'chat_record'; record: SharedChatRecord } | { kind: 'moment'; moment: SharedMoment };

export function sharedContentInput(content: SharedContent) {
  return content.kind === 'chat_record' ? { sharedRecord: content.record } : { sharedMoment: content.moment };
}
