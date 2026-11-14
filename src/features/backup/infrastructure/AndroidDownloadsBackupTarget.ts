import {
  deletePublishedBackup,
  listPublishedBackups,
  publishBackupToDownloads,
} from '../../../../modules/backup-storage';

import type {
  BackupArtifactHandle,
  BackupTarget,
} from '../domain/BackupTarget';

export class AndroidDownloadsBackupTarget implements BackupTarget {
  publish(source: BackupArtifactHandle): Promise<BackupArtifactHandle> {
    return publishBackupToDownloads(source.locator, source.fileName);
  }

  list() {
    return listPublishedBackups();
  }

  async open(artifactId: string): Promise<BackupArtifactHandle> {
    const artifact = (await listPublishedBackups()).find((item) => item.artifactId === artifactId);
    if (!artifact) throw new Error('没有找到指定的本地备份');
    return artifact;
  }

  delete(artifactId: string): Promise<void> {
    return deletePublishedBackup(artifactId);
  }
}
