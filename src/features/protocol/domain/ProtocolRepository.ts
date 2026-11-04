/** 协议空间实体与持久化端口。 */
export interface Protocol {
  id: string;
  aiAssistantId: string;
  content: string;
  summary?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProtocolInput {
  aiAssistantId: string;
  content: string;
  summary?: string | null;
}

export interface ProtocolInsertResult extends Protocol {
  /** 同 AI 下正文已存在时返回既有条目，不新建。 */
  alreadyExists: boolean;
}

export interface UpdateProtocolInput {
  content?: string;
  summary?: string | null;
}

export interface IProtocolRepository {
  getByAI(aiAssistantId: string): Promise<Protocol[]>;
  getPromptText(aiAssistantId: string): Promise<string>;
  search(aiAssistantId: string, keyword: string): Promise<Protocol[]>;
  insert(protocol: CreateProtocolInput): Promise<ProtocolInsertResult>;
  /** 仅修改所属 AI 的条目；未命中返回 null，成功返回事务内的完整结果。 */
  update(aiAssistantId: string, id: string, updates: UpdateProtocolInput): Promise<Protocol | null>;
  /** 仅删除所属 AI 的条目；返回是否实际删除。 */
  delete(aiAssistantId: string, id: string): Promise<boolean>;
}
