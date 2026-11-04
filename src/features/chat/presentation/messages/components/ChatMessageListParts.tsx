/** 提供消息列表项、可触摸气泡及加载控件等列表子组件。 */

import { getMessageSharedMoment, getMessageSharedRecord, parseMessageMetadata } from '../../../messages/domain/chatMessageMetadata';
import React, { memo, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Keyboard,
  Pressable,
  StyleSheet,
} from 'react-native';

import { Check, Circle } from 'lucide-react-native';
import MessageBubble from '../MessageBubble';
import ActionGroupProcessCard from '../MessageBubble/ActionGroupProcessCard';
import { createLayoutProbeHandler, isLayoutProbeEnabled } from '../MessageBubble/layoutProbe';
import TogetherListeningActivityCard from './TogetherListeningActivityCard';
import ChatMessageInlineActions from './ChatMessageInlineActions';
import type { ChatMessage } from '@features/chat/messages/domain/ChatMessage';
import type {
  ChatAttachment,
  StickerMessageSnapshot,
} from '@features/chat/messages/domain';

import {
  areChatMessagesEquivalent,
  areResolvedAIIdentitiesEquivalent,
  areMessageBubbleRenderStatesEquivalent,
  type RenderedMessageItem,
  type ResolvedMessageAIIdentity,
} from './chatMessageRenderUtils';
import { areActionGroupsEquivalent } from './chatActionGrouping';
import { createMessageListPartsStyles } from './chatStyles';
import type { ChatTogetherListeningResult } from '../../../conversation/application/ChatTogetherListeningGateway';
import {
  getChatInteractionProfile,
  isMoonKimiTheme,
  isPaperNoteTheme,
  useTheme,
  useThemedStyles,
} from '@shared/theme';
import {
  resolveTogetherListeningCardPresentationIdentity,
} from './togetherListeningCardViewModel';

interface MessageListItemProps {
  item: RenderedMessageItem;
  userAvatar?: unknown;
  userName?: string;
  showAssistantName?: boolean;
  isSelected?: boolean;
  selectionMode?: boolean;
  selectionKey?: string;
  showSelectionControl?: boolean;
  selectionDisabled?: boolean;
  onToggleSelection?: (key: string) => void;
  isVoiceTranscriptExpanded?: boolean;
  onOpenAssistantProfile?: (aiId: string) => void;
  onMessageLongPress?: (message: ChatMessage, position: { x: number; y: number }) => void;
  onRetryMessage?: (messageId: number) => void;
  onHideTranslation?: (messageId: number) => void;
  onPreviewFile: (params: { fileUri: string; fileName: string; mimeType?: string | null }) => void;
  onNestedScrollActiveChange?: (isActive: boolean) => void;
  onTogetherListeningAccept?: (activityId: string) => Promise<ChatTogetherListeningResult>;
  onTogetherListeningDecline?: (activityId: string) => Promise<ChatTogetherListeningResult>;
  onTogetherListeningLeave?: (activityId: string) => Promise<ChatTogetherListeningResult>;
}

/**
 * 消息列表项组件
 * 
 * 用于在聊天列表中渲染单条消息，包括：
 * - 可选的日期时间分隔符（当与上一条消息日期不同时显示）
 * - 消息气泡（通过 `TouchableMessageBubble` 组件展示）
 * 
 * 该组件使用 `React.memo` 和自定义比较函数 `areMessageListItemEqual` 来避免不必要的重新渲染，
 * 仅当 `item` 内容或相关回调发生实质性变化时才重新渲染。
 * 
 * @param props - 组件属性
 * @param props.item - 渲染项数据，包含消息对象、时间分隔符标识、格式化时间文本、token 使用量等
 * @param props.userAvatar - 当前用户头像，可传递 URL 或 React 元素
 * @param props.userName - 当前用户名称
 * @param props.onMessageLongPress - 长按消息时的回调函数
 * @param props.onRetryMessage - 重试失败消息的回调函数
 * @returns 渲染的消息项元素，可能包含时间分隔符和消息气泡
 */
export const MessageListItem = memo(function MessageListItem({
  item,
  userAvatar,
  userName,
  showAssistantName,
  isSelected,
  selectionMode,
  selectionKey,
  showSelectionControl,
  selectionDisabled,
  onToggleSelection,
  isVoiceTranscriptExpanded,
  onMessageLongPress,
  onOpenAssistantProfile,
  onRetryMessage,
  onHideTranslation,
  onPreviewFile,
  onNestedScrollActiveChange,
  onTogetherListeningAccept,
  onTogetherListeningDecline,
  onTogetherListeningLeave,
}: MessageListItemProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createMessageListPartsStyles);
  const {
    msg,
    actionGroup,
    showTimeSeparator,
    showSpeakerSeparator,
    timeText,
    displayTokensUsed,
    bubbleText,
    attachments,
    sticker,
    voice,
    resolvedAIIdentity,
    bubbleRenderState,
    translation,
    processCard,
    togetherListeningCard,
    isAssistantOutputTail,
    presentationRunKey,
  } = item;

  // 开发态布局探针：默认关闭，关闭时不生成 handler，也不产生额外渲染开销。
  // 这一层是 FlashList 之外的列表项根节点，用来判断"空白是否已经落在列表项内部"。
  const layoutProbeHandler = useMemo(() => {
    if (!isLayoutProbeEnabled()) {
      return undefined;
    }
    return createLayoutProbeHandler({
      messageId: msg.id,
      senderType: msg.senderType,
      isMe: msg.isMe,
      themeId: theme.id,
      presentationRunKey: presentationRunKey ?? null,
      // wide 标记只有 MessageBubble 内部算得出；外层不猜，交给同 messageId 的上下文合并。
      isWideMarkdown: null,
    }, 'messageListItem');
  }, [msg.id, msg.isMe, msg.senderType, presentationRunKey, theme.id]);

  const content = (
    <>
      {actionGroup ? (
        <ActionGroupProcessCard
          group={actionGroup}
          onNestedScrollActiveChange={onNestedScrollActiveChange}
        />
      ) : togetherListeningCard ? (
        <TogetherListeningActivityCard
          viewModel={togetherListeningCard}
          identity={resolveTogetherListeningCardPresentationIdentity(
            togetherListeningCard.initiator,
            {
              user: {
                avatar: userAvatar as string | null,
                name: userName,
              },
              ai: {
                avatar: resolvedAIIdentity.avatar as string | null,
                name: resolvedAIIdentity.name,
              },
            },
          )}
          onAccept={onTogetherListeningAccept}
          onDecline={onTogetherListeningDecline}
          onLeave={onTogetherListeningLeave}
        />
      ) : (
        <TouchableMessageBubble
          msg={msg}
          displayTokensUsed={displayTokensUsed}
          bubbleText={bubbleText}
          attachments={attachments}
          sticker={sticker}
          voice={voice}
          resolvedAIIdentity={resolvedAIIdentity}
          bubbleRenderState={bubbleRenderState}
          translation={translation}
          processCard={processCard}
          isAssistantOutputTail={isAssistantOutputTail}
          hideInlineActions={selectionMode}
          presentationRunKey={presentationRunKey}
          userAvatar={userAvatar as string | null}
          userName={userName}
          showAssistantName={showAssistantName}
          isSelected={isSelected}
          isVoiceTranscriptExpanded={isVoiceTranscriptExpanded}
          onOpenAssistantProfile={selectionMode ? undefined : onOpenAssistantProfile}
          onMessageLongPress={onMessageLongPress}
          onRetryMessage={onRetryMessage}
          onHideTranslation={onHideTranslation}
          onPreviewFile={onPreviewFile}
          onNestedScrollActiveChange={onNestedScrollActiveChange}
        />
      )}
    </>
  );

  return (
    <View onLayout={layoutProbeHandler}>
      {showSpeakerSeparator && isPaperNoteTheme(theme) ? (
        <View
          pointerEvents="none"
          importantForAccessibility="no-hide-descendants"
          style={styles.paperNoteSpeakerSeparator}
        >
          <Text
            style={styles.paperNoteSpeakerSeparatorText}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.7}
          >
            —————·✦₊˚✧.˖ ☁︎ ·˖✶—————
          </Text>
        </View>
      ) : null}
      {showTimeSeparator && !isPaperNoteTheme(theme) && !isMoonKimiTheme(theme) ? (
        <View style={styles.timeSeparator}>
          <Text style={styles.timeSeparatorText}>{timeText}</Text>
        </View>
      ) : null}

      {selectionMode ? (
        <Pressable
          accessibilityRole={selectionKey ? 'checkbox' : undefined}
          accessibilityLabel={selectionKey ? (msg.senderType === 'user' ? '选择用户消息' : '选择 AI 整轮回复') : undefined}
          accessibilityState={{ checked: Boolean(isSelected), disabled: !selectionKey || selectionDisabled }}
          disabled={!selectionKey || selectionDisabled}
          onPress={() => onToggleSelection!(selectionKey!)}
          style={[selectionStyles.row, isSelected && { backgroundColor: theme.colors.surface.muted }]}
        >
          <View style={selectionStyles.control}>
            {showSelectionControl && (isSelected
              ? <View style={[selectionStyles.checked, { backgroundColor: theme.colors.brand.primary }]}><Check size={16} color={theme.colors.brand.onPrimary} /></View>
              : <Circle size={24} color={theme.colors.text.secondary} />)}
          </View>
          <View pointerEvents="none" style={selectionStyles.content}>
            {content}
          </View>
        </Pressable>
      ) : content}
    </View>
  );
}, areMessageListItemEqual);

interface TouchableMessageBubbleProps {
  msg: ChatMessage;
  displayTokensUsed: number;
  bubbleText: string;
  attachments: ChatAttachment[];
  sticker: StickerMessageSnapshot | null;
  voice: RenderedMessageItem['voice'];
  resolvedAIIdentity: ResolvedMessageAIIdentity;
  bubbleRenderState: RenderedMessageItem['bubbleRenderState'];
  translation?: RenderedMessageItem['translation'];
  processCard?: RenderedMessageItem['processCard'];
  isAssistantOutputTail: boolean;
  hideInlineActions?: boolean;
  presentationRunKey?: string | null;
  userAvatar?: unknown;
  userName?: string;
  showAssistantName?: boolean;
  isSelected?: boolean;
  isVoiceTranscriptExpanded?: boolean;
  onOpenAssistantProfile?: (aiId: string) => void;
  onMessageLongPress?: (message: ChatMessage, position: { x: number; y: number }) => void;
  onRetryMessage?: (messageId: number) => void;
  onHideTranslation?: (messageId: number) => void;
  onPreviewFile: (params: { fileUri: string; fileName: string; mimeType?: string | null }) => void;
  onNestedScrollActiveChange?: (isActive: boolean) => void;
}

/**
 * 可触摸的消息气泡组件
 * 
 * 该组件是消息列表项的核心交互部分，负责：
 * - 渲染消息气泡内容（文本、时间、头像、Token 使用量等）
 * - 处理长按消息事件，触发回调（如复制、删除）
 * - 根据消息状态显示重试按钮（发送失败）或发送中指示器
 * 
 * 使用 `React.memo` 优化性能，通过自定义比较函数避免不必要的重渲染。
 * 
 * @param props - 组件属性
 * @param props.msg - 消息对象，包含消息内容、发送者、状态等
 * @param props.displayTokensUsed - 本次渲染需要显示的 Token 使用量（仅在助手消息的最后一个片段显示）
 * @param props.userAvatar - 当前用户头像（URL 或 React 元素）
 * @param props.userName - 当前用户名称
 * @param props.onMessageLongPress - 长按消息时的回调函数，参数为被长按的消息对象
 * @param props.onRetryMessage - 重试发送失败消息的回调函数，参数为消息 ID
 * @returns 渲染的可触摸消息气泡，可能包含重试按钮或发送中指示器
 */
export const TouchableMessageBubble = memo(function TouchableMessageBubble({
  msg,
  displayTokensUsed,
  bubbleText,
  attachments,
  sticker,
  voice,
  resolvedAIIdentity,
  bubbleRenderState,
  translation,
  processCard,
  isAssistantOutputTail,
  hideInlineActions,
  presentationRunKey,
  userAvatar,
  userName,
  showAssistantName,
  isSelected,
  isVoiceTranscriptExpanded,
  onMessageLongPress,
  onOpenAssistantProfile,
  onRetryMessage,
  onHideTranslation,
  onPreviewFile,
  onNestedScrollActiveChange,
}: TouchableMessageBubbleProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createMessageListPartsStyles);
  const interactionProfile = getChatInteractionProfile(theme);
  const touchPositionRef = React.useRef({ x: 0, y: 0 });

  // 开发态布局探针：`TouchableWithoutFeedback` 不落原生节点，所以内容包装 View 就是
  // 本组件能测到的最外层，也是"列表项根 → 气泡"之间的最后一层。
  const layoutProbeHandler = useMemo(() => {
    if (!isLayoutProbeEnabled()) {
      return undefined;
    }
    return createLayoutProbeHandler({
      messageId: msg.id,
      senderType: msg.senderType,
      isMe: msg.isMe,
      themeId: theme.id,
      presentationRunKey: presentationRunKey ?? null,
      isWideMarkdown: null,
    }, 'touchWrapper');
  }, [msg.id, msg.isMe, msg.senderType, presentationRunKey, theme.id]);
  const isAssistantMessage = msg.senderType === 'assistant' && !msg.isMe;
  const shouldHandleLongPress = interactionProfile.enableMessageLongPressMenu && Boolean(onMessageLongPress);
  // 语音气泡不经过外层 Touchable 的长按：其内部播放 Pressable 会吞掉 Android 长按
  // responder。因此语音消息通过独立回调到达同一菜单，不依赖外层正文的触控路径。
  const shouldHandleVoiceLongPress =
    interactionProfile.enableVoiceMessageLongPressMenu
    && Boolean(voice)
    && Boolean(onMessageLongPress);
  // 操作栏语义是“整轮 AI 回复的 footer”，不是“每条 assistant 消息的装饰”。
  // 因此必须挂在 run 内最后一个用户可见 assistant 输出上，否则一次 run 有多少个
  // 物理 assistant 消息（多 step、多分段）就会渲染多少条操作栏。
  const shouldShowInlineActions =
    !hideInlineActions &&
    interactionProfile.showAssistantInlineActions &&
    isAssistantMessage &&
    isAssistantOutputTail &&
    msg.status === 'sent';
  const inlineActionsStyle = isMoonKimiTheme(theme) ? { marginLeft: theme.spacing.lg, width: '90%' as const } : undefined;
  // 思维链文字自己拥有原生选择手势；外层 Touchable 不得抢占长按或嵌套滚动。
  const shouldBypassTouchWrapper = msg.senderType === 'reasoning'
    || Boolean(processCard && interactionProfile.toolStatusSurface === 'official-replica');

  const handlePressIn = useCallback((event: any) => {
    if (!shouldHandleLongPress) {
      return;
    }

    touchPositionRef.current = {
      x: event.nativeEvent.pageX,
      y: event.nativeEvent.pageY,
    };
  }, [shouldHandleLongPress]);

  const handleLongPress = useCallback(() => {
    if (!shouldHandleLongPress) {
      return;
    }

    onMessageLongPress?.(msg, touchPositionRef.current);
  }, [msg, onMessageLongPress, shouldHandleLongPress]);

  const handleVoiceLongPress = useCallback((position: { x: number; y: number }) => {
    if (!shouldHandleVoiceLongPress) {
      return;
    }

    onMessageLongPress?.(msg, position);
  }, [msg, onMessageLongPress, shouldHandleVoiceLongPress]);

  const handleAttachmentLongPress = useCallback((position: { x: number; y: number }) => {
    onMessageLongPress?.(msg, position);
  }, [msg, onMessageLongPress]);

  const handlePress = useCallback(() => {
    Keyboard.dismiss();
  }, []);

  const handleRetry = useCallback(() => {
    onRetryMessage?.(msg.id);
  }, [msg.id, onRetryMessage]);

  const handleHideTranslation = useCallback(() => {
    onHideTranslation?.(msg.id);
  }, [msg.id, onHideTranslation]);

  const content = (
    <View onLayout={layoutProbeHandler}>
      <MessageBubble
        sharedRecord={getMessageSharedRecord(msg)}
        sharedMoment={getMessageSharedMoment(msg)}
        sharedComment={msg.text}
        text={voice ? msg.text : bubbleText}
        messageId={msg.id}
        clientMessageId={msg.clientMessageId}
        isMe={msg.isMe}
        senderType={msg.senderType}
        tokensUsed={displayTokensUsed}
        promptTokens={msg.promptTokens}
        completionTokens={msg.completionTokens}
        cachedTokens={parseMessageMetadata(msg)?.cachedTokens}
        replyToText={msg.replyToText}
        replyQuote={parseMessageMetadata(msg)?.replyQuote}
        onOpenAssistantProfile={onOpenAssistantProfile}
        avatar={resolvedAIIdentity.avatar as string | null}
        userAvatar={userAvatar as string | null}
        aiId={resolvedAIIdentity.aiId}
        agentId={resolvedAIIdentity.agentId}
        aiName={resolvedAIIdentity.name || undefined}
        showAssistantName={showAssistantName}
        userName={userName}
        messageStatus={msg.status}
        attachments={attachments}
        sticker={sticker}
        voice={voice}
        voicePlayedAt={msg.voicePlayedAt}
        renderState={bubbleRenderState}
        translation={translation}
        processCard={processCard}
        presentationRunKey={presentationRunKey}
        reasoningSurface={interactionProfile.reasoningSurface}
        processCardSurface={interactionProfile.toolStatusSurface === 'official-replica' ? 'official-replica' : 'none'}
        onNestedScrollActiveChange={onNestedScrollActiveChange}
        onHideTranslation={handleHideTranslation}
        onPreviewFile={onPreviewFile}
        isSelected={isSelected}
        isVoiceTranscriptExpanded={isVoiceTranscriptExpanded}
        canLongPressVoice={shouldHandleVoiceLongPress}
        onVoiceLongPress={handleVoiceLongPress}
        onAttachmentLongPress={shouldHandleLongPress ? handleAttachmentLongPress : undefined}
      />

      {shouldShowInlineActions ? (
        <ChatMessageInlineActions style={inlineActionsStyle} />
      ) : null}

      {msg.isMe && msg.status === 'failed' ? (
        <TouchableOpacity style={styles.retryButton} onPress={handleRetry}>
          <Text style={styles.retryText}>!</Text>
        </TouchableOpacity>
      ) : null}

      {msg.isMe && msg.status === 'pending' ? (
        <View style={styles.sendingIndicator}>
          <View style={styles.sendingDot} />
        </View>
      ) : null}
    </View>
  );

  if (shouldBypassTouchWrapper) {
    return content;
  }

  return (
    <TouchableWithoutFeedback
      onPress={handlePress}
      onPressIn={shouldHandleLongPress ? handlePressIn : undefined}
      onLongPress={shouldHandleLongPress ? handleLongPress : undefined}
    >
      {content}
    </TouchableWithoutFeedback>
  );
}, areTouchableMessageBubbleEqual);

function areMessageListItemEqual(
  prevProps: Readonly<MessageListItemProps>,
  nextProps: Readonly<MessageListItemProps>
) {
  return (
    prevProps.item.key === nextProps.item.key &&
    areChatMessagesEquivalent(prevProps.item.msg, nextProps.item.msg) &&
    areActionGroupsEquivalent(
      prevProps.item.actionGroup,
      nextProps.item.actionGroup,
      areChatMessagesEquivalent
    ) &&
    prevProps.item.showTimeSeparator === nextProps.item.showTimeSeparator &&
    prevProps.item.showSpeakerSeparator === nextProps.item.showSpeakerSeparator &&
    prevProps.item.timeText === nextProps.item.timeText &&
    prevProps.item.displayTokensUsed === nextProps.item.displayTokensUsed &&
    prevProps.item.bubbleText === nextProps.item.bubbleText &&
    prevProps.item.attachments === nextProps.item.attachments &&
    prevProps.item.sticker === nextProps.item.sticker &&
    prevProps.item.voice === nextProps.item.voice &&
    areResolvedAIIdentitiesEquivalent(
      prevProps.item.resolvedAIIdentity,
      nextProps.item.resolvedAIIdentity
    ) &&
    areMessageBubbleRenderStatesEquivalent(
      prevProps.item.bubbleRenderState,
      nextProps.item.bubbleRenderState
    ) &&
    prevProps.item.togetherListeningCard?.activityId === nextProps.item.togetherListeningCard?.activityId &&
    prevProps.item.togetherListeningCard?.phase === nextProps.item.togetherListeningCard?.phase &&
    prevProps.item.togetherListeningCard?.body === nextProps.item.togetherListeningCard?.body &&
    prevProps.item.togetherListeningCard?.isMe === nextProps.item.togetherListeningCard?.isMe &&
    prevProps.item.togetherListeningCard?.actions?.join(',') === nextProps.item.togetherListeningCard?.actions?.join(',') &&
    prevProps.item.processCard?.kind === nextProps.item.processCard?.kind &&
    prevProps.item.processCard?.title === nextProps.item.processCard?.title &&
    prevProps.item.processCard?.status === nextProps.item.processCard?.status &&
    prevProps.item.isAssistantOutputTail === nextProps.item.isAssistantOutputTail &&
    prevProps.item.isRunTail === nextProps.item.isRunTail &&
    prevProps.userAvatar === nextProps.userAvatar &&
    prevProps.userName === nextProps.userName &&
    prevProps.showAssistantName === nextProps.showAssistantName &&
    prevProps.onOpenAssistantProfile === nextProps.onOpenAssistantProfile &&
    prevProps.onMessageLongPress === nextProps.onMessageLongPress &&
    prevProps.onRetryMessage === nextProps.onRetryMessage &&
    prevProps.onHideTranslation === nextProps.onHideTranslation &&
    prevProps.onPreviewFile === nextProps.onPreviewFile &&
    prevProps.onNestedScrollActiveChange === nextProps.onNestedScrollActiveChange &&
    prevProps.onTogetherListeningAccept === nextProps.onTogetherListeningAccept &&
    prevProps.onTogetherListeningDecline === nextProps.onTogetherListeningDecline &&
    prevProps.onTogetherListeningLeave === nextProps.onTogetherListeningLeave &&
    prevProps.selectionMode === nextProps.selectionMode &&
    prevProps.selectionKey === nextProps.selectionKey &&
    prevProps.showSelectionControl === nextProps.showSelectionControl &&
    prevProps.selectionDisabled === nextProps.selectionDisabled &&
    prevProps.onToggleSelection === nextProps.onToggleSelection &&
    prevProps.isSelected === nextProps.isSelected
    && prevProps.isVoiceTranscriptExpanded === nextProps.isVoiceTranscriptExpanded
  );
}

function areTouchableMessageBubbleEqual(
  prevProps: Readonly<TouchableMessageBubbleProps>,
  nextProps: Readonly<TouchableMessageBubbleProps>
) {
  return (
    areChatMessagesEquivalent(prevProps.msg, nextProps.msg) &&
    prevProps.displayTokensUsed === nextProps.displayTokensUsed &&
    prevProps.bubbleText === nextProps.bubbleText &&
    prevProps.attachments === nextProps.attachments &&
    prevProps.sticker === nextProps.sticker &&
    prevProps.voice === nextProps.voice &&
    areResolvedAIIdentitiesEquivalent(prevProps.resolvedAIIdentity, nextProps.resolvedAIIdentity) &&
    areMessageBubbleRenderStatesEquivalent(prevProps.bubbleRenderState, nextProps.bubbleRenderState) &&
    prevProps.translation?.text === nextProps.translation?.text &&
    prevProps.translation?.sourceLabel === nextProps.translation?.sourceLabel &&
    prevProps.processCard?.kind === nextProps.processCard?.kind &&
    prevProps.processCard?.title === nextProps.processCard?.title &&
    prevProps.processCard?.status === nextProps.processCard?.status &&
    prevProps.isAssistantOutputTail === nextProps.isAssistantOutputTail &&
    prevProps.hideInlineActions === nextProps.hideInlineActions &&
    prevProps.userAvatar === nextProps.userAvatar &&
    prevProps.userName === nextProps.userName &&
    prevProps.showAssistantName === nextProps.showAssistantName &&
    prevProps.onOpenAssistantProfile === nextProps.onOpenAssistantProfile &&
    prevProps.onMessageLongPress === nextProps.onMessageLongPress &&
    prevProps.onRetryMessage === nextProps.onRetryMessage &&
    prevProps.onHideTranslation === nextProps.onHideTranslation &&
    prevProps.onPreviewFile === nextProps.onPreviewFile &&
    prevProps.onNestedScrollActiveChange === nextProps.onNestedScrollActiveChange &&
    prevProps.isSelected === nextProps.isSelected
    && prevProps.isVoiceTranscriptExpanded === nextProps.isVoiceTranscriptExpanded
  );
}

const selectionStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  control: { width: 36, alignItems: 'center', justifyContent: 'center' },
  checked: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  content: { flex: 1, minWidth: 0 },
});
