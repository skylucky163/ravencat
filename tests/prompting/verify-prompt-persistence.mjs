import { repoRoot } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { loadTypeScriptModule } from '../helpers/load-typescript-module.mjs';
import { createSqliteExecutor } from '../helpers/sqlite-bootstrap-fixture.mjs';


const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-persistence-'));
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const schemaSource = read('src/platform/persistence/sqlite/promptingSchema.ts');
const compiledSchema = ts.transpileModule(schemaSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: 'promptingSchema.ts',
}).outputText;
const schemaModule = { exports: {} };
Function('module', 'exports', compiledSchema)(schemaModule, schemaModule.exports);
const { PROMPTING_SCHEMA } = schemaModule.exports;

const dbPath = path.join(tempRoot, 'prompting.db');
let db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE ai_assistants (id TEXT PRIMARY KEY);
  CREATE TABLE group_chats (id TEXT PRIMARY KEY);
`);
db.exec(PROMPTING_SCHEMA);
db.exec(`
  INSERT INTO ai_assistants (id) VALUES ('assistant-1');
  INSERT INTO group_chats (id) VALUES ('group-1');
  INSERT INTO prompt_custom_blocks (
    id, name, content, category, default_slot, placement, created_at, updated_at
  ) VALUES ('custom-1', '历史自定义规则', '规则正文', 'user_rules', 'user_rules', 'system', 'now', 'now');
  INSERT INTO prompt_presets (
    id, name, scenario_id, base_preset_id, is_system, created_at, updated_at
  ) VALUES
    ('preset-1', '历史预设', 'chat.private_reply', 'system.chat.private_reply', 0, 'now', 'now'),
    ('preset-group', '历史群聊预设', 'chat.group_member_reply', 'system.chat.group_member_reply', 0, 'now', 'now');
  INSERT INTO prompt_preset_items (
    id, preset_id, definition_id, slot, sort_order, enabled, created_at, updated_at
  ) VALUES ('item-1', 'preset-1', 'custom-1', 'user_rules', 10, 1, 'now', 'now');
  INSERT INTO prompt_bindings (
    id, scenario_id, target_type, target_id, preset_id, created_at, updated_at
  ) VALUES
    ('binding-assistant', 'chat.private_reply', 'assistant', 'assistant-1', 'preset-1', 'now', 'now'),
    ('binding-group', 'chat.group_member_reply', 'group', 'group-1', 'preset-group', 'now', 'now');
  INSERT INTO assistant_prompt_settings (assistant_id, language_mode, created_at, updated_at)
    VALUES ('assistant-1', 'zh-CN', 'now', 'now');
  INSERT INTO assistant_prompt_definition_states (assistant_id, definition_id, enabled, sort_order, updated_at)
    VALUES ('assistant-1', 'context.protocol_space', 0, 20, 'now');
  INSERT INTO assistant_prompt_definition_overrides (assistant_id, definition_id, locale, content, updated_at)
    VALUES ('assistant-1', 'foundation.default_core', 'zh-CN', '覆盖正文', 'now');
  INSERT INTO assistant_user_prompts (id, assistant_id, name, content, condition, enabled, sort_order, created_at, updated_at)
    VALUES ('assistant-user-1', 'assistant-1', '用户规则', '原文保存', 'always', 1, 10, 'now', 'now');
  INSERT INTO assistant_tool_permissions (assistant_id, tool_name, enabled, updated_at)
    VALUES ('assistant-1', 'search_protocols', 0, 'now');
`);

// 回归：新数据库的 condition CHECK 不得再接受已退役的 raven_cat_proactive。
assert.throws(() => db.exec(`
  INSERT INTO assistant_user_prompts (
    id, assistant_id, name, content, condition, enabled, sort_order, created_at, updated_at
  ) VALUES ('legacy-raven', 'assistant-1', '遗留', 'x', 'raven_cat_proactive', 1, 99, 'now', 'now');
`), /CHECK constraint failed/);

db.close();

db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM prompt_custom_blocks').get().count, 1);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM prompt_presets').get().count, 2);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM prompt_bindings').get().count, 2);
assert.equal(db.prepare("SELECT language_mode FROM assistant_prompt_settings WHERE assistant_id = 'assistant-1'").get().language_mode, 'zh-CN');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assistant_prompt_definition_states').get().count, 1);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assistant_prompt_definition_overrides').get().count, 1);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assistant_user_prompts').get().count, 1);
assert.equal(db.prepare('SELECT enabled FROM assistant_tool_permissions').get().enabled, 0);
// 旧配置没有新定义时默认关闭；只读解析不补写状态，也不改旧覆盖。
const builtIn = loadTypeScriptModule('src/host/prompt/PromptBuiltInContent.ts');
const { HOST_PROMPT_DEFINITIONS } = loadTypeScriptModule('src/host/prompt/catalog/hostPromptDefinitions.ts', { '../PromptBuiltInContent': builtIn });
const openManagement = () => {
  const { sqlitePromptingRepository } = loadTypeScriptModule('src/features/prompting/infrastructure/SQLitePromptingRepository.ts', {
    '@platform/persistence': { databaseCoordinator: { openTaskExecutor: () => createSqliteExecutor(db) } },
  });
  return loadTypeScriptModule('src/features/prompting/application/ManageAssistantPrompts.ts', {
    './PromptingRuntimeDependencies': { getPromptingRuntimeDependencies: () => ({
      assistantPrompts: sqlitePromptingRepository,
      defaults: { read: async () => ({ overrides: {}, userPrompts: [], agentRegistryExcludedAssistantIds: [] }) },
      catalog: { getById: id => HOST_PROMPT_DEFINITIONS.find(definition => definition.id === id) },
    }) },
  });
};
let management = openManagement();
const definitionId = 'output.format_guidelines';
const resolveFormat = assistantId => management.resolveAssistantPromptConfiguration({ assistantId, scenarioId: 'chat.private_reply' });
const oldStates = db.prepare('SELECT * FROM assistant_prompt_definition_states').all();
const oldOverrides = db.prepare('SELECT * FROM assistant_prompt_definition_overrides').all();
assert.equal((await resolveFormat('assistant-1')).formatGuidelinesEnabled, false);
assert.deepEqual(db.prepare('SELECT * FROM assistant_prompt_definition_states').all(), oldStates);
assert.deepEqual(db.prepare('SELECT * FROM assistant_prompt_definition_overrides').all(), oldOverrides);
db.exec("INSERT INTO ai_assistants (id) VALUES ('assistant-2');");
await management.saveAssistantDefinitionState({ assistantId: 'assistant-1', definitionId, enabled: true });
await management.saveAssistantDefinitionOverride({ assistantId: 'assistant-1', definitionId, locale: 'zh-CN', content: '重启后保留的格式正文' });
db.close();
db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');
management = openManagement();
assert.equal((await resolveFormat('assistant-1')).formatGuidelinesEnabled, true);
assert.equal((await resolveFormat('assistant-1')).overrides[definitionId], '重启后保留的格式正文');
assert.equal((await resolveFormat('assistant-2')).formatGuidelinesEnabled, false);
assert.equal((await resolveFormat('assistant-2')).overrides[definitionId], undefined);
assert.deepEqual(db.prepare('SELECT * FROM assistant_prompt_definition_states WHERE definition_id <> ?').all(definitionId), oldStates);
assert.deepEqual(db.prepare('SELECT * FROM assistant_prompt_definition_overrides WHERE definition_id <> ?').all(definitionId), oldOverrides);
await management.resetAssistantDefinitionOverride({ assistantId: 'assistant-1', definitionId, locale: 'zh-CN' });
assert.equal((await resolveFormat('assistant-1')).overrides[definitionId], undefined);
assert.equal((await resolveFormat('assistant-1')).formatGuidelinesEnabled, true);
assert.throws(() => db.exec(`
  INSERT INTO prompt_bindings (
    id, scenario_id, target_type, target_id, preset_id, created_at, updated_at
  ) VALUES ('duplicate', 'chat.private_reply', 'assistant', 'assistant-1', 'preset-1', 'now', 'now');
`), /UNIQUE constraint failed/);
db.exec("DELETE FROM ai_assistants WHERE id = 'assistant-1';");
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM prompt_bindings WHERE target_type = 'assistant'").get().count, 0);
for (const table of [
  'assistant_prompt_settings', 'assistant_prompt_definition_states',
  'assistant_prompt_definition_overrides', 'assistant_user_prompts', 'assistant_tool_permissions',
]) {
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `${table} 未随 AI 级联删除`);
}
db.exec("DELETE FROM group_chats WHERE id = 'group-1';");
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM prompt_bindings WHERE target_type = 'group'").get().count, 0);
db.exec("DELETE FROM prompt_presets WHERE id = 'preset-1';");
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM prompt_preset_items WHERE preset_id = 'preset-1'").get().count, 0);
db.close();

console.log('提示词持久化检查通过（重启保留格式规则开关与覆盖、AI 隔离、旧配置只读兼容、唯一约束与级联删除）。');
fs.rmSync(tempRoot, { recursive: true, force: true });
