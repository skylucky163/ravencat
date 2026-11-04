/** 群聊详情页，协调群消息时间线、输入、召唤成员与群聊操作。 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, ScrollView, ToastAndroid, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import ChatHeader from '../messages/components/ChatHeader';
import { useChatMessageSelection } from '../messages/components/useChatMessageSelection';
import { useChatMessageShare } from '../messages/components/useChatMessageShare';
import { useChatFavoriteAction } from '../messages/components/useChatFavoriteAction';
import { useChatStickerAction } from '../messages/components/useChatStickerAction';
import { getChatMessageActions } from '../../messages/domain/ChatMessageActions';
import ChatContentShareSheet from '../messages/components/ChatContentShareSheet';
import { ChatSelectionHeader, ChatSelectionFooter } from '../messages/components/ChatSelectionBars';
import ChatMessageList from '../messages/components/ChatMessageList';
import ChatInputArea from '../messages/components/ChatInputArea';
import ChatBackground from '../messages/components/ChatBackground';
import { createChatDetailStyles } from '../messages/components/chatStyles';
import { useTheme } from '@shared/theme';
import { AIAvatar, showAppDialog } from '@shared/ui';
import {
  getActiveGroupSpeechPlan,
  getGroupChat,
  getGroupParticipantDirectory,
  invokeGroupChat,
  sendGroupUserMessage,
  terminateGroupSpeechPlan,
} from '../../group/application';
import GroupSpeechQueueOverlay from './GroupSpeechQueueOverlay';
import { subscribeGroupChanged } from '../../group/application/GroupMembership';
import { getHostAIAssistant } from '@features/assistants';
import { acceptChatTogetherListeningInvitation, declineChatTogetherListeningInvitation, leaveChatTogetherListening,
  type ChatTogetherListeningResult } from '../../conversation/application/ChatTogetherListeningGateway';
import { setChatEventBus } from '../../messages/events/ChatEvents';
import { useMessageHistoryState } from '../messages/components/useMessageHistoryState';
import { useChatTimelineSync } from '../messages/components/useChatTimelineSync';
import type { GroupChat, GroupChatDetails, GroupSpeechPlan } from '../../group/domain/GroupChat';
import type {
  GroupAssistantParticipant,
  GroupParticipantDirectory,
} from '../../group/domain/GroupParticipantDirectory';
import type { ChatMessage } from '../../messages/domain/ChatMessage';
import type { StickerMessageSnapshot } from '../../messages/domain/ChatSticker';
import type { ChatReplyTarget } from '../../messages/domain/chatMessageMetadata';
import { createChatReplyTarget, type ChatDetailAIAssistantLike } from '../messages/components/chatTypes';
import type { UserProfile } from '@features/profile';
import ChatMessageActionMenu from '../messages/components/ChatMessageActionMenu';
import ChatMessageEditor from '../messages/components/ChatMessageEditor';
import ChatMessageTextSelectionSheet from '../messages/components/ChatMessageTextSelectionSheet';
import { getChatSelectionKey } from '../../messages/domain/ChatMessageSelection';
import { canEditChatMessage } from '../../messages/domain/ChatMessageEditing';
import { copyTextToClipboard } from '@platform/device';
import { useAttachmentDraft } from '../messages/ChatDetail/useAttachmentDraft';
import { translateMessageText } from '@features/integrations';
import { deleteChatMessage } from '../../messages/application/DeleteChatMessage';
import { voiceMessagePlaybackCoordinator } from '../../messages/application/VoiceMessagePlaybackCoordinator';
import type { MessageTranslationBlock } from '../messages/components/chatMessageRenderUtils';
import { useChatComposerSurface } from '../messages/components/useChatComposerSurface';
import { useChatTextDraft } from '../shell/ChatTextDraftProvider';

type GroupChatCurrentUser = Pick<UserProfile, 'name' | 'avatar'>;
type SelectedMention = Pick<GroupAssistantParticipant, 'assistantId' | 'displayName'>;

interface GroupChatDetailProps {
  group: GroupChat;
  /** React Navigation 会保留失焦页面；只有当前 route 可见时为 true。 */
  isActive: boolean;
  currentUser: GroupChatCurrentUser;
  aiAssistants: ChatDetailAIAssistantLike[];
  onOpenFilePreview: (params: { fileUri: string; fileName: string; mimeType?: string | null }) => void;
  onOpenMenu: () => void;
  onOpenAssistantProfile: (aiId: string) => void;
  onGoBack?: () => void;
}

function getActiveMentionQuery(text: string): { start: number; query: string } | null {
  const cursorText = String(text || '');
  const mentionStart = cursorText.lastIndexOf('@');
  if (mentionStart < 0) {
    return null;
  }

  const query = cursorText.slice(mentionStart + 1);
  if (/\s/.test(query)) {
    return null;
  }

  return {
    start: mentionStart,
    query,
  };
}

function resolveSelectedMentions(
  text: string,
  selectedMentions: SelectedMention[],
): SelectedMention[] {
  const remainingOccurrences = new Map<string, number>();

  const countMentionTokens = (mentionText: string) => {
    let count = 0;
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const index = text.indexOf(mentionText, searchFrom);
      if (index < 0) {
        break;
      }
      const nextCharacter = text[index + mentionText.length] || '';
      if (!nextCharacter || !/[\p{L}\p{N}_]/u.test(nextCharacter)) {
        count += 1;
      }
      searchFrom = index + mentionText.length;
    }
    return count;
  };

  return selectedMentions.filter((mention) => {
    const mentionText = `@${mention.displayName}`;
    const remaining = remainingOccurrences.get(mentionText)
      ?? countMentionTokens(mentionText);
    if (remaining === 0) {
      return false;
    }
    remainingOccurrences.set(mentionText, remaining - 1);
    return true;
  });
}

export default function GroupChatDetail({
  group,
  isActive,
  currentUser,
  aiAssistants,
  onOpenFilePreview,
  onOpenMenu,
  onOpenAssistantProfile,
  onGoBack,
}: GroupChatDetailProps) {
  const theme = useTheme();
  const listeningAction = async (action: typeof acceptChatTogetherListeningInvitation, activityId: string): Promise<ChatTogetherListeningResult> => {
    const host = await getHostAIAssistant();
    if (!host) return { status: 'unavailable', message: '当前没有主理AI，一起听操作未执行。' };
    return action({ activityId, chatSessionId: group.id, aiConfig: { id: host.id, isHostAI: host.isHostAI } });
  };
  const styles = useMemo(() => createChatDetailStyles(theme), [theme]);
  const localStyles = useMemo(() => StyleSheet.create({
    summonBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 6,
    },
    pillTag: {
      height: 28,
      paddingHorizontal: theme.spacing.sm,
      borderRadius: theme.radius.round,
      backgroundColor: theme.colors.background.app,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
    },
    pillTagDisabled: {
      backgroundColor: theme.colors.background.app,
    },
    pillText: {
      color: theme.colors.text.secondary,
      fontSize: 12,
      fontWeight: '600',
    },
    pillTextDisabled: {
      color: theme.colors.text.secondary,
    },
    mentionPanel: {
      maxHeight: 218,
      flexGrow: 0,
      backgroundColor: theme.colors.background.app,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.border.light,
    },
    mentionPanelContent: {
      paddingVertical: 6,
    },
    mentionItem: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 44,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 6,
    },
    mentionAvatar: {
      marginRight: theme.spacing.sm,
    },
    mentionInfo: {
      flex: 1,
    },
    mentionName: {
      color: theme.colors.text.primary,
      fontSize: 14,
      fontWeight: '600',
    },
  }), [theme]);

  function LoadingState() {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color={theme.colors.brand.primary} />
        <Text style={styles.loadingText}>加载中...</Text>
      </View>
    );
  }

  const insets = useSafeAreaInsets();
  const sessionId = group.id;
  const chatBackgroundKey = `group:${sessionId}`;
  const lastMessageIdRef = useRef<number | null>(null);

  const [groupDetails, setGroupDetails] = useState<GroupChatDetails | null>(null);
  const [participantDirectory, setParticipantDirectory] = useState<GroupParticipantDirectory | null>(null);
  const [activePlan, setActivePlan] = useState<GroupSpeechPlan | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const [isInvoking, setIsInvoking] = useState(false);
  const [isTerminating, setIsTerminating] = useState(false);
  const [queueOverlayVisible, setQueueOverlayVisible] = useState(false);
  const { text: inputText, setText: setInputText, ready: draftReady, store: textDrafts } = useChatTextDraft(sessionId, isActive);
  const [selectedMentions, setSelectedMentions] = useState<SelectedMention[]>([]);
  const {
    activeSurface,
    setActiveSurface,
    dismiss: dismissInputSurface,
    keyboardOffset,
    surfaceHeight,
  } = useChatComposerSurface();
  const [actionMenuVisible, setActionMenuVisible] = useState(false);
  const [selectedMessage, setSelectedMessage] = useState<ChatMessage | null>(null);
  const [textSelectionText, setTextSelectionText] = useState<string | null>(null);
  useEffect(() => { setTextSelectionText(null); }, [sessionId, isActive]);
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [isTranslatingMessage, setIsTranslatingMessage] = useState(false);
  const [messageTranslations, setMessageTranslations] = useState<Record<number, MessageTranslationBlock>>({});
  const [replyTo, setReplyTo] = useState<ChatReplyTarget | null>(null);
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
  const attachmentSessionIdRef = useRef(sessionId);
  const participantDirectoryRevision = useMemo(() => JSON.stringify({
    currentUser,
    assistants: aiAssistants.map((assistant) => ({
      id: assistant.id,
      name: assistant.name,
      nickname: assistant.nickname,
      avatar: assistant.avatar || null,
      isBlocked: assistant.isBlocked === true,
    })),
  }), [aiAssistants, currentUser]);

  const {
    messages,
    setMessages,
    isLoading,
    isLoadingMore,
    hasMore,
    loadMore,
    resetHistory,
  } = useMessageHistoryState(sessionId);

  const handleSelectionDeleted = useCallback((ids: readonly number[]) => {
    const deleted = new Set(ids);
    setReplyTo((previous) => previous && deleted.has(previous.id) ? null : previous);
  }, []);
  const selection = useChatMessageSelection({
    sessionId, isActive, messages,
    onDeleted: handleSelectionDeleted,
  });
  const share = useChatMessageShare({ sessionId, sourceName: group.name, isActive, onShared: selection.exit });
  const favoriteMessage = useChatFavoriteAction(selectedMessage, group.name);
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

  useEffect(() => {
    lastMessageIdRef.current = messages.length
      ? Math.max(...messages.map((message) => message.id))
      : null;
  }, [messages]);

  useEffect(() => {
    if (attachmentSessionIdRef.current === sessionId) {
      return;
    }
    attachmentSessionIdRef.current = sessionId;
    setEditingMessage(null);
    setActionMenuVisible(false);
    setSelectedMessage(null);
    setMenuPosition(null);
    clearAttachment();
    setSelectedMentions([]);
    dismissInputSurface();
  }, [clearAttachment, dismissInputSurface, sessionId]);

  useChatTimelineSync({
    sessionId,
    messages,
    isTyping,
    setIsTyping,
    setMessages,
    lastMessageIdRef,
    resetHistory,
  });

  const refreshGroupDetails = useCallback(async () => {
    const [details, directory, runningPlan] = await Promise.all([
      getGroupChat(sessionId),
      getGroupParticipantDirectory(sessionId),
      getActiveGroupSpeechPlan(sessionId),
    ]);
    setGroupDetails(details);
    setParticipantDirectory(directory);
    setActivePlan(runningPlan);
  }, [sessionId]);

  const refreshActivePlan = useCallback(async () => {
    setActivePlan(await getActiveGroupSpeechPlan(sessionId));
  }, [sessionId]);

  useEffect(() => subscribeGroupChanged(id => {
    if (id === sessionId) void refreshGroupDetails().catch(error => console.error('[群聊] 成员资料刷新失败', error));
  }), [sessionId, refreshGroupDetails]);

  useEffect(() => {
    void refreshGroupDetails().catch((error) => {
      console.error('[GroupChatDetail] Failed to load group detail:', error);
    });
  }, [participantDirectoryRevision, refreshGroupDetails]);

  // plan 生命周期不属于消息/typing 状态。application 在持久事实 commit 后只
  // 发布“已变化”，页面按 groupId 重读窄 query，覆盖手动召唤、自动召唤、
  // planning、换代和强制终止，不维护第二份 plan 状态机。
  useEffect(() => setChatEventBus({
    emit: async (eventName, payload) => {
      if (eventName !== 'groupSpeechPlanChanged' || payload.sessionId !== sessionId) {
        return;
      }
      await refreshActivePlan();
    },
  }), [refreshActivePlan, sessionId]);

  const aiAssistantLike = useMemo<ChatDetailAIAssistantLike>(() => ({
    id: group.id,
    agentId: `group_${group.id}`,
    name: groupDetails?.group.name ?? group.name,
    avatar: group.avatar,
    model: '群聊',
    apiKey: '',
    apiBaseUrl: '',
    temperature: 0.7,
    topP: 1.0,
    maxTokens: 2000,
    systemPrompt: undefined,
    enableTools: false,
    allowMultipleBubbles: true,
    isHostAI: false,
    isBlocked: false,
  }), [group, groupDetails]);

  const assistantById = useMemo(() => {
    return new Map(
      aiAssistants.map((assistant) => [assistant.id, assistant])
    );
  }, [aiAssistants]);

  const memberAssistants = useMemo<ChatDetailAIAssistantLike[]>(() => {
    const members = groupDetails?.members || [];

    return [
      aiAssistantLike,
      ...members.map((member) => {
        const profile = assistantById.get(member.aiAssistantId);

        return {
          id: member.aiAssistantId,
          agentId: member.agentId,
          name: member.name || profile?.name || 'AI',
          nickname: profile?.nickname ?? member.nickname,
          avatar: member.avatar ?? profile?.avatar ?? null,
          model: member.model || profile?.model || 'AI',
          apiKey: '',
          apiBaseUrl: '',
        };
      }),
    ];
  }, [aiAssistantLike, assistantById, groupDetails]);

  const mentionCandidates = useMemo(
    () => participantDirectory?.assistants.map((participant) => ({
      ...participant, displayName: participant.nickname ?? participant.displayName,
    })) || [],
    [participantDirectory],
  );

  const activeMentionQuery = useMemo(() => getActiveMentionQuery(inputText), [inputText]);
  const filteredMentionCandidates = useMemo(() => {
    if (!activeMentionQuery) {
      return [];
    }

    const query = activeMentionQuery.query.trim().toLowerCase();
    return mentionCandidates.filter((candidate) => {
      if (!query) {
        return true;
      }

      return candidate.displayName.toLowerCase().includes(query);
    });
  }, [activeMentionQuery, mentionCandidates]);

  const shouldShowMentionPanel = Boolean(
    activeMentionQuery && filteredMentionCandidates.length > 0
  );

  const isSummonDisabled = isInvoking || Boolean(activePlan);

  // 强制终止：先由持久层把 plan 与未到终态任务裁决为 terminated，commit 后
  // 才中止在途请求；终止不产生继承，队列浮层直接反映持久事实。
  const handleTerminate = useCallback(async () => {
    if (!activePlan || isTerminating) {
      return;
    }
    setIsTerminating(true);
    try {
      await terminateGroupSpeechPlan(sessionId);
    } catch (error) {
      showAppDialog({ title: '终止失败', message: error instanceof Error ? error.message : '强制终止失败', tone: 'error' });
    } finally {
      setIsTerminating(false);
      await refreshGroupDetails();
    }
  }, [activePlan, isTerminating, refreshGroupDetails, sessionId]);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text && readyAttachments.length === 0) {
      return;
    }

    textDrafts.change(sessionId, '');
    const clearedDraft = textDrafts.read(sessionId);
    const currentReplyTo = replyTo;
    const committedMentions = resolveSelectedMentions(text, selectedMentions);
    setReplyTo(null);
    try {
      await withAttachmentSubmission(async (attachments, consumeDraft) => {
        await sendGroupUserMessage({
          groupId: sessionId,
          text,
          attachments,
          mentions: committedMentions.map((mention) => ({
            actorType: 'user' as const,
            target: {
              targetType: 'assistant' as const,
              assistantId: mention.assistantId,
              displayNameAtSend: mention.displayName,
            },
          })),
          replyToId: currentReplyTo?.id || null,
          replyToText: currentReplyTo?.text || null,
          replyQuote: currentReplyTo?.quote,
        });
        consumeDraft();
      });
      setSelectedMentions([]);
    } catch (error) {
      showAppDialog({ title: '发送失败', message: error instanceof Error ? error.message : '发送失败', tone: 'error' });
      textDrafts.replaceIfUnchanged(sessionId, clearedDraft, inputText);
      setReplyTo(currentReplyTo);
    }
  }, [inputText, readyAttachments, selectedMentions, sessionId, replyTo, withAttachmentSubmission, textDrafts]);

  const handleStickerPress = useCallback(async (sticker: StickerMessageSnapshot) => {
    try {
      await sendGroupUserMessage({
        groupId: sessionId,
        text: '',
        attachments: [],
        mentions: [],
        sticker,
      });
    } catch (error) {
      showAppDialog({ title: '表情包发送失败', message: error instanceof Error ? error.message : '发送表情包失败', tone: 'error' });
    }
  }, [sessionId]);

  const handleInvoke = useCallback(async () => {
    if (isSummonDisabled) {
      return;
    }

    setIsInvoking(true);
    setIsTyping(true);
    try {
      const result = await invokeGroupChat(sessionId);
      if (!result.success && result.error) {
        showAppDialog({ title: '召唤失败', message: result.error, tone: 'error' });
      }
    } finally {
      setIsInvoking(false);
      setIsTyping(false);
      await refreshGroupDetails();
    }
  }, [isSummonDisabled, refreshGroupDetails, sessionId]);

  const handleSelectMentionCandidate = useCallback((candidate: GroupAssistantParticipant) => {
    const activeMention = getActiveMentionQuery(inputText);
    if (!activeMention) {
      return;
    }

    const beforeMention = inputText.slice(0, activeMention.start);
    const afterMention = inputText.slice(activeMention.start + activeMention.query.length + 1);
    setInputText(`${beforeMention}@${candidate.displayName} ${afterMention}`.replace(/\s+$/, ' '));
    setSelectedMentions((current) => current.some(
      (mention) => mention.assistantId === candidate.assistantId,
    ) ? current : [...current, {
      assistantId: candidate.assistantId,
      displayName: candidate.displayName,
    }]);
  }, [inputText, setInputText]);

  const handleInsertAtMention = useCallback(() => {
    setInputText((prev) => {
      if (getActiveMentionQuery(prev)) {
        return prev;
      }
      const trimmed = prev.trimEnd();
      return trimmed ? `${trimmed} @`.trimStart() : '@';
    });
  }, [setInputText]);

  const handleMessageLongPress = useCallback((msg: ChatMessage, position: { x: number; y: number }) => {
    if (msg.senderType !== 'user' && msg.senderType !== 'assistant') return;

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
    setTextSelectionText(selectedMessage!.text);
  }, [dismissInputSurface, selectedMessage]);

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
    setReplyTo((previous) => previous?.id === edited.id ? createChatReplyTarget(edited, aiAssistants, currentUser.name) : previous);
  }, [aiAssistants, currentUser.name, setMessages]);

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
    setReplyTo(createChatReplyTarget(selectedMessage, aiAssistants, currentUser.name));
  }, [aiAssistants, currentUser.name, selectedMessage]);

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

  const handleCancelReply = useCallback(() => {
    setReplyTo(null);
  }, []);

  const renderFooter = (paddingBottom: number) => (
    <>
      <View style={localStyles.summonBar}>
        <TouchableOpacity
          style={[
            localStyles.pillTag,
            isSummonDisabled && localStyles.pillTagDisabled,
          ]}
          onPress={handleInvoke}
          disabled={isSummonDisabled}
          activeOpacity={0.75}
        >
          <Ionicons
            name="sparkles"
            size={14}
            color={isSummonDisabled ? theme.colors.text.secondary : theme.colors.brand.primary}
          />
          <Text
            style={[
              localStyles.pillText,
              isSummonDisabled && localStyles.pillTextDisabled,
            ]}
          >
            {isInvoking || activePlan ? '召唤中' : '召唤'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={localStyles.pillTag}
          onPress={handleInsertAtMention}
          activeOpacity={0.75}
        >
          <Ionicons name="at" size={14} color={theme.colors.text.secondary} />
        </TouchableOpacity>

        {activePlan ? (
          <TouchableOpacity
            style={[
              localStyles.pillTag,
              isTerminating && localStyles.pillTagDisabled,
            ]}
            onPress={handleTerminate}
            disabled={isTerminating}
            activeOpacity={0.75}
          >
            <Ionicons
              name="stop-circle-outline"
              size={14}
              color={isTerminating ? theme.colors.text.secondary : theme.colors.feedback.error}
            />
            <Text
              style={[
                localStyles.pillText,
                { color: isTerminating ? theme.colors.text.secondary : theme.colors.feedback.error },
              ]}
            >
              {isTerminating ? '终止中' : '终止'}
            </Text>
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity
          style={localStyles.pillTag}
          onPress={() => setQueueOverlayVisible(true)}
          activeOpacity={0.75}
        >
          <Ionicons name="list" size={14} color={theme.colors.text.secondary} />
          <Text style={localStyles.pillText}>队列</Text>
        </TouchableOpacity>
      </View>

      {shouldShowMentionPanel ? (
        <ScrollView
          style={localStyles.mentionPanel}
          contentContainerStyle={localStyles.mentionPanelContent}
          keyboardShouldPersistTaps="handled"
        >
          {filteredMentionCandidates.map((candidate) => (
            <TouchableOpacity
              key={candidate.assistantId}
              style={localStyles.mentionItem}
              onPress={() => handleSelectMentionCandidate(candidate)}
              activeOpacity={0.75}
            >
              <AIAvatar
                name={candidate.displayName}
                avatarUrl={candidate.avatar}
                size="small"
                style={localStyles.mentionAvatar}
              />
              <View style={localStyles.mentionInfo}>
                <Text style={localStyles.mentionName} numberOfLines={1}>
                  {candidate.displayName}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : null}

      <ChatInputArea
        value={inputText}
        disabled={!draftReady}
        onChangeText={setInputText}
        onSend={handleSend}
        attachmentDrafts={draftAttachments}
        hasReadyAttachment={readyAttachments.length > 0}
        isPreparingAttachment={isPreparingAttachment}
        onRemoveAttachment={removeAttachment}
        onImagePress={selectImageAttachment}
        onCameraPress={capturePhotoAttachment}
        onFilePress={selectDocumentAttachment}
        onStickerPress={handleStickerPress}
        replyTo={replyTo}
        onCancelReply={handleCancelReply}
        paddingBottom={paddingBottom}
        activeSurface={activeSurface}
        onActiveSurfaceChange={setActiveSurface}
        surfaceHeight={surfaceHeight}
      />
    </>
  );

  return (
    <ChatBackground chatKey={chatBackgroundKey}>
      <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <View style={styles.keyboardView}>
        {selection.selecting ? (
            <ChatSelectionHeader count={selection.count} paddingTop={Math.max(insets.top, 8)} disabled={selection.isDeleting} onCancel={selection.exit} />
          ) : (
            <ChatHeader
            aiName={groupDetails?.group.name ?? group.name}
            onGoBack={onGoBack}
            onOpenMenu={onOpenMenu}
            paddingTop={Math.max(insets.top, 8)}
          />
          )}

        {isLoading && messages.length === 0 ? (
          <LoadingState />
        ) : (
          <ChatMessageList
            sessionId={sessionId}
            messages={messages}
            aiAssistant={aiAssistantLike}
            aiAssistants={memberAssistants}
            onOpenAssistantProfile={onOpenAssistantProfile}
            hasMore={hasMore}
            isLoadingMore={isLoadingMore}
            onLoadMore={loadMore}
            userAvatar={currentUser.avatar}
            userName={currentUser.name}
            pauseAutoScroll={share.visible || textSelectionText !== null}
            showAssistantName
            onTogetherListeningAccept={(id) => listeningAction(acceptChatTogetherListeningInvitation, id)}
            onTogetherListeningDecline={(id) => listeningAction(declineChatTogetherListeningInvitation, id)}
            onTogetherListeningLeave={(id) => listeningAction(leaveChatTogetherListening, id)}
            onMessageLongPress={handleMessageLongPress}
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
            onDismissInputSurface={dismissInputSurface}
          />
        )}

        <Animated.View style={{ marginBottom: keyboardOffset }}>
          {selection.selecting
            ? <ChatSelectionFooter count={selection.count} isDeleting={selection.isDeleting} paddingBottom={Math.max(insets.bottom, 8)} onDelete={selection.requestDelete} onShare={() => { void share.open(selection.anchorMessageIds); }} />
            : renderFooter(Math.max(insets.bottom, 8))}
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

      <ChatMessageActionMenu
        visible={actionMenuVisible}
        onClose={handleCloseActionMenu}
        position={menuPosition}
        onCopy={selectedMessage?.text.trim() ? handleCopyMessage : undefined}
        onSelectText={selectedMessage?.text.trim() ? handleSelectMessageText : undefined}
        onRewrite={selectedMessage && canEditChatMessage(selectedMessage) ? handleRewriteMessage : undefined}
        onDelete={handleDeleteMessage}
        onMultiSelect={selectedMessage && selection.availableKeys.has(getChatSelectionKey(selectedMessage)) ? handleEnterSelection : undefined}
        onForward={selectedMessage && selection.availableKeys.has(getChatSelectionKey(selectedMessage)) ? handleShareMessage : undefined}
        onQuote={messageActions?.quote ? handleQuoteMessage : undefined}
        onTranslate={messageActions?.translate ? handleTranslateMessage : undefined}
        onFavorite={messageActions?.favorite ? favoriteMessage.toggle : undefined}
        isFavorited={favoriteMessage.isFavorited}
        stickerAction={stickerAction}
      />
      <ChatContentShareSheet share={share} onPreviewFile={(params) => { share.close(); onOpenFilePreview(params); }} />

      <GroupSpeechQueueOverlay
        visible={queueOverlayVisible}
        groupId={sessionId}
        participantDirectory={participantDirectory}
        onClose={() => setQueueOverlayVisible(false)}
        onActivePlanChange={setActivePlan}
      />

      </SafeAreaView>
    </ChatBackground>
  );
}
