import * as FileSystem from 'expo-file-system/legacy';
import { withMediaFileLifetime } from './MediaFileLifetime';

export const PERSISTENT_MEDIA_CATEGORY = {
  chatImage: 'chatImage',
  chatFile: 'chatFile',
  callSnapshot: 'callSnapshot',
} as const;

export type PersistentMediaCategory =
  (typeof PERSISTENT_MEDIA_CATEGORY)[keyof typeof PERSISTENT_MEDIA_CATEGORY];

export interface PersistMediaParams {
  sourceUri: string;
  category: PersistentMediaCategory;
  entityId: string;
  originalFileName?: string | null;
  mimeType?: string | null;
}

export interface PersistentMediaInfo {
  normalizedUri: string | null;
  exists: boolean;
  isDirectory: boolean;
  uri: string | null;
  size: number | null;
  modificationTime: number | null;
}

export interface PreparePersistentMediaAssetParams {
  sourceUri: string;
  assetId: string;
  fileName?: string | null;
}

export interface CopyPersistentMediaAssetParams {
  sourceUri: string;
  storageKey: string;
}

export type LegacyChatMediaCategory =
  | typeof PERSISTENT_MEDIA_CATEGORY.chatImage
  | typeof PERSISTENT_MEDIA_CATEGORY.chatFile;

export interface MapLegacyChatUriToAssetReferenceParams {
  uri: string;
  category: LegacyChatMediaCategory;
}

export interface LegacyChatMediaAssetReference {
  storageKey: string;
  localUri: string;
}

interface FileInfoLike {
  exists: boolean;
  isDirectory: boolean;
  uri: string;
  size?: number;
  modificationTime?: number;
}

function getDocumentDirectory(): string {
  if (!FileSystem.documentDirectory) {
    throw new Error('FileSystem.documentDirectory 不可用，无法持久化附件');
  }

  return FileSystem.documentDirectory;
}

function getPersistentMediaRoot(): string {
  return `${getDocumentDirectory()}persistent-media/`;
}

/** 备份等平台消费者使用的长期媒体根目录；目录可尚未创建。 */
export function getPersistentMediaRootUri(): string {
  return getPersistentMediaRoot();
}

/** canonical create 独占的 persistent-media 命名空间前缀；对象与校验的唯一来源。 */
const PERSISTENT_MEDIA_CANONICAL_KEY_PREFIX = 'catalog/media/';

/**
 * persistent-media category 的 backing 相对目录前缀。
 *
 * 这是 media backing owner 对 category 目录的唯一真相：白名单校验、目录拼装、legacy 迁移
 * 都必须复用这里。手工复制这些字符串会让它们与 PERSISTENT_MEDIA_CATEGORY 集合分叉。
 */
export function getPersistentMediaCategoryPrefix(category: PersistentMediaCategory): string {
  switch (category) {
    case PERSISTENT_MEDIA_CATEGORY.chatImage:
      return 'chat/images/';
    case PERSISTENT_MEDIA_CATEGORY.chatFile:
      return 'chat/files/';
    case PERSISTENT_MEDIA_CATEGORY.callSnapshot:
      return 'calls/snapshots/';
    default:
      throw new Error(`未定义的 persistent-media category：${String(category)}`);
  }
}

/**
 * persistent-media backing 内所有合法 backing-relative locator 前缀。
 *
 * 必须由 category 权威映射 + canonical 命名空间派生：手工枚举一旦与 category 集合分叉，
 * 新增 category 的受管文件就会被 require 误判成「不属于 persistent-media backing」。
 */
const PERSISTENT_MEDIA_ASSET_KEY_PREFIXES = [
  PERSISTENT_MEDIA_CANONICAL_KEY_PREFIX,
  ...Object.values(PERSISTENT_MEDIA_CATEGORY).map(getPersistentMediaCategoryPrefix),
];

function requirePersistentMediaAssetStorageKey(storageKey: string): string {
  const segments = storageKey.split('/');
  if (
    !storageKey
    || storageKey.startsWith('/')
    || storageKey.includes('\\')
    || storageKey.includes('%')
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
    || !PERSISTENT_MEDIA_ASSET_KEY_PREFIXES.some((prefix) => storageKey.startsWith(prefix))
  ) {
    throw new Error(`storageKey 不属于 persistent-media backing：${storageKey}`);
  }
  return storageKey;
}

function getLegacyChatCategoryPrefix(category: LegacyChatMediaCategory): string {
  switch (category) {
    case PERSISTENT_MEDIA_CATEGORY.chatImage:
    case PERSISTENT_MEDIA_CATEGORY.chatFile:
      return getPersistentMediaCategoryPrefix(category);
    default:
      throw new Error(`legacy Chat 迁移不支持该媒体 category：${String(category)}`);
  }
}

function normalizeLegacyChatFileUri(uri: string): string | null {
  const trimmed = String(uri || '').trim();
  if (
    !trimmed
    || trimmed.includes('?')
    || trimmed.includes('#')
    || trimmed.includes('%')
    || trimmed.startsWith('content://')
    || trimmed.startsWith('http://')
    || trimmed.startsWith('https://')
    || trimmed.startsWith('asset://')
    || trimmed.startsWith('bundle://')
    || trimmed.startsWith('data:')
  ) {
    return null;
  }

  if (trimmed.startsWith('persistent-media/')) {
    return `${getDocumentDirectory()}${trimmed}`;
  }

  // 早期 Android 数据可能保存绝对路径；仍必须落在下面校验的 Chat category 根内。
  if (trimmed.startsWith('/')) {
    return `file://${trimmed}`;
  }

  return trimmed.startsWith('file://') ? trimmed : null;
}

function sanitizeSegment(input: string, fallback: string): string {
  const trimmed = String(input || '').trim();
  return (trimmed || fallback).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function extractExtension(fileName?: string | null, sourceUri?: string | null): string {
  const candidate = String(fileName || sourceUri || '').split('?')[0].split('#')[0];
  const match = candidate.match(/\.([a-zA-Z0-9]{1,8})$/);
  return match ? `.${match[1].toLowerCase()}` : '';
}

function buildCategoryDirectory(category: PersistentMediaCategory): string {
  return `${getPersistentMediaRoot()}${getPersistentMediaCategoryPrefix(category)}`;
}

export class PersistentMediaStore {
  /**
   * 计算 canonical MediaAsset backing 的 storageKey（纯计算，不触碰文件系统）。
   *
   * canonical create 的 locator 必须能在任何文件写入之前确定：backing 要先 reserve 这个
   * key，再开始 copy。否则 copy 已经产生文件、reservation 还没登记的窗口里，目录枚举会看见
   * 一个还没有主人的 canonical 文件，把它误判成 physical orphan 删除。
   */
  buildAssetStorageKey(params: PreparePersistentMediaAssetParams): string {
    const sourceUri = this.resolveFileUri(params.sourceUri);
    const extension = extractExtension(params.fileName, sourceUri);
    return `${PERSISTENT_MEDIA_CANONICAL_KEY_PREFIX}${sanitizeSegment(params.assetId, 'asset')}${extension}`;
  }

  /**
   * 把源文件复制到已经确定（并由调用方 reserve）的 canonical key；返回目标 localUri。
   *
   * 失败时自行做一次补偿删除：单次补偿也失败时不在调用层重复 retry，保留 locator 与
   * 双重错误，交由 M5 扫描 orphan。
   */
  async copyAssetToStorageKey(params: CopyPersistentMediaAssetParams): Promise<string> {
    const sourceUri = this.resolveFileUri(params.sourceUri);
    if (!sourceUri) {
      throw new Error('无效的媒体 URI，无法准备 MediaAsset backing');
    }

    const storageKey = requirePersistentMediaAssetStorageKey(params.storageKey);
    const directory = `${getPersistentMediaRoot()}${PERSISTENT_MEDIA_CANONICAL_KEY_PREFIX}`;
    await this.ensureDirectory(directory);
    const localUri = `${getPersistentMediaRoot()}${storageKey}`;

    try {
      await FileSystem.copyAsync({ from: sourceUri, to: localUri });
      return localUri;
    } catch (error) {
      try {
        await FileSystem.deleteAsync(localUri, { idempotent: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `准备 persistent-media backing 失败且未能清理目标文件：${storageKey}`,
        );
      }
      throw error;
    }
  }

  /** storageKey 已由 MediaAsset schema 保证为 backend-relative locator。 */
  async resolveAssetStorageKey(storageKey: string): Promise<string | null> {
    const key = requirePersistentMediaAssetStorageKey(storageKey);
    const localUri = `${getPersistentMediaRoot()}${key}`;
    const info = await FileSystem.getInfoAsync(localUri);
    if (!info.exists || info.isDirectory) {
      return null;
    }
    return info.uri || localUri;
  }

  /** Backup 在明确给定的 live/staging 根下检查受管相对 key，不使用活动设备根猜测。 */
  getInfoInRoot(rootUri: string, storageKey: string): Promise<PersistentMediaInfo> {
    const key = requirePersistentMediaAssetStorageKey(storageKey);
    return this.getInfo(`${rootUri.endsWith('/') ? rootUri : `${rootUri}/`}${key}`);
  }

  /**
   * 将 M3a 允许迁移的 legacy Chat 文件映射回 backend-relative locator。
   *
   * 该入口只接受 persistent-media 根目录下 chat/images 或 chat/files 的普通文件；
   * picker content URI、远程/内置资源、越界路径、目录和已删除文件都不产生资产身份。
   */
  async mapLegacyChatUriToAssetReference(
    params: MapLegacyChatUriToAssetReferenceParams,
  ): Promise<LegacyChatMediaAssetReference | null> {
    const categoryPrefix = getLegacyChatCategoryPrefix(params.category);
    const localUri = normalizeLegacyChatFileUri(params.uri);
    if (!localUri) {
      return null;
    }

    const categoryDirectory = `${getPersistentMediaRoot()}${categoryPrefix}`;
    if (!localUri.startsWith(categoryDirectory)) {
      return null;
    }

    const fileName = localUri.slice(categoryDirectory.length);
    // legacy persistMedia 只在 category 目录直接写文件；拒绝空段、目录和任何路径跳转。
    if (
      !fileName
      || fileName.endsWith('/')
      || fileName.includes('/')
      || fileName.includes('\\')
      || fileName === '.'
      || fileName === '..'
    ) {
      return null;
    }

    let info: FileInfoLike;
    try {
      info = await FileSystem.getInfoAsync(localUri) as FileInfoLike;
    } catch {
      return null;
    }

    if (!info.exists || info.isDirectory) {
      return null;
    }

    return {
      storageKey: `${categoryPrefix}${fileName}`,
      localUri,
    };
  }

  deleteAssetStorageKey(storageKey: string): Promise<void> {
    const key = requirePersistentMediaAssetStorageKey(storageKey);
    return withMediaFileLifetime(() => FileSystem.deleteAsync(`${getPersistentMediaRoot()}${key}`, { idempotent: true }));
  }

  /** 只枚举统一创建流程独占的目录；legacy category 仍可能存在裸 URI consumer。 */
  async listCanonicalAssetStorageKeys(): Promise<readonly string[]> {
    const prefix = PERSISTENT_MEDIA_CANONICAL_KEY_PREFIX;
    const directory = `${getPersistentMediaRoot()}${prefix}`;
    const directoryInfo = await FileSystem.getInfoAsync(directory);
    if (!directoryInfo.exists || !directoryInfo.isDirectory) {
      return [];
    }

    const names = await FileSystem.readDirectoryAsync(directory);
    const keys: string[] = [];
    for (const name of names) {
      const storageKey = requirePersistentMediaAssetStorageKey(`${prefix}${name}`);
      const info = await FileSystem.getInfoAsync(`${getPersistentMediaRoot()}${storageKey}`);
      if (info.exists && !info.isDirectory) {
        keys.push(storageKey);
      }
    }
    return keys.sort();
  }

  resolveFileUri(uri?: string | null): string | null {
    if (!uri) return null;

    const trimmed = String(uri).trim();
    if (!trimmed) return null;

    if (
      trimmed.startsWith('file://') ||
      trimmed.startsWith('content://') ||
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://')
    ) {
      return trimmed;
    }

    if (trimmed.startsWith('/')) {
      return `file://${trimmed}`;
    }

    // 处理数据库中存储的相对路径 例如: persistent-media/chat/files/...
    if (trimmed.startsWith('persistent-media/')) {
      return `${getDocumentDirectory()}${trimmed}`;
    }

    return trimmed;
  }

  async ensureDirectory(directoryUri?: string): Promise<string> {
    const targetDirectory = directoryUri || getPersistentMediaRoot();
    const info = await FileSystem.getInfoAsync(targetDirectory);

    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(targetDirectory, { intermediates: true });
    }

    return targetDirectory;
  }

  async getInfo(uri?: string | null): Promise<PersistentMediaInfo> {
    const normalizedUri = this.resolveFileUri(uri);

    if (!normalizedUri) {
      return {
        normalizedUri: null,
        exists: false,
        isDirectory: false,
        uri: null,
        size: null,
        modificationTime: null,
      };
    }

    try {
      // 存在性与基础信息查询不能读取整份媒体计算 Hash；内容指纹由资产入库流程负责。
      const info = (await FileSystem.getInfoAsync(normalizedUri)) as FileInfoLike;
      return {
        normalizedUri,
        exists: Boolean(info.exists),
        isDirectory: Boolean(info.isDirectory),
        uri: info.uri || normalizedUri,
        size: info.exists ? info.size ?? null : null,
        modificationTime: info.exists ? info.modificationTime ?? null : null,
      };
    } catch (error) {
      console.warn('[PersistentMediaStore] Failed to get info:', error);
      return {
        normalizedUri,
        exists: false,
        isDirectory: false,
        uri: normalizedUri,
        size: null,
        modificationTime: null,
      };
    }
  }

  async deleteIfExists(uri?: string | null): Promise<boolean> {
    const info = await this.getInfo(uri);
    if (!info.exists || !info.normalizedUri) {
      return false;
    }

    await withMediaFileLifetime(() => FileSystem.deleteAsync(info.normalizedUri!, { idempotent: true }));
    return true;
  }

  /** SQLite 中的临时文件定位是外部输入；删除必须限制在该 category 的平面文件目录。 */
  async deleteCategoryFileIfExists(uri: string, category: PersistentMediaCategory): Promise<void> {
    const normalized = this.resolveFileUri(uri);
    const directory = buildCategoryDirectory(category);
    if (!normalized?.startsWith(directory)) throw new Error('待删除媒体不属于指定目录');
    const fileName = normalized.slice(directory.length);
    if (!fileName || /[\\/%\u0000-\u001f]/u.test(fileName) || fileName === '.' || fileName === '..') throw new Error('待删除媒体文件名无效');
    await withMediaFileLifetime(() => FileSystem.deleteAsync(normalized, { idempotent: true }));
  }

  /** 临时目录 owner 回收旧实例的文件，包括写入后未能提交 SQLite 记录的残留。 */
  async deleteCategoryFilesExceptPrefix(category: PersistentMediaCategory, preservedPrefix: string): Promise<void> {
    const directory = buildCategoryDirectory(category);
    await withMediaFileLifetime(async () => {
      const info = await FileSystem.getInfoAsync(directory);
      if (!info.exists) return;
      const names = await FileSystem.readDirectoryAsync(directory);
      for (const name of names) {
        if (!name.startsWith(preservedPrefix)) await FileSystem.deleteAsync(`${directory}${name}`, { idempotent: true });
      }
    });
  }

  async persistMedia(params: PersistMediaParams): Promise<string> {
    const normalizedSourceUri = this.resolveFileUri(params.sourceUri);
    if (!normalizedSourceUri) {
      throw new Error('无效的附件 URI，无法持久化');
    }

    const targetDirectory = buildCategoryDirectory(params.category);
    await this.ensureDirectory(targetDirectory);

    const safeEntityId = sanitizeSegment(params.entityId, 'attachment');
    const safeFileName = sanitizeSegment(
      params.originalFileName || `${safeEntityId}${extractExtension(null, normalizedSourceUri)}`,
      safeEntityId
    );
    const extension = extractExtension(safeFileName, normalizedSourceUri);
    const baseName = safeFileName.endsWith(extension)
      ? safeFileName.slice(0, safeFileName.length - extension.length)
      : safeFileName;
    const targetUri = `${targetDirectory}${baseName}_${Date.now()}${extension}`;

    await this.deleteIfExists(targetUri);
    await FileSystem.copyAsync({
      from: normalizedSourceUri,
      to: targetUri,
    });

    return targetUri;
  }

  async writeChatTextDraft(id: string, text: string): Promise<string> {
    const directory = buildCategoryDirectory(PERSISTENT_MEDIA_CATEGORY.chatFile);
    const uri = `${directory}${sanitizeSegment(id, 'draft')}.txt`;
    await this.ensureDirectory(directory);
    try {
      await FileSystem.writeAsStringAsync(uri, text, { encoding: FileSystem.EncodingType.UTF8 });
      return uri;
    } catch (error) {
      await this.deleteIfExists(uri);
      throw error;
    }
  }

  async readAsText(uri: string): Promise<string> {
    const normalizedUri = this.resolveFileUri(uri);
    if (!normalizedUri) {
      throw new Error('无效的文件 URI，无法读取文本');
    }

    return FileSystem.readAsStringAsync(normalizedUri);
  }

  async readAsBase64(uri: string): Promise<string> {
    const normalizedUri = this.resolveFileUri(uri);
    if (!normalizedUri) {
      throw new Error('无效的文件 URI，无法读取 Base64');
    }

    return FileSystem.readAsStringAsync(normalizedUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
  }
}

export const persistentMediaStore = new PersistentMediaStore();

/**
 * 清空应用持久化媒体根目录 persistent-media/。
 *
 * 恢复出厂时调用，删除头像、AI 头像、壁纸、朋友圈封面、聊天图片、附件、通话截图等
 * 用户自定义媒体文件。幂等：目录不存在时成功返回。
 *
 * 不得删除数据库文件、导出的 Backups/ 目录或随应用打包的默认资源。
 * PersistentImageStore 与 PersistentMediaStore 共用同一个 persistent-media/ 根目录，
 * 因此只清理根目录一次。
 */
export async function clearPersistentApplicationMedia(): Promise<void> {
  if (!FileSystem.documentDirectory) {
    return;
  }

  const root = `${FileSystem.documentDirectory}persistent-media/`;
  const info = await FileSystem.getInfoAsync(root);

  if (!info.exists) {
    return;
  }

  await withMediaFileLifetime(() => FileSystem.deleteAsync(root, { idempotent: true }));
}
