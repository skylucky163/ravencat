/** 定义提示词用户配置持久化端口。 */

import type {
  PromptBinding,
  PromptBindingTargetType,
  PromptCustomBlock,
  PromptPreset,
  PromptPresetItem,
  AssistantPromptSettings,
  AssistantPromptDefinitionState,
  AssistantPromptDefinitionOverride,
  AssistantUserPrompt,
  PromptLanguageMode,
} from './Prompting';
import type { PromptScenarioId } from '@shared/prompt';

/** 2.x 历史片段端口：只按 ID 或列表读取，写入链路已不存在。 */
export interface PromptCustomBlockRepository {
  listCustomBlocks(): Promise<PromptCustomBlock[]>;
  getCustomBlockById(id: string): Promise<PromptCustomBlock | null>;
}

/** 2.x 历史预设端口：只读取绑定指到的预设及其条目。 */
export interface PromptPresetRepository {
  getPresetById(id: string): Promise<PromptPreset | null>;
  listItems(presetId: string): Promise<PromptPresetItem[]>;
}

/** 2.x 历史绑定端口：只按目标查找，绑定内容来自历史数据。 */
export interface PromptBindingRepository {
  find(
    scenarioId: PromptScenarioId,
    targetType: PromptBindingTargetType,
    targetId: string | null
  ): Promise<PromptBinding | null>;
}

export interface AssistantPromptConfigurationRepository {
  listDirectToolNames(assistantId: string): Promise<string[]>;
  setDirectToolExposure(assistantId: string, toolName: string, exposed: boolean): Promise<void>;
  /** 原子替换指定 AI 在工具范围内的星标，范围之外的偏好保持不变。 */
  applyDirectToolSnapshot(assistantIds: readonly string[], toolNames: readonly string[], exposedToolNames: readonly string[]): Promise<void>;
  getAssistantSettings(assistantId: string): Promise<AssistantPromptSettings | null>;
  saveAssistantLanguageMode(assistantId: string, languageMode: PromptLanguageMode): Promise<AssistantPromptSettings>;
  listDefinitionStates(assistantId: string): Promise<AssistantPromptDefinitionState[]>;
  saveDefinitionState(state: AssistantPromptDefinitionState): Promise<AssistantPromptDefinitionState>;
  listDefinitionOverrides(assistantId: string): Promise<AssistantPromptDefinitionOverride[]>;
  saveDefinitionOverride(override: AssistantPromptDefinitionOverride): Promise<AssistantPromptDefinitionOverride>;
  /** 原子覆盖指定 AI 的同一项正文，保留开关、其他正文与全局默认。 */
  applyDefinitionOverrideSnapshot(assistantIds: readonly string[], override: Omit<AssistantPromptDefinitionOverride, 'assistantId'>): Promise<void>;
  resetDefinitionOverride(assistantId: string, definitionId: string, locale: 'zh-CN' | 'en-US'): Promise<boolean>;
  listAssistantUserPrompts(assistantId: string): Promise<AssistantUserPrompt[]>;
  saveAssistantUserPrompt(prompt: AssistantUserPrompt): Promise<AssistantUserPrompt>;
  saveAssistantUserPrompts(prompts: AssistantUserPrompt[]): Promise<AssistantUserPrompt[]>;
  deleteAssistantUserPrompt(id: string, assistantId: string): Promise<boolean>;
}
