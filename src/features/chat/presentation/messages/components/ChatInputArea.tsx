/** 提供聊天文本输入、附件操作、回复状态与主题快捷面板。 */

import { showAppDialog } from '@shared/ui';
import React, { useRef, useState, useCallback, useMemo } from 'react';
import { View, Text, TextInput, TouchableOpacity, type LayoutChangeEvent, Keyboard } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BrainCircuit, CirclePlay, Keyboard as KeyboardIcon } from 'lucide-react-native';
import ChatEmojiPanel from './ChatEmojiPanel';
import ChatToolPanel from './ChatToolPanel';
import ChatAttachmentComposerTray from './ChatAttachmentComposerTray';
import { ChatSendButton } from './ChatSendButton';
import { ChatVoiceReviewPanel } from './ChatVoiceReviewPanel';
import { ChatVoiceRecordingFeedback } from './ChatVoiceRecordingFeedback';
import type {
  AttachmentDraftItem,
  StickerMessageSnapshot,
} from '@features/chat/messages/domain';
import { createInputAreaStyles, GLASS_COMPOSER_CONTROL_SIZE } from './chatInputStyles';
import { isMoonKimiTheme, ThemedSurface, useTheme } from '@shared/theme';
import { MoonKimiComposer } from './MoonKimiComposer';
import type { MoonKimiQuickAction } from './MoonKimiComposer';
import { resolveTogetherListeningToolPanelHandler } from './chatToolPanelCapability';
import { CHAT_TEXT_ATTACHMENT_MAX_LENGTH } from '../../../messages/domain/ChatAttachment';
import { ChatComposerTextInput } from './ChatComposerTextInput';
import type { ChatComposerSurface } from './useChatComposerSurface';
import type { ChatVoiceMessageReviewDraft, ChatVoiceRecordingState } from './chatTypes';

export type { MoonKimiQuickAction } from './MoonKimiComposer';

const DEFAULT_MOON_KIMI_QUICK_ACTIONS: MoonKimiQuickAction[] = [
  { id: 'memory', label: '记忆', Icon: BrainCircuit },
];

export interface InputAreaReplyTarget {
  id: number;
  text: string;
}

interface ChatInputAreaProps {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => Promise<unknown> | unknown;
  onInvoke?: () => Promise<unknown> | unknown;
  onStopReply?: () => void;
  isStoppingReply?: boolean;
  voiceRecordingState?: ChatVoiceRecordingState;
  voiceRecordingProgress?: { durationMs: number; level: number };
  /** 语音录制 / STT 的即时失败文案；由输入区直接可见，不走历史消息 error 通道。 */
  voiceRecordingError?: string | null;
  onDismissVoiceRecordingError?: () => void;
  /** 发送前校对 draft。非 null 时输入区切换为校对面板，不再展示普通输入或录音按钮。 */
  voiceReviewDraft?: ChatVoiceMessageReviewDraft | null;
  onVoiceReviewTranscriptChange?: (transcript: string) => void;
  onVoiceReviewSend?: () => Promise<boolean> | boolean;
  onVoiceReviewCancel?: () => Promise<void> | void;
  /**
   * 进入“按住说话”前的 preflight（麦克风权限确认）。
   * 返回 false 表示不进入语音模式，由调用方给出可见错误。
   */
  onVoiceModeEnter?: () => Promise<boolean> | boolean;
  onVoiceRecordingStart?: () => Promise<boolean>;
  onVoiceRecordingFinish?: () => Promise<boolean>;
  onVoiceRecordingCancel?: () => Promise<void>;
  attachmentDrafts?: AttachmentDraftItem[];
  hasReadyAttachment?: boolean;
  isPreparingAttachment?: boolean;
  onRemoveAttachment?: (id: string) => void;
  onImagePress?: () => Promise<unknown> | unknown;
  onCameraPress?: () => Promise<unknown> | unknown;
  onFilePress?: () => Promise<unknown> | unknown;
  onAttachPastedText?: (text: string) => Promise<void>;
  onStickerPress?: (sticker: StickerMessageSnapshot) => Promise<unknown> | unknown;
  onVideoCallPress?: () => Promise<unknown> | unknown;
  onTogetherListeningPress?: () => Promise<unknown> | unknown;
  disabled?: boolean;
  disabledPlaceholder?: string;
  disabledPressMessage?: string;
  replyTo?: InputAreaReplyTarget | null;
  onCancelReply?: () => void;
  paddingBottom?: number;
  onLayout?: (event: LayoutChangeEvent) => void;
  moonKimiQuickActions?: MoonKimiQuickAction[];
  onMoonKimiQuickActionPress?: (action: MoonKimiQuickAction) => void;
  activeSurface: ChatComposerSurface;
  onActiveSurfaceChange: (surface: ChatComposerSurface) => void;
  surfaceHeight: number;
}

export default function ChatInputArea({
  value,
  onChangeText,
  onSend,
  onInvoke,
  onStopReply,
  isStoppingReply = false,
  voiceRecordingState = 'idle',
  voiceRecordingProgress = { durationMs: 0, level: 0 },
  voiceRecordingError = null,
  onDismissVoiceRecordingError,
  voiceReviewDraft = null,
  onVoiceReviewTranscriptChange,
  onVoiceReviewSend,
  onVoiceReviewCancel,
  onVoiceModeEnter,
  onVoiceRecordingStart,
  onVoiceRecordingFinish,
  onVoiceRecordingCancel,
  attachmentDrafts = [],
  hasReadyAttachment = false,
  isPreparingAttachment = false,
  onRemoveAttachment,
  onImagePress,
  onCameraPress,
  onFilePress,
  onAttachPastedText,
  onStickerPress,
  onVideoCallPress,
  onTogetherListeningPress,
  disabled = false,
  disabledPlaceholder = '当前不可发送消息',
  disabledPressMessage,
  replyTo,
  onCancelReply,
  paddingBottom = 0,
  onLayout,
  moonKimiQuickActions = DEFAULT_MOON_KIMI_QUICK_ACTIONS,
  onMoonKimiQuickActionPress,
  activeSurface,
  onActiveSurfaceChange,
  surfaceHeight,
}: ChatInputAreaProps) {
  const theme = useTheme();
  const handleOverflowPaste = onAttachPastedText && !disabled
    ? (text: string | null) => {
      if (text == null) {
        showAppDialog({ title: '粘贴文本过长', message: `转为 TXT 最多支持 ${CHAT_TEXT_ATTACHMENT_MAX_LENGTH.toLocaleString('zh-CN')} 字符，请分段粘贴。`, tone: 'warning' });
        return;
      }
      void onAttachPastedText(text).catch((error: unknown) => {
        showAppDialog({ title: '附件处理失败', message: error instanceof Error ? error.message : '无法将粘贴文本转为 TXT', tone: 'error' });
      });
    }
    : undefined;
  const styles = useMemo(() => createInputAreaStyles(theme), [theme]);
  const isMoonKimi = isMoonKimiTheme(theme);
  const usesGlass = theme.effects.glass.enabled;
  const inputRef = useRef<TextInput | null>(null);
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [pendingSubmissions, setPendingSubmissions] = useState(0);
  const [isInvoking, setIsInvoking] = useState(false);
  const trackSubmission = useCallback(async (submit: () => Promise<unknown> | unknown) => {
    setPendingSubmissions(count => count + 1);
    try { return await submit(); }
    finally { setPendingSubmissions(count => count - 1); }
  }, []);
  const voiceButtonSizeRef = useRef({ width: 0, height: 0 });
  const shouldCancelVoiceRef = useRef(false);
  const [isCancellingVoice, setIsCancellingVoice] = useState(false);
  const voiceStartPromiseRef = useRef<Promise<boolean> | null>(null);
  const hasText = value.trim().length > 0;
  const hasAttachment = attachmentDrafts.length > 0;
  const hasFailedAttachment = attachmentDrafts.some((attachment) => attachment.status === 'failed');
  const canSend = !disabled && !isPreparingAttachment && !hasFailedAttachment && (hasText || hasReadyAttachment);
  const shouldShowSendButton = hasText || hasAttachment;

  const isEmojiPanelVisible = activeSurface === 'stickers';
  const isToolPanelVisible = activeSurface === 'tools';
  // starting 属于“已按下、还没出音频”的窗口（STT 建连 + 权限 + native 初始化），
  // 必须有即时反馈，否则长按到波形出现之间是完全空白的。
  const isVoiceFeedbackVisible =
    isVoiceMode
    && (
      voiceRecordingState === 'starting'
      || voiceRecordingState === 'recording'
      || voiceRecordingState === 'processing'
    );
  const shouldShowMoonKimiQuickActions =
    isMoonKimi &&
    !disabled &&
    activeSurface === 'none' &&
    moonKimiQuickActions.length > 0;

  const showDisabledMessage = useCallback(() => {
    if (disabledPressMessage) {
      showAppDialog({ title: '暂不可发送', message: disabledPressMessage, tone: 'warning' });
    }
  }, [disabledPressMessage]);

  const handleSend = () => {
    if (disabled) {
      showDisabledMessage();
      return;
    }
    if (!canSend) return;

    void trackSubmission(onSend);

    // Android Edge-to-Edge 模式下，延迟聚焦避免键盘动画冲突
    setTimeout(() => {
      inputRef.current?.focus();
    }, 100);
  };

  // 切换表情面板显示状态
  const toggleEmojiPanel = useCallback(() => {
    if (isEmojiPanelVisible) {
      onActiveSurfaceChange('none');
    } else {
      inputRef.current?.blur();
      Keyboard.dismiss();
      onActiveSurfaceChange('stickers');
    }
  }, [isEmojiPanelVisible, onActiveSurfaceChange]);

  // 切换工具面板显示状态
  const toggleToolPanel = useCallback(() => {
    if (isToolPanelVisible) {
      onActiveSurfaceChange('none');
    } else {
      inputRef.current?.blur();
      Keyboard.dismiss();
      onActiveSurfaceChange('tools');
    }
  }, [isToolPanelVisible, onActiveSurfaceChange]);

  const handleInputFocus = useCallback(() => {
    onActiveSurfaceChange('keyboard');
  }, [onActiveSurfaceChange]);

  const beginVoicePress = useCallback(() => {
    // 只允许从 idle 发起一次新录音。starting 期间（pending start）重复 grant
    // 必须忽略，否则会有第二次 start 与第一次抢同一个 recording 所有权。
    if (
      !onVoiceRecordingStart
      || voiceStartPromiseRef.current
      || voiceRecordingState !== 'idle'
    ) {
      return;
    }
    shouldCancelVoiceRef.current = false;
    setIsCancellingVoice(false);
    voiceStartPromiseRef.current = onVoiceRecordingStart();
  }, [onVoiceRecordingStart, voiceRecordingState]);

  const leaveVoiceMode = useCallback(() => {
    // 退出语音模式属于正式取消：recording 要停掉，pending start（starting）也要作废，
    // 否则旧启动完成后录音会继续在已经退出的语音模式之外存在。
    const hasPendingStart = voiceStartPromiseRef.current !== null;
    voiceStartPromiseRef.current = null;
    if (
      voiceRecordingState === 'recording'
      || voiceRecordingState === 'starting'
      || hasPendingStart
    ) {
      void onVoiceRecordingCancel?.();
    }
    setIsVoiceMode(false);
  }, [onVoiceRecordingCancel, voiceRecordingState]);

  const endVoicePress = useCallback(() => {
    const started = voiceStartPromiseRef.current;
    voiceStartPromiseRef.current = null;
    if (!started) return;
    const shouldCancel = shouldCancelVoiceRef.current;
    void started.then(async (didStart) => {
      if (!didStart) return;
      if (shouldCancel) await onVoiceRecordingCancel?.();
      else await onVoiceRecordingFinish?.();
    });
  }, [onVoiceRecordingCancel, onVoiceRecordingFinish]);

  const handleStickerPress = useCallback((sticker: StickerMessageSnapshot) => {
    onActiveSurfaceChange('none');
    void trackSubmission(() => onStickerPress?.(sticker)).catch((error) => {
      showAppDialog({ title: '表情包发送失败', message: error instanceof Error ? error.message : '发送表情包失败', tone: 'error' });
    });
  }, [onActiveSurfaceChange, onStickerPress, trackSubmission]);

  const runAttachmentAction = useCallback(async (
    action: (() => Promise<unknown> | unknown) | undefined,
    fallbackMessage: string
  ) => {
    if (!action) {
      return;
    }

    onActiveSurfaceChange('none');
    try {
      await action();
    } catch (error) {
      showAppDialog({ title: '附件处理失败', message: error instanceof Error ? error.message : fallbackMessage, tone: 'error' });
    }
  }, [onActiveSurfaceChange]);

  const handleImagePress = useCallback(() => {
    void runAttachmentAction(onImagePress, '选择图片失败');
  }, [onImagePress, runAttachmentAction]);

  const handleCameraPress = useCallback(() => {
    void runAttachmentAction(onCameraPress, '拍照失败');
  }, [onCameraPress, runAttachmentAction]);

  const handleFilePress = useCallback(() => {
    void runAttachmentAction(onFilePress, '选择文件失败');
  }, [onFilePress, runAttachmentAction]);

  const handleVideoCallPress = useCallback(() => {
    if (!onVideoCallPress) {
      return;
    }

    onActiveSurfaceChange('none');
    void Promise.resolve(onVideoCallPress()).catch((error) => {
      showAppDialog({ title: '视频电话失败', message: error instanceof Error ? error.message : '发起视频电话失败', tone: 'error' });
    });
  }, [onActiveSurfaceChange, onVideoCallPress]);

  const handleTogetherListeningPress = useCallback(() => {
    if (!onTogetherListeningPress) {
      return;
    }

    onActiveSurfaceChange('none');
    void Promise.resolve(onTogetherListeningPress()).catch((error) => {
      showAppDialog({ title: '一起听失败', message: error instanceof Error ? error.message : '发起一起听失败', tone: 'error' });
    });
  }, [onActiveSurfaceChange, onTogetherListeningPress]);

  const enterVoiceMode = useCallback(() => {
    void (async () => {
      inputRef.current?.blur();
      Keyboard.dismiss();
      onActiveSurfaceChange('none');
      // 进入语音模式前先做麦克风权限 preflight：权限被拒时立刻给出可见错误，
      // 而不是让用户先长按一次才发现麦克风入口“像坏掉”。
      // STT session 不在这里建立，仍然只在真正准备录音时创建。
      if (onVoiceModeEnter && !(await onVoiceModeEnter())) {
        return;
      }
      setIsVoiceMode(true);
    })();
  }, [onActiveSurfaceChange, onVoiceModeEnter]);

  // 输入行保持透明，输入框和独立按钮各自采样聊天玻璃场景。
  const glassButtonTouchTarget = usesGlass && styles.glassButtonTouchTarget;
  const renderButton = (button: React.ReactElement) => usesGlass ? (
    <ThemedSurface
      variant="inputBar"
      cornerRadius={GLASS_COMPOSER_CONTROL_SIZE / 2}
      style={styles.glassButton}
    >
      {button}
    </ThemedSurface>
  ) : button;
  // 单聊和群聊共用此入口，各种输入形态只负责将它放到自己的操作栏。
  const invokeDisabled = disabled || isPreparingAttachment || hasFailedAttachment || pendingSubmissions > 0 || isInvoking;
  const replyButtonStyle = [
    isMoonKimi ? styles.moonKimiInputIconButton : styles.iconButton,
    usesGlass && (voiceReviewDraft ? styles.glassButtonTouchTarget : styles.glassFieldReplyButton),
  ];
  const replyStopButton = onStopReply ? (
    <TouchableOpacity
      style={replyButtonStyle}
      onPress={onStopReply}
      disabled={isStoppingReply}
      accessibilityRole="button"
      accessibilityLabel="终止回复"
      accessibilityState={{ disabled: isStoppingReply, busy: isStoppingReply }}
    >
      <Ionicons name="stop-circle" size={26} color={theme.colors.icon.primary} />
    </TouchableOpacity>
  ) : onInvoke ? (
    <TouchableOpacity style={replyButtonStyle}
      accessibilityRole="button" accessibilityLabel="召唤回复" disabled={invokeDisabled}
      accessibilityState={{ disabled: invokeDisabled, busy: isInvoking }}
      onPress={() => {
        setIsInvoking(true);
        void Promise.resolve(onInvoke()).catch(error => {
          showAppDialog({ title: '召唤失败', message: error instanceof Error ? error.message : '请求失败', tone: 'error' });
        }).finally(() => setIsInvoking(false));
      }}>
      <CirclePlay size={26} strokeWidth={1.5} color={invokeDisabled ? theme.colors.icon.secondary : theme.colors.icon.primary} />
    </TouchableOpacity>
  ) : null;
  const renderField = (field: React.ReactElement) => usesGlass ? (
    <ThemedSurface
      variant="inputBar"
      cornerRadius={GLASS_COMPOSER_CONTROL_SIZE / 2}
      style={styles.glassField}
    >
      {field}
      {replyStopButton}
    </ThemedSurface>
  ) : field;

  return (
    <View style={styles.container} onLayout={onLayout}>
      {isVoiceFeedbackVisible && (
        <ChatVoiceRecordingFeedback
          level={voiceRecordingProgress.level}
          isPreparing={voiceRecordingState === 'starting'}
          isCancelling={isCancellingVoice && voiceRecordingState !== 'processing'}
          isProcessing={voiceRecordingState === 'processing'}
        />
      )}
      {replyTo ? (
        <View style={styles.replyPreviewContainer}>
          <View style={styles.replyPreviewTextContainer}>
            <Text style={styles.replyPreviewText} numberOfLines={1}>
              {replyTo.text}
            </Text>
          </View>
          <TouchableOpacity onPress={onCancelReply} style={styles.replyCancelBtn}>
            <Ionicons name="close-circle" size={25} color={theme.colors.background.app} />
          </TouchableOpacity>
        </View>
      ) : null}

      <ChatAttachmentComposerTray attachments={attachmentDrafts} onRemove={onRemoveAttachment} />

      {/* 语音录制 / STT 的即时失败提示。输入区在会话始终挂载，因此这里的错误
          与「历史消息加载失败」独立，不依赖 messages.length === 0。 */}
      {voiceRecordingError ? (
        <TouchableOpacity
          style={styles.voiceErrorBanner}
          activeOpacity={0.8}
          onPress={onDismissVoiceRecordingError}
        >
          <Ionicons name="alert-circle-outline" size={16} color={theme.colors.feedback.error} />
          <Text style={styles.voiceErrorText}>{voiceRecordingError}</Text>
        </TouchableOpacity>
      ) : null}

      {/* 发送前校对面板优先于录音条与普通输入：reviewing / committing 期间
          输入区只服务于这一条尚未提交的语音，避免出现“一边校对一边又发别的东西”。 */}
      {voiceReviewDraft ? (
        <ChatVoiceReviewPanel
          draft={voiceReviewDraft}
          isCommitting={voiceRecordingState === 'committing'}
          onChangeTranscript={onVoiceReviewTranscriptChange ?? (() => undefined)}
          onSend={() => { void onVoiceReviewSend?.(); }}
          onCancel={() => { void onVoiceReviewCancel?.(); }}
          replyStopButton={replyStopButton && renderButton(replyStopButton)}
          paddingBottom={paddingBottom}
          styles={styles}
          theme={theme}
        />
      ) : isVoiceMode ? (
        <View style={[styles.inputContainer, { paddingBottom }]}>
          {renderButton(
            <TouchableOpacity
              style={[styles.voiceButton, glassButtonTouchTarget]}
              onPress={leaveVoiceMode}
              accessibilityRole="button"
              accessibilityLabel="切换到键盘"
            >
              <KeyboardIcon size={24} color={theme.colors.icon.primary} />
            </TouchableOpacity>
          )}
          {renderField(<View
            style={[styles.input, { alignItems: 'center', justifyContent: 'center' }]}
            onLayout={(event) => { voiceButtonSizeRef.current = event.nativeEvent.layout; }}
            onStartShouldSetResponder={() => !disabled && voiceRecordingState === 'idle'}
            onResponderGrant={beginVoicePress}
            onResponderRelease={endVoicePress}
            onResponderTerminate={() => {
              shouldCancelVoiceRef.current = true;
              endVoicePress();
            }}
            onResponderMove={(event) => {
              const { locationX, locationY } = event.nativeEvent;
              const { width, height } = voiceButtonSizeRef.current;
              const nextCancelling = locationX < 0 || locationY < 0 || locationX > width || locationY > height;
              shouldCancelVoiceRef.current = nextCancelling;
              // move 事件频率很高，只在越界状态真正翻转时更新，避免整条输入区反复重渲染。
              setIsCancellingVoice((previous) => (previous === nextCancelling ? previous : nextCancelling));
            }}
          >
            <Text style={{ color: theme.colors.text.primary, textAlign: 'center' }}>
              {voiceRecordingState === 'processing'
                ? '识别中…'
                : voiceRecordingState === 'starting'
                  ? '正在准备录音…'
                  : voiceRecordingState === 'recording'
                    ? isCancellingVoice ? '松开取消，移回继续' : '松开发送，滑出取消'
                    : '按住说话'}
            </Text>
          </View>)}
          {!usesGlass && replyStopButton}
        </View>
      ) : isMoonKimi ? (
        <MoonKimiComposer
          actions={moonKimiQuickActions}
          allowDisabledPress={Boolean(disabled && disabledPressMessage)}
          canSend={canSend}
          disabled={disabled}
          disabledPlaceholder={disabledPlaceholder}
          inputRef={inputRef}
          isInputSurfaceVisible={activeSurface !== 'none'}
          isPreparingAttachment={isPreparingAttachment}
          isToolPanelVisible={isToolPanelVisible}
          onChangeText={onChangeText}
          onOverflowPaste={handleOverflowPaste}
          onDisabledPress={showDisabledMessage}
          onFocus={handleInputFocus}
          onQuickActionPress={onMoonKimiQuickActionPress}
          onSend={handleSend}
          onToggleToolPanel={toggleToolPanel}
          onVoiceModePress={enterVoiceMode}
          paddingBottom={paddingBottom}
          replyStopButton={replyStopButton}
          shouldShowQuickActions={shouldShowMoonKimiQuickActions}
          shouldShowSendButton={shouldShowSendButton}
          styles={styles}
          theme={theme}
          value={value}
        />
      ) : (
        <View style={[styles.inputContainer, { paddingBottom }]}>
          {renderButton(
            <TouchableOpacity
              style={[styles.voiceButton, glassButtonTouchTarget]}
              onPress={enterVoiceMode}
              accessibilityRole="button"
              accessibilityLabel="切换到语音"
            >
              <Ionicons name="mic-outline" size={26} color={theme.colors.icon.primary} />
            </TouchableOpacity>
          )}
          {renderField(<ChatComposerTextInput
            ref={inputRef}
            style={usesGlass && replyStopButton ? [styles.input, styles.glassInputWithReplyButton] : styles.input}
            value={value}
            onChangeText={onChangeText}
            placeholder={disabled ? disabledPlaceholder : ''}
            placeholderTextColor={theme.colors.text.tertiary}
            onOverflowPaste={handleOverflowPaste}
            autoGrow
            textAlignVertical={usesGlass ? 'center' : 'top'}
            scrollEnabled
            editable={!disabled}
            blurOnSubmit={false}
            onPressIn={() => {
              if (disabled) {
                showDisabledMessage();
              }
            }}
            onFocus={handleInputFocus}
          />)}

          <View style={styles.rightActions}>
            {!usesGlass && replyStopButton}
            {shouldShowSendButton ? renderButton(
              <ChatSendButton
                size={23}
                isDisabled={!canSend}
                isPreparing={isPreparingAttachment}
                onPress={handleSend}
                keepPressableWhenDisabled={disabled && Boolean(disabledPressMessage)}
                style={[styles.sendButton, glassButtonTouchTarget]}
                theme={theme}
              />
            ) : (
              <>
                {renderButton(
                  <TouchableOpacity
                    style={[styles.iconButton, isEmojiPanelVisible && styles.iconButtonActive, glassButtonTouchTarget]}
                    onPress={toggleEmojiPanel}
                    accessibilityRole="button"
                    accessibilityLabel="表情包"
                  >
                    <Ionicons
                      name={isEmojiPanelVisible ? "happy" : "happy-outline"}
                      size={26}
                      color={isEmojiPanelVisible ? theme.colors.text.primary : theme.colors.icon.primary}
                    />
                  </TouchableOpacity>
                )}
                {renderButton(
                  <TouchableOpacity
                    style={[styles.iconButton, isToolPanelVisible && styles.iconButtonActive, glassButtonTouchTarget]}
                    onPress={toggleToolPanel}
                    accessibilityRole="button"
                    accessibilityLabel="功能面板"
                  >
                    <Ionicons
                      name={isToolPanelVisible ? "add-circle" : "add-circle-outline"}
                      size={26}
                      color={isToolPanelVisible ? theme.colors.text.primary : theme.colors.icon.primary}
                    />
                  </TouchableOpacity>
                )}
              </>
            )}
          </View>
        </View>
      )}

      {/* 表情面板 */}
      {isEmojiPanelVisible && (
        <ChatEmojiPanel
          height={surfaceHeight}
          onStickerPress={handleStickerPress}
        />
      )}

      {/* 工具面板 */}
      {isToolPanelVisible && (
        <ChatToolPanel
          height={surfaceHeight}
          onImagePress={handleImagePress}
          onCameraPress={handleCameraPress}
          onFilePress={handleFilePress}
          onVideoCallPress={onVideoCallPress ? handleVideoCallPress : undefined}
          onTogetherListeningPress={resolveTogetherListeningToolPanelHandler(
            onTogetherListeningPress,
            handleTogetherListeningPress,
          )}
        />
      )}
    </View>
  );
}
