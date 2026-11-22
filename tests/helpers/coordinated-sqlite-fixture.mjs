/** 行为验证复用真实调度、事务回滚及错误包装，只替换原生连接与诊断输出。 */
import { loadTypeScriptModule } from './load-typescript-module.mjs';

export const databaseErrors = loadTypeScriptModule('src/platform/persistence/runtime/DatabaseErrors.ts');
const scheduler = loadTypeScriptModule('src/platform/persistence/runtime/DatabaseTaskScheduler.ts');

export function createCoordinatedSqliteFixture(raw, meta = { name: 'test.tool', feature: 'test', priority: 'interactive' }) {
  const diagnostics = [];
  const { DatabaseCoordinator } = loadTypeScriptModule('src/platform/persistence/runtime/DatabaseCoordinator.ts', {
    'expo-sqlite': {},
    '../sqlite/connection': { getDB: async () => raw },
    './DatabaseErrors': databaseErrors,
    './DatabaseDiagnostics': { emitDatabaseDiagnostic: event => diagnostics.push(event) },
    './DatabaseTaskScheduler': scheduler,
  });
  const databaseCoordinator = new DatabaseCoordinator();
  return { ...databaseErrors, databaseCoordinator, executor: databaseCoordinator.openTaskExecutor(meta), diagnostics };
}
