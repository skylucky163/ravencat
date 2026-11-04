/** 独立编辑页沿用字段自动保存和头像草稿，离开边界由 App 承接。 */
import React, { useEffect } from 'react';
import { Keyboard, Pressable, ScrollView, Text } from 'react-native';
import { ThemedSurface, useThemedStyles } from '@shared/theme';
import { AIInfoCard, InputField, KeyboardAvoidingContainer } from '@shared/ui';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { AutoSaveErrors } from '@shared/ui/AutoSaveErrors';
import type { AIProfile } from '../../domain/AIProfile';
import useAssistantProfile from './useAssistantProfile';
import AssistantProfilePage from './AssistantProfilePage';
import { createAssistantProfileStyles } from './AssistantProfile.styles';

export interface AssistantProfileNavigationState {
  dirty: boolean;
  flush(): Promise<boolean>;
}

interface Props {
  aiId: string;
  onBack(): void;
  onNavigationStateChange(state: AssistantProfileNavigationState): void;
}

function AssistantProfileContent({
  assistant, onBack, onNavigationStateChange,
}: Omit<Props, 'aiId'> & { assistant: AIProfile }) {
  const styles = useThemedStyles(createAssistantProfileStyles);
  const profile = useAssistantProfile({ aiAssistant: assistant });
  const { dirty, flush } = profile;
  useEffect(() => { onNavigationStateChange({ dirty, flush }); }, [dirty, flush, onNavigationStateChange]);
  const finishEditing = async () => {
    Keyboard.dismiss();
    if (await flush()) onBack();
  };

  return <KeyboardAvoidingContainer style={styles.screen}>
    <NavigationHeader title="编辑 AI 资料" onGoBack={onBack} rightButton={
      <Pressable accessibilityRole="button" accessibilityLabel="完成编辑"
        style={styles.action} onPress={() => void finishEditing()}>
        <Text style={styles.actionText}>完成</Text>
      </Pressable>
    } />
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      <ThemedSurface variant="card" style={styles.card}>
        <AIInfoCard name={profile.nickname.trim() || profile.name} avatarUrl={profile.avatarUrl}
          size="large" onAvatarPress={profile.handleAvatarPress} />
      </ThemedSurface>
      <AutoSaveErrors error={profile.avatarError} blocked={false} retry={profile.retryAvatar}
        restore={() => void profile.restoreAvatar()} />
      <ThemedSurface variant="card" style={styles.card}>
        <InputField label="AI 名称" value={profile.name} onChangeText={profile.setName}
          onBlur={() => void profile.commit()} error={profile.nameError} placeholder="给 AI 起个名字（最多 20 字）" />
        <InputField label="专属昵称" value={profile.nickname} onChangeText={profile.setNickname}
          onBlur={() => void profile.commit()} error={profile.nicknameError} placeholder="你的专属称呼，留空使用 AI 名称" />
        <InputField label="AI 人设" value={profile.systemPrompt} onChangeText={profile.setSystemPrompt}
          onBlur={() => void profile.commit()} placeholder="写下 AI 的身份、性格、关系与表达方式"
          hint="离开输入框时自动保存，完成编辑后返回个人主页。" autoGrow textAlignVertical="top" style={styles.lastField} />
      </ThemedSurface>
      <AutoSaveErrors error={profile.infoSaveError} blocked={profile.blocked && Boolean(profile.nameError || profile.nicknameError)}
        retry={() => void flush()} restore={() => void profile.restoreInfo()} />
    </ScrollView>
  </KeyboardAvoidingContainer>;
}

export default function AssistantProfileEditScreen({ aiId, ...props }: Props) {
  return <AssistantProfilePage aiId={aiId} title="编辑 AI 资料" onBack={props.onBack}>
    {assistant => <AssistantProfileContent key={aiId} assistant={assistant} {...props} />}
  </AssistantProfilePage>;
}
