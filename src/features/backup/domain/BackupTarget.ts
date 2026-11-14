/** 备份产物在技术存储层中的不透明句柄，不得假设它是裸文件路径。 */
export interface BackupArtifactHandle {
  artifactId: string;
  fileName: string;
  byteLength: number;
  locator: string;
}

/** 备份列表使用的稳定摘要，不暴露 Target 私有实现。 */
export interface BackupArtifactSummary {
  artifactId: string;
  fileName: string;
  byteLength: number;
  createdAt: string;
}

/**
 * 完整备份包的存储目标。
 *
 * Target 只搬运完整产物，不参与数据库快照、媒体枚举或恢复。
 */
export interface BackupTarget {
  publish(source: BackupArtifactHandle): Promise<BackupArtifactHandle>;
  list(): Promise<BackupArtifactSummary[]>;
  open(artifactId: string): Promise<BackupArtifactHandle>;
  delete(artifactId: string): Promise<void>;
}
