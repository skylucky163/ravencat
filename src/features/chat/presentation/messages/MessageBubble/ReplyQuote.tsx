/** 引用摘要和点击入口共用一层主题表面，详细内容由原有预览展示。 */

import React, { memo, useContext } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRecyclingState } from '@shopify/flash-list';
import { MediaAssetImage } from '@features/media';
import { ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import { createMessageBubbleStyles } from './styles';
import { buildSharedChatRecordQuoteLabel, type ChatReplyQuote } from '../../../messages/domain/chatMessageMetadata';
import type { SharedMoment } from '../../../messages/domain/SharedMoment';
import { useChatShareNavigation } from '../components/ChatShareNavigation';
import { ChatMediaResolutionCacheContext } from '../components/chatMediaResolutionCache';
import { SharedChatRecordDetail } from '../components/SharedChatRecordView';
import AttachmentCard from './AttachmentCard';
import VoiceMessageCard from './VoiceMessageCard';

interface ReplyQuoteProps {
  replyToText?: string | null;
  quote?: ChatReplyQuote | null;
  messageId?: number;
  onPreviewFile: (params: { fileUri: string; fileName: string; mimeType?: string | null }) => void;
  isMe: boolean;
}

function MomentQuote({ moment, senderName }: { moment: SharedMoment; senderName?: string }) {
  const { openMoment } = useChatShareNavigation();
  const styles = useThemedStyles(createMessageBubbleStyles);
  const uriCache = useContext(ChatMediaResolutionCacheContext)?.assets;
  const image = moment.images[0];
  const title = `${moment.author.displayName} · 时刻`;
  return (
    <Pressable accessibilityRole="button" onPress={() => openMoment(moment.momentId)} style={styles.replyRow}>
      <View style={styles.replyCopy}>
        <Text style={styles.replyAuthorName} numberOfLines={1}>{senderName && senderName !== moment.author.displayName ? `${senderName}：[时刻] ${moment.author.displayName}` : title}</Text>
        {moment.content ? <Text style={styles.replyText} numberOfLines={1}>{moment.content}</Text> : null}
      </View>
      {image ? <MediaAssetImage mediaAssetId={image.mediaAssetId} uriCache={uriCache} style={styles.replyThumbnail} resizeMode="cover" /> : null}
    </Pressable>
  );
}

export const ReplyQuote = memo(function ReplyQuote({ replyToText, quote, messageId, onPreviewFile, isMe }: ReplyQuoteProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createMessageBubbleStyles);
  const uriCache = useContext(ChatMediaResolutionCacheContext)?.assets;
  const [recordOpen, setRecordOpen] = useRecyclingState(false, [messageId]);

  if (!quote && !replyToText) return null;

  const author = quote?.authorName ? <Text style={styles.replyAuthorName} numberOfLines={1}>{quote.authorName}</Text> : null;
  const attachment = quote?.attachments.find((item) => item.type === 'image') ?? quote?.attachments[0];
  const attachmentCount = quote?.attachments.length ?? 0;
  const text = quote ? quote.text : replyToText;
  const summary = [text || (attachment?.type === 'image' ? '图片' : quote?.sticker ? `[表情] ${quote.sticker.name}` : ''),
    attachmentCount > 1 ? `共 ${attachmentCount} 个附件` : ''].filter(Boolean).join(' · ');
  const summaryText = summary ? <Text style={styles.replyText} numberOfLines={2}>{summary}</Text> : null;
  const record = quote?.sharedRecord;
  const hasFilePreview = attachment?.type === 'file';
  const attachmentPreview = attachment ? <AttachmentCard attachment={attachment} isMe={isMe} thumbnail onPreview={onPreviewFile} /> : null;

  return (
    <>
      <ThemedSurface backgroundColor={theme.colors.chat.quote} cornerRadius={styles.replyContainer.borderRadius}
        style={[styles.replyContainer, isMe ? styles.myReplyContainer : styles.aiReplyContainer]}>
        {record ? (
          <Pressable accessibilityRole="button" onPress={() => setRecordOpen(true)}>
            {author}
            <Text style={styles.replyText} numberOfLines={2}>{buildSharedChatRecordQuoteLabel(record)}</Text>
          </Pressable>
        ) : quote?.moment ? <MomentQuote moment={quote.moment} senderName={quote.authorName} /> : quote?.voice ? (
          <>
            {author}
            <VoiceMessageCard playbackTarget={{ kind: 'quote', id: String(messageId) }}
              voice={quote.voice} transcript={quote.text} isTranscriptExpanded={false} isMe={isMe}
              foregroundColor={theme.colors.text.secondary} />
            {summaryText}
          </>
        ) : attachment || quote?.sticker ? (
          <View style={hasFilePreview ? undefined : styles.replyRow}>
            <View style={hasFilePreview ? undefined : styles.replyCopy}>
              {author}
              {summaryText}
              {hasFilePreview ? attachmentPreview : null}
            </View>
            {attachment ? (hasFilePreview ? null : attachmentPreview)
              : quote?.sticker ? <MediaAssetImage mediaAssetId={quote.sticker.mediaAssetId} uriCache={uriCache} style={styles.replyThumbnail} resizeMode="contain" /> : null}
          </View>
        ) : <>{author}{summaryText}</>}
      </ThemedSurface>
      {quote?.sharedRecord ? <SharedChatRecordDetail visible={recordOpen} record={quote.sharedRecord} comment={quote.text} onClose={() => setRecordOpen(false)} onPreviewFile={onPreviewFile} /> : null}
    </>
  );
});
