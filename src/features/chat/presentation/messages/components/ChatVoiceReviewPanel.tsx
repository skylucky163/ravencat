/** 语音消息发送前的校对面板：展示 STT 结果、允许编辑、发送或取消。 */

import React from 'react';
import {
  ActivityIndicator,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppTextInput } from '@shared/ui';

import type { PresentationTheme } from '@shared/theme';
import type { createInputAreaStyles } from './chatInputStyles';
import type { ChatVoiceMessageReviewDraft } from './chatTypes';

type InputAreaStyles = ReturnType<typeof createInputAreaStyles>;

interface ChatVoiceReviewPanelProps {
  draft: ChatVoiceMessageReviewDraft;
  /** 是否正在提交（committing）：提交期间禁止重复发送与再次编辑。 */
  isCommitting: boolean;
  onChangeTranscript: (transcript: string) => void;
  onSend: () => void;
  onCancel: () => void;
  paddingBottom: number;
  replyStopButton?: React.ReactNode;
  styles: InputAreaStyles;
  theme: PresentationTheme;
}

/**
 * 发送前校对面板。
 *
 * 这不是一个独立页面，而是输入区在 `reviewing` 状态下的替换形态：同一个输入区
 * 位置，展示“语音识别结果”、可编辑文本、录音时长、取消与发送。
 *
 * 关键约束：此时 **还没有任何 canonical Chat message**。用户看到的一切都来自
 * 尚未提交的 draft；点“取消”就是彻底丢弃，点“发送”才会提交并触发 AI 回复。
 */
export function ChatVoiceReviewPanel({
  draft,
  isCommitting,
  onChangeTranscript,
  onSend,
  onCancel,
  paddingBottom,
  replyStopButton,
  styles,
  theme,
}: ChatVoiceReviewPanelProps) {
  const canSend = draft.transcript.trim().length > 0 && !isCommitting;

  return (
    <View style={[styles.voiceReviewContainer, { paddingBottom }]}>
      <View style={styles.voiceReviewHeader}>
        <Ionicons name="mic-outline" size={16} color={theme.colors.text.secondary} />
        <Text style={styles.voiceReviewTitle}>语音识别结果</Text>
        <Text style={styles.voiceReviewDuration}>{formatDuration(draft.durationMs)}</Text>
      </View>

      <AppTextInput
        style={styles.voiceReviewInput}
        value={draft.transcript}
        onChangeText={onChangeTranscript}
        placeholder="没有识别到内容，可以手动输入"
        placeholderTextColor={theme.colors.text.tertiary}
        autoGrow
        textAlignVertical="top"
        scrollEnabled
        editable={!isCommitting}
        autoFocus={false}
      />

      <View style={styles.voiceReviewActions}>
        {replyStopButton}
        <TouchableOpacity
          style={[styles.voiceReviewButton, styles.voiceReviewCancelButton]}
          onPress={onCancel}
          disabled={isCommitting}
          activeOpacity={0.75}
        >
          <Text style={[styles.voiceReviewButtonText, { color: theme.colors.text.secondary }]}>
            取消
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.voiceReviewButton,
            styles.voiceReviewSendButton,
            !canSend && styles.voiceReviewSendButtonDisabled,
          ]}
          onPress={onSend}
          disabled={!canSend}
          activeOpacity={0.75}
        >
          {isCommitting ? (
            <ActivityIndicator size="small" color={theme.colors.icon.inverse} />
          ) : (
            <Text style={[styles.voiceReviewButtonText, { color: theme.colors.icon.inverse }]}>
              发送
            </Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(durationMs / 1_000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}
