/** SQLite 行为测试共用真实建库入口，不截取历史迁移源码。 */
import fs from 'node:fs';
import ts from 'typescript';

const modules = new Map();
export function loadSqliteModule(name) {
  const url = new URL(`../../src/platform/persistence/sqlite/${name}.ts`, import.meta.url);
  if (modules.has(url.href)) return modules.get(url.href).exports;
  const module = { exports: {} };
  modules.set(url.href, module);
  const compiled = ts.transpileModule(fs.readFileSync(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(
    id => loadSqliteModule(id.replace(/^\.\//, '')), module, module.exports,
  );
  return module.exports;
}

export function createSqliteExecutor(database, statements = []) {
  return {
    execAsync: async sql => { statements.push(sql); database.exec(sql); },
    getFirstAsync: async (sql, values = []) => database.prepare(sql).get(...values) ?? null,
    getAllAsync: async (sql, values = []) => database.prepare(sql).all(...values),
    runAsync: async (sql, values = []) => {
      statements.push(sql);
      const row = database.prepare(sql).run(...values);
      return { changes: Number(row.changes), lastInsertRowId: Number(row.lastInsertRowid) };
    },
  };
}

export const { SCHEMAS, INDEXES } = loadSqliteModule('schema');
export const { runMigrations: bootstrapSqlite, DATABASE_SCHEMA_VERSION } = loadSqliteModule('migrations');

/** 还原分组迁移前的真实连接表，供旧版本升级夹具使用；保留已有连接及引用。 */
export function restoreLegacyModelServicesFixture(db) {
  db.exec(`ALTER TABLE model_service_configs ADD COLUMN base_url TEXT;
    ALTER TABLE model_service_configs ADD COLUMN auth_type TEXT;
    UPDATE model_service_configs SET name = (SELECT name FROM model_service_groups WHERE id = group_id),
      base_url = (SELECT base_url FROM model_service_groups WHERE id = group_id),
      auth_type = (SELECT auth_type FROM model_service_groups WHERE id = group_id);
    DROP INDEX idx_model_service_key; DROP INDEX idx_model_service_key_ordinal;
    ALTER TABLE model_service_configs DROP COLUMN ordinal;
    ALTER TABLE model_service_configs DROP COLUMN group_id;
    DROP TABLE model_service_groups;
    CREATE UNIQUE INDEX idx_model_service_connection ON model_service_configs(base_url,api_key,auth_type,credentials_json);`);
}

/** 为回合行为用例准备“已消费历史”的明确起始状态；生产环境不执行此 fixture。 */
export async function prepareConsumedTurnFixture(db) {
  await db.execAsync(SCHEMAS.conversationTurnRuns);
  await db.execAsync(SCHEMAS.conversationTurnState);
  await db.execAsync(SCHEMAS.chatToolPackageExposure);
  for (const key of ['idxMessagesTurnItem', 'idxTurnRunsRecovery', 'idxTurnRunsSessionHistory', 'idxTurnRunsSingleActive']) {
    await db.execAsync(INDEXES[key]);
  }
  await db.execAsync(`INSERT OR IGNORE INTO conversation_turn_state (session_id, reply_cursor, revision, updated_at)
    SELECT c.id, COALESCE((SELECT MAX(id) FROM messages WHERE session_id=c.id),0), 0, '2026-08-01T00:00:00.000Z'
    FROM chat_conversations c;`);
}
