/** Backup restore 启动提交与补偿回滚行为测试。 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importTypeScriptModule } from './lib/import-typescript-module.mjs';

await import('./verify-image-generation-backup.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = resolvePath('src/host/composition/runPendingBackupRestoreCompletion.ts');

function resolvePath(relativePath) {
  return path.join(ROOT, relativePath);
}

function fakeDependencies(options = {}) {
  const calls = [];
  let action = options.action ?? null;
  const dependencies = {
    calls,
    consumeRestoreFailure: async () => {
      calls.push('consume-failure');
      return options.previousFailure ?? null;
    },
    readPendingRestoreAction: async () => {
      calls.push('read-action');
      return typeof action === 'function' ? action() : action;
    },
    initializeDatabase: async () => {
      calls.push('init-database');
      if (options.databaseError) throw options.databaseError;
    },
    closeDatabaseForRollback: async () => {
      calls.push('close-database');
    },
    restoreStableSettings: async (json) => {
      calls.push(`restore-settings:${json}`);
      if (json === 'new-settings' && options.settingsError) throw options.settingsError;
    },
    commitActivatedRestore: async () => {
      calls.push('commit');
    },
    rollbackActivatedRestore: async (message) => {
      calls.push(`rollback-data:${message}`);
      action = {
        kind: 'restore_rollback_settings',
        stableSettingsJson: 'old-settings',
        failureMessage: message,
      };
    },
    completeRolledBackRestore: async () => {
      calls.push('complete-rollback');
    },
    collectRestoreGarbage: async () => {
      calls.push('collect-garbage');
      if (options.cleanupError) throw options.cleanupError;
    },
    reportCleanupFailure: (error) => {
      calls.push(`cleanup-warning:${error.message}`);
    },
  };
  return dependencies;
}

const { runPendingBackupRestoreCompletion } = await importTypeScriptModule(modulePath);

// 无事务时不触碰数据库和设置。
{
  const deps = fakeDependencies();
  await runPendingBackupRestoreCompletion(deps);
  assert.deepEqual(deps.calls, ['consume-failure', 'read-action']);
}

// commit point 必须严格位于 bootstrap 与全部设置之后、GC 之前。
{
  const deps = fakeDependencies({
    action: { kind: 'apply_settings', stableSettingsJson: 'new-settings' },
  });
  await runPendingBackupRestoreCompletion(deps);
  assert.deepEqual(deps.calls, [
    'consume-failure',
    'read-action',
    'init-database',
    'restore-settings:new-settings',
    'commit',
    'collect-garbage',
  ]);
}

// migration/bootstrap 失败：先关闭新连接，再恢复数据和旧设置。
{
  const deps = fakeDependencies({
    action: { kind: 'apply_settings', stableSettingsJson: 'new-settings' },
    databaseError: new Error('migration failed'),
  });
  await assert.rejects(
    runPendingBackupRestoreCompletion(deps),
    /migration failed/u,
  );
  assert.deepEqual(deps.calls, [
    'consume-failure',
    'read-action',
    'init-database',
    'close-database',
    'rollback-data:migration failed',
    'read-action',
    'restore-settings:old-settings',
    'complete-rollback',
    'collect-garbage',
  ]);
}

// stable settings 中途失败：不得 commit，必须重放完整旧设置快照。
{
  const deps = fakeDependencies({
    action: { kind: 'apply_settings', stableSettingsJson: 'new-settings' },
    settingsError: new Error('wallpaper restore failed'),
  });
  await assert.rejects(
    runPendingBackupRestoreCompletion(deps),
    /wallpaper restore failed/u,
  );
  assert.equal(deps.calls.includes('commit'), false);
  assert.deepEqual(deps.calls.slice(-6), [
    'close-database',
    'rollback-data:wallpaper restore failed',
    'read-action',
    'restore-settings:old-settings',
    'complete-rollback',
    'collect-garbage',
  ]);
}

// activate 后、设置前中断：下一次启动只执行旧设置回滚，不尝试提交新 generation。
{
  const deps = fakeDependencies({
    action: {
      kind: 'restore_rollback_settings',
      stableSettingsJson: 'old-settings',
      failureMessage: 'restore interrupted before commit',
    },
  });
  await assert.rejects(
    runPendingBackupRestoreCompletion(deps),
    /restore interrupted before commit/u,
  );
  assert.deepEqual(deps.calls, [
    'consume-failure',
    'read-action',
    'restore-settings:old-settings',
    'complete-rollback',
    'collect-garbage',
  ]);
}

// committed 后 GC 失败不改变成功结果；故障只进入可重试诊断。
{
  const deps = fakeDependencies({
    action: { kind: 'apply_settings', stableSettingsJson: 'new-settings' },
    cleanupError: new Error('cleanup interrupted'),
  });
  await runPendingBackupRestoreCompletion(deps);
  assert.deepEqual(deps.calls.slice(-3), [
    'commit',
    'collect-garbage',
    'cleanup-warning:cleanup interrupted',
  ]);
}

// 已完成的 rollback failure 只报告，不重新进入恢复流程。
{
  const deps = fakeDependencies({ previousFailure: 'original data restored' });
  await assert.rejects(
    runPendingBackupRestoreCompletion(deps),
    /original data restored/u,
  );
  assert.deepEqual(deps.calls, ['consume-failure']);
}

const bootstrapSource = fs.readFileSync(
  resolvePath(
    'modules/backup-storage/android/src/main/java/expo/modules/backupstorage/BackupRestoreBootstrap.kt',
  ),
  'utf8',
);
assert.match(bootstrapSource, /phaseApplying -> beginRollback/u);
assert.match(bootstrapSource, /phaseActivated -> beginRollback/u);
assert.match(bootstrapSource, /phaseCommitted, phaseRolledBack -> collectGarbage/u);
assert.match(bootstrapSource, /phase != phaseCommitted && phase != phaseRolledBack/u);
assert.match(bootstrapSource, /hadDatabaseWalKey/u);
assert.match(bootstrapSource, /hadDatabaseShmKey/u);

console.log('Backup restore 启动提交与补偿回滚行为测试通过');
