/** 群消息只提交事实与计划换代；模型请求由显式召唤拥有。 */

import { commitGroupUserMessage } from './GroupMessageCommit';
import { abortGroupSpeechPlanExecution } from './GroupSpeechExecutionAbort';
import { emitChatGroupSpeechPlanChanged } from '../../messages/events/ChatEvents';
import { recordUserStickerUse } from '@features/stickers';

export type SendGroupUserMessageParams = Parameters<typeof commitGroupUserMessage>[0];

export async function sendGroupUserMessage(params: SendGroupUserMessageParams) {
  const { message, rotation } = await commitGroupUserMessage(params);
  if (params.sticker) {
    try {
      // Sticker 的使用统计不侵入群消息/计划原子事务，只在消息事实提交后更新。
      await recordUserStickerUse(params.sticker.stickerId);
    } catch (error) {
      console.warn('[GroupUserMessaging] Sticker 使用统计更新失败：', error);
    }
  }
  if (rotation.kind === 'superseded') {
    // 换代事实已在消息事务内 commit；abort 只节约旧请求的模型/网络资源，
    // 晚到旧输出的落库资格由持久化 fence 最终裁决。
    abortGroupSpeechPlanExecution(rotation.previousPlanId);
  }
  // 消息事务可能新建或扩展 pending successor；页面收到事实后从 query 重读，
  // 不从 rotation payload 自行投影 active plan。
  // 群消息已经提交；订阅者异常不能让分享方误认为未发送并再次提交。
  try { emitChatGroupSpeechPlanChanged(params.groupId); }
  catch (error) { console.warn('[GroupUserMessaging] 已提交群消息的计划通知失败：', error); }
  return message;
}
