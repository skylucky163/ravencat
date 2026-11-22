/** Moon Kimi 主题专属的快捷操作与输入栏。 */

import React from 'react';
import {
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { CirclePlus, WifiHigh, type LucideIcon } from 'lucide-react-native';

import type { PresentationTheme } from '@shared/theme';
import type { createInputAreaStyles } from './chatInputStyles';
import { ChatSendButton } from './ChatSendButton';
import { ChatComposerTextInput, type OverflowPasteHandler } from './ChatComposerTextInput';

type InputAreaStyles = ReturnType<typeof createInputAreaStyles>;

export interface MoonKimiQuickAction {
  id: string;
  label: string;
  Icon: LucideIcon;
}

interface MoonKimiComposerProps {
  actions: MoonKimiQuickAction[];
  allowDisabledPress: boolean;
  canSend: boolean;
  disabled: boolean;
  disabledPlaceholder: string;
  inputRef: React.RefObject<TextInput | null>;
  isInputSurfaceVisible: boolean;
  isPreparingAttachment: boolean;
  isToolPanelVisible: boolean;
  onChangeText: (text: string) => void;
  onOverflowPaste?: OverflowPasteHandler;
  onDisabledPress: () => void;
  onFocus: () => void;
  onQuickActionPress?: (action: MoonKimiQuickAction) => void;
  onSend: () => void;
  onToggleToolPanel: () => void;
  onVoiceModePress: () => void;
  paddingBottom: number;
  replyStopButton?: React.ReactNode;
  shouldShowQuickActions: boolean;
  shouldShowSendButton: boolean;
  styles: InputAreaStyles;
  theme: PresentationTheme;
  value: string;
}

export function MoonKimiComposer({
  actions,
  allowDisabledPress,
  canSend,
  disabled,
  disabledPlaceholder,
  inputRef,
  isInputSurfaceVisible,
  isPreparingAttachment,
  isToolPanelVisible,
  onChangeText,
  onOverflowPaste,
  onDisabledPress,
  onFocus,
  onQuickActionPress,
  onSend,
  onToggleToolPanel,
  onVoiceModePress,
  paddingBottom,
  replyStopButton,
  shouldShowQuickActions,
  shouldShowSendButton,
  styles,
  theme,
  value,
}: MoonKimiComposerProps) {
  return (
    <>
      {shouldShowQuickActions ? (
        <View style={styles.moonKimiQuickActionsContainer}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.moonKimiQuickActionsContent}
          >
            {actions.map((action) => (
              <TouchableOpacity
                key={action.id}
                style={styles.moonKimiQuickAction}
                onPress={() => onQuickActionPress?.(action)}
                disabled={!onQuickActionPress}
                activeOpacity={0.78}
              >
                <action.Icon size={17} strokeWidth={1.65} color={theme.colors.icon.primary} />
                <Text style={styles.moonKimiQuickActionText}>{action.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      ) : null}

      <View style={[styles.inputContainer, styles.moonKimiInputContainer, { paddingBottom }]}>
        <View style={styles.moonKimiInputBar}>
          <TouchableOpacity style={styles.moonKimiVoiceButton} onPress={onVoiceModePress}>
            <WifiHigh
              size={20}
              strokeWidth={2}
              color={theme.colors.icon.primary}
              // 字形墨量在画布里偏上，旋转后变成水平偏移；rotate 后的 translateY 即屏幕左右方向
              style={{ transform: [{ rotate: '90deg' }, { translateY: -1 }] }}
            />
          </TouchableOpacity>
          <ChatComposerTextInput
            ref={inputRef}
            style={styles.moonKimiInput}
            value={value}
            onChangeText={onChangeText}
            placeholder={disabled ? disabledPlaceholder : '尽管问，带图也行'}
            placeholderTextColor={theme.colors.text.tertiary}
            onOverflowPaste={onOverflowPaste}
            autoGrow
            textAlignVertical="center"
            scrollEnabled
            editable={!disabled}
            blurOnSubmit={false}
            onPressIn={disabled ? onDisabledPress : undefined}
            onFocus={onFocus}
          />
          {replyStopButton}
          <TouchableOpacity
            style={[
              styles.moonKimiInputIconButton,
              isToolPanelVisible && styles.iconButtonActive,
              { marginRight: theme.spacing.xs },
            ]}
            onPress={onToggleToolPanel}
          >
            <CirclePlus
              size={26}
              strokeWidth={1.65}
              color={isToolPanelVisible ? theme.colors.text.primary : theme.colors.icon.primary}
            />
          </TouchableOpacity>
          {shouldShowSendButton ? (
            <ChatSendButton
              size={23}
              isDisabled={!canSend}
              isPreparing={isPreparingAttachment}
              onPress={onSend}
              keepPressableWhenDisabled={allowDisabledPress}
              style={styles.moonKimiSendButton}
              theme={theme}
            />
          ) : null}
        </View>
        {!isInputSurfaceVisible ? (
          <Text style={styles.moonKimiDisclaimer}>内容由 AI 生成</Text>
        ) : null}
      </View>
    </>
  );
}
