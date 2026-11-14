/** Backup 消费各 owner 的媒体清单与服务凭据；跨 Feature 来源在 Host 组装。 */
import { ApplicationBackupSourceGateway } from '@features/backup/composition';
import { SQLiteMediaAssetRepository } from '@features/media/composition';
import { CALL_SNAPSHOT_BACKUP_EXCLUSIONS, callRepository } from '@features/calls/composition';
import { readChatCodeCoverFileReferences } from '@features/chat/composition';
import { databaseCoordinator } from '@platform/persistence';
import {
  readSearchCredentialReferences,
  readSearchCredentialsBackup,
  validateSearchCredentialsBackup,
  restoreSearchCredentialsBackup,
} from '@features/webTools/composition';
import {
  readMcpCredentialReferences,
  readMcpCredentialsBackup,
  validateMcpCredentialsBackup,
  restoreMcpCredentialsBackup,
} from '@features/mcpTools/composition';

function readSearchReferences(databaseUri?: string): Promise<string[]> {
  const task = { name: 'backup.read-search-credentials', feature: 'webTools', priority: 'maintenance' as const };
  return databaseUri === undefined
    ? readSearchCredentialReferences(databaseCoordinator.openTaskExecutor(task))
    : databaseCoordinator.readSnapshotAsync(task, databaseUri, readSearchCredentialReferences);
}

function readMcpReferences(databaseUri?: string): Promise<string[]> {
  const task = { name: 'backup.read-mcp-credentials', feature: 'mcpTools', priority: 'maintenance' as const };
  return databaseUri === undefined
    ? readMcpCredentialReferences(databaseCoordinator.openTaskExecutor(task))
    : databaseCoordinator.readSnapshotAsync(task, databaseUri, readMcpCredentialReferences);
}

export function createBackupSourceGateway(): ApplicationBackupSourceGateway {
  const repository = new SQLiteMediaAssetRepository(databaseCoordinator.openTaskExecutor({ name: 'backup.media', feature: 'media', priority: 'maintenance' }));
  return new ApplicationBackupSourceGateway({
    prepareDatabaseSnapshot: (executor) => callRepository.clearSnapshotReferencesInTransaction(executor),
    excludedMediaStoragePrefixes: CALL_SNAPSHOT_BACKUP_EXCLUSIONS,
    searchCredentials: {
      export: async (uri) => readSearchCredentialsBackup(await readSearchReferences(uri)),
      validate: async (state, uri) => validateSearchCredentialsBackup(state, await readSearchReferences(uri)),
      restore: restoreSearchCredentialsBackup,
    },
    mcpCredentials: {
      export: async (uri) => readMcpCredentialsBackup(await readMcpReferences(uri)),
      validate: async (state, uri) => validateMcpCredentialsBackup(state, await readMcpReferences(uri)),
      restore: restoreMcpCredentialsBackup,
    },
    readMediaInventory: (uri) => databaseCoordinator.readSnapshotAsync({ name: 'backup.read-snapshot-media', feature: 'backup', priority: 'maintenance' }, uri, async (executor) => { await callRepository.assertBackupSnapshotHasNoFiles(executor); return repository.listBackupAssets(executor); }),
    readChatCodeCoverFiles: uri => databaseCoordinator.readSnapshotAsync({ name: 'backup.read-chat-code-covers', feature: 'backup', priority: 'maintenance' }, uri, readChatCodeCoverFileReferences),
  });
}
