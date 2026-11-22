/** 当前主理 AI 接受或拒绝用户发起的 Together Listening 邀请。 */

import type { ToolContext } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import {
  acceptTogetherListeningInvitationByAI,
  declineTogetherListeningInvitationByAI,
} from '../application/TogetherListeningLifecycle';
import {
  endForExplicitMediaLoss,
  mapMediaUnavailable,
  observeLatestNetEase,
  readCurrentActivity,
  readCurrentHostAuthority,
  typedResult,
  unavailable,
  readLatestCurrentLyric,
} from './TogetherListeningToolRuntime';

interface RespondArgs { decision: 'accept' | 'decline' }

export const definition = {
  name: 'respond_to_listening_invitation',
  description: '接收或拒绝用户发起的 Together Listening 邀请。',
  parameters: {
    type: 'object' as const,
    properties: {
      decision: {
        type: 'string' as const,
        enum: ['accept', 'decline'],
        description: '接受会进入一起听状态，拒绝则不进入。',
      },
    },
    required: ['decision'],
    additionalProperties: false,
  },
};

export async function execute(args: RespondArgs, context: ToolContext) {
  throwIfAbortSignalAborted(context.abortSignal);
  if (args.decision !== 'accept' && args.decision !== 'decline') {
    return { success: false, error: 'decision 必须是 accept 或 decline', errorCode: 'INVALID_DECISION' };
  }
  const authority = await readCurrentHostAuthority(context);
  if ('result' in authority) return authority.result;
  const current = await readCurrentActivity();
  if (!current || current.phase !== 'pending_ai_response' || current.hostAiId !== authority.hostAiId) {
    return unavailable(
      'no_pending_user_invitation',
      '当前没有等待 AI 回应的用户 Together Listening 邀请。',
      current ? { activityId: current.id, phase: current.phase } : {},
    );
  }

  const availability = await observeLatestNetEase();
  const mediaEnd = await endForExplicitMediaLoss(current, availability);
  if (mediaEnd) return mediaEnd;
  if (args.decision === 'accept' && !availability.available) {
    return mapMediaUnavailable(availability);
  }

  throwIfAbortSignalAborted(context.abortSignal);
  const result = args.decision === 'accept'
    ? await acceptTogetherListeningInvitationByAI(current.id)
    : await declineTogetherListeningInvitationByAI(current.id);
  if (result.status !== 'transitioned') {
    return typedResult({
      status: 'transition_conflict',
      activityId: 'activity' in result ? result.activity.id : current.id,
      phase: 'activity' in result ? result.activity.phase : null,
      endReason: 'activity' in result ? result.activity.endReason : null,
    }, 'Together Listening 邀请已被其他操作更新，本次回应未覆盖现有结果。');
  }
  return typedResult({
    status: args.decision === 'accept' ? 'invitation_accepted' : 'invitation_declined',
    activityId: result.activity.id,
    phase: result.activity.phase,
    projectionStatus: result.projectionStatus,
    ...(args.decision === 'accept' ? { currentLyric: await readLatestCurrentLyric(availability) } : {}),
  }, args.decision === 'accept'
    ? '已接受用户的 Together Listening 邀请。'
    : '已拒绝用户的 Together Listening 邀请。');
}

export const RespondToListeningInvitationTool = { name: definition.name, definition, execute };
