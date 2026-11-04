/** 主页和对话设置共用此上下文页，目标来自稳定助手 ID。 */
import React from 'react';
import AssistantConversationPage from './AssistantConversationPage';
import ContextSettings from './ContextSettings';

export default function AssistantContextSettingsScreen({ aiId, onBack, onChooseFixedStart }: {
  aiId: string; onBack(): void; onChooseFixedStart(): void;
}) {
  return <AssistantConversationPage aiId={aiId} title="上下文设置" onBack={onBack}>
    {(assistant, conversation) => <ContextSettings key={conversation.id} aiAssistant={assistant}
      conversationId={conversation.id} onBack={onBack} onChooseFixedStart={onChooseFixedStart} />}
  </AssistantConversationPage>;
}
