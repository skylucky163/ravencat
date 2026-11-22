/** 小型 SQLite 用例也装配真实的 canonical anchor schema 与查询依赖。 */
import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import ts from 'typescript';

const sourceCache = new Map();
function loadSource(url) {
  if (sourceCache.has(url.href)) return sourceCache.get(url.href).exports;
  const module = { exports: {} };
  sourceCache.set(url.href, module);
  new Function('require', 'module', 'exports', compile(url))((id) => {
    return loadSource(new URL(`${id}.ts`, url));
  }, module, module.exports);
  return module.exports;
}

const compile = (url) => ts.transpileModule(fs.readFileSync(url, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const schema = { exports: {} };
const schemaUrl = new URL('../../src/platform/persistence/sqlite/chatSummarySchema.ts', import.meta.url);
new Function('require', 'module', 'exports', compile(schemaUrl))((id) => loadSource(new URL(`${id}.ts`, schemaUrl)), schema, schema.exports);
const statements = [];
await schema.exports.migrateChatSummary({ execAsync: async (sql) => { statements.push(sql); } });
export function installChatTimelineSchema(database) {
  for (const sql of statements) database.exec(sql);
  const { SCHEMAS } = loadSource(new URL('../../src/platform/persistence/sqlite/schema.ts', import.meta.url));
  database.exec(SCHEMAS.conversationTurnRuns);
  database.exec(SCHEMAS.conversationTurnState);
  const columns = database.prepare("PRAGMA table_info('conversation_turn_runs')").all();
  if (!columns.some((column) => column.name === 'regeneration_source_run_id')) {
    database.exec('ALTER TABLE conversation_turn_runs ADD COLUMN regeneration_source_run_id TEXT');
  }
  if (!columns.some((column) => column.name === 'input_cursor_at_claim')) {
    database.exec('ALTER TABLE conversation_turn_runs ADD COLUMN input_cursor_at_claim INTEGER');
  }
  database.exec(SCHEMAS.chatRegenerationRequests);
  database.exec(SCHEMAS.chatReplyVersions);
  database.exec(SCHEMAS.agentRuns);
  database.exec(SCHEMAS.chatTurnPresentations);
  database.exec(SCHEMAS.chatCodePreviews);
}

// 消息用例使用真实代码解析与快照 SQL；快照写入只消费用例自己的事务执行器。
export const chatCodeBlock = loadSource(new URL('../../src/features/chat/messages/domain/ChatCodeBlock.ts', import.meta.url));
const codePreviewRepositoryUrl = new URL('../../src/features/chat/messages/infrastructure/SQLiteChatCodePreviewRepository.ts', import.meta.url);
const codePreviewModule = { exports: {} };
new Function('require', 'module', 'exports', compile(codePreviewRepositoryUrl))(() => ({}), codePreviewModule, codePreviewModule.exports);
export const chatCodeDependencies = {
  '../domain/ChatCodeBlock': chatCodeBlock,
  '../../messages/domain/ChatCodeBlock': chatCodeBlock,
  '../../../messages/domain/ChatCodeBlock': chatCodeBlock,
  './SQLiteChatCodePreviewRepository': codePreviewModule.exports,
};
const esmUrl = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64');
export const chatCodeBlockModuleUrl = esmUrl(fs.readFileSync(new URL('../../src/features/chat/messages/domain/ChatCodeBlock.ts', import.meta.url), 'utf8'));
const previewPersistenceUrl = esmUrl('export const databaseCoordinator = {};');
const codePreviewDomainUrl = esmUrl(fs.readFileSync(new URL('../../src/features/chat/messages/domain/ChatCodePreview.ts', import.meta.url), 'utf8'));
export const chatCodePreviewRepositoryModuleUrl = esmUrl(fs.readFileSync(codePreviewRepositoryUrl, 'utf8')
  .replaceAll("from '@platform/persistence'", `from '${previewPersistenceUrl}'`)
  .replaceAll("from '../domain/ChatCodePreview'", `from '${codePreviewDomainUrl}'`));
const timelineModule = ts.transpileModule(fs.readFileSync(new URL('../../src/features/chat/messages/infrastructure/ChatTimelineSql.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
export const chatTimelineModuleUrl = 'data:text/javascript;base64,' + Buffer.from(timelineModule).toString('base64');
const mutationSourceUrl = new URL('../../src/features/chat/messages/infrastructure/ChatMessageMutationSql.ts', import.meta.url);
export const chatMessageMutations = loadSource(mutationSourceUrl);
export const chatReplyVersionSql = loadSource(new URL('../../src/features/chat/reply/infrastructure/ChatReplyVersionSql.ts', import.meta.url));
const replyVersionModule = ts.transpileModule(fs.readFileSync(new URL('../../src/features/chat/reply/infrastructure/ChatReplyVersionSql.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
export const chatReplyVersionModuleUrl = 'data:text/javascript;base64,' + Buffer.from(replyVersionModule).toString('base64');
const mutationModule = ts.transpileModule(fs.readFileSync(mutationSourceUrl, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
export const chatMutationModuleUrl = 'data:text/javascript;base64,' + Buffer.from(mutationModule).toString('base64');
