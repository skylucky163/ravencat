/** 群聊 mention metadata 一次性迁移的 SQLite 行为验证。 */

import { repoRoot as ROOT } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';


function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function loadTypeScriptModule(relativePath) {
  const sourcePath = path.join(ROOT, relativePath);
  const compiled = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(errors, [], `${relativePath} 无法编译`);

  const module = { exports: {} };
  const executeModule = new Function(
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    compiled.outputText,
  );
  executeModule(
    module.exports,
    (specifier) => {
      throw new Error(`${relativePath} 存在未声明的运行时依赖：${specifier}`);
    },
    module,
    sourcePath,
    path.dirname(sourcePath),
  );
  return module.exports;
}

function createExecutor(db, overrides = {}) {
  return {
    execAsync: async (sql) => db.exec(sql),
    getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
    runAsync: async (sql, params = []) => {
      if (overrides.beforeRun) {
        await overrides.beforeRun(sql, params);
      }
      const result = db.prepare(sql).run(...params);
      return {
        changes: Number(result.changes),
        lastInsertRowId: Number(result.lastInsertRowid),
      };
    },
  };
}

const { migrateGroupMentionMetadata } = loadTypeScriptModule(
  'src/platform/persistence/sqlite/groupMentionMetadataMigration.ts',
);

function createMessagesDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      metadata_json TEXT
    );
  `);
  return db;
}

// 旧用户 @ 被原位升级；其他 metadata、新契约和无效外部 JSON 保持原样。
{
  const db = createMessagesDatabase();
  const legacyMetadata = {
    kind: 'mixed',
    attachments: [{ id: 'attachment-1', type: 'image' }],
    groupChat: {
      kind: 'user_message',
      groupId: 'group-1',
      actorType: 'user',
      mentions: [
        { aiAssistantId: 'assistant-a', displayNameAtSend: '小A' },
        { aiAssistantId: 'assistant-b', displayNameAtSend: '小B' },
        { aiAssistantId: '', displayNameAtSend: '' },
      ],
    },
  };
  const currentMetadata = JSON.stringify({
    groupChat: {
      mentions: [{
        actorType: 'assistant',
        actorAssistantId: 'assistant-a',
        target: {
          targetType: 'user',
          userProfileId: 'self',
          displayNameAtSend: '用户',
        },
      }],
    },
  });
  const malformedMetadata = '{"groupChat":{"mentions":[';
  db.prepare('INSERT INTO messages VALUES (?, ?)').run(1, JSON.stringify(legacyMetadata));
  db.prepare('INSERT INTO messages VALUES (?, ?)').run(2, currentMetadata);
  db.prepare('INSERT INTO messages VALUES (?, ?)').run(3, malformedMetadata);
  db.prepare('INSERT INTO messages VALUES (?, ?)').run(4, JSON.stringify({ kind: 'text' }));

  const infoMessages = [];
  const originalInfo = console.info;
  console.info = (message) => infoMessages.push(String(message));
  try {
    await migrateGroupMentionMetadata(createExecutor(db));
  } finally {
    console.info = originalInfo;
  }

  const migrated = JSON.parse(
    db.prepare('SELECT metadata_json FROM messages WHERE id = 1').get().metadata_json,
  );
  assert.deepEqual(migrated.attachments, legacyMetadata.attachments);
  assert.equal(migrated.groupChat.groupId, 'group-1');
  assert.deepEqual(migrated.groupChat.mentions, [
    {
      actorType: 'user',
      target: {
        targetType: 'assistant',
        assistantId: 'assistant-a',
        displayNameAtSend: '小A',
      },
    },
    {
      actorType: 'user',
      target: {
        targetType: 'assistant',
        assistantId: 'assistant-b',
        displayNameAtSend: '小B',
      },
    },
    { aiAssistantId: '', displayNameAtSend: '' },
  ]);
  assert.equal(
    db.prepare('SELECT metadata_json FROM messages WHERE id = 2').get().metadata_json,
    currentMetadata,
    '新契约不得被迁移重写',
  );
  assert.equal(
    db.prepare('SELECT metadata_json FROM messages WHERE id = 3').get().metadata_json,
    malformedMetadata,
    '无法解析的外部 metadata 不属于本迁移的修复范围',
  );
  assert.equal(infoMessages.length, 1);

  const firstPass = db.prepare('SELECT id, metadata_json FROM messages ORDER BY id').all();
  await migrateGroupMentionMetadata(createExecutor(db));
  assert.deepEqual(
    db.prepare('SELECT id, metadata_json FROM messages ORDER BY id').all(),
    firstPass,
    '迁移必须幂等',
  );
  db.close();
}

// 任一写入失败时，已经升级的行也必须随事务回滚。
{
  const db = createMessagesDatabase();
  const first = JSON.stringify({
    groupChat: { mentions: [{ aiAssistantId: 'assistant-a', displayNameAtSend: '小A' }] },
  });
  const second = JSON.stringify({
    groupChat: { mentions: [{ aiAssistantId: 'assistant-b', displayNameAtSend: '小B' }] },
  });
  db.prepare('INSERT INTO messages VALUES (?, ?)').run(1, first);
  db.prepare('INSERT INTO messages VALUES (?, ?)').run(2, second);

  let writeCount = 0;
  await assert.rejects(
    migrateGroupMentionMetadata(createExecutor(db, {
      beforeRun: async () => {
        writeCount += 1;
        if (writeCount === 2) {
          throw new Error('模拟第二条写入失败');
        }
      },
    })),
    /模拟第二条写入失败/,
  );
  assert.deepEqual(
    db.prepare('SELECT metadata_json FROM messages ORDER BY id').all().map((row) => row.metadata_json),
    [first, second],
    '迁移失败必须回滚全部 metadata 写入',
  );
  db.close();
}

console.log('Group mention metadata migration checks passed.');
