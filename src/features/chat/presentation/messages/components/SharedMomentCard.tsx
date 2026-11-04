/** 卡片作者来自原帖快照，聊天发送者仍由外层消息表达。 */
import React, { useContext } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { CircleDot } from 'lucide-react-native';
import { AvatarImage } from '@shared/ui';
import { resolveAIAvatarSource, resolveUserAvatarSource } from '@shared/avatar/resolveAvatarSource';
import { MediaAssetImage } from '@features/media';
import { useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import type { SharedMoment } from '../../../messages/domain/SharedMoment';
import { useChatShareNavigation } from './ChatShareNavigation';
import { ChatMediaResolutionCacheContext } from './chatMediaResolutionCache';
export default function SharedMomentCard({ moment, preview = false, onOpen, onLongPress }: {
  moment: SharedMoment; preview?: boolean; onOpen?: () => void; onLongPress?: (position: { x: number; y: number }) => void;
}) {
  const navigation = useChatShareNavigation();
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const uriCache = useContext(ChatMediaResolutionCacheContext)?.assets;
  const defaultAvatar = moment.author.actorType === 'ai'
    ? resolveAIAvatarSource({ name: moment.author.displayName })
    : resolveUserAvatarSource({ name: moment.author.displayName });
  return <TouchableOpacity accessibilityRole="button" accessibilityLabel={`查看${moment.author.displayName}的时刻`}
    disabled={preview} onPress={() => { onOpen?.(); navigation.openMoment(moment.momentId); }}
    onLongPress={onLongPress ? event => onLongPress({ x: event.nativeEvent.pageX, y: event.nativeEvent.pageY }) : undefined} style={styles.card}>
    <View style={styles.heading}>{moment.author.avatar ? <MediaAssetImage mediaAssetId={moment.author.avatar.mediaAssetId} uriCache={uriCache} style={styles.avatar} resizeMode="contain" /> : <AvatarImage source={defaultAvatar.source} fallbackText={defaultAvatar.fallbackText} size={28} />}<Text numberOfLines={1} style={styles.author}>{moment.author.displayName}的时刻</Text></View>
    <View style={styles.body}><Text style={styles.text} numberOfLines={preview ? undefined : 2} ellipsizeMode="tail">{moment.content}</Text>
      {!preview && moment.images.length ? <MediaAssetImage mediaAssetId={moment.images[0].mediaAssetId} uriCache={uriCache} style={styles.thumbnail} resizeMode="cover" /> : null}</View>
    {preview && moment.images.length ? <View style={styles.grid}>{moment.images.map((image, index) => <MediaAssetImage key={`${index}:${image.mediaAssetId}`} mediaAssetId={image.mediaAssetId} uriCache={uriCache} style={styles.image} resizeMode="cover" />)}</View> : null}
    <View style={styles.footer}><CircleDot size={14} color={theme.colors.brand.primary} /><Text style={styles.hint}>时刻{moment.images.length ? ` · ${moment.images.length} 张图片` : ''} · {preview ? '分享时的内容' : '点击查看原帖'}</Text></View>
  </TouchableOpacity>;
}
const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  card: { width: '100%', maxWidth: '100%', flexShrink: 1, padding: 12, gap: 10, borderRadius: theme.effects.glass.enabled ? theme.radius.lg : 4, backgroundColor: theme.effects.glass.enabled ? 'transparent' : theme.colors.surface.default },
  author: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: theme.colors.text.primary },
  heading: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  avatar: { width: 28, height: 28, borderRadius: 14, overflow: 'hidden' },
  body: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  text: { flex: 1, fontSize: 14, lineHeight: 21, color: theme.colors.text.primary },
  thumbnail: { width: 42, height: 42, borderRadius: 6, overflow: 'hidden' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, image: { width: '31%', aspectRatio: 1, borderRadius: 6, overflow: 'hidden' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 6, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border.light, paddingTop: 8 },
  hint: { fontSize: 12, color: theme.colors.text.secondary },
});
