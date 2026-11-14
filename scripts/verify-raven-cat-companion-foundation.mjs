import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-cat-companion-'));

async function importTypeScriptModule(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
  });
  const targetPath = path.join(
    tmpDir,
    `${path.basename(relativePath, path.extname(relativePath))}.mjs`,
  );
  fs.writeFileSync(targetPath, output.outputText.replace("'./AIScheduleTiming'", "'./AIScheduleTiming.mjs'"), 'utf8');
  return import(pathToFileURL(targetPath).href);
}

await importTypeScriptModule('src/features/companion/domain/AIScheduleTiming.ts');
const settings = await importTypeScriptModule(
  'src/features/companion/domain/CompanionSettings.ts',
);
const protectedAppsPolicy = await importTypeScriptModule(
  'src/features/phoneTools/application/ProtectedAppsPolicy.ts',
);
const state = await importTypeScriptModule(
  'src/features/companion/domain/CompanionState.ts',
);
const hostRelationship = await importTypeScriptModule(
  'src/features/assistants/domain/HostRepository.ts',
);
const schema = await importTypeScriptModule(
  'src/platform/persistence/sqlite/ravenCatCompanionSchema.ts',
);

assert.throws(() => settings.createCompanionSettings({
  quietHoursStartMinutes: 480,
  quietHoursEndMinutes: 480,
}));
assert.deepEqual(
  protectedAppsPolicy.extractUserProtectedPackages([
    'com.android.settings',
    'com.example.bank',
    'com.example.bank',
  ]),
  ['com.example.bank'],
);

assert.throws(() => state.createCompanionState({
  desiredEnabled: false,
  activationStatus: 'enabled',
}));
assert.equal(state.createCompanionState({
  desiredEnabled: true,
  activationStatus: 'paused_error',
}).activationStatus, 'paused_error');

const revokedAt = new Date('2026-07-27T12:00:00.000Z');
const appointmentCooldown = hostRelationship.createHostAIAppointmentCooldown(revokedAt);
assert.equal(appointmentCooldown.startAt, revokedAt.toISOString());
assert.equal(
  new Date(appointmentCooldown.endAt).getTime() - revokedAt.getTime(),
  168 * 60 * 60 * 1000,
);

const db = new DatabaseSync(':memory:');
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE ai_assistants (
    id TEXT PRIMARY KEY,
    is_host_ai INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
`);
db.exec(schema.RAVEN_CAT_COMPANION_STATE_SCHEMA);
for (const indexSql of schema.RAVEN_CAT_COMPANION_INDEXES) db.exec(indexSql);

const insertAssistant = db.prepare(
  'INSERT INTO ai_assistants (id, is_host_ai, updated_at) VALUES (?, ?, ?)',
);
insertAssistant.run('host-a', 1, '2026-07-27T00:00:00.000Z');
assert.throws(() => insertAssistant.run('host-b', 1, '2026-07-27T00:00:01.000Z'));

db.prepare(`
  INSERT INTO raven_cat_companion_state (
    id, desired_enabled, activation_status, schedule_revision,
    host_ai_id, created_at, updated_at
  ) VALUES ('default', 1, 'enabled', 0, 'host-a', ?, ?)
`).run('2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z');
const persistedState = db.prepare(
  "SELECT * FROM raven_cat_companion_state WHERE id = 'default'",
).get();
assert.equal(state.createCompanionStateFromRow(persistedState).activationStatus, 'enabled');

console.log('RavenCat 本地伴随领域与持久化行为检查通过。');
