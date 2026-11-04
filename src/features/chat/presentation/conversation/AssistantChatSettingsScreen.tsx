/** 对话设置保留页面偏好，上下文通过导航进入同一独立页面。 */
import React from 'react';
import AssistantConversationPage from './AssistantConversationPage';
import ChatSettings from './ChatSettings';

export default function AssistantChatSettingsScreen({ aiId, onBack, onOpenContextSettings }: {
  aiId: string; onBack(): void; onOpenContextSettings(): void;
}) {
  return <AssistantConversationPage aiId={aiId} title="对话设置" onBack={onBack}>
    {(assistant, conversation) => <ChatSettings key={assistant.id} aiAssistant={assistant}
      chatBackgroundKey={`single:${conversation.id}`} onBack={onBack} onOpenContextSettings={onOpenContextSettings} />}
  </AssistantConversationPage>;
}
