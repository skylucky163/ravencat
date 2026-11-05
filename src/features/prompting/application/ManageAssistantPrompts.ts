/** 管理每 AI 的语言、内置覆盖和用户提示词，并为 Host 解析本轮有效配置。 */

import type { PromptScenarioId } from '@shared/prompt';
import type { PromptDefaults } from '../domain/PromptDefaults';
import type {
  AssistantPromptDefinitionOverride,
  AssistantPromptDefinitionState,
  AssistantPromptSettings,
  AssistantUserPrompt,
  PromptLanguageMode,
  UserPromptCondition,
} from '../domain/Prompting';
import { getPromptingRuntimeDependencies } from './PromptingRuntimeDependencies';

export interface AssistantPromptEditorDetails {
  directToolNames: string[];
  paragraphBreaksEnabled: boolean;
  actionDescriptionEnabled: boolean;
  imageGroundingEnabled: boolean;
  timeEnabled: boolean;
  messageTimestampsEnabled: boolean;
  batteryEnabled: boolean;
  /** 第 11 项「用户状态与一起听」注入开关，默认开启。 */
  userStateEnabled: boolean;
  /** 第 12 项「时刻社交信息」注入开关，默认开启。 */
  socialEnabled: boolean;
  settings: AssistantPromptSettings;
  states: AssistantPromptDefinitionState[];
  overrides: AssistantPromptDefinitionOverride[];
  userPrompts: AssistantUserPrompt[];
  tools: {
    name: string;
    description: string;
    enabled: boolean;
    mutating: boolean;
    callOnly: boolean;
    unavailableReason?: string;
  }[];
}

export interface ResolvedAssistantPromptConfiguration {
  agentRegistryExcludedAssistantIds: string[];
  paragraphBreaksEnabled: boolean;
  actionDescriptionEnabled: boolean;
  timeEnabled: boolean;
  messageTimestampsEnabled: boolean;
  batteryEnabled: boolean;
  userStateEnabled: boolean;
  socialEnabled: boolean;
  overrides: Record<string, string>;
  disabledDefinitionIds: string[];
  userPrompts: AssistantUserPrompt[];
}

/**
 * 内置 Prompt 固定中文后，覆盖正文按这一 locale 行读取。
 *
 * `assistant_prompt_definition_overrides.locale` 仍是可写列（历史行可能是 en-US），
 * 运行时只消费 zh-CN 行；历史上误存的英文覆盖不会生效，也不需要迁移。
 */
const RESOLVED_PROMPT_LOCALE = 'zh-CN';

export async function getAssistantPromptEditorDetails(
  assistantId: string,
  defaults?: PromptDefaults,
): Promise<AssistantPromptEditorDetails> {
  const dependencies = getPromptingRuntimeDependencies();
  const [storedSettings, states, overrides, userPrompts, tools, directToolNames] = await Promise.all([
    dependencies.assistantPrompts.getAssistantSettings(assistantId),
    dependencies.assistantPrompts.listDefinitionStates(assistantId),
    dependencies.assistantPrompts.listDefinitionOverrides(assistantId),
    dependencies.assistantPrompts.listAssistantUserPrompts(assistantId),
    getAssistantToolPermissions(assistantId, defaults),
    dependencies.assistantPrompts.listDirectToolNames(assistantId),
  ]);
  const now = new Date().toISOString();
  const settings = storedSettings ?? {
    assistantId,
    languageMode: 'system' as const,
    createdAt: now,
    updatedAt: now,
  };
  return {
    directToolNames,
    settings,
    paragraphBreaksEnabled: states.find((state) => state.definitionId === 'output.paragraph_breaks')?.enabled ?? false,
    actionDescriptionEnabled: states.find((state) => state.definitionId === 'output.action_description')?.enabled ?? false,
    imageGroundingEnabled: states.find((state) => state.definitionId === 'input.image_grounding')?.enabled ?? true,
    timeEnabled: states.find((state) => state.definitionId === 'context.time_awareness')?.enabled ?? true,
    messageTimestampsEnabled: states.find((state) => state.definitionId === 'context.message_timestamps')?.enabled ?? false,
    batteryEnabled: states.find((state) => state.definitionId === 'context.device_battery')?.enabled ?? true,
    userStateEnabled: states.find((state) => state.definitionId === 'context.user_state')?.enabled ?? true,
    socialEnabled: states.find((state) => state.definitionId === 'context.social')?.enabled ?? true,
    states,
    overrides,
    userPrompts: [...userPrompts].sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id)),
    tools,
  };
}

/** 手机目录与编辑器共用单项权限解析，不读取 AI 专属提示词。 */
export async function getAssistantToolPermissions(
  assistantId: string,
  defaults?: PromptDefaults,
): Promise<AssistantPromptEditorDetails['tools']> {
  const dependencies = getPromptingRuntimeDependencies();
  const [definitions, overrides, defaultValues] = await Promise.all([
    dependencies.tools.list(assistantId), dependencies.tools.listOverrides(assistantId), defaults ?? dependencies.defaults.read(),
  ]);
  const overrideByName = new Map(overrides.map((override) => [override.toolName, override.enabled]));
  return definitions.map((definition) => ({
    ...definition,
    enabled: overrideByName.get(definition.name) ?? defaultValues.toolPermissions[definition.name] ?? definition.defaultEnabled,
  }));
}

export async function resolveAssistantPromptConfiguration(params: {
  assistantId: string;
  scenarioId: PromptScenarioId;
  hasImage?: boolean;
  toolsEnabled?: boolean;
}): Promise<ResolvedAssistantPromptConfiguration> {
  const repository = getPromptingRuntimeDependencies().assistantPrompts;
  const [states, overrides, userPrompts, defaults] = await Promise.all([
    repository.listDefinitionStates(params.assistantId),
    repository.listDefinitionOverrides(params.assistantId),
    repository.listAssistantUserPrompts(params.assistantId),
    getPromptingRuntimeDependencies().defaults.read(),
  ]);
  return {
    paragraphBreaksEnabled: states.find((state) => state.definitionId === 'output.paragraph_breaks')?.enabled ?? false,
    actionDescriptionEnabled: states.find((state) => state.definitionId === 'output.action_description')?.enabled ?? false,
    timeEnabled: states.find((state) => state.definitionId === 'context.time_awareness')?.enabled ?? true,
    messageTimestampsEnabled: states.find((state) => state.definitionId === 'context.message_timestamps')?.enabled ?? false,
    batteryEnabled: states.find((state) => state.definitionId === 'context.device_battery')?.enabled ?? true,
    userStateEnabled: states.find((state) => state.definitionId === 'context.user_state')?.enabled ?? true,
    socialEnabled: states.find((state) => state.definitionId === 'context.social')?.enabled ?? true,
    agentRegistryExcludedAssistantIds: defaults.agentRegistryExcludedAssistantIds,
    overrides: { ...defaults.overrides, ...Object.fromEntries(
      overrides
        .filter((override) => override.locale === RESOLVED_PROMPT_LOCALE)
        .map((override) => [override.definitionId, override.content])
    ) },
    disabledDefinitionIds: states.filter((state) => !state.enabled).map((state) => state.definitionId),
    userPrompts: [
      ...defaults.userPrompts.filter((prompt) => prompt.enabled).map((prompt): AssistantUserPrompt => ({
        ...prompt, id: `default:${prompt.id}`, assistantId: params.assistantId,
        condition: 'always', createdAt: '', updatedAt: '',
      })),
      ...userPrompts.filter((prompt) => prompt.enabled && conditionMatches(prompt.condition, params))
        .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id)),
    ],
  };
}

/** 图片附件 owner 在确认直传路线后读取；OCR 和工具观察不消费这条提醒。 */
export async function resolveImageGroundingPrompt(assistantId: string): Promise<string | null> {
  const dependencies = getPromptingRuntimeDependencies();
  const states = await dependencies.assistantPrompts.listDefinitionStates(assistantId);
  if (states.find((state) => state.definitionId === 'input.image_grounding')?.enabled === false) return null;
  const [overrides, defaults] = await Promise.all([
    dependencies.assistantPrompts.listDefinitionOverrides(assistantId),
    dependencies.defaults.read(),
  ]);
  return overrides.find((override) => override.definitionId === 'input.image_grounding' && override.locale === RESOLVED_PROMPT_LOCALE)?.content
    ?? defaults.overrides['input.image_grounding']
    ?? dependencies.catalog.getById('input.image_grounding')!.defaultContent!;
}

/** 视觉识别正文没有独立开关，随该 AI 是否绑定视觉模型生效。 */
export async function resolveVisionOCRPrompt(assistantId: string): Promise<string> {
  const dependencies = getPromptingRuntimeDependencies();
  const [overrides, defaults] = await Promise.all([
    dependencies.assistantPrompts.listDefinitionOverrides(assistantId),
    dependencies.defaults.read(),
  ]);
  return overrides.find((override) => override.definitionId === 'internal.vision_ocr' && override.locale === RESOLVED_PROMPT_LOCALE)?.content
    ?? defaults.overrides['internal.vision_ocr']
    ?? dependencies.catalog.getById('internal.vision_ocr')!.defaultContent!;
}

/** 群摘要没有所属 AI，只读全局正文；单聊仍按来源 AI 覆盖优先。 */
export async function resolveChatSummaryPromptOverride(
  assistantId: string | null,
  level: 'primary' | 'secondary',
  kind: 'private' | 'group' = 'private'
): Promise<string | undefined> {
  const dependencies = getPromptingRuntimeDependencies();
  const definitionId = kind === 'group'
    ? level === 'primary' ? 'internal.group_chat_summary' : 'internal.group_chat_secondary_summary'
    : level === 'primary' ? 'internal.chat_summary' : 'internal.chat_secondary_summary';
  const scopedAssistantId = kind === 'group' ? null : assistantId;
  const [overrides, defaults] = await Promise.all([
    scopedAssistantId === null ? [] : dependencies.assistantPrompts.listDefinitionOverrides(scopedAssistantId),
    dependencies.defaults.read(),
  ]);
  return overrides.find((override) => override.definitionId === definitionId && override.locale === RESOLVED_PROMPT_LOCALE)?.content
    ?? defaults.overrides[definitionId];
}

export function getSummaryPromptGenerationState(assistantId: string) {
  return getPromptingRuntimeDependencies().summary.getGenerationState(assistantId);
}

export function setAssistantPromptLanguage(
  assistantId: string,
  languageMode: PromptLanguageMode
): Promise<AssistantPromptSettings> {
  return getPromptingRuntimeDependencies().assistantPrompts
    .saveAssistantLanguageMode(assistantId, languageMode);
}

export function saveAssistantDefinitionState(params: {
  assistantId: string;
  definitionId: string;
  enabled: boolean;
  sortOrder?: number | null;
}): Promise<AssistantPromptDefinitionState> {
  const definition = getPromptingRuntimeDependencies().catalog.getById(params.definitionId);
  if (!definition) throw new Error('提示词定义不存在');
  if (!params.enabled && definition.protection === 'locked') {
    throw new Error('聊天功能必需项不能关闭');
  }
  return getPromptingRuntimeDependencies().assistantPrompts.saveDefinitionState({
    assistantId: params.assistantId,
    definitionId: params.definitionId,
    enabled: params.enabled,
    sortOrder: params.sortOrder ?? null,
    updatedAt: new Date().toISOString(),
  });
}

export function saveAssistantDefinitionOverride(params: {
  assistantId: string;
  definitionId: string;
  /** 内置正文只维护中文；覆盖行固定写在 zh-CN 列，与运行时读取保持一致。 */
  locale: 'zh-CN';
  content: string;
}): Promise<AssistantPromptDefinitionOverride> {
  const definition = getPromptingRuntimeDependencies().catalog.getById(params.definitionId);
  if (!definition?.defaultContent) throw new Error('该内置提示词不支持正文覆盖');
  if (definition.editScope === 'global') throw new Error('这一项没有所属 AI，只能修改全局正文');
  if (params.definitionId !== 'foundation.default_core' && !params.content.trim()) throw new Error('提示词正文不能为空');
  return getPromptingRuntimeDependencies().assistantPrompts.saveDefinitionOverride({
    ...params,
    updatedAt: new Date().toISOString(),
  });
}

/** 使用编辑器草稿覆盖现有 AI 的同一项正文，不改变每位 AI 的注入开关。 */
export async function applyAssistantDefinitionGlobally(params: {
  definitionId: string;
  content: string;
}): Promise<void> {
  const dependencies = getPromptingRuntimeDependencies();
  const definition = dependencies.catalog.getById(params.definitionId);
  if (!definition?.defaultContent) throw new Error('该内置提示词不支持正文覆盖');
  if (definition.editScope === 'global') throw new Error('这一项没有所属 AI，只能修改全局正文');
  if (params.definitionId !== 'foundation.default_core' && !params.content.trim()) throw new Error('提示词正文不能为空');
  const assistants = await dependencies.assistants.listOptions();
  await dependencies.assistantPrompts.applyDefinitionOverrideSnapshot(assistants.map((assistant) => assistant.id), {
    ...params, locale: RESOLVED_PROMPT_LOCALE, updatedAt: new Date().toISOString(),
  });
}

export function resetAssistantDefinitionOverride(params: {
  assistantId: string;
  definitionId: string;
  locale: 'zh-CN';
}): Promise<boolean> {
  return getPromptingRuntimeDependencies().assistantPrompts.resetDefinitionOverride(
    params.assistantId,
    params.definitionId,
    params.locale
  );
}

export async function createAssistantUserPrompt(params: {
  assistantId: string;
  name: string;
  content: string;
  condition: UserPromptCondition;
  enabled: boolean;
  sortOrder: number;
}): Promise<AssistantUserPrompt> {
  const repository = getPromptingRuntimeDependencies().assistantPrompts;
  const now = new Date().toISOString();
  const prompt: AssistantUserPrompt = {
    id: `user_prompt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    assistantId: params.assistantId,
    name: params.name.trim() || '自定义提示词',
    content: params.content,
    condition: params.condition,
    enabled: params.enabled,
    sortOrder: params.sortOrder,
    createdAt: now,
    updatedAt: now,
  };
  assertUserPromptContent(prompt.content);
  return repository.saveAssistantUserPrompt(prompt);
}

export function updateAssistantUserPrompt(
  prompt: AssistantUserPrompt
): Promise<AssistantUserPrompt> {
  assertUserPromptContent(prompt.content);
  return getPromptingRuntimeDependencies().assistantPrompts.saveAssistantUserPrompt({
    ...prompt,
    name: prompt.name.trim() || '自定义提示词',
    updatedAt: new Date().toISOString(),
  });
}

export function reorderAssistantUserPrompts(
  first: AssistantUserPrompt,
  second: AssistantUserPrompt
): Promise<AssistantUserPrompt[]> {
  if (first.assistantId !== second.assistantId) {
    throw new Error('只能调整同一 AI 的提示词顺序');
  }
  const updatedAt = new Date().toISOString();
  return getPromptingRuntimeDependencies().assistantPrompts.saveAssistantUserPrompts([
    { ...first, sortOrder: second.sortOrder, updatedAt },
    { ...second, sortOrder: first.sortOrder, updatedAt },
  ]);
}

export function deleteAssistantUserPrompt(id: string, assistantId: string): Promise<boolean> {
  return getPromptingRuntimeDependencies().assistantPrompts.deleteAssistantUserPrompt(id, assistantId);
}

export async function setAssistantToolPermission(
  assistantId: string,
  toolName: string,
  enabled: boolean
): Promise<void> {
  await assertAssistantToolEditable(assistantId, toolName);
  await getPromptingRuntimeDependencies().tools.set(assistantId, toolName, enabled);
}

/** 星标只决定 schema 是否常驻，不授予调用权限。 */
export async function setAssistantDirectToolExposure(
  assistantId: string,
  toolName: string,
  exposed: boolean
): Promise<void> {
  await assertAssistantToolEditable(assistantId, toolName);
  await getPromptingRuntimeDependencies().assistantPrompts.setDirectToolExposure(assistantId, toolName, exposed);
}

/** 全局应用是一次普通工具星标快照，不改写主理专属偏好或调用权限。 */
export async function applyAssistantDirectToolsGlobally(directToolNames: readonly string[]): Promise<void> {
  const dependencies = getPromptingRuntimeDependencies();
  const [tools, assistants] = await Promise.all([dependencies.tools.list(), dependencies.assistants.listOptions()]);
  const selectedNames = new Set(directToolNames);
  const toolNames = tools.filter((tool) => !tool.hostOnly).map((tool) => tool.name);
  await dependencies.assistantPrompts.applyDirectToolSnapshot(
    assistants.map((assistant) => assistant.id),
    toolNames,
    toolNames.filter((name) => selectedNames.has(name))
  );
}

async function assertAssistantToolEditable(assistantId: string, toolName: string): Promise<void> {
  const dependencies = getPromptingRuntimeDependencies();
  const tool = (await dependencies.tools.list(assistantId)).find((item) => item.name === toolName);
  if (!tool) throw new Error('工具不存在或不在提示词中心管理');
  if (tool.unavailableReason) throw new Error(tool.unavailableReason);
  if (tool.hostOnly) {
    const assistant = (await dependencies.assistants.listOptions()).find((item) => item.id === assistantId);
    if (tool.cooldownOnly ? !assistant?.isInHostCooldown : !assistant?.isHostAI) {
      throw new Error(tool.cooldownOnly ? '只有冷静期中的原主理 AI 可以配置此工具' : '只有主理 AI 可以修改主理专属工具');
    }
  }
}

export function listAssistantDirectToolNames(assistantId: string): Promise<string[]> {
  return getPromptingRuntimeDependencies().assistantPrompts.listDirectToolNames(assistantId);
}

function conditionMatches(
  condition: string,
  params: { scenarioId: PromptScenarioId; hasImage?: boolean; toolsEnabled?: boolean }
): boolean {
  if (condition === 'always') return true;
  if (condition === 'private_chat') return params.scenarioId === 'chat.private_reply';
  if (condition === 'group_chat') return params.scenarioId === 'chat.group_member_reply';
  if (condition === 'call') return params.scenarioId === 'call.live_reply';
  if (condition === 'image_present') return params.hasImage === true;
  if (condition === 'tools_enabled') return params.toolsEnabled === true;
  // 运行时遗留或已退役的 condition（例如 moments）一律不匹配，
  // 不再落到末尾的 tools_enabled 兜底。
  return false;
}

function assertUserPromptContent(content: string): void {
  if (!content.trim()) throw new Error('提示词正文不能为空');
}
