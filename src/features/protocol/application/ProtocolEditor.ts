import type { IProtocolRepository } from '../domain/ProtocolRepository';

/** 编辑表单用完整草稿保存，AI 工具仍可按字段更新。 */
export function createProtocolEditor(repository: IProtocolRepository) {
  return {
    list(aiAssistantId: string) {
      return repository.getByAI(aiAssistantId);
    },
    async save(params: {
      protocolId: string | null;
      aiAssistantId: string;
      content: string;
      summary: string | null;
    }): Promise<void> {
      const { protocolId, aiAssistantId, content, summary } = params;
      if (protocolId === null) {
        await repository.insert({ aiAssistantId, content, summary });
        return;
      }

      const protocol = await repository.update(aiAssistantId, protocolId, { content, summary });
      if (!protocol) throw new Error('协议不存在或不属于当前 AI，请刷新后重试');
    },
    async remove(aiAssistantId: string, protocolId: string): Promise<void> {
      const deleted = await repository.delete(aiAssistantId, protocolId);
      if (!deleted) throw new Error('协议不存在或不属于当前 AI，请刷新后重试');
    },
  };
}

export type ProtocolEditor = ReturnType<typeof createProtocolEditor>;
