import type { ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AIAvatar, UserAvatar } from '@shared/ui';
import { useTheme } from '@shared/theme';
import type { MomentActorType } from '../../domain/MomentRepository';

interface AvatarProps {
  actorType: MomentActorType;
  name: string;
  avatarUrl?: string | null;
}

export const Avatar = ({ actorType, name, avatarUrl }: AvatarProps) => {
  const theme = useTheme();
  const AvatarComponent = actorType === 'ai' ? AIAvatar : UserAvatar;
  return (
    <AvatarComponent
      name={name}
      avatarUrl={avatarUrl}
      size="small"
      style={{
        width: 44,
        height: 44,
        borderRadius: theme.radius.sm,
        backgroundColor: 'transparent',
        justifyContent: 'center',
        alignItems: 'center',
      } as ViewStyle}
    />
  );
};

interface HeartIconProps {
  filled?: boolean;
}

export const HeartIcon = ({ filled }: HeartIconProps) => {
  const theme = useTheme();
  return (
    <Ionicons
      name={filled ? 'heart' : 'heart-outline'}
      size={16}
      color={filled ? theme.colors.feedback.error : theme.colors.icon.secondary}
    />
  );
};

export const CommentIcon = () => {
  const theme = useTheme();
  return (
    <Ionicons name="chatbubble-outline" size={16} color={theme.colors.icon.secondary} />
  );
};

export const MoreIcon = () => {
  const theme = useTheme();
  return (
    <Ionicons name="ellipsis-horizontal" size={20} color={theme.colors.icon.secondary} />
  );
};
