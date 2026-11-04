/** 聊天 Sticker 面板的主题样式。 */

import { Dimensions } from 'react-native';
import type { PresentationTheme } from '@shared/theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
export const STICKER_GRID_COLUMNS = 5;
const GRID_GAP = 8;
const GRID_PADDING = 12;
export const STICKER_SIZE = Math.max(
  52,
  (SCREEN_WIDTH - GRID_PADDING * 2 - GRID_GAP * (STICKER_GRID_COLUMNS - 1)) / STICKER_GRID_COLUMNS,
);

export const createChatEmojiPanelStyles = (theme: PresentationTheme) => ({
  container: {
    backgroundColor: 'transparent',
    borderTopWidth: 0.5,
    borderTopColor: theme.colors.border.default,
  },
  header: {
    minHeight: 40,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: 12,
    gap: 8,
  },
  title: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600' as const,
    color: theme.colors.text.primary,
  },
  headerAction: {
    width: 30,
    height: 30,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    borderRadius: 6,
    backgroundColor: theme.colors.surface.default,
  },
  headerTextAction: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: theme.colors.surface.default,
  },
  headerTextActionText: {
    fontSize: 12,
    color: theme.colors.text.secondary,
  },
  batchDeleteText: {
    fontSize: 12,
    fontWeight: '600' as const,
    color: theme.colors.feedback.error,
  },
  headerActionDisabled: {
    opacity: 0.4,
  },
  filterScroll: {
    maxHeight: 36,
  },
  filterContent: {
    paddingHorizontal: 12,
    gap: 7,
    alignItems: 'center' as const,
  },
  filterChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: theme.colors.surface.default,
  },
  filterChipActive: {
    backgroundColor: theme.colors.brand.primary,
  },
  filterChipText: {
    fontSize: 12,
    color: theme.colors.text.secondary,
  },
  filterChipTextActive: {
    color: theme.colors.brand.onPrimary,
  },
  gridScroll: {
    flex: 1,
    marginTop: 4,
  },
  gridContainer: {
    paddingHorizontal: GRID_PADDING,
    paddingTop: 3,
    paddingBottom: 14,
  },
  gridRow: {
    gap: GRID_GAP,
  },
  gridItem: {
    width: STICKER_SIZE,
    minHeight: STICKER_SIZE + 31,
    marginBottom: GRID_GAP,
    alignItems: 'center' as const,
    position: 'relative' as const,
  },
  gridImage: {
    width: STICKER_SIZE,
    height: STICKER_SIZE,
    borderRadius: 8,
    backgroundColor: 'transparent',
  },
  gridPlaceholder: {
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
    backgroundColor: theme.colors.surface.muted,
  },
  gridName: {
    width: STICKER_SIZE,
    marginTop: 2,
    fontSize: 10,
    color: theme.colors.text.secondary,
    textAlign: 'center' as const,
  },
  annotationStatus: {
    width: STICKER_SIZE,
    fontSize: 9,
    color: theme.colors.text.tertiary,
    textAlign: 'center' as const,
  },
  annotationStatusError: {
    color: theme.colors.feedback.error,
  },
  annotationStatusManual: {
    color: theme.colors.brand.primary,
  },
  favoriteMark: {
    position: 'absolute' as const,
    right: 3,
    top: 3,
  },
  selectionMark: {
    position: 'absolute' as const,
    left: 1,
    top: 1,
    borderRadius: 11,
    backgroundColor: theme.colors.surface.default,
  },
  emptyState: {
    paddingVertical: 24,
    alignItems: 'center' as const,
  },
  emptyStateText: {
    marginTop: 6,
    fontSize: 12,
    color: theme.colors.text.tertiary,
  },
  loadingText: {
    paddingVertical: 22,
    textAlign: 'center' as const,
    color: theme.colors.text.tertiary,
    fontSize: 12,
  },
});
