/** 引用复用原有媒体卡片，快照播放身份与原消息分离。 */

import React, { memo } from 'react';
import { View, Text } from 'react-native';
import { useThemedStyles } from '@shared/theme';
import { createMessageBubbleStyles } from './styles';
import type { ChatReplyQuote } from '../../../messages/domain/chatMessageMetadata';
import AttachmentCard from './AttachmentCard';
import StickerMessageCard from './StickerMessageCard';
import VoiceMessageCard from './VoiceMessageCard';
import SharedMomentCard from '../components/SharedMomentCard';

interface ReplyQuoteProps {
  replyToText?: string | null;
  quote?: ChatReplyQuote | null;
  messageId?: number;
  onPreviewFile: (params: { fileUri: string; fileName: string; mimeType?: string | null }) => void;
  isMe: boolean;
}

export const ReplyQuote = memo(function ReplyQuote({ replyToText, quote, messageId, onPreviewFile, isMe }: ReplyQuoteProps) {
  const styles = useThemedStyles(createMessageBubbleStyles);

  if (!quote && !replyToText) return null;

  const text = quote ? quote.text : replyToText;

  return (
    <View style={[styles.replyContainer, isMe ? styles.myReplyContainer : styles.aiReplyContainer, quote?.moment && styles.momentReplyContainer]}>
      {quote?.authorName ? <Text style={styles.replyAuthorName} numberOfLines={1}>{quote.authorName}</Text> : null}
      {quote?.moment ? <SharedMomentCard moment={quote.moment} /> : null}
      {quote?.attachments.map((attachment) => (
        <AttachmentCard key={attachment.id} attachment={attachment} isMe={isMe} thumbnail onPreview={onPreviewFile} />
      ))}
      {quote?.sticker ? <StickerMessageCard sticker={quote.sticker} /> : null}
      {quote?.voice ? <VoiceMessageCard
        playbackTarget={{ kind: 'quote', id: String(messageId) }}
        voice={quote.voice} transcript={quote.text} isTranscriptExpanded={false} isMe={isMe}
      /> : null}
      {text ? <Text style={styles.replyText} numberOfLines={2} ellipsizeMode="tail">{text}</Text> : null}
    </View>
  );
});
