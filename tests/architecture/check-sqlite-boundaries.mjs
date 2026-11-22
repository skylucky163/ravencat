import { repoRoot as ROOT } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';


const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const RUNTIME_AREAS = ['src/features', 'src/host', 'src/app', 'src/shared'];

function collect(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collect(entryPath);
    return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [entryPath] : [];
  });
}

function violationsFor(relativePath, source) {
  const violations = [];
  if (/\bgetDB\b|sqlite\/connection/.test(source)) {
    violations.push('直接取得 SQLite 连接');
  }
  if (/withTransactionAsync/.test(source)) {
    violations.push('使用非排他事务');
  }
  if (/withExclusiveTransactionAsync\s*\(\s*async\s*\(\s*\)/.test(source)) {
    violations.push('事务回调未声明 executor');
  }
  if (/\b(?:getAll|getFirst|run|exec)Sync\s*</.test(source)) {
    violations.push('使用同步 SQLite 快捷查询');
  }
  if (/from\s+['"]expo-sqlite['"]/.test(source)) {
    violations.push('Feature 或宿主直接依赖 expo-sqlite');
  }
  return violations.map((reason) => `${relativePath}: ${reason}`);
}

function selfTest() {
  assert.deepEqual(violationsFor('ok.ts', `
    import { databaseCoordinator } from '@platform/persistence';
    databaseCoordinator.read(meta, (db) => db.getAllAsync('SELECT 1'));
  `), []);
  assert.equal(violationsFor('bad.ts', `const db = await getDB();`)[0], 'bad.ts: 直接取得 SQLite 连接');
  assert.equal(violationsFor('bad.ts', `db.withTransactionAsync(async () => {});`)[0], 'bad.ts: 使用非排他事务');
  assert.equal(
    violationsFor('bad.ts', `db.withExclusiveTransactionAsync(async () => {});`)[0],
    'bad.ts: 事务回调未声明 executor',
  );
  assert.equal(violationsFor('bad.ts', `db.getAllSync<Row>('SELECT 1');`)[0], 'bad.ts: 使用同步 SQLite 快捷查询');
  console.log('SQLite 架构门禁自测通过');
}

if (process.argv.includes('--self-test')) {
  selfTest();
  process.exit(0);
}

const violations = RUNTIME_AREAS.flatMap((area) => collect(path.join(ROOT, area))).flatMap((file) => {
  const relative = path.relative(ROOT, file).replaceAll('\\', '/');
  return violationsFor(relative, fs.readFileSync(file, 'utf8'));
});

const persistenceIndex = fs.readFileSync(path.join(ROOT, 'src/platform/persistence/index.ts'), 'utf8');
for (const forbiddenExport of ['getDB', 'closeDB', 'resetDB', 'runMigrations', 'SCHEMAS']) {
  if (new RegExp(`\\b${forbiddenExport}\\b`).test(persistenceIndex)) {
    violations.push(`src/platform/persistence/index.ts: 不得公开 ${forbiddenExport}`);
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log('SQLite 架构边界检查通过');
