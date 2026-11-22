/** Backup SQLite 完整性与快照引用修复验证；格式往返由原生单测覆盖。 */

import { repoRoot as ROOT } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { importTypeScriptModule } from '../helpers/import-typescript-module.mjs';


const { repairMcpAuthorizationForeignKeys } = await importTypeScriptModule(
  path.join(ROOT, 'src/platform/persistence/sqlite/mcpSchema.ts'),
);

// 旧事务连接遗漏的授权级联：只清理无父服务/角色的授权，保留全部有效配置与授权。
{
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=OFF;
    CREATE TABLE mcp_servers(id TEXT PRIMARY KEY);
    CREATE TABLE ai_assistants(id TEXT PRIMARY KEY);
    CREATE TABLE mcp_server_assistants(
      server_id TEXT REFERENCES mcp_servers(id) ON DELETE CASCADE,
      assistant_id TEXT REFERENCES ai_assistants(id) ON DELETE CASCADE,
      PRIMARY KEY(server_id, assistant_id)
    );
    CREATE TABLE mcp_tool_grants(
      server_id TEXT REFERENCES mcp_servers(id) ON DELETE CASCADE,
      remote_tool_name TEXT, PRIMARY KEY(server_id, remote_tool_name)
    );
    INSERT INTO mcp_servers VALUES('live');
    INSERT INTO ai_assistants VALUES('live');
    INSERT INTO mcp_server_assistants VALUES('live', 'live'), ('deleted', 'live'), ('live', 'deleted');
    INSERT INTO mcp_tool_grants VALUES('live', 'tool'), ('deleted', 'tool');
    PRAGMA foreign_keys=ON;`);
  const executor = { execAsync: async (sql) => db.exec(sql) };
  try {
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 3);
    await repairMcpAuthorizationForeignKeys(executor);
    await repairMcpAuthorizationForeignKeys(executor);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    for (const table of ['mcp_servers', 'ai_assistants', 'mcp_server_assistants', 'mcp_tool_grants']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1, '有效主体与授权必须保留');
    }
    db.exec('PRAGMA foreign_keys=OFF; INSERT INTO mcp_server_assistants VALUES (\'deleted\', \'live\'); PRAGMA foreign_keys=ON;');
    await assert.rejects(() => repairMcpAuthorizationForeignKeys({ execAsync: async (sql) => {
      if (sql === 'COMMIT;') throw new Error('提交失败');
      db.exec(sql);
    } }), /提交失败/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mcp_server_assistants').get().n, 2, '修复提交失败必须整体回滚');
  } finally {
    db.close();
  }
}
const { repairConversationTurnForeignKeys } = await importTypeScriptModule(
  path.join(
    ROOT,
    'src/platform/persistence/sqlite/conversationTurnIntegrityRepair.ts',
  ),
);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ravencat-backup-artifact-'));
const databases = [];
function openDatabase(name) {
  const db = new DatabaseSync(path.join(tempRoot, name));
  databases.push(db);
  return db;
}
try {
  const validDb = openDatabase('valid.db');
  validDb.exec('PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(pid INTEGER REFERENCES p(id)); INSERT INTO p VALUES(1); INSERT INTO c VALUES(1);');
  assert.equal(validDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(validDb.prepare('PRAGMA foreign_key_check').all(), []);

  const foreignKeyDb = openDatabase('foreign-key.db');
  foreignKeyDb.exec('PRAGMA foreign_keys=OFF; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(pid INTEGER REFERENCES p(id)); INSERT INTO c VALUES(99);');
  assert.notEqual(
    foreignKeyDb.prepare('PRAGMA foreign_key_check').all().length,
    0,
  );

  // 历史会话删除残留：修复只删除失去 conversation identity 的运行时事实。
  const conversationDb = openDatabase('conversation-turn.db');
  conversationDb.exec(`
      PRAGMA foreign_keys=OFF;
      CREATE TABLE chat_conversations(id TEXT PRIMARY KEY);
      CREATE TABLE conversation_turn_runs(
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE
      );
      CREATE TABLE conversation_turn_state(
        session_id TEXT PRIMARY KEY REFERENCES chat_conversations(id) ON DELETE CASCADE,
        active_run_id TEXT REFERENCES conversation_turn_runs(run_id)
      );
      INSERT INTO chat_conversations VALUES('live-session');
      INSERT INTO conversation_turn_runs VALUES('live-run', 'live-session');
      INSERT INTO conversation_turn_state VALUES('live-session', 'live-run');
      INSERT INTO conversation_turn_runs VALUES('orphan-run', 'deleted-session');
      INSERT INTO conversation_turn_state VALUES('deleted-session', 'orphan-run');
    `);
  conversationDb.exec('PRAGMA foreign_keys=ON;');
  const sqliteAdapter = {
    execAsync: async (sql) => {
      conversationDb.exec(sql);
    },
    getAllAsync: async (sql) => {
      return conversationDb.prepare(sql).all();
    },
  };
  assert.notEqual(
    conversationDb.prepare('PRAGMA foreign_key_check').all().length,
    0,
  );
  await repairConversationTurnForeignKeys(sqliteAdapter);
  await repairConversationTurnForeignKeys(sqliteAdapter);
  assert.deepEqual(conversationDb.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(
    conversationDb.prepare('SELECT run_id FROM conversation_turn_runs').all().map(row => row.run_id),
    ['live-run'],
  );
  assert.deepEqual(
    conversationDb.prepare('SELECT session_id FROM conversation_turn_state').all().map(row => row.session_id),
    ['live-session'],
  );

  const corruptDb = path.join(tempRoot, 'corrupt.db');
  fs.writeFileSync(corruptDb, crypto.randomBytes(2048));
  assert.throws(() => openDatabase('corrupt.db').prepare('PRAGMA integrity_check').all(), {
    code: 'ERR_SQLITE_ERROR',
  });
} finally {
  for (const db of databases) db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('Backup SQLite 完整性验证通过；原生格式测试：:backup-storage:testDebugUnitTest');
