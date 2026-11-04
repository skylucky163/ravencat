import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-catalog-check-'));

const definitionModules = [
  ['src/host/prompt/catalog/hostPromptDefinitions.ts', 'HOST_PROMPT_DEFINITIONS'],
  ['src/features/calls/application/CallPromptDefinitions.ts', 'CALL_PROMPT_DEFINITIONS'],
  ['src/features/chat/group/application/GroupTaskPromptDefinitions.ts', 'GROUP_TASK_PROMPT_DEFINITIONS'],
  ['src/features/chat/reply/application/ReplyTaskPromptDefinitions.ts', 'REPLY_TASK_PROMPT_DEFINITIONS'],
  ['src/features/chat/summary/application/ChatSummaryPrompt.ts', 'CHAT_SUMMARY_PROMPT_DEFINITIONS'],
  ['src/features/companion/application/CompanionPromptDefinitions.ts', 'COMPANION_PROMPT_DEFINITIONS'],
  ['src/features/togetherListening/application/TogetherListeningPromptDefinitions.ts', 'TOGETHER_LISTENING_PROMPT_DEFINITIONS'],
];

function compile(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
  });
  const outputPath = path.join(tempRoot, relativePath.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output.outputText, 'utf8');
  return outputPath;
}

function write(relativePath, content) {
  const outputPath = path.join(tempRoot, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content, 'utf8');
}

write('node_modules/@shared/prompt/index.js', [
  "exports.__stub = true;",
].join('\n'));
compile('src/host/prompt/PromptBuiltInContent.ts');
compile('src/features/calls/application/CallPromptBlocks.ts');
compile('src/features/chat/group/application/GroupTaskPromptBlocks.ts');
compile('src/features/chat/reply/application/ReplyTaskPromptBlocks.ts');
compile('src/features/chat/summary/domain/ChatSummaryRepository.ts');

compile('src/features/companion/application/CompanionPromptBlocks.ts');
write('node_modules/@features/chat/index.js', `module.exports = require(${JSON.stringify(compile('src/features/chat/reply/application/AutonomousReplyContract.ts'))});`);
compile('src/features/togetherListening/application/TogetherListeningPromptBlocks.ts');

const definitions = definitionModules.flatMap(([relativePath, exportName]) => {
  const loaded = require(compile(relativePath));
  assert.ok(Array.isArray(loaded[exportName]), `${exportName} 不是定义数组`);
  return loaded[exportName];
});

const actualIds = definitions.map((definition) => definition.id).sort();
assert.ok(actualIds.length > 0, '内置提示词目录为空');
assert.equal(new Set(actualIds).size, actualIds.length, '提示词定义 ID 重复');
for (const definition of definitions) {
  assert.ok(definition.version > 0, `${definition.id} 缺少有效版本`);
  assert.ok(definition.owner, `${definition.id} 缺少所属模块`);
  assert.ok(definition.sourcePath, `${definition.id} 缺少代码来源`);
  assert.ok(definition.supportedScenarios.length > 0, `${definition.id} 缺少适用场景`);
  if (definition.contentKind === 'provider') {
    assert.ok(definition.providerId, `${definition.id} 缺少 providerId`);
  }
}

const providerRegistrySource = fs.readFileSync(
  path.join(repoRoot, 'src/host/prompt/providers/HostPromptProviderRegistry.ts'),
  'utf8'
);
const providerMapSource = providerRegistrySource.match(
  /const PROVIDERS:[\s\S]*?=\s*\{([\s\S]*?)\n\};/
)?.[1] || '';
const registeredProviderIds = [...providerMapSource.matchAll(/^\s*'([^']+)':/gm)]
  .map((match) => match[1]);
const { PIPELINE_PROMPT_PROVIDER_IDS } = require(
  compile('src/host/prompt/providers/PromptProviderManifest.ts')
);
const resolvableProviderIds = new Set([
  ...registeredProviderIds,
  ...PIPELINE_PROMPT_PROVIDER_IDS,
]);
for (const definition of definitions.filter((item) => item.contentKind === 'provider')) {
  assert.ok(
    resolvableProviderIds.has(definition.providerId),
    `${definition.id} 引用了未注册 Provider：${definition.providerId}`
  );
}

const { getSystemPromptPreset } = require(
  compile('src/host/prompt/compiler/systemPromptPresets.ts')
);
// 在目录和 Provider 的装配边界注入真实清单，执行启动校验并沿用它的场景范围。
write('src/host/prompt/catalog/index.js', 'exports.promptCatalog = {};');
require(path.join(tempRoot, 'src/host/prompt/catalog/index.js')).promptCatalog.list = () => definitions;
write('src/host/prompt/providers/index.js', [
  `exports.REGISTERED_HOST_PROMPT_PROVIDER_IDS = ${JSON.stringify(registeredProviderIds)};`,
  `exports.PIPELINE_PROMPT_PROVIDER_IDS = ${JSON.stringify(PIPELINE_PROMPT_PROVIDER_IDS)};`,
].join('\n'));
const { PROMPT_SCENARIO_IDS, validateBuiltInPromptArchitecture } = require(
  compile('src/host/prompt/compiler/PromptArchitectureValidator.ts')
);
assert.doesNotThrow(validateBuiltInPromptArchitecture, '内置提示词架构必须通过真实启动校验');
const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
for (const scenario of PROMPT_SCENARIO_IDS) {
  const preset = getSystemPromptPreset(scenario);
  assert.equal(preset.scenarioId, scenario, `${preset.id} 的场景不匹配`);
  assert.ok(preset.items.length > 0, `${scenario} 没有默认预设条目`);
  assert.equal(
    new Set(preset.items.map((item) => item.definitionId)).size,
    preset.items.length,
    `${scenario} 默认预设重复引用定义`,
  );
  assert.ok(
    preset.items.some((item) => item.protection === 'locked' && item.required),
    `${scenario} 默认预设没有必需受保护定义`,
  );
  assert.ok(
    preset.items.every((item) => item.enabled && Number.isFinite(item.sortOrder)),
    `${scenario} 默认预设包含无效条目`,
  );
  for (const presetItem of preset.items) {
    const definition = definitionById.get(presetItem.definitionId);
    assert.ok(definition, `${preset.id} 引用了不存在的定义：${presetItem.definitionId}`);
    assert.ok(
      definition.supportedScenarios.includes(scenario),
      `${preset.id} 引用了不支持当前场景的定义：${presetItem.definitionId}`
    );
    assert.equal(
      presetItem.slot,
      definition.defaultSlot,
      `${preset.id} 使用了无效插槽：${presetItem.definitionId}`
    );
    assert.equal(
      presetItem.protection,
      definition.protection,
      `${preset.id} 的保护级别与目录不一致：${presetItem.definitionId}`
    );
  }
}

const privateDefinitionIds = new Set(
  getSystemPromptPreset('chat.private_reply').items.map((item) => item.definitionId),
);
assert.ok(privateDefinitionIds.has('foundation.default_core'));
assert.ok(privateDefinitionIds.has('persona.assistant'));
const callDefinitionIds = new Set(
  getSystemPromptPreset('call.live_reply').items.map((item) => item.definitionId),
);
assert.ok(callDefinitionIds.has('output.call_plain_spoken_text'));

const promptingRoot = path.join(repoRoot, 'src', 'features', 'prompting');
const promptingSource = ['application', 'presentation'].flatMap((layer) => {
  const layerRoot = path.join(promptingRoot, layer);
  return fs.readdirSync(layerRoot, { recursive: true, encoding: 'utf8' })
    .filter((entry) => /\.(?:ts|tsx)$/.test(entry))
    .map((entry) => fs.readFileSync(path.join(layerRoot, entry), 'utf8'));
}).join('\n');
assert.doesNotMatch(promptingSource, /getDB\(|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE FROM\b/);
// 实际 App → Host → Feature 路由接线由 verify-prompt-overview 的行为测试覆盖。

console.log(`提示词目录检查通过（${definitions.length} 个内置定义，Provider 与系统预设引用均可解析）。`);
fs.rmSync(tempRoot, { recursive: true, force: true });
