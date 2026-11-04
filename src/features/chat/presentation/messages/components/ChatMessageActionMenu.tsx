/** 消息长按菜单按实际能力启用操作，单条分享复用完整轮次选择。 */

import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Check, History, Pin, PinOff, Star, Sticker, TextSelect } from 'lucide-react-native';
import { useTheme } from '@shared/theme';
import type { ChatStickerAction } from './useChatStickerAction';

interface ChatMessageActionMenuProps {
  visible: boolean;
  onClose: () => void;
  position?: { x: number; y: number } | null;
  onCopy?: () => void;
  onSelectText?: () => void;
  onForward?: () => void;
  onRewrite?: () => void;
  onRegenerate?: () => void;
  onHistory?: () => void;
  onDelete?: () => void;
  onMultiSelect?: () => void;
  onQuote?: () => void;
  onTranslate?: () => void;
  onFavorite?: () => void;
  isFavorited?: boolean;
  stickerAction?: ChatStickerAction | null;
  onToggleVoiceTranscript?: () => void;
  isVoiceTranscriptExpanded?: boolean;
  onFixedStart?: () => void;
  isFixedStart?: boolean;
}

type ActionItem = {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
};

const BUTTON_WIDTH = 58;
const BUTTON_HEIGHT = 62;
const MENU_PADDING_VERTICAL = 10;

function ChatMessageActionMenu({
  visible,
  onClose,
  position,
  onCopy,
  onSelectText,
  onForward,
  onRewrite,
  onRegenerate,
  onHistory,
  onDelete,
  onMultiSelect,
  onQuote,
  onTranslate,
  onFavorite,
  isFavorited = false,
  stickerAction,
  onToggleVoiceTranscript,
  isVoiceTranscriptExpanded = false,
  onFixedStart,
  isFixedStart = false,
}: ChatMessageActionMenuProps) {
  const theme = useTheme();
  const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = useWindowDimensions();

  // 通用槽位保持顺序，表情专属操作追加到末尾，避免原有操作跳位。
  const actions: ActionItem[] = [
    { key: 'copy', label: '复制', icon: 'copy-outline', onPress: onCopy },
    { key: 'selectText', label: '选择文字', icon: 'text-outline', onPress: onSelectText },
    { key: 'rewrite', label: '改写', icon: 'pencil-outline', onPress: onRewrite },
    { key: 'rewriteAI', label: '重写', icon: 'reload-outline', onPress: onRegenerate },
    { key: 'history', label: '历史版本', icon: 'time-outline', onPress: onHistory },
    { key: 'delete', label: '删除', icon: 'trash-outline', onPress: onDelete },
    { key: 'multi', label: '多选', icon: 'list-outline', onPress: onMultiSelect },
    { key: 'fixedStart', label: isFixedStart ? '取消固定' : '固定', icon: 'pin-outline', onPress: onFixedStart },
    {
      key: 'voiceTranscript',
      label: isVoiceTranscriptExpanded ? '收起文字' : '转文字',
      icon: 'document-text-outline',
      onPress: onToggleVoiceTranscript,
    },
    { key: 'quote', label: '引用', icon: 'return-up-back-outline', onPress: onQuote },
    { key: 'translate', label: '翻译', icon: 'language-outline', onPress: onTranslate },
    { key: 'forward', label: '分享', icon: 'arrow-redo-outline', onPress: onForward },
    { key: 'favorite', label: isFavorited ? '已收藏' : '收藏', icon: 'star-outline', onPress: onFavorite },
  ];

  if (stickerAction) actions.push({
    key: 'addSticker', label: stickerAction.isAdded ? '已添加' : '添加表情包',
    icon: 'happy-outline', onPress: stickerAction.add,
  });

  if (!actions.some((item) => item.onPress)) return null;

  const columns = Math.max(1, Math.min(5, Math.floor((SCREEN_WIDTH - 24) / BUTTON_WIDTH), actions.length));
  const rows: ActionItem[][] = [];
  for (let index = 0; index < actions.length; index += columns) rows.push(actions.slice(index, index + columns));
  const menuWidth = columns * BUTTON_WIDTH;
  const menuHeight = BUTTON_HEIGHT * rows.length + rows.length - 1 + MENU_PADDING_VERTICAL * 2;

  const computePosition = () => {
    if (!position) {
      return { top: SCREEN_HEIGHT / 2 - menuHeight / 2, left: SCREEN_WIDTH / 2 - menuWidth / 2 };
    }

    let left = position.x - menuWidth / 2;
    if (left < 12) left = 12;
    if (left + menuWidth > SCREEN_WIDTH - 12) left = SCREEN_WIDTH - 12 - menuWidth;

    const isUpperHalf = position.y < SCREEN_HEIGHT / 2;
    const MIN_MARGIN = 40;

    let top: number;
    if (isUpperHalf) {
      top = position.y + MIN_MARGIN;
      if (top + menuHeight > SCREEN_HEIGHT - MIN_MARGIN) {
        top = SCREEN_HEIGHT - menuHeight - MIN_MARGIN;
      }
    } else {
      top = position.y - menuHeight - MIN_MARGIN;
      if (top < MIN_MARGIN) {
        top = MIN_MARGIN;
      }
    }

    return { top, left };
  };

  const { top, left } = computePosition();

  const renderActionButton = (item: ActionItem) => {
    const action = item.onPress;
    return (
      <TouchableOpacity
        key={item.key}
        style={[styles.actionButton, !action && styles.disabledActionButton]}
        activeOpacity={0.6}
        accessibilityRole="button"
        accessibilityLabel={item.label}
        accessibilityState={{ disabled: !action, ...(item.key === 'favorite'
          ? { selected: isFavorited }
          : item.key === 'addSticker' ? { selected: stickerAction!.isAdded } : {}) }}
        disabled={!action}
        onPress={action ? () => { action(); onClose(); } : undefined}
      >
        {item.key === 'addSticker'
          ? (stickerAction!.isAdded
            ? <Check size={22} color={theme.colors.brand.onPrimary} />
            : <Sticker size={22} color={theme.colors.brand.onPrimary} />)
          : item.key === 'selectText' ? <TextSelect size={22} color={theme.colors.brand.onPrimary} /> : item.key === 'history' ? <History size={22} color={theme.colors.brand.onPrimary} /> : item.key === 'favorite' ? <Star size={22} color={theme.colors.brand.onPrimary} fill={isFavorited ? theme.colors.brand.onPrimary : 'none'} /> : item.key === 'fixedStart'
          ? (isFixedStart ? <PinOff size={22} color={theme.colors.brand.onPrimary} /> : <Pin size={22} color={theme.colors.brand.onPrimary} />)
          : <Ionicons name={item.icon} size={22} color={theme.colors.brand.onPrimary} />}
        <Text style={[styles.actionLabel, { color: theme.colors.brand.onPrimary }]}>{item.label}</Text>
      </TouchableOpacity>
    );
  };

  // dark 模式下用比聊天背景稍亮的颜色，避免融为一体；light 保持深色菜单风格
  const menuBackground = theme.mode === 'dark'
    ? theme.colors.surface.muted
    : theme.colors.text.primary;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View style={[styles.menuContainer, { top, left, width: menuWidth, backgroundColor: menuBackground }]}>
              {rows.map((row, index) => <React.Fragment key={index}>
                {index > 0 ? <View style={[styles.horizontalDivider, { backgroundColor: theme.colors.border.strong }]} /> : null}
                <View style={styles.row}>{row.map(renderActionButton)}</View>
              </React.Fragment>)}
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

export default React.memo(ChatMessageActionMenu);

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  menuContainer: {
    position: 'absolute',
    borderRadius: 2,
    overflow: 'hidden',
    paddingVertical: MENU_PADDING_VERTICAL,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
  },
  actionButton: {
    width: BUTTON_WIDTH,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabledActionButton: {
    opacity: 0.45,
  },
  actionLabel: {
    marginTop: 5,
    fontSize: 10,
    fontWeight: '400',
  },

  horizontalDivider: {
    height: 1,
    marginHorizontal: 10,
  },
});
