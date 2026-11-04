/** 定义用户提示词片段、预设条目和目标绑定领域对象。 */

import type { PromptScenarioId, PromptSlot } from '@shared/prompt';

export type PromptLanguageMode = 'system' | 'zh-CN' | 'en-US';
export type UserPromptCondition =
  | 'always'
  | 'private_chat'
  | 'group_chat'
  | 'call'
  /** 已持久化的退役值：仅用于读取、编辑与删除，不再可新建，也不匹配任何 active scenario。 */
  | 'moments'
  | 'image_present'
  | 'tools_enabled';

export interface AssistantPromptSettings {
  assistantId: string;
  languageMode: PromptLanguageMode;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantPromptDefinitionState {
  assistantId: string;
  definitionId: string;
  enabled: boolean;
  sortOrder: number | null;
  updatedAt: string;
}

export interface AssistantPromptDefinitionOverride {
  assistantId: string;
  definitionId: string;
  locale: 'zh-CN' | 'en-US';
  content: string;
  updatedAt: string;
}

export interface AssistantUserPrompt {
  id: string;
  assistantId: string;
  name: string;
  content: string;
  condition: UserPromptCondition;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type PromptCustomBlockCategory = 'persona' | 'user_rules' | 'scenario';

export interface PromptCustomBlock {
  id: string;
  name: string;
  description: string | null;
  content: string;
  category: PromptCustomBlockCategory;
  defaultSlot: Extract<PromptSlot, 'persona' | 'user_rules' | 'scenario'>;
  placement: 'system';
  createdAt: string;
  updatedAt: string;
}

export interface PromptPreset {
  id: string;
  name: string;
  description: string | null;
  scenarioId: PromptScenarioId;
  basePresetId: string | null;
  tokenBudget: number | null;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PromptPresetItem {
  id: string;
  presetId: string;
  definitionId: string;
  slot: PromptSlot;
  sortOrder: number;
  enabled: boolean;
  conditionJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PromptBindingTargetType = 'global' | 'assistant' | 'group';

export interface PromptBinding {
  id: string;
  scenarioId: PromptScenarioId;
  targetType: PromptBindingTargetType;
  targetId: string | null;
  presetId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PromptPresetWithItems {
  preset: PromptPreset;
  items: PromptPresetItem[];
}
