/** 群聊召唤的薄编排器：校验运行态、创建计划/任务并维护计划终态。 */

import {
  emitChatGroupSpeechPlanChanged,
  emitChatTypingStatusChanged,
} from '../../messages/events/ChatEvents';
import { getChatGroupRuntimeDependencies } from './ChatGroupRuntime';
import { insertSystemTip, insertSystemTipIfSpeechPlanActive } from './GroupMessageCommit';
import {
  captureGroupInvocationContext,
  prepareGroupSpeechPlan,
} from './GroupSpeakerPlanning';
import { executeGroupSpeechTasks } from './GroupSpeechTaskExecution';
import { registerGroupSpeechAbort, registerGroupSpeechInvocation } from './GroupSpeechExecutionAbort';
import type { GroupSpeechPlan, GroupSpeechTask, GroupInvocationResult } from '../domain/GroupChat';

export async function getActiveGroupSpeechPlan(groupId: string): Promise<GroupSpeechPlan | null> {
  return getChatGroupRuntimeDependencies().groups.getRunningSpeechPlan(groupId);
}

/**
 * 队列浮层的只读投影：UI 只消费持久 task 状态，不维护任何进程内队列副本。
 * 展示目标是当前 active plan；没有 active plan 时回退到最近一个 plan，使
 * 终止/失败后的队列结果仍可查看。activePlan 单独返回，供调用方同步控制区状态。
 */
export interface GroupSpeechQueueSnapshot {
  activePlan: GroupSpeechPlan | null;
  plan: GroupSpeechPlan | null;
  tasks: GroupSpeechTask[];
}

export async function getGroupSpeechQueue(groupId: string): Promise<GroupSpeechQueueSnapshot> {
  const groups = getChatGroupRuntimeDependencies().groups;
  const activePlan = await groups.getRunningSpeechPlan(groupId);
  const plan = activePlan ?? await groups.getLatestSpeechPlan(groupId);
  if (!plan) {
    return { activePlan: null, plan: null, tasks: [] };
  }
  const tasks = await groups.listSpeechPlanTasks(plan.id);
  return { activePlan, plan, tasks };
}

function buildId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 激活资格已被并发换代夺走时安静退出：最新世代会接管后续执行。 */
function lostActivation(planId: string): GroupInvocationResult {
  return { success: false, error: null, planId, outcome: 'already_running' };
}

export async function invokeGroupChat(groupId: string): Promise<GroupInvocationResult> {
  const releaseOwner = registerGroupSpeechInvocation(groupId);
  try {
    return await executeGroupInvocation(groupId);
  } finally {
    releaseOwner();
  }
}

async function executeGroupInvocation(groupId: string): Promise<GroupInvocationResult> {
  const groups = getChatGroupRuntimeDependencies().groups;
  const details = await groups.getById(groupId);
  if (!details) {
    return { success: false, error: '群聊不存在', planId: null, outcome: 'not_found' };
  }

  const claim = await groups.tryClaimGroupSpeechPlan(groupId);
  let plan: GroupSpeechPlan;
  let previousInputUpperBoundMessageId: number;
  if (claim.claimed) {
    plan = claim.plan;
    previousInputUpperBoundMessageId = claim.previousInputUpperBoundMessageId;
  } else if (claim.plan.status === 'pending' && claim.plan.supersedesPlanId) {
    // 用户消息换代建立的 pending successor 仍处于输入窗口：显式召唤
    // 关闭窗口并激活该 plan；窗口起点在换代事务内已写入
    // last_included_message_id。
    plan = claim.plan;
    previousInputUpperBoundMessageId = plan.inputUpperBoundMessageId ?? 0;
  } else {
    return {
      success: false,
      error: '当前已经有一轮召唤正在运行',
      planId: claim.plan.id,
      outcome: 'already_running',
    };
  }

  let typingStarted = false;
  const abortController = new AbortController();
  let unregisterAbort: (() => void) | null = null;
  try {
    // 召唤接管该 plan：输入窗口立即关闭（pending → preparing CAS）。此后到达的
    // 用户消息由换代事务按打断处理，而不是继续并入已开始规划的窗口；plan 已被
    // 并发换代或被另一路召唤接管时安静退出。
    const preparationBegun = await groups.beginSpeechPlanPreparation(plan.id);
    if (!preparationBegun) {
      return lostActivation(plan.id);
    }
    // 管理员规划也属于该 plan，终止或换代必须能结束它的在途请求。
    unregisterAbort = registerGroupSpeechAbort(plan.id, abortController);
    // preparing 已是持久 active 事实：立即通知页面重读，使管理员 planning 期间
    // 也能展示强制终止入口；事件不携带 plan 副本。
    emitChatGroupSpeechPlanChanged(groupId);

    const invocationContext = await captureGroupInvocationContext(
      groupId,
      previousInputUpperBoundMessageId,
    );
    const inputUpdated = await groups.updateSpeechPlanInput(
      plan.id,
      invocationContext.currentUserMessages.map((message) => message.id),
      invocationContext.inputUpperBoundMessageId,
    );
    if (!inputUpdated) {
      return lostActivation(plan.id);
    }

    // successor 激活前已从换代事务物化继承队列；fresh claim 的队列必然为空。
    const inheritedTasks = (await groups.listSpeechPlanTasks(plan.id))
      .filter((task) => task.status === 'queued');

    const planning = await prepareGroupSpeechPlan(
      details,
      invocationContext.currentUserMessages,
      { hasInheritedSpeechTasks: inheritedTasks.length > 0, abortSignal: abortController.signal },
    );

    if (planning.adminRequestFailureNotice) {
      // 该提示属于本次规划：落库资格与 plan 所有权同一事务裁决，planning 期间
      // 被换代时不得把旧 plan 的提示写到用户新消息之后。
      await insertSystemTipIfSpeechPlanActive(
        groupId,
        plan.id,
        planning.adminRequestFailureNotice.text,
        planning.adminRequestFailureNotice.metadata,
      );
    }

    if (planning.sequenceMembers.length === 0 && inheritedTasks.length === 0) {
      const completed = await groups.updateSpeechPlanStatus(plan.id, 'completed', {
        expectedStatus: ['preparing'],
      });
      if (!completed) {
        return lostActivation(plan.id);
      }
      return { success: true, error: null, planId: plan.id, outcome: 'completed' };
    }

    // 原子激活：新任务插入队首、去除与继承队列的交叉重复、CAS preparing→running；
    // plan 在管理员请求期间被换代时返回 false，本轮安静退出。
    const activated = await groups.activateSpeechPlanWithTasks(plan.id, {
      tasks: planning.sequenceMembers.map((member) => ({
        id: buildId('group_task'),
        groupId,
        aiAssistantId: member.aiAssistantId,
        agentId: member.agentId,
        source: planning.mentionedAssistantIds.has(member.aiAssistantId)
          ? 'user_mention' as const
          : 'admin' as const,
      })),
      mentionAssistantIds: [...planning.mentionedAssistantIds],
    });
    if (!activated) {
      return lostActivation(plan.id);
    }

    emitChatTypingStatusChanged(groupId, true);
    typingStarted = true;
    await executeGroupSpeechTasks({
      planId: plan.id,
      details,
      currentUserMessages: invocationContext.currentUserMessages,
      inputUpperBoundMessageId: invocationContext.inputUpperBoundMessageId,
      memberProfiles: planning.memberProfiles,
    });

    const completed = await groups.updateSpeechPlanStatus(plan.id, 'completed', {
      expectedStatus: ['running'],
    });
    if (!completed) {
      return lostActivation(plan.id);
    }
    return { success: true, error: null, planId: plan.id, outcome: 'completed' };
  } catch (error) {
    const message = error instanceof Error ? error.message : '群聊召唤失败';
    // CAS 守卫：plan 已被换代时不得把 superseded 改写成 failed，也不写失败提示。
    const marked = await groups.updateSpeechPlanStatus(plan.id, 'failed', {
      errorMessage: message,
      expectedStatus: ['preparing', 'running'],
    });
    if (!marked) return lostActivation(plan.id);
    await insertSystemTip(groupId, `群聊召唤失败：${message}`);
    return { success: false, error: message, planId: plan.id, outcome: 'failed' };
  } finally {
    unregisterAbort?.();
    if (typingStarted) {
      emitChatTypingStatusChanged(groupId, false);
    }
    // completed / failed / superseded / terminated 均可能在本轮收尾时成为最终事实；
    // consumer 重读当前 active plan，不能沿用旧页面快照。
    emitChatGroupSpeechPlanChanged(groupId);
  }
}
