/** 主页和更多共用原摘要页面；所有下级页按目标会话读取，不准备聊天。 */
import React from 'react';
import AssistantConversationPage from '../../presentation/conversation/AssistantConversationPage';
import ChatSummaryScreen from './ChatSummaryScreen';
import ChatSummaryEditorScreen from './ChatSummaryEditorScreen';
import ChatSecondarySummaryScreen from './ChatSecondarySummaryScreen';
import ChatSummaryTaskScreen from './ChatSummaryTaskScreen';
import ChatSummarySettingsScreen from './ChatSummarySettingsScreen';

export function ChatSummaryRouteScreen({ aiId, onBack, ...navigation }: {
  aiId: string; onBack(): void; onCreateSummary(): void; onEditSummary(segmentId: string): void;
  onEditSecondary(): void; onTask(taskId: string): void; onSettings(): void;
}) {
  return <AssistantConversationPage aiId={aiId} title="聊天摘要" onBack={onBack}>
    {(_, conversation) => <ChatSummaryScreen key={conversation.id} conversationId={conversation.id}
      onBack={onBack} {...navigation} />}
  </AssistantConversationPage>;
}

export function ChatSummaryEditorRouteScreen({ aiId, onBack, segmentId, taskId, secondary = false,
  onSettings, onEditSource, onEditSecondary }: {
  aiId: string; onBack(): void; segmentId?: string; taskId?: string; secondary?: boolean;
  onSettings(): void; onEditSource(id: string): void; onEditSecondary(): void;
}) {
  return <AssistantConversationPage aiId={aiId} title="聊天摘要" onBack={onBack}>
    {(_, conversation) => taskId ? <ChatSummaryTaskScreen key={`${conversation.id}:${taskId}`}
      conversationId={conversation.id} taskId={taskId} onBack={onBack} onSettings={onSettings}
      onEditSummary={onEditSource} onEditSecondary={onEditSecondary} />
      : secondary ? <ChatSecondarySummaryScreen key={conversation.id} conversationId={conversation.id}
        onBack={onBack} onEditSource={onEditSource} />
        : <ChatSummaryEditorScreen key={`${conversation.id}:${segmentId ?? 'new'}`} conversationId={conversation.id}
          segmentId={segmentId} onBack={onBack} onEditSource={onEditSource} />}
  </AssistantConversationPage>;
}

export function ChatSummarySettingsRouteScreen({ aiId, onBack }: { aiId: string; onBack(): void }) {
  return <AssistantConversationPage aiId={aiId} title="摘要设置" onBack={onBack}>
    {(assistant, conversation) => <ChatSummarySettingsScreen key={conversation.id} conversationId={conversation.id}
      assistantId={assistant.id} onBack={onBack} />}
  </AssistantConversationPage>;
}
