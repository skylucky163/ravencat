/** 执行悬浮层截图草稿与显式发送，共用应用运行宿主。 */
import { getAssistantDisplayName } from '@features/assistants';

import type { ChatAttachment } from '@features/chat';
import {
  releaseCapturedScreen,
  ScreenCaptureError,
  type CapturedScreen,
} from '@features/screenCapture';
import {
  completeScreenCaptureVisibility,
  recordFloatingMessageTaskCompletion,
  updateReplyPreview,
  updateTargetPreview,
} from '@features/floatingLayer';
import {
  buildCompanionAIRequestConfig,
  resolveCompanionConversationTarget,
  type CompanionConversationTarget,
} from './CompanionConversationTarget';
import {
  captureCompanionScreen,
  deletePersistedCompanionScreenAttachment,
  persistCompanionScreenAttachment,
} from './CompanionScreenCapture';
import { getCompanionRuntimeDependencies } from './CompanionRuntimeDependencies';

interface FloatingMessageTaskData {
  action?: string;
  text?: string;
  correlationId?: string;
  createdAtEpochMs?: number;
  screenshotCorrelationId?: string;
}

type FloatingMessageAction = 'message' | 'screen' | 'discard_screen';

// 与原生输入区同属进程内草稿；只有用户点击发送才交给 Chat 持久化。
const stagedScreens = new Map<string, CapturedScreen>();

export async function executeFloatingMessage(
  data: FloatingMessageTaskData,
  execution: { signal: AbortSignal; executionDeadlineAt: number },
): Promise<void> {
  const correlationId = data.correlationId?.trim();
  if (!correlationId) {
    throw new Error('悬浮消息后台任务缺少 correlationId');
  }

  const action = normalizeAction(data.action);
  const text = data.text?.trim() ?? '';
  const dependencies = getCompanionRuntimeDependencies();
  let succeeded = false;
  let failureMessage: string | null = null;
  let taskError: Error | null = null;
  let overlayRestored = action !== 'screen';
  let capture: CapturedScreen | null = null;
  let attachment: ChatAttachment | null = null;
  let sessionId: string | undefined;

  console.info('[RavenCatFloatingMessageTask] started', {
    correlationId,
    action,
    createdAtEpochMs: data.createdAtEpochMs || null,
  });

  const restoreScreenOverlay = async (succeeded: boolean) => {
    if (overlayRestored) {
      return;
    }
    await completeScreenCaptureVisibility({
      correlationId,
      succeeded,
    });
    overlayRestored = true;
  };

  try {
    if (execution.signal.aborted) throw new Error('后台执行已取消或超时');
    if (action === 'discard_screen') {
      capture = takeStagedScreen(data.screenshotCorrelationId!);
      succeeded = true;
      return;
    }
    if (action === 'message' && data.screenshotCorrelationId) {
      capture = takeStagedScreen(data.screenshotCorrelationId);
    }
    await dependencies.initializeDatabase();
    if (action === 'screen') {
      capture = await captureCompanionScreen();
      stagedScreens.set(correlationId, capture);
      const accepted = await completeScreenCaptureVisibility({
        correlationId,
        succeeded: true,
        screenshotUri: capture.screenshot.uri,
      });
      overlayRestored = true;
      if (accepted) {
        capture = null;
      }
      succeeded = accepted;
      return;
    }
    if (!text && !capture) {
      throw new Error('悬浮消息不能为空');
    }
    const targetResult = await resolveCompanionConversationTarget();
    if ('error' in targetResult) {
      // 目标不可用是已知业务结果，由悬浮提示和原生回执收口。
      failureMessage = targetResult.error;
      await updateReplyPreview({
        correlationId,
        status: 'error',
        text: failureMessage,
      });
      return;
    }
    sessionId = targetResult.session.id;

    await updateTargetPreview({
      title: `To ${getAssistantDisplayName(targetResult.ai)}`,
      subtitle: targetResult.session.name?.trim() || 'Active session',
      status: 'ready',
    });

    if (capture) {
      attachment = await persistCompanionScreenAttachment(capture);
      capture = null;
    }

    await deliverFloatingMessage({ correlationId, text, attachment, target: targetResult }, execution);

    succeeded = true;
  } catch (error) {
    taskError = error instanceof Error
      ? error
      : new Error('RavenCat 悬浮消息后台任务发生未知错误');
    failureMessage = taskError.message;
    await updateReplyPreview({
      correlationId,
      sessionId,
      status: 'error',
      text: taskError.message,
    }).catch(() => {});
  } finally {
    if (capture) {
      if (action === 'screen') {
        stagedScreens.delete(correlationId);
      }
      await releaseCapturedScreen(capture).catch((error) => {
        console.warn('[RavenCatFloatingMessageTask] 截图草稿释放失败：', error);
      });
    }
    // Chat 提交时接管独立 canonical backing，发送准备文件始终由本次任务释放。
    if (attachment) {
      await deletePersistedCompanionScreenAttachment(attachment).catch((error) => {
        console.warn('[RavenCatFloatingMessageTask] 截图发送源释放失败：', error);
      });
    }
    await restoreScreenOverlay(false).catch(() => {});
    await recordFloatingMessageTaskCompletion({
      correlationId,
      succeeded,
      error: failureMessage,
    });
    console.info('[RavenCatFloatingMessageTask] completed', {
      correlationId,
      action,
      succeeded,
      error: failureMessage,
    });
  }

  // 截屏策略拒绝已通过悬浮预览和原生回执表达，不再升级为执行异常。
  if (taskError && !(taskError instanceof ScreenCaptureError)) {
    throw taskError;
  }
}

function takeStagedScreen(correlationId: string): CapturedScreen {
  const capture = stagedScreens.get(correlationId);
  if (!capture) {
    throw new Error('暂存截图已失效，请重新截图');
  }
  stagedScreens.delete(correlationId);
  return capture;
}

async function deliverFloatingMessage(params: {
  correlationId: string;
  text: string;
  attachment: ChatAttachment | null;
  target: CompanionConversationTarget;
}, execution: { signal: AbortSignal; executionDeadlineAt: number }): Promise<void> {
  const dependencies = getCompanionRuntimeDependencies();
  let deliveredSegmentCount = 0;
  let replySettled = false;
  let settleReply!: () => void;
  const replyCompletion = new Promise<void>((resolve) => {
    settleReply = () => {
      if (!replySettled) {
        replySettled = true;
        resolve();
      }
    };
  });
  let previewUpdates: Promise<void> = Promise.resolve();
  const displayedSegments = new Map<string, { correlationId: string; displayed: boolean }>();
  const queuePreviewUpdate = <T>(update: () => Promise<T>): Promise<T> => {
    const result = previewUpdates.then(update);
    // 后续更新必须继续排队，即使某个原生预览调用失败；失败段会回退到系统通知。
    previewUpdates = result.then(() => undefined, () => undefined);
    return result;
  };
  const settleAfterPreview = () => {
    void previewUpdates.then(settleReply, settleReply);
  };

  await updateReplyPreview({
    correlationId: params.correlationId,
    sessionId: params.target.session.id,
    status: 'pending',
    text: 'Waiting for reply...',
  });

  // 取消时 Coordinator 可以直接撤销 owner，不再产生回复回调；等待方也必须收口。
  execution.signal.addEventListener('abort', settleAfterPreview, { once: true });
  if (execution.signal.aborted) settleAfterPreview();
  try {
    // 该窄端口由 Host 固定当前宿主执行模式；调用方等待回复投影完成。
    const result = await dependencies.chat.sendUserMessageFromExecutionHost({
      execution,
      message: {
        sessionId: params.target.session.id,
        text: params.text,
        clientMessageId: params.correlationId,
        attachments: params.attachment ? [params.attachment] : [],
      },
      aiConfig: buildCompanionAIRequestConfig(params.target.ai),
      correlationId: params.correlationId,
      replyCallbacks: {
        onReplyDisplaySegment: async (payload) => {
          const correlationId = deliveredSegmentCount === 0
            ? params.correlationId
            : `${params.correlationId}:reply-segment:${payload.clientMessageId}`;
          deliveredSegmentCount++;
          const segment = { correlationId, displayed: false };
          displayedSegments.set(payload.clientMessageId, segment);
          const displayed = await queuePreviewUpdate(() => updateReplyPreview({
            correlationId, sessionId: payload.sessionId, status: 'reply', text: payload.previewText,
          }));
          segment.displayed = displayed;
          return { userNotificationHandled: displayed };
        },
        onReplySegment: async (payload) => {
          if (payload.clientMessageId && displayedSegments.has(payload.clientMessageId)) {
            const segment = displayedSegments.get(payload.clientMessageId)!;
            // 沿同一预览身份绑定正式 ID，让实际可见回执和会话投影接管；不新增气泡。
            await queuePreviewUpdate(() => updateReplyPreview({
              correlationId: segment.correlationId, sessionId: payload.sessionId, messageId: payload.messageId,
              status: 'reply', text: payload.previewText,
            }));
            return { userNotificationHandled: segment.displayed };
          }
          // 工具输出可各自独立提交，分段序号不再是整轮唯一身份；媒体沿正式消息的稳定身份展示。
          const segmentCorrelationId = payload.clientMessageId
            ? `${params.correlationId}:reply-segment:${payload.clientMessageId}`
            : payload.segmentIndex === 0 ? params.correlationId : `${params.correlationId}:reply-segment:${payload.segmentIndex}`;
          deliveredSegmentCount = Math.max(deliveredSegmentCount, payload.segmentIndex + 1);
          try {
            const displayed = await queuePreviewUpdate(() => updateReplyPreview({
              correlationId: segmentCorrelationId,
              sessionId: payload.sessionId,
              messageId: payload.messageId,
              status: 'reply',
              text: payload.previewText.trim() || payload.text.trim(),
            }));
            return { userNotificationHandled: displayed };
          } catch (error) {
            console.warn('[RavenCatFloatingMessageTask] 回复预览更新失败，将保留系统通知：', error);
            return undefined;
          }
        },
        onFinalReply: (payload) => {
          if (deliveredSegmentCount === 0) {
            queuePreviewUpdate(() => updateReplyPreview({
              correlationId: params.correlationId,
              sessionId: payload.sessionId,
              messageId: payload.segments[0]?.messageId,
              status: 'reply',
              text: payload.previewText.trim() || payload.joinedText.trim() || payload.text.trim(),
            }));
          }
          settleAfterPreview();
        },
        onReplyCommitted: settleAfterPreview,
        onReplyFailed: (payload) => {
          queuePreviewUpdate(() => updateReplyPreview({
            correlationId: params.correlationId,
            sessionId: payload.sessionId,
            messageId: payload.messageId ?? undefined,
            status: 'error',
            text: payload.previewText.trim() || payload.error,
          }));
          settleAfterPreview();
        },
      },
    });


    if (!result.success) {
      throw new Error(result.error || '悬浮窗消息发送失败。');
    }

    await replyCompletion;
    await previewUpdates;
    if (execution.signal.aborted) throw new Error('后台执行已取消或超时');
  } finally {
    execution.signal.removeEventListener('abort', settleAfterPreview);
  }
}

function normalizeAction(value: string | undefined): FloatingMessageAction {
  if (value === 'screen' || value === 'discard_screen') {
    return value;
  }
  return 'message';
}
