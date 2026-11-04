/** 选择由 Memory 持久化，原有模型同步流程负责更新向量。 */
import React from 'react';
import { ConfiguredModelPicker, showAppDialog } from '@shared/ui';
import { getMemoryEmbeddingModelSettings, getMemoryEmbeddingIndexStatus, selectMemoryEmbeddingModel } from '../application/MemoryEmbeddingModels';
import { subscribeMemoryChanged } from '../application/MemorySignals';
export default function MemoryEmbeddingModelPicker({ disabled }: { disabled?: boolean }) {
  return <ConfiguredModelPicker title="向量化模型"
    description="更换模型不会自动重建。切回未变化的旧模型时，仍匹配正文版本的旧向量会直接恢复使用；也可逐条请求向量化。"
    getSettings={getMemoryEmbeddingModelSettings} onSelect={async id => {
      const previous = await getMemoryEmbeddingModelSettings();
      await selectMemoryEmbeddingModel(id);
      if (previous.selectedModelId !== id) {
        const status = await getMemoryEmbeddingIndexStatus();
        showAppDialog({ title: '向量模型已更换', message: status.valid > 0
          ? `已恢复使用 ${status.valid} 条与当前模型和正文版本匹配的旧向量，没有重新请求模型。其他记忆可逐条向量化，也可手动重建全部索引。`
          : '当前没有可直接使用的匹配向量。旧数据保留，尚未重新向量化；开启向量化后可逐条请求，也可手动重建全部索引。正文与关键词检索不受影响。' });
      }
    }}
    subscribeChanged={subscribeMemoryChanged} disabled={disabled} />;
}
