/**
 * 保留原验证入口，检查现役 Moments 工具公共出口与生产注册契约。
 * V1 迁移已完成，不再盘点旧文件名、私有 helper 或已删除的 Repository API。
 * 工具业务由 verify-moments-v2-domain / verify-moments-social-inbox 执行；
 * 历史 moments 提示词条件不匹配现役场景由 verify-prompt-center 保护。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(relativePath, requireMock = (specifier) => {
  throw new Error(`${relativePath} 未声明依赖：${specifier}`);
}) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: relativePath,
  });
  const module = { exports: {} };
  new Function('exports', 'require', 'module', compiled.outputText)(module.exports, requireMock, module);
  return module.exports;
}

// 此处只验证注册，未执行工具业务；隔离界面、应用服务及其他 Feature 的初始化。
const placeholder = new Proxy({}, {
  get: (_target, name) => ({
    name: String(name),
    definition: { name: String(name), description: '', parameters: { type: 'object' } },
  }),
});
const moments = load('src/features/moments/index.ts', (specifier) => (
  specifier.startsWith('./aiTools/')
    ? load(`src/features/moments/${specifier.slice(2)}.ts`, () => placeholder)
    : {}
));
const { AgentToolRegistry } = load('src/platform/agentRuntime/AgentToolRegistry.ts');
const adapter = load('src/host/composition/agent/LegacyAgentToolAdapter.ts');
// 非 Moments 工具不执行，但注册表加载时仍校验真实的产品包绑定。
const phoneTools = new Proxy(load('src/features/phoneTools/toolPackages/ToolPackageCatalog.ts'), {
  get: (target, name) => target[name] ?? placeholder[String(name).startsWith('Xiaohongshu')
    ? String(name).replace(/Tool$/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    : name],
});
const momentShareTool = load('src/host/composition/agent/ShareMomentTool.ts', () => placeholder);
const registration = load('src/host/composition/agent/createAgentToolRegistry.ts', (specifier) => {
  if (specifier === '@platform/ai') return load('src/platform/ai/moonshotEndpoint.ts');
  if (specifier === '@shared/aiTools') return load('src/shared/aiTools/ToolCompletionIntent.ts');
  if (specifier === '@features/moments') return moments;
  if (specifier === '@features/phoneTools') return phoneTools;
  if (specifier === '@platform/agentRuntime') return { AgentToolRegistry };
  if (specifier === './LegacyAgentToolAdapter') return adapter;
  if (specifier === './ApplicationSettingsTools') return { applicationSettingsTools: [] };
  if (specifier === './ShareMomentTool') return momentShareTool;
  if (specifier === './GroupManagementTools') return { groupManagementTools: [] };
  if (specifier === '@features/phoneTools/neteaseComposition') return { productionNetEaseChildTools: [] };
  assert.ok(specifier.startsWith('@features/'), `Registry 未声明依赖：${specifier}`);
  return placeholder;
});
const expectedNames = [
  'searchMoments', 'getMomentDetail', 'readSocialInbox', 'aiLikeMoment', 'aiCommentMoment',
  'aiCreateMoment', 'aiReplyMomentComment', 'aiUnlikeMoment', 'aiDeleteOwnMoment',
  'aiDeleteOwnMomentComment', 'share_moment',
];
const registry = registration.createAgentToolRegistry({ createLegacyContext: () => ({}) });
const descriptors = registry.list().filter((tool) => tool.owner === 'moments');
assert.deepEqual(descriptors.map((tool) => tool.name).sort(), [...expectedNames].sort());
for (const descriptor of descriptors) {
  const publicTool = Object.values({ ...moments, ...momentShareTool }).find((tool) => tool?.name === descriptor.name);
  assert.ok(publicTool, `${descriptor.name} 必须使用所属能力的工具定义`);
  assert.equal(publicTool.definition.name, descriptor.name);
  assert.deepEqual(descriptor.inputSchema, publicTool.definition.parameters);
}
assert.deepEqual(registration.getRuntimeAllowedToolNamesForAI({
  enableTools: true, isHostAI: false, triggerSource: 'chat', allowedToolNames: expectedNames,
}).sort(), [...expectedNames].sort(), '普通 AI 获得授权后也能使用 Moments 工具');
assert.deepEqual(registration.getRuntimeAllowedToolNamesForAI({
  enableTools: false, allowedToolNames: expectedNames,
}), [], '关闭工具时不得暴露 Moments 工具');

const content = load('src/host/prompt/PromptBuiltInContent.ts');
const { HOST_PROMPT_DEFINITIONS } = load('src/host/prompt/catalog/hostPromptDefinitions.ts', (specifier) => {
  assert.equal(specifier, '../PromptBuiltInContent');
  return content;
});
for (const id of ['context.moments_social_inbox']) {
  assert.ok(HOST_PROMPT_DEFINITIONS.some((definition) => definition.id === id), `${id} 必须保持注册`);
}
assert.ok(HOST_PROMPT_DEFINITIONS.every((definition) => (
  !definition.supportedScenarios.includes('moments.interaction')
)), '时刻上下文不得恢复为独立的 V1 模型场景');
const { getSystemPromptPreset } = load('src/host/prompt/compiler/systemPromptPresets.ts');
// 自主唤醒复用普通单聊组装，完整行为由 verify-memory-v3-prompt 覆盖。
for (const scenario of ['chat.private_reply']) {
  assert.ok(getSystemPromptPreset(scenario).items.some((item) => (
    item.definitionId === 'context.moments_social_inbox' && item.enabled
  )), `${scenario} 必须保留 Social Inbox`);
}

console.log('Moments 工具公共出口、生产注册与提示词目录契约验证通过。');
