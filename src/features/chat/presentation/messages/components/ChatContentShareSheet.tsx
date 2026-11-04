/** Chat 提供目标目录与提交，公共窗口通过预览插槽展示不同分享内容。 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ShareSheet, type ShareSheetTarget } from '@shared/ui';
import type { ChatShareTarget } from '../../../messages/application/ShareChatMessages';
import { useThemedStyles, type PresentationTheme } from '@shared/theme';
import { SharedChatRecordEntries } from './SharedChatRecordView';
import SharedMomentCard from './SharedMomentCard';
import type { useChatContentShare } from './useChatContentShare';
import type { PreviewFileHandler } from '../MessageBubble/MessageBubbleContent';
export default function ChatContentShareSheet({ share, onPreviewFile }: { share: Omit<ReturnType<typeof useChatContentShare>, 'open'>; onPreviewFile?: PreviewFileHandler }) {
  const styles = useThemedStyles(createStyles);
  const content = share.content;
  const targets = share.targets.map(target => ({ ...target, key: `${target.kind}:${target.id}`, description: target.kind === 'group' ? '群聊' : 'AI 单聊' }));
  const target = share.target ? { ...share.target, key: `${share.target.kind}:${share.target.id}`, description: share.target.kind === 'group' ? '群聊' : 'AI 单聊' } : null;
  return <ShareSheet<ChatShareTarget & ShareSheetTarget> visible={share.visible} targets={targets} target={target} loading={share.loading} sending={share.sending} error={share.error}
    comment={share.comment} ready={content !== null} canChooseTarget={!share.fixedTarget} onClose={share.close} onChoose={share.choose} onCommentChange={share.setComment} onSend={() => { void share.send(); }}
    selectionHint={content?.kind === 'chat_record' ? `已选 ${content.record.selectionCount} 条 · AI 回复按整轮分享` : '选择接收这条时刻的 AI 或群聊'}
    preview={content?.kind === 'chat_record' ? <><Text style={styles.hint}>来源：{content.record.sourceName} · {content.record.selectionCount} 条消息</Text><SharedChatRecordEntries preview record={content.record} onPreviewFile={onPreviewFile!} /></>
      : content?.kind === 'moment' ? <View style={styles.preview}><SharedMomentCard moment={content.moment} preview /></View> : null}
    footer={content?.kind === 'chat_record' ? <Text style={styles.hint}>语音消息将以转写文本分享，不包含可播放音频。</Text> : <Text style={styles.hint}>分享正文和图片，评论与点赞请查看原帖。</Text>} />;
}
const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  hint: { padding: 16, fontSize: 12, color: theme.colors.text.secondary }, preview: { padding: 16 },
});
