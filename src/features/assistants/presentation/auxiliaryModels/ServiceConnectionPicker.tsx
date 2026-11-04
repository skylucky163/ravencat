/** 选择连接只填连接字段；不复制模型、生成参数或任务配置。 */
import React, { useState } from 'react';
import { Button, ModelPickerModal, showAppDialog } from '@shared/ui';
import { getModelServiceConfig, listModelServiceConfigs, type ModelServiceConfig, type ModelServiceConnection } from '../../ModelServices';

export default function ServiceConnectionPicker({ baseUrl, apiKey, authType = 'apiKey', onFill, disabled = false }: {
  baseUrl: string;
  apiKey: string;
  authType?: ModelServiceConnection['authType'];
  onFill(service: ModelServiceConfig): void;
  disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [models, setModels] = useState<ModelServiceConfig[]>([]);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setVisible(true); setLoading(true); setError(null);
    try { setModels((await listModelServiceConfigs()).filter(service => service.authType === authType)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '读取服务配置失败'); }
    finally { setLoading(false); }
  };
  const select = async (id: string) => {
    setLoading(true);
    try {
      const service = await getModelServiceConfig(id);
      onFill(service); setVisible(false);
    } catch (failure) { showAppDialog({ title: '选择失败', message: failure instanceof Error ? failure.message : '读取服务配置失败', tone: 'error' }); }
    finally { setLoading(false); }
  };
  return <>
    <Button title="选择已有服务" variant="primary" disabled={disabled} onPress={() => { void open(); }} />
    <ModelPickerModal visible={visible} title="选择服务配置" onClose={() => setVisible(false)}
      models={models.map(service => ({ id: service.id, name: service.name, model: service.baseUrl }))}
      selectedModel={models.find(service => service.baseUrl === baseUrl.trim() && service.apiKey === apiKey.trim())?.id}
      loading={loading} error={error} disabled={disabled || loading} onRetry={() => { void open(); }} onSelect={id => { void select(id); }}
      emptyText="暂无匹配的服务，可手动填写连接，或到辅助模型中心的服务配置中添加。"
      description="只填入连接和凭据，模型与参数由当前用途管理。在此修改连接只影响当前配置；统一更新请进入服务配置。" />
  </>;
}
