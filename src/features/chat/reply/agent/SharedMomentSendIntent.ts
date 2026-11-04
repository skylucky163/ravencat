/** 工具准备卡片，发送事实仍由 Chat 在当前回合的提交 fence 内保存。 */
import type { SharedMoment } from '../../messages/domain/SharedMoment';
const DISCRIMINATOR = 'ravencat.chat.moment.send.v1' as const;
export interface SharedMomentSendIntent { discriminator: typeof DISCRIMINATOR; moment: SharedMoment }
export function createSharedMomentSendIntent(moment: SharedMoment): SharedMomentSendIntent {
  return { discriminator: DISCRIMINATOR, moment };
}
export function isSharedMomentSendIntent(value: unknown): value is SharedMomentSendIntent {
  return (value as SharedMomentSendIntent | null)?.discriminator === DISCRIMINATOR;
}
