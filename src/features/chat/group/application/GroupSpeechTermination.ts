/**
 * 群聊发言 plan 的强制终止 command。
 *
 * 与用户消息换代（supersede）是两套语义：终止不创建 successor、不计算继承
 * 队列，清掉该 plan 的全部后续发言机会。顺序必须是先持久撤销资格（plan 与
 * queued/running 任务在同一事务内裁决为 terminated 终态），commit 后再 abort
 * 在途请求——abort 只节约模型/网络资源，晚到输出的落库资格已被持久化 fence
 * 撤销。
 */

import { getChatGroupRuntimeDependencies } from './ChatGroupRuntime';
import type { DatabaseTransactionExecutor } from '@platform/persistence';
import { abortGroupSpeechPlanExecution, listActiveGroupSpeechGroupIds } from './GroupSpeechExecutionAbort';
import { emitChatGroupSpeechPlanChanged } from '../../messages/events/ChatEvents';

/** 群工具的持久提交资格来自当前发言任务，与网络取消分工。 */
export function isGroupSpeechTaskRunCurrentInTransaction(transaction: DatabaseTransactionExecutor, taskId: string): Promise<boolean> {
  return getChatGroupRuntimeDependencies().groups.isSpeechTaskRunCurrentInTransaction(transaction, taskId);
}

/** 冷启动只结算失去执行者的旧计划；同进程仍活着的调用保留原 owner。 */
export async function interruptAbandonedGroupSpeechPlans(): Promise<void> {
  const groupIds = await getChatGroupRuntimeDependencies().groups.interruptSpeechPlansWithoutOwner(
    listActiveGroupSpeechGroupIds(),
  );
  for (const groupId of groupIds) {
    emitChatGroupSpeechPlanChanged(groupId);
  }
}

/** 返回 true 表示确实终止了一个 active plan；无 active plan 时返回 false。 */
export async function terminateGroupSpeechPlan(groupId: string): Promise<boolean> {
  const terminatedPlanId = await getChatGroupRuntimeDependencies()
    .groups.terminateActiveSpeechPlan(groupId);
  if (!terminatedPlanId) {
    return false;
  }
  emitChatGroupSpeechPlanChanged(groupId);
  // 以下都是 commit 后的资源节约副作用，不影响已裁决的持久事实：
  // 中止在途请求；是否再次发言由用户下一次显式召唤决定。
  abortGroupSpeechPlanExecution(terminatedPlanId);
  return true;
}
