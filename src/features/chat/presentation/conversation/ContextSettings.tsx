/** 两种上下文范围沿用既有语义，固定起点只替代对应单聊的条数范围。 */
import React, { useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ContextLimitsApply, type AIProfile } from '@features/assistants';
import { useThemedStyles, useTheme } from '@shared/theme';
import { KeyboardAvoidingContainer } from '@shared/ui';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { AutoSaveErrors } from '@shared/ui/AutoSaveErrors';
import { createCommonStyles } from '@shared/ui/commonStyles';
import ContextWindowSection from './ContextWindowSection';
import FixedChatContextSection from './FixedChatContextSection';
import HistoricalGroupsSection from './HistoricalGroupsSection';
import useContextSettings from './useContextSettings';
import { createStyles } from './chatSettingsStyles';

interface Props { aiAssistant: AIProfile; conversationId: string; onBack(): void; onChooseFixedStart(): void }

export default function ContextSettings({ aiAssistant, conversationId, onBack, onChooseFixedStart }: Props) {
  const [fixed, setFixed] = useState(false);
  const styles = useThemedStyles(createStyles);
  const theme = useTheme();
  const common = React.useMemo(() => createCommonStyles(theme), [theme]);
  const settings = useContextSettings({ aiAssistant, onBack });
  return <SafeAreaView style={common.screenContainer} edges={['top', 'left', 'right']}>
    <KeyboardAvoidingContainer style={common.screenContainer}>
      <NavigationHeader title="上下文设置" onGoBack={settings.back} help={{ sections: [
        { title: '按条数注入', body: '单聊会带入当前单聊与已参加的群；群聊会带入当前群聊、这位 AI 的单聊和其他已参加的群。背景条数设为 0 时，该类来源的原文与摘要都不带入，但不停止来源继续生成摘要。' },
        { title: '固定消息起点', body: '在消息列表长按消息并选择「固定」。从该消息到最新的全部原文都会带入，当前单聊条数暂不生效，自动摘要暂停生成。取消固定后恢复先前条数，重新开启自动生成需在摘要设置中手动操作。已有摘要的注入仍由摘要设置控制。' },
        { title: '历史群聊', body: '退出或被移除时保存的历史不会接收后续群消息。可查看和开关自动带入，也可以让 AI 使用记忆工具转存为长期记忆。' },
      ] }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <Text style={styles.rowDescription}>{fixed ? '当前单聊使用固定消息起点，其他来源沿用原有上下文设置。' : '摘要开启时至少保留当前单聊条数的近期原文，更早内容按批次整理，生成期间继续保留原文；也可选择固定消息起点。'}</Text>
        <ContextWindowSection values={settings.contextLimits} onChange={settings.handleContextLimitChange}
          onBlur={() => void settings.commit()} errors={settings.settingsErrors} fixed={fixed}>
          <ContextLimitsApply readSettings={async () => {
            if (!await settings.flush()) return null;
            return { privateContextPrimaryLimit: Number(settings.contextLimits.privatePrimary), privateContextSecondaryLimit: Number(settings.contextLimits.privateSecondary),
              groupContextPrimaryLimit: Number(settings.contextLimits.groupPrimary), groupContextSecondaryLimit: Number(settings.contextLimits.groupSecondary) };
          }} />
        </ContextWindowSection>
        <FixedChatContextSection conversationId={conversationId} onFixedChange={setFixed}
          onChoose={() => { void settings.leave(onChooseFixedStart); }} />
        <AutoSaveErrors error={settings.infoSaveError} blocked={settings.blocked && Object.keys(settings.settingsErrors).length > 0}
          retry={() => void settings.flush()} restore={() => void settings.restoreInfo()} />
        <HistoricalGroupsSection assistantId={aiAssistant.id} />
      </ScrollView>
    </KeyboardAvoidingContainer>
  </SafeAreaView>;
}
