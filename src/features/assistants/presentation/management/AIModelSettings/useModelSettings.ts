/** 模型配置、模型查询与独立主理关系命令的页面装配。 */
import { type AppDialogButton, type AppDialogTone } from '@shared/ui';
import { useCallback, useEffect } from 'react';
import type { AIProfile } from '../../../domain/AIProfile';
import useModelSelection from './useModelSelection';
import useConnectionTest from './useConnectionTest';
import useModelSettingsForm from './useModelSettingsForm';
import useHostAISetting from './useHostAISetting';

export default function useModelSettings({ aiAssistant, onUpdated, onShowAlert }: {
  aiAssistant: AIProfile;
  onUpdated?: (ai: Partial<AIProfile>) => void;
  onShowAlert?: (title: string, message: string, buttons?: AppDialogButton[], tone?: AppDialogTone) => void;
}) {
  const form = useModelSettingsForm({ aiAssistant, onUpdated });
  const host = useHostAISetting({ aiAssistant, onUpdated, onShowAlert });
  const selection = useModelSelection({
    apiBaseUrl: form.apiBaseUrl, apiKey: form.apiKey, selectedModel: form.selectedModel,
    setSelectedModel: form.setSelectedModel, resetKey: `${aiAssistant.id}:${form.apiBaseUrl}`,
  });
  const test = useConnectionTest({
    apiBaseUrl: form.apiBaseUrl, apiKey: form.apiKey, selectedModel: form.selectedModel,
    getConnectionParams: form.getConnectionParams, onShowAlert,
  });
  const { resetTestState } = test;
  const { validateAll } = form;
  const { handleTestConnection: testConnection } = test;
  useEffect(() => { resetTestState(); }, [form.apiBaseUrl, form.apiKey, form.selectedModel, form.disableThinking, resetTestState]);
  const handleTestConnection = useCallback(async () => {
    // 先校验本地输入；连接测试不替代持久化，也不使用最后一次合法数字掩盖无效草稿。
    if (validateAll()) await testConnection();
  }, [validateAll, testConnection]);
  return { ...form, ...host, ...selection, ...test, handleTestConnection,
    fillServiceConnection: (service: { id: string; baseUrl: string; apiKey: string }) => { form.fillServiceConnection(service); selection.resetModelSelection(); resetTestState(); } };
}
