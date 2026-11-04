/** 上下文页持有自己的草稿和离开屏障，写入仍由 Assistants 命令拥有。 */
import { useCallback, useMemo, useState } from 'react';
import { updateAIAssistantSettings, type AIProfile } from '@features/assistants';
import { useAutoSaveDraft, useAutoSaveNavigation } from '@shared/ui/useAutoSaveDraft';
import { getContextSettingsDraft, parseContextSettingsDraft, type ContextLimitsDraft } from './contextSettingsDraft';

export default function useContextSettings({ aiAssistant, onBack }: { aiAssistant: AIProfile; onBack(): void }) {
  const [blocked, setBlocked] = useState(false);
  const initial = useMemo(() => getContextSettingsDraft(aiAssistant), [aiAssistant]);
  const editor = useAutoSaveDraft({ initial, parse: parseContextSettingsDraft, save: async patch => {
    if (!await updateAIAssistantSettings(aiAssistant.id, patch)) throw new Error('AI 助手不存在');
  } });
  const { flush, restore } = editor;
  const navigation = useAutoSaveNavigation(flush, onBack, () => setBlocked(true));
  const restoreInfo = useCallback(async () => { await restore(); setBlocked(false); }, [restore]);
  return {
    contextLimits: editor.draft,
    handleContextLimitChange: (field: keyof ContextLimitsDraft, value: string) => editor.change({ [field]: value }),
    settingsErrors: editor.errors, infoSaveError: editor.saveError,
    commit: editor.commit, flush, restoreInfo, blocked, ...navigation,
  };
}
