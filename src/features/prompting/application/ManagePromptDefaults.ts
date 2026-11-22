/** 默认配置由 Prompting 管理，Host 消费同一配置，页面不保存另一套状态。 */
import type { DefaultUserPrompt } from '../domain/PromptDefaults';
import { getPromptingRuntimeDependencies } from './PromptingRuntimeDependencies';

export function readPromptDefaults() {
  return getPromptingRuntimeDependencies().defaults.read();
}

export function listLegacyGroupAdminPrompts() {
  return getPromptingRuntimeDependencies().defaults.listLegacyGroupAdminPrompts();
}

export async function getAppToolPackageSettings() {
  return (await readPromptDefaults()).appToolPackages;
}

export function setAppToolPackageEnabled(packageId: string, enabled: boolean) {
  return getPromptingRuntimeDependencies().defaults.setEnabled(`app_tool_package:${packageId}`, enabled);
}

export async function getDefaultPromptEditor() {
  const dependencies = getPromptingRuntimeDependencies();
  const [defaults, tools] = await Promise.all([dependencies.defaults.read(), dependencies.tools.list()]);
  return {
    ...defaults,
    tools: tools.map((tool) => ({ ...tool, enabled: defaults.toolPermissions[tool.name] ?? tool.defaultEnabled })),
  };
}

export function saveDefaultDefinition(definitionId: string, content: string) {
  const dependencies = getPromptingRuntimeDependencies();
  if (!dependencies.catalog.getById(definitionId)?.defaultContent) throw new Error('该条目没有可编辑的默认正文');
  if (definitionId !== 'foundation.default_core' && !content.trim()) throw new Error('提示词正文不能为空');
  return dependencies.defaults.saveOverride(definitionId, content);
}

export function resetDefaultDefinition(definitionId: string) {
  return getPromptingRuntimeDependencies().defaults.resetOverride(definitionId);
}

export function saveDefaultUserPrompt(prompt: DefaultUserPrompt) {
  if (!prompt.content.trim()) throw new Error('提示词正文不能为空');
  return getPromptingRuntimeDependencies().defaults.saveUserPrompt({ ...prompt, name: prompt.name.trim() || '自定义提示词' });
}

export function deleteDefaultUserPrompt(id: string) {
  return getPromptingRuntimeDependencies().defaults.deleteUserPrompt(id);
}

export function reorderDefaultUserPrompts(promptIds: readonly string[]) {
  return getPromptingRuntimeDependencies().defaults.reorderUserPrompts(promptIds);
}

export function setDefaultPromptSwitch(key: string, enabled: boolean) {
  if (!key.startsWith('tool:')) throw new Error('未知默认开关');
  return getPromptingRuntimeDependencies().defaults.setEnabled(key, enabled);
}

export function listPromptAssistantOptions() {
  return getPromptingRuntimeDependencies().assistants.listOptions();
}

export async function getAgentRegistrySettings() {
  const dependencies = getPromptingRuntimeDependencies();
  const [assistants, defaults] = await Promise.all([dependencies.assistants.list(), dependencies.defaults.read()]);
  const excludedIds = new Set(defaults.agentRegistryExcludedAssistantIds);
  return assistants.map((assistant) => ({
    id: assistant.id,
    name: assistant.name,
    model: assistant.model,
    included: !excludedIds.has(assistant.id),
  }));
}

export function setAgentRegistryAssistantIncluded(assistantId: string, included: boolean) {
  return getPromptingRuntimeDependencies().defaults.setEnabled(`agent_registry:${assistantId}`, included);
}

export async function getPromptAssistant(assistantId: string) {
  const assistant = (await getPromptingRuntimeDependencies().assistants.list()).find((item) => item.id === assistantId);
  if (!assistant) throw new Error('AI 不存在');
  return assistant;
}
