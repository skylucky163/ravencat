import { getAssistantDisplayName } from '../../AssistantNickname';
import React, { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, type ListRenderItemInfo, type GestureResponderEvent, Dimensions, Modal, TouchableWithoutFeedback, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Pin } from 'lucide-react-native';

import type { AIProfile } from '../../domain/AIProfile';
import type { GroupChat } from '@features/chat';
import { GlassSurface, ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import EmptyState from '@shared/ui/EmptyState';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { formatChatTime } from '@shared/utils/timeFormat';
import { AIAvatar, GroupAvatar, useFloatingTabBarScrollPadding, showAppDialog } from '@shared/ui';
import {
  buildConversationListItems,
  type ConversationListItem,
} from './conversationListItems';

export type { ConversationListItem } from './conversationListItems';

/** 置顶目标：与 Chat 的 ConversationKind 同构，presentation 只表达身份。 */
export interface ConversationListPinTarget {
  kind: 'direct' | 'group';
  id: string;
}

interface ConversationListProps {
  aiList: AIProfile[];
  groupChats?: GroupChat[];
  /** 只覆盖摘要的文字草稿，键为 canonical conversation ID。 */
  textDrafts?: Readonly<Record<string, string>>;
  onSelectAI: (ai: AIProfile) => void | Promise<void>;
  onSelectGroup?: (group: GroupChat) => void | Promise<void>;
  onAddAI: (() => void) | null | undefined;
  onCreateGroup?: (() => void) | null | undefined;
  /** 切换置顶。列表不自己写库，也不自己排序，只表达用户意图。 */
  onTogglePinned?: (
    target: ConversationListPinTarget,
    pinned: boolean,
  ) => void | Promise<void> | null;
  onRefresh: () => void | Promise<unknown>;
  unreadMessages?: Record<string, number>;
}

interface MenuItem {
  key: string;
  label: string;
  icon: ReactNode;
  onPress: () => void;
}

type MenuState =
  | { target: 'header' }
  | { target: 'item'; item: ConversationListItem; pageY: number };

const MENU_WIDTH = 160;
const MENU_TOP = 80;
const MENU_ESTIMATED_HEIGHT = 120;

const createStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    tabContainer: {
      flex: 1,
      backgroundColor: theme.colors.background.app,
    },
    aiList: {
      flex: 1,
      backgroundColor: theme.colors.background.app,
    },
    listContent: {
      paddingTop: theme.effects.glass.enabled ? theme.spacing.sm : 0,
    },
    aiItem: theme.effects.glass.enabled ? {
      marginHorizontal: theme.spacing.lg,
      marginVertical: theme.spacing.xs,
      borderRadius: theme.radius.lg,
      overflow: 'hidden',
    } : {
      backgroundColor: theme.colors.background.app,
      borderBottomWidth: 0.5,
      borderBottomColor: theme.colors.border.light,
    },
    aiItemUnread: {
      backgroundColor: theme.colors.surface.muted,
    },
    aiItemBlocked: {
      opacity: 0.6,
    },
    aiRow: {
      flexDirection: 'row',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.lg,
      alignItems: 'center',
    },
    avatarWrapper: {
      position: 'relative',
      marginRight: theme.spacing.lg,
    },
    // 列表头像保持透明底，不在列表表面上叠加额外底色。
    listAvatar: {
      backgroundColor: 'transparent',
    },
    contentWrapper: {
      flex: 1,
      justifyContent: 'center',
    },
    headerRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 4,
    },
    nameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
      marginRight: theme.spacing.md,
    },
    aiName: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text.primary,
      marginRight: 8,
    },
    aiNameUnread: {
      fontWeight: '600',
    },
    pinnedMark: {
      marginRight: 6,
    },
    blockedTag: {
      backgroundColor: theme.colors.feedback.error + '15',
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: theme.radius.sm,
      marginRight: 6,
    },
    blockedTagText: {
      fontSize: 10,
      color: theme.colors.feedback.error,
      fontWeight: '600',
    },
    aiTime: {
      fontSize: 12,
      color: theme.colors.text.tertiary,
      flexShrink: 0,
    },
    previewRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    aiPreview: {
      fontSize: 14,
      color: theme.colors.text.secondary,
      flex: 1,
      marginRight: theme.spacing.md,
    },
    aiPreviewUnread: {
      color: theme.colors.text.primary,
    },
    unreadBadge: {
      minWidth: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: theme.colors.feedback.error,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 6,
    },
    unreadBadgeText: {
      fontSize: 11,
      fontWeight: '600',
      color: theme.colors.brand.onPrimary,
    },
    menuOverlay: {
      flex: 1,
      backgroundColor: 'transparent',
    },
    menuWrapper: {
      position: 'absolute',
    },
    menuContent: {
      width: MENU_WIDTH,
      // 玻璃主题下底色由 GlassSurface 提供，避免半透明白膜与玻璃层叠加。
      ...(theme.effects.glass.enabled
        ? {}
        : { backgroundColor: theme.colors.background.elevated }),
      borderRadius: theme.radius.sm,
      overflow: 'hidden',
      paddingVertical: 6,
      shadowColor: theme.shadow.md.shadowColor,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.25,
      shadowRadius: 8,
      elevation: 5,
    },
    menuItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    menuItemIcon: {
      marginRight: 10,
    },
    menuItemText: {
      fontSize: 14,
      color: theme.colors.text.primary,
      fontWeight: '400',
    },
    menuDivider: {
      height: 1,
      backgroundColor: theme.colors.border.light,
      marginHorizontal: 10,
    },
  });

/**
 * 构建统一会话列表项。
 *
 * 排序只调用共享的排序函数：pinned 分区 → 可见消息活动 → createdAt → id。
 * 这里不写任何比较逻辑，也不引入「最近打开」之类的额外状态。
 */

export default function ConversationList({
  aiList,
  groupChats = [],
  textDrafts = {},
  onSelectAI,
  onSelectGroup,
  onAddAI,
  onCreateGroup,
  onTogglePinned,
  onRefresh,
  unreadMessages = {},
}: ConversationListProps) {
  const displayList = useMemo<ConversationListItem[]>(
    () => buildConversationListItems({ aiList, groupChats }),
    [aiList, groupChats]
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuOpacity = useRef(new Animated.Value(0)).current;

  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const floatingTabBarScrollPadding = useFloatingTabBarScrollPadding();
  // 只有纸条主题的 TabBar 占据布局空间；其余主题均需为悬浮底栏预留滚动空间。
  const listPaddingBottom = theme.id === 'paper-note'
    ? 20
    : floatingTabBarScrollPadding;

  const animateMenuIn = useCallback(() => {
    menuOpacity.setValue(0);
    Animated.timing(menuOpacity, {
      toValue: 1,
      duration: 100,
      useNativeDriver: true,
    }).start();
  }, [menuOpacity]);

  const openHeaderMenu = useCallback(() => {
    setMenu({ target: 'header' });
    animateMenuIn();
  }, [animateMenuIn]);

  // 关闭不做淡出动画：elevation 灰影和原生玻璃层不跟随 JS 透明度，
  // 动画结束后再卸载会看到两层先后消失，直接整体卸载保证同一帧消失。
  const closeMenu = useCallback(() => {
    setMenu(null);
  }, []);

  const handleAddAIPress = useCallback(() => {
    closeMenu();
    onAddAI?.();
  }, [closeMenu, onAddAI]);

  const handleCreateGroupChat = useCallback(() => {
    closeMenu();
    onCreateGroup?.();
  }, [closeMenu, onCreateGroup]);

  const handleTogglePinned = useCallback((item: ConversationListItem) => {
    closeMenu();
    const toggle = onTogglePinned;
    if (!toggle) {
      return;
    }

    void Promise.resolve(toggle({ kind: item.kind, id: item.id }, !item.isPinned))
      .catch((error) => {
        showAppDialog({
          title: '设置失败',
          message: error instanceof Error ? error.message : '无法切换置顶状态', tone: 'error',
        });
      });
  }, [closeMenu, onTogglePinned]);

  const handleItemLongPress = useCallback((
    item: ConversationListItem,
    event: GestureResponderEvent,
  ) => {
    if (!onTogglePinned) {
      return;
    }
    setMenu({ target: 'item', item, pageY: event.nativeEvent.pageY });
    animateMenuIn();
  }, [animateMenuIn, onTogglePinned]);

  const headerMenuItems: MenuItem[] = [
    {
      key: 'addAI',
      label: '添加AI助手',
      icon: <Ionicons name="person-add-outline" size={18} color={theme.colors.brand.primary} />,
      onPress: handleAddAIPress,
    },
    {
      key: 'createGroup',
      label: '创建群聊',
      icon: <Ionicons name="chatbubbles-outline" size={18} color={theme.colors.brand.primary} />,
      onPress: handleCreateGroupChat,
    },
  ];

  // 长按菜单复用头部菜单的同一套 Modal / 玻璃层 / 样式，同一时刻只显示一个菜单。
  const menuItems: MenuItem[] = menu?.target === 'item'
    ? [{
        key: 'pin',
        label: menu.item.isPinned ? '取消置顶' : '置顶',
        icon: <Pin size={16} color={theme.colors.brand.primary} />,
        onPress: () => handleTogglePinned(menu.item),
      }]
    : headerMenuItems;

  const menuPositionStyle = useMemo(() => {
    if (menu?.target !== 'item') {
      return { top: MENU_TOP, right: 8 };
    }

    const windowHeight = Dimensions.get('window').height;
    const clampedTop = Math.min(
      Math.max(menu.pageY, MENU_TOP),
      Math.max(MENU_TOP, windowHeight - MENU_ESTIMATED_HEIGHT - 24),
    );
    return { top: clampedTop, right: 12 };
  }, [menu]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  }, [onRefresh]);

  const renderItem = useCallback(({ item }: ListRenderItemInfo<ConversationListItem>) => {
    const isGroupChat = item.kind === 'group';
    const name = isGroupChat ? item.group.name : getAssistantDisplayName(item.ai);
    const avatar = isGroupChat ? item.group.avatar : item.ai.avatar;
    const lastMessage = isGroupChat ? item.group.lastMessage : item.ai.lastMessage;
    const lastTime = isGroupChat ? item.group.lastTime : item.ai.lastTime;
    const conversationId = isGroupChat ? item.group.id : item.ai.canonicalConversationId;
    const draft = conversationId ? textDrafts[conversationId]?.replace(/\s+/g, ' ').trim() : '';
    const isBlocked = !isGroupChat && item.ai.isBlocked === true;
    const blockedUntil = !isGroupChat ? item.ai.blockedUntil : null;
    const unreadCount = unreadMessages[item.id] || 0;
    const hasUnread = unreadCount > 0;

    return (
      <ThemedSurface
        nativeGlass
        variant="card"
        style={[styles.aiItem, hasUnread && styles.aiItemUnread, isBlocked && styles.aiItemBlocked]}
      >
        <TouchableOpacity
          style={styles.aiRow}
          onPress={() => {
            if (isBlocked) {
              return;
            }
            if (isGroupChat) {
              onSelectGroup?.(item.group);
              return;
            }
            onSelectAI(item.ai);
          }}
          onLongPress={(event) => handleItemLongPress(item, event)}
          delayLongPress={400}
          activeOpacity={0.7}
        >
          <View style={styles.avatarWrapper}>
            {isGroupChat ? (
              <GroupAvatar name={name} avatarUrl={avatar} size="small" style={styles.listAvatar} />
            ) : (
              <AIAvatar name={name} avatarUrl={avatar} size="small" style={styles.listAvatar} />
            )}
          </View>

          <View style={styles.contentWrapper}>
            <View style={styles.headerRow}>
              <View style={styles.nameRow}>
                <Text style={[styles.aiName, hasUnread && styles.aiNameUnread]} numberOfLines={1}>
                  {name}
                </Text>
                {item.isPinned ? (
                  <Pin
                    size={12}
                    color={theme.colors.text.tertiary}
                    style={styles.pinnedMark}
                  />
                ) : null}
                {isBlocked ? (
                  <View style={styles.blockedTag}>
                    <Text style={styles.blockedTagText}>已拉黑</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.aiTime}>
                {formatChatTime(lastTime ?? item.createdAt)}
              </Text>
            </View>
            <View style={styles.previewRow}>
              <Text style={[styles.aiPreview, hasUnread && styles.aiPreviewUnread]} numberOfLines={1}>
                {isBlocked
                  ? (blockedUntil ? `已拉黑至 ${formatChatTime(blockedUntil)}` : '当前已被拉黑')
                  : draft ? <><Text style={{ color: theme.colors.feedback.error }}>[草稿]</Text> {draft}</>
                    : (lastMessage || '暂无消息')}
              </Text>
              {hasUnread ? (
                <View style={styles.unreadBadge}>
                  <Text style={styles.unreadBadgeText}>
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>
        </TouchableOpacity>
      </ThemedSurface>
    );
  }, [handleItemLongPress, onSelectAI, onSelectGroup, styles, theme, unreadMessages, textDrafts]);

  const rightButton = (
    <TouchableOpacity
      onPress={openHeaderMenu}
      activeOpacity={0.7}
      disabled={!onAddAI}
    >
      <Ionicons name="add" size={28} color={theme.colors.brand.primary} />
    </TouchableOpacity>
  );

  const renderMenuItem = (item: MenuItem) => (
    <TouchableOpacity
      key={item.key}
      style={styles.menuItem}
      activeOpacity={0.6}
      onPress={item.onPress}
    >
      <View style={styles.menuItemIcon}>{item.icon}</View>
      <Text style={styles.menuItemText}>{item.label}</Text>
    </TouchableOpacity>
  );

  const renderMenuContent = () => (
    <>
      {menuItems.map((item, index) => (
        <View key={item.key}>
          {renderMenuItem(item)}
          {index < menuItems.length - 1 && <View style={styles.menuDivider} />}
        </View>
      ))}
    </>
  );

  return (
    <View style={styles.tabContainer}>
      <NavigationHeader
        title="AI助手"
        includeTopInset={theme.effects.glass.enabled}
        rightButton={rightButton}
      />

      <Modal
        visible={menu !== null}
        transparent
        animationType="none"
        statusBarTranslucent
        onRequestClose={closeMenu}
      >
        <TouchableWithoutFeedback onPress={closeMenu}>
          <View style={styles.menuOverlay}>
            <TouchableWithoutFeedback>
              <Animated.View style={[styles.menuWrapper, menuPositionStyle, { opacity: menuOpacity }]}>
                {theme.effects.glass.enabled ? (
                  <GlassSurface
                    material={{ cornerRadius: theme.radius.sm }}
                    style={styles.menuContent}
                  >
                    {renderMenuContent()}
                  </GlassSurface>
                ) : (
                  <View style={styles.menuContent}>
                    {renderMenuContent()}
                  </View>
                )}
              </Animated.View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      <FlatList
        data={displayList}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        style={styles.aiList}
        contentContainerStyle={[styles.listContent, { paddingBottom: listPaddingBottom }]}
        refreshing={isRefreshing}
        onRefresh={handleRefresh}
        ListEmptyComponent={
          <EmptyState
            title="暂无AI助手"
          />
        }
      />
    </View>
  );
}
