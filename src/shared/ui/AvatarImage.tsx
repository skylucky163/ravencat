import React, { useEffect, useMemo, useState } from 'react';
import {
  Image,
  StyleSheet,
  Text,
  View,
  type ImageSourcePropType,
  type ImageStyle,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { AVATAR_SHAPE, type AvatarShape } from '@shared/avatar/avatarConstants';
import { useTheme, useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';

export interface AvatarImageProps {
  source?: ImageSourcePropType | null;
  fallbackSource?: ImageSourcePropType | null;
  fallbackText?: string | null;
  size?: number;
  shape?: AvatarShape;
  style?: StyleProp<ViewStyle>;
  imageStyle?: StyleProp<ImageStyle>;
  textStyle?: StyleProp<TextStyle>;
  backgroundColor?: string;
}

function getSourceKey(source?: ImageSourcePropType | null): string {
  if (!source) return 'null';
  if (typeof source === 'number') return `asset:${source}`;
  if (Array.isArray(source)) return source.map(getSourceKey).join('|');
  if (typeof source === 'object' && 'uri' in source && source.uri) {
    return `uri:${source.uri}`;
  }
  return 'unknown';
}

function getBorderRadius(size: number, shape: AvatarShape, mediumRadius: number): number {
  if (shape === AVATAR_SHAPE.circle) return size / 2;
  if (shape === AVATAR_SHAPE.square) return Math.max(3, Math.round(size * 0.06));
  return Math.max(mediumRadius, Math.round(size * 0.22));
}

function getPlaceholderText(text?: string | null): string {
  const normalized = String(text || '').trim();
  return normalized ? normalized.charAt(0).toUpperCase() : '?';
}

export default function AvatarImage({
  source = null,
  fallbackSource = null,
  fallbackText = '?',
  size = 56,
  shape = AVATAR_SHAPE.circle,
  style,
  imageStyle,
  textStyle,
  backgroundColor,
}: AvatarImageProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const [primaryFailed, setPrimaryFailed] = useState(false);
  const [fallbackFailed, setFallbackFailed] = useState(false);

  const primaryKey = getSourceKey(source);
  const fallbackKey = getSourceKey(fallbackSource);

  useEffect(() => {
    setPrimaryFailed(false);
    setFallbackFailed(false);
  }, [primaryKey, fallbackKey]);

  const activeSource = useMemo(() => {
    if (!primaryFailed && source) return source;
    if (!fallbackFailed && fallbackSource) return fallbackSource;
    return null;
  }, [fallbackFailed, fallbackSource, primaryFailed, source]);

  const isUsingFallbackSource = primaryFailed && Boolean(fallbackSource);
  const borderRadius = getBorderRadius(size, shape, theme.radius.md);

  const containerStyle = [
    styles.container,
    {
      width: size,
      height: size,
      borderRadius,
      backgroundColor: backgroundColor || 'transparent',
    },
    style,
  ];

  if (activeSource) {
    return (
      <View style={containerStyle}>
        <Image
          source={activeSource}
          style={[styles.image, { borderRadius }, imageStyle]}
          onError={() => {
            if (isUsingFallbackSource) {
              setFallbackFailed(true);
              return;
            }

            setPrimaryFailed(true);
          }}
        />
      </View>
    );
  }

  return (
    <View style={containerStyle}>
      <Text style={[styles.placeholderText, { fontSize: Math.max(12, Math.round(size * 0.4)) }, textStyle]}>
        {getPlaceholderText(fallbackText)}
      </Text>
    </View>
  );
}

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  container: {
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
    resizeMode: 'contain',
  },
  placeholderText: {
    fontWeight: '600',
    color: theme.colors.brand.primary,
  },
});
