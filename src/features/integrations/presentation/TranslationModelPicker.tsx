/** 选择直接嵌入资产列表，业务引用仍由 Integrations 保存。 */
import React from 'react';
import { ConfiguredModelPicker, useModelManagementNavigation } from '@shared/ui';
import { getTranslationModelSettings, selectTranslationModel, subscribeTranslationModelsChanged } from '../application/TranslationModels';

export default function TranslationModelPicker() {
  const manageModels = useModelManagementNavigation();
  return <ConfiguredModelPicker title="聊天翻译模型"
    getSettings={getTranslationModelSettings} onSelect={selectTranslationModel}
    subscribeChanged={subscribeTranslationModelsChanged} onManageModels={() => manageModels('translation')} />;
}
