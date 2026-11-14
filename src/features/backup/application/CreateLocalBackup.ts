import type { BackupArchiveBuilder } from '../domain/BackupArchiveBuilder';
import type { BackupTarget } from '../domain/BackupTarget';

export interface BackupSourceGateway {
  createDatabaseSnapshot(): Promise<string>;
  deleteDatabaseSnapshot(uri: string): Promise<void>;
  readNonDatabaseSources(databaseSnapshotUri: string): Promise<{
    mediaRootUri: string;
    excludedMediaStoragePrefixes: readonly string[];
    bubbleSkinRootUri: string;
    stableSettingsJson: string;
  }>;
  exportStableSettingsJson(): Promise<string>;
  validateStableSettingsJson(
    json: string,
    bubbleSkinRootUri: string,
    stagingMediaRootUri: string,
    stagingDatabaseUri: string,
  ): Promise<void>;
  restoreStableSettingsJson(json: string): Promise<void>;
}

interface CreateLocalBackupDependencies {
  archiveBuilder: BackupArchiveBuilder;
  localTarget: BackupTarget;
  sourceGateway: BackupSourceGateway;
  appVersion: string;
  databaseContractVersion: number;
}

export function createLocalBackupUseCase(dependencies: CreateLocalBackupDependencies) {
  return async (): Promise<void> => {
    const databaseSnapshotUri = await dependencies.sourceGateway.createDatabaseSnapshot();
    try {
      const createdAt = new Date().toISOString();
      const sources = await dependencies.sourceGateway.readNonDatabaseSources(databaseSnapshotUri);
      const prepared = await dependencies.archiveBuilder.prepare({
        databaseSnapshotUri,
        ...sources,
        createdAt,
        appVersion: dependencies.appVersion,
        databaseContractVersion: dependencies.databaseContractVersion,
      });
      await dependencies.localTarget.publish(prepared);
    } finally {
      await dependencies.sourceGateway.deleteDatabaseSnapshot(databaseSnapshotUri);
    }
  };
}
