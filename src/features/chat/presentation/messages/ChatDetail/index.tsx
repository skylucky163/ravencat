/** 单聊消息详情页，协调时间线、输入区与消息操作。 */
import { getAssistantDisplayName } from '@features/assistants';
import { showAppDialog } from '@shared/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, ActivityIndicator, Animated, Text, TouchableOpacity, ToastAndroid } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import ChatHeader from '../components/ChatHeader';
import { useChatMessageSelection } from '../components/useChatMessageSelection';
import { useChatMessageShare } from '../components/useChatMessageShare';
import { useChatFavoriteAction } from '../components/useChatFavoriteAction';
import { useChatStickerAction } from '../components/useChatStickerAction';
import { getChatMessageActions } from '../../../messages/domain/ChatMessageActions';
import ChatContentShareSheet from '../components/ChatContentShareSheet';
import { ChatSelectionHeader, ChatSelectionFooter } from '../components/ChatSelectionBars';
import ChatMessageList from '../components/ChatMessageList';
import ChatInputArea from '../components/ChatInputArea';
import ChatMessageActionMenu from '../components/ChatMessageActionMenu';
import ChatMessageEditor from '../components/ChatMessageEditor';
import ChatMessageTextSelectionSheet from '../components/ChatMessageTextSelectionSheet';
import ChatRegenerationConfirm, { shouldConfirmChatRegeneration } from '../components/ChatRegenerationConfirm';
import ChatReplyVersionSheet from '../components/ChatReplyVersionSheet';
import { getChatSelectionKey } from '../../../messages/domain/ChatMessageSelection';
import { canEditChatMessage } from '../../../messages/domain/ChatMessageEditing';
import { copyTextToClipboard } from '@platform/device';
import ChatBackground from '../components/ChatBackground';
import { useChatDetail } from './useChatDetail';
import { useChatTurnExecutionStatus } from './useChatTurnExecutionStatus';
import { useChatRegeneration } from './useChatRegeneration';
import { useAttachmentDraft } from './useAttachmentDraft';
import { translateMessageText } from '@features/integrations';
import { deleteChatMessage } from '../../../messages/application/DeleteChatMessage';
import { isAgentTransientTimelineMessage } from '../../../messages/application/AgentTransientTimeline';
import { voiceMessagePlaybackCoordinator } from '../../../messages/application/VoiceMessagePlaybackCoordinator';
import {
  getMessageVoice,
  type ChatReplyTarget,
} from '../../../messages/domain/chatMessageMetadata';
import type { ChatMessage } from '../../../messages/domain/ChatMessage';
import type { StickerMessageSnapshot } from '../../../messages/domain/ChatSticker';
import type { ChatCallSession } from '../../../conversation/application/ChatCallGateway';
import { shouldShowTogetherListeningChatEntry } from '../../../conversation/application/ChatTogetherListeningGateway';
import type { ChatSession } from '../../../conversation/domain/SessionRepository';
import { createChatReplyTarget, type ChatDetailAIAssistantLike } from '../components/chatTypes';
import type { MessageTranslationBlock } from '../components/chatMessageRenderUtils';
import type { UserProfile } from '@features/profile';
import { createChatDetailStyles } from '../components/chatStyles';
import { useTheme } from '@shared/theme';
import { useChatComposerSurface } from '../components/useChatComposerSurface';
import { getChatSummarySettings, setFixedChatContextStart } from '../../../summary/application/ChatSummary';
import { subscribeChatSummaryChanged } from '../../../summary/application/ChatSummaryRuntime';
import { setChatEventBus } from '../../../messages/events/ChatEvents';
import { projectChatContextMessage } from '../../../summary/domain/ChatContext';
import { useChatTextDraft } from '../../shell/ChatTextDraftProvider';
import type { ChatSummarySettings } from '../../../summary/domain/ChatSummaryRepository';

type ChatDetailCurrentUser = Pick<UserProfile, 'name' | 'avatar'>;

interface ChatDetailModuleProps {
  aiAssistant?: ChatDetailAIAssistantLike | null;
  session?: ChatSession | null;
  /** React Navigation 会保留失焦页面；只有当前 route 可见时为 true。 */
  isActive?: boolean;
  /** 主动生活「查看当时的聊天」一次性定位目标消息 id；null/undefined 表示正常进入。 */
  anchorMessageId?: number | null;
  currentUser: ChatDetailCurrentUser;
  aiAssistants: ChatDetailAIAssistantLike[];
  onOpenMenu?: () => void;
  onOpenAssistantProfile?: (aiId: string) => void;
  onOpenFilePreview?: (params: { fileUri: string; fileName: string; mimeType?: string | null }) => void;
  onGoBack?: () => void;
  onCallCreated?: (call: ChatCallSession) => void;
}

export default function ChatDetailModule({
  aiAssistant,
  session,
  isActive = true,
  anchorMessageId = null,
  currentUser,
  aiAssistants,
  onOpenMenu,
  onOpenAssistantProfile,
  onOpenFilePreview,
  onGoBack,
  onCallCreated,
}: ChatDetailModuleProps) {
  const theme = useTheme();
  const styles = useMemo(() => createChatDetailStyles(theme), [theme]);
  const insets = useSafeAreaInsets();

  function LoadingView() {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color={theme.colors.brand.primary} />
        <Text style={styles.loadingText}>加载中...</Text>
      </View>
    );
  }

  function ErrorView({ message, onRetry }: { message: string; onRetry: () => void | Promise<void> }) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.errorText}>{message || '加载失败'}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={onRetry}>
          <Text style={styles.retryText}>点击重试</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const sessionId = session?.id;
  const chatBackgroundKey = sessionId ? `single:${sessionId}` : aiAssistant?.id ? `single:${aiAssistant.id}` : null;
  const headerPaddingTop = Math.max(insets.top, 8);
  const headerTitle = (aiAssistant ? getAssistantDisplayName(aiAssistant) : null) || 'AI助手';
  const { text: inputText, setText: setInputText, ready: draftReady, store: textDrafts } = useChatTextDraft(sessionId, isActive);
  const [replyTo, setReplyTo] = useState<ChatReplyTarget | null>(null);
  const [actionMenuVisible, setActionMenuVisible] = useState(false);
  const [selectedMessage, setSelectedMessage] = useState<ChatMessage | null>(null);
  const [textSelectionText, setTextSelectionText] = useState<string | null>(null);
  const [regenerationPrompt, setRegenerationPrompt] = useState<ChatMessage | null>(null);
  const [historyRunId, setHistoryRunId] = useState<string | null>(null);
  const activeConversation = useRef({ sessionId, isActive });
  activeConversation.current = { sessionId, isActive };
  useEffect(() => {
    setRegenerationPrompt(null);
    setHistoryRunId(null);
    setTextSelectionText(null);
  }, [sessionId, isActive]);
  const [summarySettings, setSummarySettings] = useState<ChatSummarySettings | null>(null);
  useEffect(() => {
    setSummarySettings(null);
    if (!sessionId || !isActive) return;
    let active = true;
    let revision = 0;
    const load = async () => {
      const current = ++revision;
      try {
        const settings = await getChatSummarySettings(sessionId);
        if (active && current === revision) setSummarySettings(settings);
      } catch (error) { console.error('[ChatDetail] 读取固定起点失败', error); }
    };
    void load();
    const unsubscribe = subscribeChatSummaryChanged((id) => { if (id === sessionId) void load(); });
    const unsubscribeMessages = setChatEventBus({ emit(name, payload) {
      if (payload.sessionId === sessionId && ['messagesReloadRequested', 'messagesPatched', 'messagesDeleted', 'regenerationChanged'].includes(name)) void load();
    } });
    return () => { active = false; unsubscribe(); unsubscribeMessages(); };
  }, [sessionId, isActive]);
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [isTranslatingMessage, setIsTranslatingMessage] = useState(false);
  const [messageTranslations, setMessageTranslations] = useState<Record<number, MessageTranslationBlock>>({});
  const [expandedVoiceTranscriptIds, setExpandedVoiceTranscriptIds] = useState<Set<number>>(
    () => new Set(),
  );

  const availableAssistants = useMemo<ChatDetailAIAssistantLike[]>(() => {
    const assistants = [...aiAssistants];

    if (
      aiAssistant
      && !assistants.some((item) => item.id === aiAssistant.id)
    ) {
      assistants.push(aiAssistant);
    }

    return assistants;
  }, [aiAssistant, aiAssistants]);

  const {
    activeSurface,
    setActiveSurface,
    dismiss: dismissInputSurface,
    keyboardOffset,
    surfaceHeight,
  } = useChatComposerSurface();
  const {
    draftAttachments,
    readyAttachments,
    withAttachmentSubmission,
    isPreparingAttachment,
    selectImageAttachment,
    capturePhotoAttachment,
    selectDocumentAttachment,
    clearAttachment,
    removeAttachment,
  } = useAttachmentDraft();
  const previousSessionIdRef = useRef(sessionId);

  // 页面退出时停止当前语音播放；输入面板 hook 负责收起键盘。
  useEffect(() => {
    return () => {
      void voiceMessagePlaybackCoordinator.stop();
    };
  }, []);

  useEffect(() => {
    if (previousSessionIdRef.current === sessionId) {
      return;
    }

    previousSessionIdRef.current = sessionId;
    void voiceMessagePlaybackCoordinator.stop();
    setReplyTo(null);
    setActionMenuVisible(false);
    setSelectedMessage(null);
    setEditingMessage(null);
    setMenuPosition(null);
    setMessageTranslations({});
    setExpandedVoiceTranscriptIds(new Set());
    clearAttachment();
    dismissInputSurface();
  }, [sessionId, clearAttachment, dismissInputSurface]);

  const {
    messages,
    setMessages,
    isLoading,
    isLoadingMore,
    hasMore,
    error,
    isTyping,
    isChatSendBlockedByActiveCall,
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
    inviteTogetherListening,
    acceptTogetherListening,
    declineTogetherListening,
    leaveTogetherListening,
    loadMore,
    refresh,
    retrySend,
  } = useChatDetail(sessionId, aiAssistant, onCallCreated);
  const regeneration = useChatRegeneration(sessionId, refresh);
  const executionStatus = useChatTurnExecutionStatus(sessionId ?? null);

  const handleSelectionDeleted = useCallback((ids: readonly number[]) => {
    const deleted = new Set(ids);
    setReplyTo((previous) => previous && deleted.has(previous.id) ? null : previous);
  }, []);
  const selection = useChatMessageSelection({
    sessionId, isActive, messages,
    hiddenRunId: regeneration.sourceRunId,
    onDeleted: handleSelectionDeleted,
  });
  const share = useChatMessageShare({ sessionId, sourceName: headerTitle, assistantId: aiAssistant?.id, isActive, onShared: selection.exit });
  const favoriteMessage = useChatFavoriteAction(selectedMessage, headerTitle, aiAssistant?.id);
  const stickerAction = useChatStickerAction(selectedMessage);
  const messageActions = selectedMessage ? getChatMessageActions(selectedMessage) : null;
  const handleShareMessage = useCallback(() => {
    dismissInputSurface();
    void voiceMessagePlaybackCoordinator.stop();
    void share.open([selectedMessage!.id]);
  }, [dismissInputSurface, share, selectedMessage]);
  const handleEnterSelection = useCallback(() => {
    dismissInputSurface();
    void voiceMessagePlaybackCoordinator.stop();
    selection.enter(selectedMessage!);
  }, [dismissInputSurface, selection, selectedMessage]);

  const handleRegenerateMessage = useCallback(() => {
    dismissInputSurface();
    void voiceMessagePlaybackCoordinator.stop();
    const message = selectedMessage!;
    void shouldConfirmChatRegeneration().then(confirm => {
      if (activeConversation.current.sessionId !== message.sessionId || !activeConversation.current.isActive) return;
      if (confirm) setRegenerationPrompt(message);
      else void regeneration.regenerate(message, messages);
    }).catch(error => showAppDialog({ title: '无法读取重写提示设置', message: error instanceof Error ? error.message : '请重试', tone: 'error' }));
  }, [dismissInputSurface, regeneration, selectedMessage, messages]);

  const handleTogetherListeningInvite = useCallback(async () => {
    const result = await inviteTogetherListening();
    if (result.status !== 'invitation_created' || result.reason) {
      showAppDialog({ title: '一起听', message: result.message });
    }
  }, [inviteTogetherListening]);

  const handleSend = useCallback(async () => {
    if (inputText.trim().length === 0 && readyAttachments.length === 0) return;
    const draft = textDrafts.read(sessionId!);

    await withAttachmentSubmission(
      (attachments, consumeDraft) => sendMessage(inputText.trim(), replyTo, attachments, {
        onQueued: () => {
          consumeDraft();
          textDrafts.replaceIfUnchanged(sessionId!, draft, '');
          setReplyTo(null);
        },
      }),
    );
  }, [inputText, replyTo, readyAttachments, sendMessage, withAttachmentSubmission, sessionId, textDrafts]);

  const handleStickerPress = useCallback(async (sticker: StickerMessageSnapshot) => {
    const wasQueued = await sendSticker(sticker);
    if (wasQueued) {
    }
  }, [sendSticker]);

  // 语音校对通过后发送。这里只负责“提交成功后通知外层有新消息”，
  // 提交失败时 hook 内部会保留 reviewing draft，用户可以继续修改重试。
  const handleVoiceReviewSend = useCallback(async () => {
    const committed = await commitVoiceReviewDraft();
    if (committed) {
    }
    return committed;
  }, [commitVoiceReviewDraft]);

  const handleMessageLongPress = useCallback((msg: ChatMessage, position: { x: number; y: number }) => {
    if (msg.senderType !== 'user' && msg.senderType !== 'assistant') return;
    if (isAgentTransientTimelineMessage(msg)) return;

    setSelectedMessage(msg);
    setMenuPosition(position);
    setActionMenuVisible(true);
  }, []);

  const handleCloseActionMenu = useCallback(() => {
    setActionMenuVisible(false);
    setSelectedMessage(null);
    setMenuPosition(null);
  }, []);

  const handleCopyMessage = useCallback(() => {
    if (!selectedMessage) return;
    try {
      copyTextToClipboard(selectedMessage.text);
      ToastAndroid.show('复制成功', ToastAndroid.SHORT);
    } catch (error) {
      showAppDialog({ title: '复制失败', message: error instanceof Error ? error.message : '无法写入剪贴板', tone: 'error' });
    }
  }, [selectedMessage]);

  const handleSelectMessageText = useCallback(() => {
    dismissInputSurface();
    // 菜单关闭会清空 selectedMessage；选字窗口独立持有打开时的正文快照。
    setTextSelectionText(selectedMessage!.text);
  }, [dismissInputSurface, selectedMessage]);
  const handleFixedStart = useCallback(() => {
    if (!selectedMessage || !sessionId || !summarySettings) return;
    const cancelling = summarySettings.fixedMessageId === selectedMessage.id;
    void setFixedChatContextStart(sessionId, cancelling ? null : selectedMessage.id).then(() => {
      ToastAndroid.show(cancelling ? '已取消固定，一级摘要仍保持关闭' : '已固定上下文起点，一级摘要已暂停', ToastAndroid.LONG);
    }).catch((error: unknown) => {
      showAppDialog({ title: '设置固定起点失败', message: error instanceof Error ? error.message : '请稍后再试', tone: 'error' });
    });
  }, [selectedMessage, sessionId, summarySettings]);

  const handleRewriteMessage = useCallback(() => {
    dismissInputSurface();
    setEditingMessage(selectedMessage);
  }, [dismissInputSurface, selectedMessage]);

  const handleMessageEdited = useCallback((edited: ChatMessage) => {
    setMessages((previous) => previous.map((message) => message.id === edited.id ? edited : message));
    setMessageTranslations((previous) => {
      const next = { ...previous };
      delete next[edited.id];
      return next;
    });
    setReplyTo((previous) => previous?.id === edited.id ? createChatReplyTarget(edited, availableAssistants, currentUser.name, aiAssistant) : previous);
  }, [aiAssistant, availableAssistants, currentUser.name, setMessages]);

  const handleDeleteMessage = useCallback(() => {
    if (!selectedMessage) return;

    showAppDialog({
      title: '删除消息',
      message: '确定要删除这条消息吗？删除后无法恢复。',
      buttons: [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            try {
              const deletedIds = await deleteChatMessage(selectedMessage.id);
              handleSelectionDeleted(deletedIds);
            } catch (error) {
              showAppDialog({ title: '删除失败', message: error instanceof Error ? error.message : '删除消息失败', tone: 'error' });
            }
          },
        },
      ],
    });
  }, [selectedMessage, handleSelectionDeleted]);

  const handleQuoteMessage = useCallback(() => {
    if (!selectedMessage) return;
    setReplyTo(createChatReplyTarget(selectedMessage, availableAssistants, currentUser.name, aiAssistant));
  }, [aiAssistant, availableAssistants, currentUser.name, selectedMessage]);

  const handleToggleVoiceTranscript = useCallback(() => {
    if (!selectedMessage || !getMessageVoice(selectedMessage)) return;
    setExpandedVoiceTranscriptIds((previous) => {
      const next = new Set(previous);
      if (next.has(selectedMessage.id)) {
        next.delete(selectedMessage.id);
      } else {
        next.add(selectedMessage.id);
      }
      return next;
    });
  }, [selectedMessage]);

  const handleTranslateMessage = useCallback(async () => {
    if (!selectedMessage || isTranslatingMessage) return;

    const text = String(selectedMessage.text || '').trim();
    if (!text) {
      showAppDialog({ title: '翻译', message: '这条消息没有可翻译的文本' });
      return;
    }

    setIsTranslatingMessage(true);
    try {
      const result = await translateMessageText({ text });
      setMessageTranslations((prev) => ({
        ...prev,
        [selectedMessage.id]: {
          text: result.translatedText,
          sourceLabel: result.sourceLabel,
        },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : '翻译失败';
      showAppDialog({ title: '翻译失败', message: message, tone: 'error' });
    } finally {
      setIsTranslatingMessage(false);
    }
  }, [isTranslatingMessage, selectedMessage]);

  const handleHideTranslation = useCallback((messageId: number) => {
    setMessageTranslations((prev) => {
      if (!prev[messageId]) {
        return prev;
      }

      const next = { ...prev };
      delete next[messageId];
      return next;
    });
  }, []);

  const handleRetryMessage = useCallback((messageId: number) => {
    retrySend(messageId);
  }, [retrySend]);

  const handleCancelReply = useCallback(() => {
    setReplyTo(null);
  }, []);

  if (isLoading && messages.length === 0) {
    return (
      <ChatBackground chatKey={chatBackgroundKey}>
        <SafeAreaView style={styles.container} edges={['left', 'right']}>
          <ChatHeader
            aiName={headerTitle}
            isTyping={false}
            onOpenMenu={onOpenMenu}
            paddingTop={headerPaddingTop}
            onGoBack={onGoBack}
          />
          <LoadingView />
        </SafeAreaView>
      </ChatBackground>
    );
  }

  if (error && messages.length === 0) {
    return (
      <ChatBackground chatKey={chatBackgroundKey}>
        <SafeAreaView style={styles.container} edges={['left', 'right']}>
          <ChatHeader
            aiName={headerTitle}
            isTyping={false}
            onOpenMenu={onOpenMenu}
            paddingTop={headerPaddingTop}
            onGoBack={onGoBack}
          />
          <ErrorView message={error} onRetry={refresh} />
        </SafeAreaView>
      </ChatBackground>
    );
  }

  return (
    <ChatBackground chatKey={chatBackgroundKey}>
      <SafeAreaView style={styles.container} edges={['left', 'right']}>
        <View style={styles.keyboardView}>
          {selection.selecting ? (
            <ChatSelectionHeader count={selection.count} paddingTop={Math.max(insets.top, 8)} disabled={selection.isDeleting} onCancel={selection.exit} />
          ) : (
            <ChatHeader
              aiName={headerTitle}
              statusText={executionStatus ?? (regeneration.sourceRunId !== null ? '等待重写执行宿主' : null)}
              onOpenMenu={onOpenMenu}
              paddingTop={headerPaddingTop}
              onGoBack={onGoBack}
            />
          )}

          <ChatMessageList
            sessionId={sessionId}
            messages={messages}
            hiddenRunId={regeneration.sourceRunId}
            pauseAutoScroll={share.visible || textSelectionText !== null}
            anchorMessageId={anchorMessageId}
            aiAssistant={aiAssistant}
            aiAssistants={availableAssistants}
            userAvatar={currentUser.avatar}
            userName={currentUser.name}
            onOpenAssistantProfile={onOpenAssistantProfile}
            onMessageLongPress={handleMessageLongPress}
            onLoadMore={loadMore}
            hasMore={hasMore}
            isLoadingMore={isLoadingMore}
            onRetryMessage={handleRetryMessage}
            onTogetherListeningAccept={acceptTogetherListening}
            onTogetherListeningDecline={declineTogetherListening}
            onTogetherListeningLeave={leaveTogetherListening}
            translations={messageTranslations}
            onHideTranslation={handleHideTranslation}
            onPreviewFile={onOpenFilePreview}
            selectedMessageId={selectedMessage?.id}
            selection={selection.selecting ? {
              selectedKeys: selection.selectedKeys,
              availableKeys: selection.availableKeys,
              disabled: selection.isDeleting,
              onToggle: selection.toggle,
            } : undefined}
            expandedVoiceTranscriptIds={expandedVoiceTranscriptIds}
            onDismissInputSurface={dismissInputSurface}
          />

          <Animated.View style={{ marginBottom: keyboardOffset }}>
            {selection.selecting ? (
              <ChatSelectionFooter count={selection.count} isDeleting={selection.isDeleting} paddingBottom={Math.max(insets.bottom, 8)} onDelete={selection.requestDelete} onShare={() => { void share.open(selection.anchorMessageIds); }} />
            ) : (
              <ChatInputArea
                value={inputText}
                onChangeText={setInputText}
                onSend={handleSend}
                voiceRecordingState={voiceRecordingState}
                voiceRecordingProgress={voiceRecordingProgress}
                voiceRecordingError={voiceRecordingError}
                onDismissVoiceRecordingError={dismissVoiceRecordingError}
                onVoiceModeEnter={prepareVoiceRecordingEntry}
                onVoiceRecordingStart={startVoiceRecording}
                onVoiceRecordingFinish={finishVoiceRecording}
                onVoiceRecordingCancel={cancelVoiceRecording}
                voiceReviewDraft={voiceReviewDraft}
                onVoiceReviewTranscriptChange={updateVoiceReviewTranscript}
                onVoiceReviewSend={handleVoiceReviewSend}
                onVoiceReviewCancel={discardVoiceReviewDraft}
                attachmentDrafts={draftAttachments}
                hasReadyAttachment={readyAttachments.length > 0}
                isPreparingAttachment={isPreparingAttachment}
                onRemoveAttachment={removeAttachment}
                onImagePress={selectImageAttachment}
                onCameraPress={capturePhotoAttachment}
                onFilePress={selectDocumentAttachment}
                onStickerPress={handleStickerPress}
                onVideoCallPress={startVideoCall}
                onTogetherListeningPress={shouldShowTogetherListeningChatEntry(aiAssistant)
                  ? handleTogetherListeningInvite
                  : undefined}
                disabled={isChatSendBlockedByActiveCall || !draftReady}
                disabledPlaceholder={isChatSendBlockedByActiveCall ? '视频电话期间不可发送普通聊天消息' : ''}
                disabledPressMessage={
                  isChatSendBlockedByActiveCall ? '视频电话期间不可发送普通聊天消息' : undefined
                }
                replyTo={replyTo}
                onCancelReply={handleCancelReply}
                paddingBottom={Math.max(insets.bottom, 8)}
                activeSurface={activeSurface}
                onActiveSurfaceChange={setActiveSurface}
                surfaceHeight={surfaceHeight}
              />
            )}
          </Animated.View>

        </View>

      {editingMessage && (
        <ChatMessageEditor
          key={editingMessage.id}
          message={editingMessage}
          onClose={() => setEditingMessage(null)}
          onSaved={handleMessageEdited}
        />
      )}

      {textSelectionText !== null && isActive && (
        <ChatMessageTextSelectionSheet text={textSelectionText} onClose={() => setTextSelectionText(null)} />
      )}

      {regenerationPrompt ? <ChatRegenerationConfirm
        onClose={() => setRegenerationPrompt(null)}
        onConfirm={() => {
          const message = regenerationPrompt;
          setRegenerationPrompt(null);
          void regeneration.regenerate(message, messages);
        }}
      /> : null}
      {historyRunId && sessionId ? <ChatReplyVersionSheet
        key={`${sessionId}:${historyRunId}`} sessionId={sessionId} runId={historyRunId}
        blocked={isTyping || isChatSendBlockedByActiveCall}
        onClose={() => setHistoryRunId(null)}
        onPreviewFile={params => { setHistoryRunId(null); onOpenFilePreview?.(params); }}
      /> : null}
      <ChatMessageActionMenu
        visible={actionMenuVisible}
        onClose={handleCloseActionMenu}
        position={menuPosition}
        onCopy={selectedMessage?.text.trim() ? handleCopyMessage : undefined}
        onSelectText={selectedMessage?.text.trim() ? handleSelectMessageText : undefined}
        onRewrite={selectedMessage && canEditChatMessage(selectedMessage) ? handleRewriteMessage : undefined}
        onRegenerate={selectedMessage?.senderType === 'assistant'
          && selectedMessage.turnItemIndex != null
          && selectedMessage.turnRunId === regeneration.eligibleRunId
          && !isTyping && !isChatSendBlockedByActiveCall ? handleRegenerateMessage : undefined}
        onHistory={selectedMessage?.senderType === 'assistant' && selectedMessage.turnItemIndex != null
          && selectedMessage.turnRunId && regeneration.versionedRunIds.includes(selectedMessage.turnRunId)
          ? () => { dismissInputSurface(); setHistoryRunId(selectedMessage.turnRunId!); } : undefined}
        onDelete={handleDeleteMessage}
        onFixedStart={summarySettings && selectedMessage && projectChatContextMessage(selectedMessage,
          [selectedMessage.createdAt, selectedMessage.id, 0, selectedMessage.id])?.kind === 'dialogue' ? handleFixedStart : undefined}
        isFixedStart={selectedMessage?.id === summarySettings?.fixedMessageId}
        onMultiSelect={selectedMessage && selection.availableKeys.has(getChatSelectionKey(selectedMessage)) && voiceRecordingState === 'idle' ? handleEnterSelection : undefined}
        onForward={selectedMessage && selection.availableKeys.has(getChatSelectionKey(selectedMessage)) && voiceRecordingState === 'idle' ? handleShareMessage : undefined}
        onQuote={messageActions?.quote ? handleQuoteMessage : undefined}
        onTranslate={messageActions?.translate ? handleTranslateMessage : undefined}
        onFavorite={messageActions?.favorite ? favoriteMessage.toggle : undefined}
        isFavorited={favoriteMessage.isFavorited}
        stickerAction={stickerAction}
        onToggleVoiceTranscript={getMessageVoice(selectedMessage)
          ? handleToggleVoiceTranscript
          : undefined}
        isVoiceTranscriptExpanded={Boolean(
          selectedMessage && expandedVoiceTranscriptIds.has(selectedMessage.id)
        )}
      />
      <ChatContentShareSheet share={share} onPreviewFile={(params) => { share.close(); onOpenFilePreview?.(params); }} />
      </SafeAreaView>
    </ChatBackground>
  );
}
