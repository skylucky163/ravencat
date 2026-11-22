/** 定义纸条主题的横线纸容器，不参与其他主题的气泡布局。 */
import { StyleSheet } from 'react-native';

import type { PresentationTheme } from '@shared/theme';

export function createPaperNoteMessageStyles(theme: PresentationTheme) {
  return StyleSheet.create({
    paperNoteFrame: {
      position: 'relative',
      width: '100%',
      minHeight: 60,
      paddingHorizontal: theme.spacing.lg,
      overflow: 'hidden',
    },
    paperNoteRules: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 0,
    },
    paperNoteRule: {
      position: 'absolute',
      left: 0,
      right: 0,
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.border.default,
    },
    paperNoteSelection: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 1,
      backgroundColor: 'rgba(77, 113, 148, 0.1)',
    },
    paperNoteSpeaker: {
      zIndex: 2,
      height: 30,
      fontSize: 15,
      lineHeight: 30,
      fontWeight: '600',
      color: theme.colors.text.primary,
    },
    paperNoteBody: {
      zIndex: 2,
      minHeight: 30,
      width: '100%',
    },
    paperNoteCard: {
      position: 'relative',
      width: '100%',
      marginVertical: 4,
      alignItems: 'flex-start',
      alignSelf: 'stretch',
    },
    paperNoteContent: {
      width: '100%',
      minHeight: 30,
      paddingHorizontal: 0,
      paddingVertical: 0,
      borderRadius: 0,
      backgroundColor: 'transparent',
      maxWidth: '100%',
      alignSelf: 'stretch',
      overflow: 'visible',
    },
  });
}
