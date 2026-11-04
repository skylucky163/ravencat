import {
  type DatabaseWriteExecutor,
  createDatabaseBackupSnapshot,
  deleteDatabaseBackupSnapshot,
} from '@platform/persistence';
import {
  getPersistentMediaRootUri,
  persistentMediaStore,
} from '@platform/device';
import {
  getPersistentImageInfoInRoot,
} from '@platform/device/DeviceMediaService';
import { MEDIA_ASSET_STORAGE_BACKEND, type MediaAsset } from '@features/media';
import {
  loadStoredThemeBackupState,
  parseStoredThemeBackupState,
  restoreStoredThemeBackupState,
  type StoredThemeBackupState,
} from '@shared/theme';
import type { BackupSourceGateway } from '../application/CreateLocalBackup';
import {
  getBubbleSkinBackupSource,
  restoreBubbleSkinBackupSettings,
  validateBubbleSkinBackupSettings,
} from '../../../../modules/ravencat-floating-layer';
import {
  STABLE_SETTINGS_BACKUP_SCHEMA_VERSION,
  parseStableSettingsBackupJson,
} from './stableSettingsBackupState';

export class ApplicationBackupSourceGateway implements BackupSourceGateway {
  constructor(private readonly dependencies: {
    readMediaInventory(uri: string): Promise<readonly MediaAsset[]>;
    prepareDatabaseSnapshot(executor: DatabaseWriteExecutor): Promise<void>;
    excludedMediaStoragePrefixes: readonly string[];
    searchCredentials: {
      export(databaseUri?: string): Promise<unknown>;
      validate(state: unknown, databaseUri: string): Promise<void>;
      restore(state: unknown): Promise<void>;
    };
  }) {}

  createDatabaseSnapshot(): Promise<string> {
    return createDatabaseBackupSnapshot(this.dependencies.prepareDatabaseSnapshot);
  }

  private async validateDatabaseMedia(databaseUri: string, rootUri: string): Promise<void> {
    const assets = await this.dependencies.readMediaInventory(databaseUri);
    for (const asset of assets) {
      const info = asset.storageBackend === MEDIA_ASSET_STORAGE_BACKEND.persistentImage
        ? await getPersistentImageInfoInRoot(rootUri, asset.storageKey)
        : asset.storageBackend === MEDIA_ASSET_STORAGE_BACKEND.persistentMedia
          ? await persistentMediaStore.getInfoInRoot(rootUri, asset.storageKey)
          : null;
      if (info === null) throw new Error(`备份媒体 backend 不支持：${asset.storageBackend}`);
      if (!info.exists || info.isDirectory || info.size !== asset.byteSize) {
        throw new Error(`备份引用的媒体文件缺失或大小不符：${asset.id}`);
      }
    }
  }

  deleteDatabaseSnapshot(uri: string): Promise<void> {
    return deleteDatabaseBackupSnapshot(uri);
  }

  async readNonDatabaseSources(databaseSnapshotUri: string) {
    await this.validateDatabaseMedia(databaseSnapshotUri, getPersistentMediaRootUri());
    const stableSettings = await this.readStableSettingsSource(databaseSnapshotUri);
    return {
      mediaRootUri: getPersistentMediaRootUri(),
      excludedMediaStoragePrefixes: this.dependencies.excludedMediaStoragePrefixes,
      bubbleSkinRootUri: stableSettings.bubbleSkinRootUri,
      stableSettingsJson: stableSettings.json,
    };
  }

  async exportStableSettingsJson(): Promise<string> {
    return (await this.readStableSettingsSource()).json;
  }

  async validateStableSettingsJson(
    json: string,
    bubbleSkinRootUri: string,
    mediaRootUri: string,
    databaseUri: string,
  ): Promise<void> {
    await this.validateDatabaseMedia(databaseUri, mediaRootUri);
    const settings = parseStableSettingsBackupJson(json);
    if ('searchCredentials' in settings) {
      await this.dependencies.searchCredentials.validate(settings.searchCredentials, databaseUri);
    }
    const themeState = parseStoredThemeBackupState(settings.theme);
    await this.validateChatFooterImage(themeState, mediaRootUri);

    await validateBubbleSkinBackupSettings(
      JSON.stringify(settings.bubbleSkins),
      bubbleSkinRootUri,
    );
  }

  async restoreStableSettingsJson(json: string): Promise<void> {
    const settings = parseStableSettingsBackupJson(json);

    await restoreBubbleSkinBackupSettings(JSON.stringify(settings.bubbleSkins));
    await restoreStoredThemeBackupState(settings.theme);
    if ('searchCredentials' in settings) {
      await this.dependencies.searchCredentials.restore(settings.searchCredentials);
    }
  }

  private async readStableSettingsSource(databaseUri?: string): Promise<{
    json: string;
    bubbleSkinRootUri: string;
  }> {
    const [theme, bubbleSkins, searchCredentials] = await Promise.all([
      loadStoredThemeBackupState(),
      getBubbleSkinBackupSource(),
      this.dependencies.searchCredentials.export(databaseUri),
    ]);
    // create 侧同样校验底栏图标真实存在，避免产出引用缺失文件的“缩水”备份。
    await this.validateChatFooterImage(theme, getPersistentMediaRootUri());

    const json = JSON.stringify({
      schemaVersion: STABLE_SETTINGS_BACKUP_SCHEMA_VERSION,
      legacyMediaRootUri: getPersistentMediaRootUri(),
      theme,
      bubbleSkins: JSON.parse(bubbleSkins.settingsJson) as unknown,
      searchCredentials,
    });

    // create 侧必须与 restore 侧满足同一份严格契约，避免产生"缩水后仍成功"的备份。
    parseStableSettingsBackupJson(json);

    return { bubbleSkinRootUri: bubbleSkins.rootUri, json };
  }

  /** 底栏图标文件位于 persistent-media 根内，随媒体根归档；引用必须能真实命中。 */
  private async validateChatFooterImage(
    themeState: StoredThemeBackupState,
    mediaRootUri: string,
  ): Promise<void> {
    const image = themeState.paperNoteChatFooter?.image;
    if (!image) return;
    const info = await getPersistentImageInfoInRoot(mediaRootUri, image.storageKey);
    if (!info.exists || info.isDirectory) {
      throw new Error(`备份引用的聊天底栏图标缺失：${image.storageKey}`);
    }
  }
}
