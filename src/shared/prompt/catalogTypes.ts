/** 定义内置提示词目录在 Feature、Host 与提示词中心之间共享的稳定契约。 */

export type PromptScenarioId =
  | 'chat.private_reply'
  | 'chat.group_member_reply'
  | 'chat.group_admin_schedule'
  | 'ledger.reply'
  | 'call.live_reply'
  | 'call.outgoing_decision'
  | 'call.post_user_hangup'
  | 'together_listening.post_user_decline'
  | 'raven_cat.ai_schedule_trigger'
  | 'chat.summary'
  | 'vision.ocr';

export type PromptSlot =
  | 'foundation'
  | 'persona'
  | 'user_rules'
  | 'scenario'
  | 'capabilities'
  | 'dynamic_context'
  | 'output_contract'
  | 'history'
  | 'input';

export type PromptDefinitionCategory =
  | 'foundation'
  | 'persona'
  | 'user_rules'
  | 'scenario'
  | 'capability'
  | 'context'
  | 'style'
  | 'output'
  | 'control'
  | 'history'
  | 'input'
  | 'internal';

export type PromptDefinitionProtection = 'locked' | 'overridable' | 'editable';
export type PromptDefinitionContentKind = 'static' | 'template' | 'provider';
export type PromptDefinitionStatus = 'active' | 'legacy';

export interface PromptDefinitionDescriptor {
  id: string;
  version: number;
  name: string;
  description: string;
  owner: string;
  category: PromptDefinitionCategory;
  supportedScenarios: PromptScenarioId[];
  defaultSlot: PromptSlot;
  placement: 'system' | 'history' | 'input';
  protection: PromptDefinitionProtection;
  protectionReason?: string;
  /** 正文只有全局版本（如群摘要没有所属 AI）时声明；默认按当前 AI 保存覆盖。 */
  editScope?: 'global';
  contentKind: PromptDefinitionContentKind;
  providerId?: string;
  content?: string;
  defaultContent?: string;
  contentDescription?: string;
  sourcePath: string;
  status?: PromptDefinitionStatus;
}
