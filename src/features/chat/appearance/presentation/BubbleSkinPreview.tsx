import React, { useState } from 'react';
import { View } from 'react-native';
import MessageBubble from '../../presentation/messages/MessageBubble';
import { ReasoningExpansionContext } from '../../presentation/messages/components/reasoningExpansionState';
import type { BubbleAppearancePreview } from './BubbleSkinDrawing';
import type { BubbleSkinRole } from '../domain/ChatBubbleSkin';
import { useThemedStyles } from '@shared/theme';
import { createBubbleSkinEditorStyles } from './BubbleSkinEditor.styles';

const noPreviewFile = () => {};

/** 单条普通消息复用正式气泡的排版和绘制，滚动只由整页持有。 */
export function BubbleSkinPreview({ role, text, appearance }: {
  role: BubbleSkinRole; text: string; appearance: BubbleAppearancePreview;
}) {
  const styles = useThemedStyles(createBubbleSkinEditorStyles);
  const [expansion] = useState(() => new Set<string | number>());
  return <View style={styles.preview}>
    <ReasoningExpansionContext.Provider value={expansion}>
      <MessageBubble messageId={-100} text={text}
        isMe={role === 'user'} senderType={role === 'user' ? 'user' : 'assistant'}
        renderState={{ variant: role === 'user' ? 'me' : 'ai', hasTextContent: text.length > 0,
          shouldUseMarkdown: false, hasAttachments: false, hasSticker: false, hasVoice: false,
          isStandaloneAttachmentMessage: false, isStandaloneStickerMessage: false,
          isReasoning: false, isSystem: false, isToolStatusMessage: false }}
        userName="你" aiName="AI" appearancePreview={appearance} onPreviewFile={noPreviewFile} />
    </ReasoningExpansionContext.Provider>
  </View>;
}
