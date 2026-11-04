import { StyleSheet } from 'react-native';
import type { PresentationTheme } from '@shared/theme';

export const createAssistantSettingsEntriesStyles = (theme: PresentationTheme) => StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface.default,
    ...(theme.effects.glass.enabled ? { borderRadius: theme.radius.lg, overflow: 'hidden' } : {}),
  },
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: 16,
  },
  firstEntry: {
    borderBottomWidth: 0.5,
    borderBottomColor: theme.colors.border.light,
  },
  entryTitle: {
    flex: 1,
    color: theme.colors.text.primary,
    fontSize: 16,
  },
});
