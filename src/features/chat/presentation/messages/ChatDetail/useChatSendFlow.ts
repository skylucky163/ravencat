/** 编排聊天消息发送、乐观更新、附件提交、重试与通话创建。 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { showAppDialog } from '@shared/ui';
import { retainChatAttachmentDraftFiles } from './ChatAttachmentDraftFiles';
import { messageTimeline } from '../../../messages/application/MessageTimeline';
import { sendUserMessage } from '../../../messages/application/SendUserMessage';
import {
  getActiveChatCall,
  isChatSendBlockedByCall,
  startOutgoingChatCall,
  type ChatCallSession,
} from '../../../conversation/application/ChatCallGateway';
import type { AIAssistantConfig } from '../../../messages/application/SendUserMessage';
import type { ChatMessage } from '../../../messages/domain/ChatMessage';
import type { ChatAttachment } from '../../../messages/domain/ChatAttachment';
import type { StickerMessageSnapshot } from '../../../messages/domain/ChatSticker';
import {
  getMessageAttachments,
  getMessageSticker,
  getMessageReplyQuote,
} from '../../../messages/domain/chatMessageMetadata';
import type { ChatVoiceRecordingState, ChatVoiceMessageReviewDraft, ReplyTarget } from '../components/chatTypes';
import {
  acceptChatTogetherListeningInvitation,
  declineChatTogetherListeningInvitation,
  inviteTogetherListeningFromChat,
  leaveChatTogetherListening,
  type ChatTogetherListeningResult,
} from '../../../conversation/application/ChatTogetherListeningGateway';
import {
  prepareUserVoiceMessageRecording,
  startUserVoiceMessageRecording,
  type UserVoiceMessageDraft,
  type UserVoiceMessageRecording,
} from '../../../messages/application/UserVoiceMessageRecording';

type MessageStateSetter = Dispatch<SetStateAction<ChatMessage[]>>;
type ErrorStateSetter = Dispatch<SetStateAction<string | null>>;
type BooleanStateSetter = Dispatch<SetStateAction<boolean>>;
type ValueRef<T> = { current: T };

const TIME_SEPARATOR_GAP_MS = 10 * 60 * 1000;

function buildMissingTogetherListeningContextResult(): ChatTogetherListeningResult {
  return {
    status: 'failed',
    activity: null,
    message: '当前聊天暂时无法发起一起听操作',
  };
}

function shouldShowTimeSeparatorForOptimisticMessage(messages: ChatMessage[]): boolean {
  if (messages.length === 0) {
    return true;
  }

  const lastMessage = messages[messages.length - 1];
  const lastTimestamp = new Date(lastMessage.createdAt).getTime();
  const nowTimestamp = Date.now();

  if (!Number.isFinite(lastTimestamp)) {
    return false;
  }

  return nowTimestamp - lastTimestamp >= TIME_SEPARATOR_GAP_MS;
}

interface UseChatSendFlowParams {
  sessionId?: string | null;
  aiAssistant?: { id?: string } | null;
  aiRequestConfig: AIAssistantConfig | null;
  messages: ChatMessage[];
  setMessages: MessageStateSetter;
  setError: ErrorStateSetter;
  setIsTyping: BooleanStateSetter;
  lastMessageIdRef: ValueRef<number | null>;
  onCallCreated?: (call: ChatCallSession) => void;
}

export function useChatSendFlow({
  sessionId,
  aiAssistant,
  aiRequestConfig,
  messages,
  setMessages,
  setError,
  setIsTyping,
  lastMessageIdRef,
  onCallCreated,
}: UseChatSendFlowParams) {
  // 输入框成功受理后会清空草稿；未落库气泡仍需独立持有源，供失败重发读取。
  const failedAttachmentLeases = useRef(new Map<number, () => void>());
  useEffect(() => {
    const leases = failedAttachmentLeases.current;
    return () => { for (const release of leases.values()) release(); leases.clear(); };
  }, [sessionId]);
  const releaseFailedAttachment = useCallback((messageId: number) => {
    failedAttachmentLeases.current.get(messageId)?.();
    failedAttachmentLeases.current.delete(messageId);
  }, []);
  useEffect(() => {
    const visibleIds = new Set(messages.map((message) => message.id));
    for (const id of failedAttachmentLeases.current.keys()) {
      if (!visibleIds.has(id)) releaseFailedAttachment(id);
    }
  }, [messages, releaseFailedAttachment]);
  const [voiceRecordingState, setVoiceRecordingState] = useState<ChatVoiceRecordingState>('idle');
  // 语音录制 / STT 是即时交互，失败必须由输入区直接可见。
  // 不能复用 setError：那是历史消息加载与发送失败的通道，ChatDetail 只在
  // messages.length === 0 时渲染它，已有消息的正常会话里会静默吞掉语音错误。
  const [voiceRecordingError, setVoiceRecordingError] = useState<string | null>(null);
  // 发送前校对阶段。draft 只在 reviewing/committing 期间存在；null 表示没有待发送语音。
  const [voiceReviewDraft, setVoiceReviewDraftState] = useState<ChatVoiceMessageReviewDraft | null>(null);
  const [voiceRecordingProgress, setVoiceRecordingProgress] = useState({ durationMs: 0, level: 0 });
  // commit 需要读到“用户此刻编辑中的文本”。state 在异步回调里可能是旧值，
  // 因此用 ref 同步镜像最新的校对内容；两者只通过 setVoiceReviewDraft 一起更新。
  const voiceReviewDraftRef = useRef<ChatVoiceMessageReviewDraft | null>(null);
  const setVoiceReviewDraft = useCallback((next: ChatVoiceMessageReviewDraft | null) => {
    voiceReviewDraftRef.current = next;
    setVoiceReviewDraftState(next);
  }, []);
  const voiceRecordingRef = useRef<UserVoiceMessageRecording | null>(null);
  // reviewing 阶段真正的资源所有者。presentation 状态（voiceReviewDraft）只是它的
  // 只读投影：raw URI 与 MediaAsset attempt 不离开 application 层。
  const voiceMessageDraftRef = useRef<UserVoiceMessageDraft | null>(null);
  // starting 期间（含 pending start）不允许第二次 start。用 ref 而不是 state：
  // press 事件可能在 state 更新 re-render 之前同帧重复到达，state 读到的还是旧值。
  const voiceStartInFlightRef = useRef(false);
  // commit ownership 绑定具体 draft 与 generation。旧 session 的 commit 可以继续跑完，
  // 但它的 finally 不能清掉新 session 已经开始的另一次 commit。
  const voiceCommitInFlightRef = useRef<{
    draft: UserVoiceMessageDraft;
    generation: number;
  } | null>(null);
  // generation fence：每次 session 变化 / unmount / 显式取消 / finish 都自增。startUserVoiceMessageRecording
  // 是异步的（STT 连接、麦克风权限、AudioRecord 初始化都可能耗时），期间用户可能切会话、
  // 退出语音模式或 unmount。只有 generation 仍然匹配的启动才允许写回 ref/state；
  // 过期启动即使随后成功，也必须立即 cancel 自己，绝不允许旧 session 的录音泄漏到新 session。
  const voiceGenerationRef = useRef(0);

  /**
   * 作废当前语音启动的所有权。
   *
   * 同时清掉 in-flight 标记：否则启动期间切 session 后，新 session 立刻长按会被
   * 旧启动的标记挡住，表现为“切了会话就按不动”。
   */
  const invalidateVoiceGeneration = useCallback(() => {
    voiceGenerationRef.current += 1;
    voiceStartInFlightRef.current = false;
  }, []);

  /**
   * 释放 reviewing/committing 阶段持有的 draft。
   *
   * 只在“本条语音已经彻底作废”时调用（切 session / unmount / 用户取消）。commit
   * 失败时**不**调用：那时 draft 仍要保留，用户才能重试发送，不能把音频丢掉。
   */
  const releaseVoiceDraft = useCallback((options?: { silent?: boolean }) => {
    const draft = voiceMessageDraftRef.current;
    voiceMessageDraftRef.current = null;
    setVoiceReviewDraft(null);
    setVoiceRecordingState('idle');
    if (!draft) return;
    // 进行中的 canonical commit 拥有本次 attempt。此处只放弃 UI ownership；失败后由
    // commit 回调在 attempt 已结束时 discard，不能在这里并发删除 source/backing。
    if (voiceCommitInFlightRef.current?.draft === draft) return;
    void draft.discard().catch((error) => {
      if (!options?.silent) {
        setVoiceRecordingError(error instanceof Error ? error.message : '清理语音草稿失败');
      }
    });
  }, [setVoiceReviewDraft]);

  useEffect(() => {
    invalidateVoiceGeneration();
    // 切 session / unmount 时 reviewing draft 必须被丢弃：它属于旧 session，
    // 既不能提交进新 session，也不能继续占用录音文件。
    const draft = voiceMessageDraftRef.current;
    voiceMessageDraftRef.current = null;
    if (draft && voiceCommitInFlightRef.current?.draft !== draft) {
      void draft.discard().catch(() => undefined);
    }
    setVoiceReviewDraft(null);
    setVoiceRecordingState('idle');
    setVoiceRecordingError(null);
    return () => {
      invalidateVoiceGeneration();
      const recording = voiceRecordingRef.current;
      voiceRecordingRef.current = null;
      if (recording) void recording.cancel();
      const pendingDraft = voiceMessageDraftRef.current;
      voiceMessageDraftRef.current = null;
      if (pendingDraft && voiceCommitInFlightRef.current?.draft !== pendingDraft) {
        void pendingDraft.discard().catch(() => undefined);
      }
    };
  }, [sessionId, invalidateVoiceGeneration, setVoiceReviewDraft]);
  const markMessageFailed = useCallback(
    (messageId: number) => {
      setMessages((prev) =>
        prev.map((message) =>
          message.id === messageId ? { ...message, status: 'failed' } : message
        )
      );
    },
    [setMessages]
  );

  const replaceMessage = useCallback(
    (nextMessage: ChatMessage) => {
      setMessages((prev) => {
        const mergeResult = messageTimeline.mergeMessages(prev, [nextMessage], 'append');
        lastMessageIdRef.current = mergeResult.lastMessageId;
        return mergeResult.changed ? mergeResult.messages : prev;
      });
    },
    [lastMessageIdRef, setMessages]
  );

  const sendMessage = useCallback(
    async (
      text: string,
      replyTo: ReplyTarget | null = null,
      attachments: ChatAttachment[] = [],
      { sticker = null, onQueued, requestReply }: { sticker?: StickerMessageSnapshot; onQueued?: () => void; requestReply?: boolean } = {},
    ) => {
      const normalizedText = text.trim();
      if (
        (!normalizedText && attachments.length === 0 && !sticker)
        || !sessionId
        || !aiAssistant
        || !aiRequestConfig
      ) {
        return false;
      }

      setError(null);

      const activeCall = getActiveChatCall();
      if (isChatSendBlockedByCall(activeCall, sessionId, aiRequestConfig.id)) {
        setError('视频电话期间不可发送普通聊天消息');
        return false;
      }

      const optimisticMessages = messageTimeline.createOptimisticUserMessages({
        sessionId,
        text: normalizedText,
        replyToId: replyTo?.id || null,
        showTimeSeparatorBefore: shouldShowTimeSeparatorForOptimisticMessage(messages),
        replyToText: replyTo?.text || null,
        replyQuote: replyTo?.quote,
        attachments,
        sticker,
      });
      const tail = optimisticMessages[optimisticMessages.length - 1];
      for (const message of optimisticMessages) {
        failedAttachmentLeases.current.set(message.id, retainChatAttachmentDraftFiles(getMessageAttachments(message)));
      }
      const markSubmissionFailed = () => {
        for (const message of optimisticMessages) markMessageFailed(message.id);
      };

      setMessages((prev) => {
        const mergeResult = messageTimeline.mergeMessages(prev, optimisticMessages, 'append');
        lastMessageIdRef.current = mergeResult.lastMessageId;
        return mergeResult.changed ? mergeResult.messages : prev;
      });
      // 气泡与附件持有权已接住本次提交，输入区可立即清空，不等待落库和宿主交接。
      onQueued?.();

      try {
        const result = await sendUserMessage(
          {
            sessionId,
            text: normalizedText,
            requestReply,
            replyToId: replyTo?.id || null,
            replyToText: replyTo?.text || null,
            replyQuote: replyTo?.quote,
            clientMessageId: tail.clientMessageId,
            attachments,
            sticker,
          },
          aiRequestConfig
        );

        if (result.userMessage) {
          for (const message of optimisticMessages) releaseFailedAttachment(message.id);
          setMessages((prev) => {
            const merged = messageTimeline.mergeMessages(prev, result.userMessages, 'append');
            lastMessageIdRef.current = merged.lastMessageId;
            return merged.changed ? merged.messages : prev;
          });
        } else {
          markSubmissionFailed();
        }
        if (!result.success) setError(result.error || '发送失败');
      } catch (err) {
        markSubmissionFailed();
        setError(err instanceof Error ? err.message : '发送失败');
      }

      return true;
    },
    [
      sessionId,
      aiAssistant,
      aiRequestConfig,
      messages,
      setError,
      setMessages,
      lastMessageIdRef,
      markMessageFailed,
      releaseFailedAttachment,
    ]
  );

  const sendSticker = useCallback(
    (sticker: StickerMessageSnapshot) => sendMessage('', null, [], { sticker }),
    [sendMessage],
  );

  /**
   * 进入语音输入模式前的 preflight。
   *
   * 只确认麦克风权限，不建立 STT session：腾讯实时 ASR 的 WebSocket 仍然只在
   * 真正准备录音时建立。权限被拒时立刻给出可见错误，用户不必先长按一次才发现
   * 麦克风入口“像坏掉”；同时这里不检查 STT 是否已配置，未配置 STT 的环境依然
   * 可以正常进入“按住说话”。
   */
  const prepareVoiceRecordingEntry = useCallback(async () => {
    const result = await prepareUserVoiceMessageRecording();
    if (result.ready === false) {
      setVoiceRecordingError(result.message);
      return false;
    }

    setVoiceRecordingError(null);
    return true;
  }, []);

  const dismissVoiceRecordingError = useCallback(() => {
    setVoiceRecordingError(null);
  }, []);

  const startVoiceRecording = useCallback(async () => {
    if (!sessionId || !aiAssistant?.id || !aiRequestConfig) {
      return false;
    }
    // starting 期间重复触发直接忽略，避免第二次 start 与第一次抢同一个 generation。
    if (voiceStartInFlightRef.current) {
      return false;
    }
    // reviewing / committing 期间不允许开始第二段录音：draft 的生命周期不允许被
    // 新的录音覆盖（否则会丢失用户正在校对的音频）。
    if (voiceMessageDraftRef.current) {
      return false;
    }

    voiceStartInFlightRef.current = true;
    const generation = voiceGenerationRef.current;
    setVoiceRecordingError(null);
    setVoiceRecordingProgress({ durationMs: 0, level: 0 });
    // press grant 后立刻进入 starting：STT 模型解析、ASR 建连、权限确认与
    // native AudioRecord 初始化都在这个窗口内，UI 必须给用户可见反馈。
    setVoiceRecordingState('starting');

    try {
      const result = await startUserVoiceMessageRecording({
        sessionId,
        assistantId: aiAssistant.id,
        aiConfig: aiRequestConfig,
        onProgress: (progress) => {
          // 音量与转写结果共享同一所有权，旧录音不得刷新新会话的反馈。
          if (generation === voiceGenerationRef.current) setVoiceRecordingProgress(progress);
        },
      });
      // 启动期间 session 变化 / unmount / 取消 / finish：本次启动已失去所有权。
      // 成功也必须立即 cancel 自己，不得写入 ref/state 污染新 session。
      if (generation !== voiceGenerationRef.current) {
        if (!('success' in result)) void result.cancel();
        return false;
      }
      if ('success' in result) {
        setVoiceRecordingError(result.message);
        setVoiceRecordingState('idle');
        return false;
      }
      voiceRecordingRef.current = result;
      setVoiceRecordingState('recording');
      return true;
    } catch (error) {
      // startUserVoiceMessageRecording 正常路径只返回失败结果；这里兜住意外抛出，
      // 否则 starting 会永远停在原地，用户再也按不动录音。
      if (generation === voiceGenerationRef.current) {
        setVoiceRecordingError(error instanceof Error ? error.message : '无法开始录音');
        setVoiceRecordingState('idle');
      }
      return false;
    } finally {
      // 只有仍拥有 generation 的启动才收回 in-flight 标记，否则会误清新一次 start 的标记。
      if (generation === voiceGenerationRef.current) {
        voiceStartInFlightRef.current = false;
      }
    }
  }, [aiAssistant?.id, aiRequestConfig, sessionId]);

  /**
   * 结束录音并进入发送前校对。
   *
   * 识别成功后**不**提交 canonical message，而是把结果投影成 `voiceReviewDraft`
   * 并进入 `reviewing`：此刻 AI、preview、timeline 都还没有这条语音。真正的提交
   * 只发生在用户点击“发送”之后（`commitVoiceReviewDraft`）。
   */
  const finishVoiceRecording = useCallback(async () => {
    // 结束录音会消费掉当前 recording，同样作废任何仍 pending 的启动。
    invalidateVoiceGeneration();
    const recording = voiceRecordingRef.current;
    if (!recording) return false;
    voiceRecordingRef.current = null;
    const generation = voiceGenerationRef.current;
    setVoiceRecordingState('processing');
    try {
      const result = await recording.finish();
      // processing 期间切 session / unmount / 取消：本次识别结果已失去所有权。
      // 即使 STT 随后成功，也必须 self-discard，绝不能生成 stale draft。
      if (generation !== voiceGenerationRef.current) {
        if (result.success) await result.draft.discard().catch(() => undefined);
        return false;
      }
      if (result.success === false) {
        setVoiceRecordingError(result.message);
        setVoiceRecordingState('idle');
        return false;
      }
      voiceMessageDraftRef.current = result.draft;
      setVoiceReviewDraft({
        originalTranscript: result.draft.originalTranscript,
        durationMs: result.draft.durationMs,
        transcript: result.draft.originalTranscript,
      });
      setVoiceRecordingState('reviewing');
      return true;
    } catch (error) {
      if (generation === voiceGenerationRef.current) {
        setVoiceRecordingError(error instanceof Error ? error.message : '语音识别失败');
        setVoiceRecordingState('idle');
      }
      return false;
    }
  }, [invalidateVoiceGeneration, setVoiceReviewDraft]);

  /** 校对阶段用户编辑 transcript。 */
  const updateVoiceReviewTranscript = useCallback((transcript: string) => {
    const previous = voiceReviewDraftRef.current;
    if (!previous) return;
    setVoiceReviewDraft({ ...previous, transcript });
  }, [setVoiceReviewDraft]);

  /**
   * 用户点击“发送”：用最终确认的 transcript 提交 canonical 用户语音消息。
   *
   * 提交成功后 AI reply run 才会开始（由 `commitAndDispatchCanonicalUserMessage`
   * 在 commit 之后触发）。提交失败时保留 reviewing draft，用户可以重试发送，
   * 绝不能把音频丢掉。
   */
  const commitVoiceReviewDraft = useCallback(async () => {
    const draft = voiceMessageDraftRef.current;
    if (!draft) return false;
    // 同一 draft 只能有一个 commit；不同 generation 的旧 commit 不阻塞新 session。
    if (voiceCommitInFlightRef.current?.draft === draft) return false;

    const ownership = { draft, generation: voiceGenerationRef.current };
    voiceCommitInFlightRef.current = ownership;
    setVoiceRecordingState('committing');
    try {
      const transcript = voiceReviewDraftRef.current?.transcript ?? draft.originalTranscript;
      const result = await draft.commit(transcript);
      const stale = ownership.generation !== voiceGenerationRef.current
        || voiceMessageDraftRef.current !== draft;
      if (result.success === false) {
        if (stale) {
          // session 已切换或组件已卸载：attempt 已结束，现在才允许终结孤儿 draft。
          await draft.discard().catch(() => undefined);
          return false;
        }
        // commit 失败：保留 draft 与 reviewing 状态，允许用户修改后重试。
        setVoiceRecordingError(result.message);
        setVoiceRecordingState('reviewing');
        return false;
      }
      if (stale) {
        // application 已完成 finalize/source cleanup；旧 session 结果不得写当前 UI。
        return false;
      }
      voiceMessageDraftRef.current = null;
      setVoiceReviewDraft(null);
      replaceMessage(result.message);
      setVoiceRecordingState('idle');
      return true;
    } catch (error) {
      const stale = ownership.generation !== voiceGenerationRef.current
        || voiceMessageDraftRef.current !== draft;
      if (stale) {
        await draft.discard().catch(() => undefined);
        return false;
      }
      setVoiceRecordingError(error instanceof Error ? error.message : '语音消息发送失败');
      setVoiceRecordingState('reviewing');
      return false;
    } finally {
      if (voiceCommitInFlightRef.current === ownership) {
        voiceCommitInFlightRef.current = null;
      }
    }
  }, [replaceMessage, setVoiceReviewDraft]);

  /** 用户点击“取消”：丢弃录音与未接管的 media backing，不产生任何 Chat 事实。 */
  const discardVoiceReviewDraft = useCallback(async () => {
    releaseVoiceDraft();
  }, [releaseVoiceDraft]);

  const cancelVoiceRecording = useCallback(async () => {
    // 取消同时作废正在启动的录音：即使 pending start 之后成功，也会 self-cancel。
    invalidateVoiceGeneration();
    const recording = voiceRecordingRef.current;
    voiceRecordingRef.current = null;
    if (recording) await recording.cancel();
    // reviewing / committing 期间取消同样要丢弃 draft。
    const draft = voiceMessageDraftRef.current;
    voiceMessageDraftRef.current = null;
    setVoiceReviewDraft(null);
    setVoiceRecordingState('idle');
    if (draft && voiceCommitInFlightRef.current?.draft !== draft) {
      await draft.discard();
    }
  }, [invalidateVoiceGeneration, setVoiceReviewDraft]);

  const retrySend = useCallback(
    async (messageId: number) => {
      const message = messages.find((item) => item.id === messageId);
      if (!message || message.isMe === false || !sessionId || !aiRequestConfig) return;

      setError(null);

      const activeCall = getActiveChatCall();
      if (isChatSendBlockedByCall(activeCall, sessionId, aiRequestConfig.id)) {
        setError('视频通话中请先在通话界面继续对话，挂断后再重发聊天消息');
        return;
      }

      setMessages((prev) =>
        prev.map((item) =>
          item.id === messageId ? { ...item, status: 'pending' } : item
        )
      );

      try {
        const attachments = getMessageAttachments(message);
        const sticker = getMessageSticker(message);
        const releaseRetry = retainChatAttachmentDraftFiles(attachments);
        const result = await sendUserMessage(
          {
            sessionId,
            text: message.text,
            replyToId: message.replyToId,
            replyToText: message.replyToText,
            replyQuote: getMessageReplyQuote(message),
            clientMessageId: message.clientMessageId || null,
            attachments,
            sticker,
          },
          aiRequestConfig
        ).finally(releaseRetry);

        if (result.userMessage) {
          releaseFailedAttachment(messageId);
          setMessages((prev) => {
            const merged = messageTimeline.mergeMessages(prev, result.userMessages, 'append');
            lastMessageIdRef.current = merged.lastMessageId;
            return merged.changed ? merged.messages : prev;
          });
        } else {
          markMessageFailed(messageId);
        }
        if (!result.success) setError(result.error || '重发失败');
      } catch (err) {
        markMessageFailed(messageId);
        setError(err instanceof Error ? err.message : '重发失败');
      }
    },
    [
      messages,
      sessionId,
      aiRequestConfig,
      setMessages,
      setError,
      markMessageFailed,
      releaseFailedAttachment,
      lastMessageIdRef,
    ]
  );

  const startVideoCall = useCallback(async () => {
    if (!sessionId || !aiAssistant || !aiRequestConfig) return;

    setError(null);
    setIsTyping(true);

    try {
      const result = await startOutgoingChatCall({
        chatSessionId: sessionId,
        aiConfig: aiRequestConfig,
        requestedMode: 'video',
        onCallCreated,
      });
      const visibleMessagesForCurrentSession = result.visibleMessages.filter(
        (message) => message.sessionId === sessionId
      );

      if (visibleMessagesForCurrentSession.length > 0) {
        setMessages((prev) => {
          const mergeResult = messageTimeline.mergeMessages(prev, visibleMessagesForCurrentSession, 'append');
          lastMessageIdRef.current = mergeResult.lastMessageId;
          return mergeResult.changed ? mergeResult.messages : prev;
        });
      }

      if (result.status === 'failed') {
        // 拨号可能已经切到通话页；全局详情在终态退出后仍可见，不走历史加载错误通道。
        showAppDialog({ title: '视频通话未接通', message: result.errorMessage, tone: 'error' });
      }
    } catch (err) {
      showAppDialog({ title: '视频通话未接通', message: err instanceof Error ? err.message : String(err), tone: 'error' });
    } finally {
      setIsTyping(false);
    }
  }, [
    sessionId,
    aiAssistant,
    aiRequestConfig,
    setError,
    setIsTyping,
    setMessages,
    lastMessageIdRef,
    onCallCreated,
  ]);

  const inviteTogetherListening = useCallback(() => {
    if (!sessionId || !aiAssistant || !aiRequestConfig) {
      return Promise.resolve(buildMissingTogetherListeningContextResult());
    }

    return inviteTogetherListeningFromChat({
      chatSessionId: sessionId,
      aiConfig: aiRequestConfig,
    });
  }, [aiAssistant, aiRequestConfig, sessionId]);

  const acceptTogetherListening = useCallback((activityId: string) => {
    if (!sessionId || !aiAssistant || !aiRequestConfig) {
      return Promise.resolve(buildMissingTogetherListeningContextResult());
    }

    return acceptChatTogetherListeningInvitation({
      activityId,
      chatSessionId: sessionId,
      aiConfig: aiRequestConfig,
    });
  }, [aiAssistant, aiRequestConfig, sessionId]);

  const declineTogetherListening = useCallback((activityId: string) => {
    if (!sessionId || !aiAssistant || !aiRequestConfig) {
      return Promise.resolve(buildMissingTogetherListeningContextResult());
    }

    return declineChatTogetherListeningInvitation({
      activityId,
      chatSessionId: sessionId,
      aiConfig: aiRequestConfig,
    });
  }, [aiAssistant, aiRequestConfig, sessionId]);

  const leaveTogetherListening = useCallback((activityId: string) => {
    if (!sessionId || !aiAssistant || !aiRequestConfig) {
      return Promise.resolve(buildMissingTogetherListeningContextResult());
    }

    return leaveChatTogetherListening({
      activityId,
      chatSessionId: sessionId,
      aiConfig: aiRequestConfig,
    });
  }, [aiAssistant, aiRequestConfig, sessionId]);

  return {
    sendMessage,
    sendSticker,
    voiceRecordingState,
    voiceRecordingProgress,
    voiceRecordingError,
    voiceReviewDraft,
    prepareVoiceRecordingEntry,
    dismissVoiceRecordingError,
    startVoiceRecording,
    finishVoiceRecording,
    updateVoiceReviewTranscript,
    commitVoiceReviewDraft,
    discardVoiceReviewDraft,
    cancelVoiceRecording,
    startVideoCall,
    retrySend,
    inviteTogetherListening,
    acceptTogetherListening,
    declineTogetherListening,
    leaveTogetherListening,
  };
}
