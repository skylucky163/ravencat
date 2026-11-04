/** 群聊消费共享Agent timeline，以逐条事务提交正文、媒体与mention调度；取消后保留已提交事实。 */
import { databaseCoordinator } from '@platform/persistence';
import type { ModelFinishReason } from '@platform/ai';
import type { ConversationTurnCommitItem } from '../../reply/domain/ConversationTurn';
import type { ChatMessage } from '../../messages/domain/ChatMessage';
import { buildSessionPreviewTextFromMessage } from '../../messages/domain/chatMessageMetadata';
import { deliverCommittedAssistantSegment } from '../../reply/application/CommittedAssistantSegmentDelivery';
import { assertChatReplyNotAborted , ChatReplyRunCancelledError } from '../../reply/application/ChatReplyAbort';
import type { AssistantTurnCommitPort } from '../../reply/application/AssistantTurnCommit';

import type { IMessageRepository } from '../../messages/domain/MessageRepository';
import { getChatMessageRuntimeDependencies } from '../../messages/application/ChatMessageRuntime';
import type { GroupMessageMention } from '../../messages/domain/chatMessageMetadata';
import { parseGroupMessageMentions } from './GroupMessageMentionParser';
import { resolveGroupAIMentionSpeechTaskInputs } from './GroupSpeechTaskAppend';
import { getChatGroupRuntimeDependencies } from './ChatGroupRuntime';
import type { GroupParticipantDirectory } from '../domain/GroupParticipantDirectory';
import type { AppendGroupSpeechTaskInput, GroupSpeechTask } from '../domain/GroupChat';

/** 通用端口仍描述两种投影，群聊只能消费共享Agent timeline，误用应暴露内部契约错误。 */
async function rejectLegacyProjection(): Promise<void> {
  throw new Error('群聊回复必须经共享Agent timeline提交');
}

export function createGroupSegmentedReplyPersistence(params: {
  directory: GroupParticipantDirectory;
  task: Pick<
    GroupSpeechTask,
    'id' | 'planId' | 'groupId' | 'aiAssistantId' | 'sequenceOrder'
  >;
}): AssistantTurnCommitPort & {
  getReplyOutput: () => {
    visibleReplyCommitted: boolean;
    reasoningCommitted: boolean;
    finishReason: ModelFinishReason | null;
  };
} {
  // 队列消费模型结束事实和实际 commit 事实；不能用最终回调替代已发出的气泡。
  const output = {
    visibleReplyCommitted: false,
    reasoningCommitted: false,
    finishReason: null as ModelFinishReason | null,
  };
  return {
    getReplyOutput: () => output,
    observeRunEvent(event) {
      if (event.type === 'run_completed') {
        output.finishReason = event.result.steps.at(-1)?.modelTurn.finishReason ?? null;
      }
    },
    persistAssistantPrelude: rejectLegacyProjection,
    // 共用 Agent timeline 消费语音／贴纸 intent；仍由群逐泡事务裁决提交资格。
    persistsIntermediates: false,
    async commitAgentOutput(commitParams) {
      assertChatReplyNotAborted(commitParams.runtimeContext ?? {});
      const fenced = withCommitFence(commitParams.repository, params.task, null, commitParams.item.materializeInTransaction);
      const message = await fenced.commitMessage({
        message: { ...commitParams.item.message, turnRunId: params.task.id, turnItemIndex: null },
        previewText: buildSessionPreviewTextFromMessage(commitParams.item.message),
      });
      output.visibleReplyCommitted = true;
      // 消息已经是事实，观察者失败不能让调用方误报未发送或在末尾重复发送。
      try { commitParams.callbacks?.notifyUI?.(message.sessionId); }
      catch (error) { console.warn('[GroupAssistantTurnCommit] 已提交媒体的界面通知失败', { messageId: message.id, error }); }
      try {
        await deliverCommittedAssistantSegment({ sessionId: message.sessionId, text: message.text, metadataJson: message.metadataJson,
          messageId: message.id, clientMessageId: message.clientMessageId!, logicalMessageId: message.logicalMessageId ?? null,
          segmentIndex: 0, segmentTotal: 1, aiConfig: commitParams.aiConfig,
          runtimeContext: commitParams.runtimeContext ?? {}, callbacks: commitParams.callbacks ?? {} });
      } catch (error) { console.warn('[GroupAssistantTurnCommit] 已提交媒体的交付观察失败', { messageId: message.id, error }); }
      return { outcome: 'committed', messages: [message] };
    },
    async commitAgentTimeline(commitParams) {
      const items = commitParams.items;
      if (items.length === 0) return { outcome: 'empty_items', messages: [] };
      const mentions = parseGroupMessageMentions({ text: items.filter((item) => item.message.senderType === 'assistant').map((item) => item.message.text).join('\n'),
        directory: params.directory, actorAssistantId: params.task.aiAssistantId });
      const inputs = await resolveGroupAIMentionSpeechTaskInputs({ groupId: params.task.groupId, mentions });
      const mentionTasks = createMentionTaskMaterialization({ mentions, inputs, directory: params.directory, actorAssistantId: params.task.aiAssistantId });
      const messages: ChatMessage[] = [];
      const total = items.filter((item) => item.message.senderType === 'assistant').length;
      let delivered = 0;
      let committedItemCount = 0;
      try {
        for (const [index, item] of items.entries()) {
          assertChatReplyNotAborted(commitParams.runtimeContext ?? {});
          if (item.committedMessageId !== undefined) {
            const bound = await databaseCoordinator.transaction({ name: 'chat.bind-group-output', feature: 'chat', priority: 'interactive' }, async transaction => {
              if (!await getChatGroupRuntimeDependencies().groups.isSpeechTaskCommitEligibleInTransaction(transaction, params.task.planId, params.task.id)) {
                throw new ChatReplyRunCancelledError('superseded');
              }
              const message = await getChatMessageRuntimeDependencies().messages.bindTurnMessageInTransaction(transaction, item.committedMessageId!, index + 1);
              if (message) await getChatGroupRuntimeDependencies().groups.updatePreviewInTransaction(
                transaction, message.sessionId, message.id, buildSessionPreviewTextFromMessage(message), message.createdAt,
              );
              return message;
            });
            if (bound) { messages.push(bound); delivered++; }
            committedItemCount = index + 1;
            continue;
          }
          const fenced = withCommitFence(commitParams.repository, params.task, mentionTasks, item.materializeInTransaction);
          const message = await fenced.commitMessage({ message: { ...item.message, turnRunId: params.task.id, turnItemIndex: index + 1 },
            previewText: item.message.senderType === 'assistant' ? buildSessionPreviewTextFromMessage(item.message) : null });
          messages.push(message);
          committedItemCount = index + 1;
          if (message.senderType === 'assistant') output.visibleReplyCommitted = true;
          if (message.senderType === 'reasoning') output.reasoningCommitted = true;
          try { await item.finalizeAfterCommit?.(); }
          catch (error) { console.warn('[GroupAssistantTurnCommit] 已提交媒体的暂存清理失败', error); }
          commitParams.callbacks?.notifyUI?.(message.sessionId);
          if (message.senderType === 'assistant') {
            await deliverCommittedAssistantSegment({ sessionId: message.sessionId, text: message.text, metadataJson: message.metadataJson,
              messageId: message.id, logicalMessageId: message.logicalMessageId ?? null, segmentIndex: delivered++, segmentTotal: total,
              aiConfig: commitParams.aiConfig, runtimeContext: commitParams.runtimeContext ?? {}, callbacks: commitParams.callbacks ?? {} });
          }
        }
      } catch (error) {
        await Promise.all(items.slice(committedItemCount).map((item) => item.discardAfterRollback?.()));
        throw error;
      }
      const visible = messages.filter((message) => message.senderType === 'assistant');
      if (visible.length) {
        const joinedText = visible.map(buildSessionPreviewTextFromMessage).join('\n\n');
        commitParams.callbacks?.onFinalReply?.({ status: 'completed', sessionId: params.task.groupId,
          correlationId: commitParams.runtimeContext?.correlationId ?? params.task.id, text: joinedText, previewText: joinedText, joinedText,
          logicalMessageId: visible[0].logicalMessageId ?? null, firstSegmentMessageId: visible[0].id, lastSegmentMessageId: visible.at(-1)!.id,
          segmentTotal: visible.length, segments: visible.map((message, segmentIndex) => ({ messageId: message.id, segmentIndex, text: buildSessionPreviewTextFromMessage(message) })) });
      }
      commitParams.callbacks?.onReplyCommitted?.();
      return { outcome: 'committed', messages };
    },
    confirmCommitEligible: () => getChatGroupRuntimeDependencies()
      .groups.isSpeechTaskCommitEligible(
        params.task.planId,
        params.task.id,
      ),
    decorateCommitRepository: (repository) => withCommitFence(
      repository,
      params.task,
      null,
    ),
    persistCompletedAssistantReply: rejectLegacyProjection,
  };
}

/**
 * 一次回复内的 mention 调度上下文：预解析的任务输入按目标 assistantId
 * 索引，handledTargets 记录已随气泡 commit 成功完成调度裁决的目标（可能是
 * future coverage，也可能是新任务），保证同一目标在一次回复中被多个气泡 @
 * 时只裁决一次。directory/actorAssistantId 用于在气泡
 * 提交事务内解析该气泡自己文本里的结构化 @。
 */
interface MentionTaskMaterialization {
  inputsByAssistantId: Map<string, AppendGroupSpeechTaskInput>;
  handledTargets: Set<string>;
  directory: GroupParticipantDirectory;
  actorAssistantId: string;
}

function createMentionTaskMaterialization(params: {
  mentions: GroupMessageMention[];
  inputs: AppendGroupSpeechTaskInput[];
  directory: GroupParticipantDirectory;
  actorAssistantId: string;
}): MentionTaskMaterialization | null {
  if (params.mentions.length === 0) {
    return null;
  }
  return {
    inputsByAssistantId: new Map(params.inputs.map((input) => [input.aiAssistantId, input])),
    handledTargets: new Set(),
    directory: params.directory,
    actorAssistantId: params.actorAssistantId,
  };
}

/**
 * 逐泡提交 fence：只覆写 commitMessage（逐泡落库的唯一写入口），把每个气泡的
 * 提交包成 { fence + INSERT + 可见标记 } 单一事务。含 "@AI" 的气泡在同一
 * 事务内裁决对应发言任务（future-turn coverage 或队尾追加）。fence
 * 失败抛取消错误，由 AssistantMessageDelivery 按投递中断收尾；执行器随后的
 * 终态回写带 expectedStatus CAS，对被换代任务安静丢弃。
 */
function withCommitFence(
  repository: IMessageRepository,
  task: Pick<
    GroupSpeechTask,
    'id' | 'planId' | 'aiAssistantId' | 'sequenceOrder'
  >,
  mentionTasks: MentionTaskMaterialization | null,
  materialize?: ConversationTurnCommitItem['materializeInTransaction'],
): IMessageRepository {
  return {
    ...repository,
    commitMessage: (input) => {
      // 只有事务真正 commit 后才能把目标计入已裁决：fence 拒绝或回滚时不得
      // 留下"已处理"假象，否则后续含同一 mention 的气泡会漏掉调度后果。
      const resolvedTargets: string[] = [];
      return databaseCoordinator.transaction(
        {
          name: 'chat.commit-group-assistant-bubble',
          feature: 'chat',
          priority: 'interactive',
        },
        async (transaction) => {
          const groups = getChatGroupRuntimeDependencies().groups;
          const eligible = await groups.isSpeechTaskCommitEligibleInTransaction(
            transaction,
            task.planId,
            task.id,
          );
          if (!eligible) {
            throw new ChatReplyRunCancelledError('superseded');
          }
          if (materialize) input = { ...input, message: await materialize(transaction, input.message) };
          const segmentMentions = mentionTasks && input.message.senderType === 'assistant'
            ? parseGroupMessageMentions({
              text: input.message.text,
              directory: mentionTasks.directory,
              actorAssistantId: mentionTasks.actorAssistantId,
            })
            : null;
          const message = await getChatMessageRuntimeDependencies()
            .messages.commitMessageInTransaction(
              transaction,
              segmentMentions === null
                ? input
                : {
                  ...input,
                  message: {
                    ...input.message,
                    metadataJson: replaceGroupChatMentions(
                      input.message.metadataJson!,
                      segmentMentions,
                    ),
                  },
                },
            );
          // 群预览与可见气泡同事务提交，交付事件的 consumer 才能立即读到最新列表事实。
          if (message.senderType !== 'reasoning' && input.previewText !== null) {
            await groups.updatePreviewInTransaction(
              transaction,
              message.sessionId,
              message.id,
              input.previewText ?? message.text,
              message.createdAt,
            );
          }
          if (message.senderType === 'assistant') await groups.markSpeechTaskReplyCommittedInTransaction(transaction, task.id);
          // mention 所在气泡的 commit 边界即调度事实边界：该气泡说出口，
          // 对应 scheduling consequence 必须在同一事务裁决；该气泡未 commit，
          // 既不能覆盖未来任务，也不能追加新任务。
          if (mentionTasks && segmentMentions) {
            const dueInputs: AppendGroupSpeechTaskInput[] = [];
            for (const mention of segmentMentions) {
              if (mention.actorType !== 'assistant'
                || mention.target.targetType !== 'assistant') {
                continue;
              }
              const targetId = mention.target.assistantId;
              const taskInput = mentionTasks.inputsByAssistantId.get(targetId);
              if (!taskInput || mentionTasks.handledTargets.has(targetId)) {
                continue;
              }
              dueInputs.push(taskInput);
              resolvedTargets.push(targetId);
            }
            if (dueInputs.length > 0) {
              await groups.materializeAIMentionSpeechTasksInTransaction(
                transaction,
                task.planId,
                task,
                dueInputs,
              );
            }
          }
          return message;
        },
      ).then((message) => {
        for (const targetId of resolvedTargets) {
          mentionTasks?.handledTargets.add(targetId);
        }
        return message;
      });
    },
  };
}

/**
 * 回复层会把整轮 runtime metadata 复制给每个分段；群聊的 mention 却属于各自
 * 可见气泡。这里在该气泡的提交事务内以本段解析结果覆写它，避免后泡尚未提交的
 * @ 提前成为前泡事实。
 */
function replaceGroupChatMentions(
  metadataJson: string,
  mentions: GroupMessageMention[],
): string {
  const metadata = JSON.parse(metadataJson) as { groupChat: Record<string, unknown> };
  return JSON.stringify({
    ...metadata,
    groupChat: {
      ...metadata.groupChat,
      mentions,
    },
  });
}
