import { withMediaFileLifetime } from './MediaFileLifetime';

import * as FileSystem from 'expo-file-system/legacy';

export const PERSISTENT_IMAGE_CATEGORY = {
  userAvatar: 'userAvatar',
  aiAvatar: 'aiAvatar',
  groupAvatar: 'groupAvatar',
  appIcon: 'appIcon',
  wallpaper: 'wallpaper',
  callBackground: 'callBackground',
  momentsCover: 'momentsCover',
  chatFooterIcon: 'chatFooterIcon',
  chatCodeCover: 'chatCodeCover',
} as const;

export type PersistentImageCategory =
  (typeof PERSISTENT_IMAGE_CATEGORY)[keyof typeof PERSISTENT_IMAGE_CATEGORY];

/** 识别 Android 应用私有缓存引用，包括旧安装保存的路径；不判断文件存在，也不删除文件。 */
export function isAppCacheFileUri(uri: string): boolean {
  return /^(?:file:\/\/)?\/data\/(?:user\/\d+|data)\/[a-zA-Z0-9_.]+\/cache\/.+/.test(uri);
}

/** M3b 只迁移三个当前头像 category，不接管 Moments/comment 的历史展示 URI。 */
export type LegacyAvatarCategory =
  | typeof PERSISTENT_IMAGE_CATEGORY.userAvatar
  | typeof PERSISTENT_IMAGE_CATEGORY.aiAvatar
  | typeof PERSISTENT_IMAGE_CATEGORY.groupAvatar;

export interface MapLegacyAvatarUriToAssetReferenceParams {
  uri: string;
  category: LegacyAvatarCategory;
}

export interface LegacyAvatarMediaAssetReference {
  storageKey: string;
  localUri: string;
}

export interface CopyPickedImageParams {
  sourceUri: string;
  category: PersistentImageCategory;
  entityId: string;
  compression?: PersistentImageCompressionOptions;
}

export interface PersistentImageCompressionOptions {
  maxWidth: number;
  quality: number;
  sourceWidth?: number | null;
}

export interface PersistentImageInfo {
  normalizedUri: string | null;
  exists: boolean;
  isDirectory: boolean;
  uri: string | null;
  size: number | null;
  modificationTime: number | null;
  md5: string | null;
}

export interface PreparePersistentImageAssetParams {
  sourceUri: string;
  assetId: string;
  fileName?: string | null;
}

export interface CopyPersistentImageAssetParams {
  sourceUri: string;
  storageKey: string;
}

interface FileInfoLike {
  exists: boolean;
  isDirectory: boolean;
  uri: string;
  size?: number;
  modificationTime?: number;
  md5?: string | null;
}

function getDocumentDirectory(): string {
  if (!FileSystem.documentDirectory) {
    throw new Error('FileSystem.documentDirectory 不可用，无法持久化图片');
  }

  return FileSystem.documentDirectory;
}

function getPersistentMediaRoot(): string {
  return `${getDocumentDirectory()}persistent-media/`;
}

/** canonical create 独占的 persistent-image 命名空间前缀；对象与校验的唯一来源。 */
const PERSISTENT_IMAGE_CANONICAL_KEY_PREFIX = 'catalog/images/';

/**
 * persistent-image backing 内所有合法 backing-relative locator 前缀。
 *
 * 必须由 category 权威映射（getPersistentImageCategoryPrefix）+ canonical 命名空间派生。
 * 此前这里手工枚举 category 前缀，结果与 category 集合分叉：漏掉了 appIcon 的
 * `icons/apps/`，使该目录下的受管图片会被 require 误判成「不属于 persistent-image backing」。
 */
const PERSISTENT_IMAGE_ASSET_KEY_PREFIXES = [
  PERSISTENT_IMAGE_CANONICAL_KEY_PREFIX,
  ...Object.values(PERSISTENT_IMAGE_CATEGORY).map(getPersistentImageCategoryPrefix),
];

function requirePersistentImageAssetStorageKey(storageKey: string): string {
  if (!isPersistentImageAssetStorageKey(storageKey)) {
    throw new Error(`storageKey 不属于 persistent-image backing：${storageKey}`);
  }
  return storageKey;
}

/**
 * storageKey 是否是 persistent-image backing 的合法 backing-relative locator。
 *
 * 该判断不抛错，供需要"不合法即返回 null"的调用方（例如把已受管 URI 还原为 locator）复用；
 * 真正的边界校验仍然走 requirePersistentImageAssetStorageKey。
 */
function isPersistentImageAssetStorageKey(storageKey: string): boolean {
  if (typeof storageKey !== 'string' || !storageKey) {
    return false;
  }
  const segments = storageKey.split('/');
  if (
    storageKey.startsWith('/')
    || storageKey.includes('\\')
    || storageKey.includes('%')
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return false;
  }
  return PERSISTENT_IMAGE_ASSET_KEY_PREFIXES.some((prefix) => storageKey.startsWith(prefix));
}

const LEGACY_AVATAR_IMAGE_EXTENSIONS: Readonly<Record<string, true>> = {
  jpg: true,
  jpeg: true,
  png: true,
  gif: true,
  webp: true,
  heic: true,
  heif: true,
  avif: true,
  bmp: true,
};

function getLegacyAvatarCategoryPrefix(category: LegacyAvatarCategory): string {
  switch (category) {
    case PERSISTENT_IMAGE_CATEGORY.userAvatar:
    case PERSISTENT_IMAGE_CATEGORY.aiAvatar:
    case PERSISTENT_IMAGE_CATEGORY.groupAvatar:
      return getPersistentImageCategoryPrefix(category);
    default:
      throw new Error(`legacy 头像迁移不支持该媒体 category：${String(category)}`);
  }
}

function normalizeLegacyAvatarFileUri(uri: string): string | null {
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
    || trimmed.startsWith('blob:')
  ) {
    return null;
  }

  if (trimmed.startsWith('persistent-media/')) {
    return `${getDocumentDirectory()}${trimmed}`;
  }

  // 早期 Android 数据可能保存绝对路径；后续仍要校验它位于当前应用的 category 根内。
  if (trimmed.startsWith('/')) {
    return `file://${trimmed}`;
  }

  return trimmed.startsWith('file://') ? trimmed : null;
}

function hasReliableLegacyAvatarImageExtension(fileName: string): boolean {
  const match = fileName.match(/\.([a-zA-Z0-9]{2,5})$/);
  return Boolean(match && LEGACY_AVATAR_IMAGE_EXTENSIONS[match[1].toLowerCase()]);
}

function sanitizeEntityId(entityId: string): string {
  const trimmed = String(entityId || '').trim();
  return (trimmed || 'image').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function extractFileExtension(uri: string): string {
  const cleanUri = uri.split('?')[0].split('#')[0];
  const match = cleanUri.match(/\.([a-zA-Z0-9]{2,5})$/);
  return match ? `.${match[1].toLowerCase()}` : '.jpg';
}

function buildTargetFilename(entityId: string, extension: string): string {
  const safeEntityId = sanitizeEntityId(entityId);
  const version = Date.now();
  return `${safeEntityId}_${version}${extension}`;
}

function normalizeCompressionQuality(quality: number): number {
  return Math.max(0.1, Math.min(1, quality));
}

/**
 * persistent-image category 在 persistent-media backing 中的 backing-relative 前缀。
 *
 * 这是 media backing owner 对 category 目录的唯一真相：需要判断某个 locator 是否属于
 * 某个 category（例如备份校验 wallpaper / 通话背景引用）时，必须复用这里，不得在别处复制目录字符串。
 */
export function getPersistentImageCategoryPrefix(category: PersistentImageCategory): string {
  switch (category) {
    case PERSISTENT_IMAGE_CATEGORY.userAvatar:
      return 'avatars/user/';
    case PERSISTENT_IMAGE_CATEGORY.aiAvatar:
      return 'avatars/ai/';
    case PERSISTENT_IMAGE_CATEGORY.groupAvatar:
      return 'avatars/group/';
    case PERSISTENT_IMAGE_CATEGORY.appIcon:
      return 'icons/apps/';
    case PERSISTENT_IMAGE_CATEGORY.wallpaper:
      return 'wallpapers/';
    case PERSISTENT_IMAGE_CATEGORY.callBackground:
      return 'backgrounds/calls/';
    case PERSISTENT_IMAGE_CATEGORY.momentsCover:
      return 'covers/moments/';
    case PERSISTENT_IMAGE_CATEGORY.chatFooterIcon:
      return 'chat-footer/';
    case PERSISTENT_IMAGE_CATEGORY.chatCodeCover:
      return 'covers/chat-code/';
    default:
      // 前缀白名单派生于本函数：静默返回空串会让 startsWith('') 恒真、校验彻底失效。
      throw new Error(`未定义的 persistent-image category：${String(category)}`);
  }
}

function buildCategoryDirectory(category: PersistentImageCategory): string {
  return `${getPersistentMediaRoot()}${getPersistentImageCategoryPrefix(category)}`;
}

export class PersistentImageStore {
  /**
   * 计算 canonical MediaAsset backing 的 storageKey（纯计算，不触碰文件系统）。
   *
   * 与 PersistentMediaStore 同一不变量：locator 先于任何文件写入确定，backing 才能先
   * reserve 再 copy，避免「文件已可见、catalog 行还没有」的窗口被误判成 physical orphan。
   */
  buildAssetStorageKey(params: PreparePersistentImageAssetParams): string {
    const sourceUri = this.resolveFileUri(params.sourceUri);
    const extension = extractFileExtension(params.fileName || sourceUri || '');
    return `${PERSISTENT_IMAGE_CANONICAL_KEY_PREFIX}${sanitizeEntityId(params.assetId)}${extension}`;
  }

  /**
   * 为 MediaAsset backing 复制最终图片字节；压缩或转码必须由调用方在进入该边界前完成，
   * 这样 Hash、大小和 MIME 始终描述 resolver 将来读取的同一份内容。
   */
  async copyAssetToStorageKey(params: CopyPersistentImageAssetParams): Promise<string> {
    const sourceUri = this.resolveFileUri(params.sourceUri);
    if (!sourceUri) {
      throw new Error('无效的图片 URI，无法准备 MediaAsset backing');
    }

    const storageKey = requirePersistentImageAssetStorageKey(params.storageKey);
    const directory = `${getPersistentMediaRoot()}${PERSISTENT_IMAGE_CANONICAL_KEY_PREFIX}`;
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
          `准备 persistent-image backing 失败且未能清理目标文件：${storageKey}`,
        );
      }
      throw error;
    }
  }

  /** storageKey 已由 MediaAsset schema 保证为 backend-relative locator。 */
  async resolveAssetStorageKey(storageKey: string): Promise<string | null> {
    const key = requirePersistentImageAssetStorageKey(storageKey);
    const localUri = `${getPersistentMediaRoot()}${key}`;
    const info = await FileSystem.getInfoAsync(localUri);
    if (!info.exists || info.isDirectory) {
      return null;
    }
    return info.uri || localUri;
  }

  /** storageKey 是否属于 persistent-image backing（纯判断，不抛错）。 */
  isAssetStorageKey(storageKey: string): boolean {
    return isPersistentImageAssetStorageKey(storageKey);
  }

  /**
   * 把 persistent-media 根下的已受管图片 URI 还原为 backing-relative storageKey。
   *
   * 返回 null 表示该 URI 不是本 backing 拥有的可迁移 locator（远程 URI、picker content URI、
   * 越界路径或非法 storageKey）。调用方不得据此继续生成 backup locator。
   */
  toManagedStorageKey(uri?: string | null): string | null {
    const normalizedUri = this.resolveFileUri(uri);
    if (!normalizedUri) return null;

    const root = getPersistentMediaRoot();
    if (!normalizedUri.startsWith(root)) return null;

    const storageKey = normalizedUri.slice(root.length);
    return isPersistentImageAssetStorageKey(storageKey) ? storageKey : null;
  }

  /**
   * 在给定 persistent-media 根下查询 storageKey 的普通文件信息。
   *
   * 用于 restore staging 这类"解析基准不是当前运行时根"的只读校验：locator 语义与运行时一致，
   * 但根本身由调用方明确传入，避免把 staging 路径当作当前数据根、也避免为 staging 复制一套解析逻辑。
   */
  getInfoInRoot(mediaRootUri: string, storageKey: string): Promise<PersistentImageInfo> {
    const key = requirePersistentImageAssetStorageKey(storageKey);
    const root = mediaRootUri.endsWith('/') ? mediaRootUri : `${mediaRootUri}/`;
    return this.getInfo(`${root}${key}`);
  }

  /**
   * 将当前头像字段中的 legacy URI 映射为 persistent-image locator。
   *
   * 这里只接管三个头像目录的已有普通图片文件；Moments/comment 的展示 URI
   * 不属于头像资产迁移入口，也不能借此创建历史快照资产。
   */
  async mapLegacyAvatarUriToAssetReference(
    params: MapLegacyAvatarUriToAssetReferenceParams,
  ): Promise<LegacyAvatarMediaAssetReference | null> {
    const categoryPrefix = getLegacyAvatarCategoryPrefix(params.category);
    const localUri = normalizeLegacyAvatarFileUri(params.uri);
    if (!localUri) {
      return null;
    }

    const categoryDirectory = `${getPersistentMediaRoot()}${categoryPrefix}`;
    if (!localUri.startsWith(categoryDirectory)) {
      return null;
    }

    const fileName = localUri.slice(categoryDirectory.length);
    // 头像持久化只在 category 目录直接写文件；拒绝空段、目录和任何路径跳转。
    if (
      !fileName
      || fileName.endsWith('/')
      || fileName.includes('/')
      || fileName.includes('\\')
      || fileName === '.'
      || fileName === '..'
      || !hasReliableLegacyAvatarImageExtension(fileName)
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
    const key = requirePersistentImageAssetStorageKey(storageKey);
    return withMediaFileLifetime(() => FileSystem.deleteAsync(`${getPersistentMediaRoot()}${key}`, { idempotent: true }));
  }

  /** 只枚举统一创建流程独占的目录；头像等 legacy category 仍可能由裸 URI 引用。 */
  async listCanonicalAssetStorageKeys(): Promise<readonly string[]> {
    const prefix = PERSISTENT_IMAGE_CANONICAL_KEY_PREFIX;
    const directory = `${getPersistentMediaRoot()}${prefix}`;
    const directoryInfo = await FileSystem.getInfoAsync(directory);
    if (!directoryInfo.exists || !directoryInfo.isDirectory) {
      return [];
    }

    const names = await FileSystem.readDirectoryAsync(directory);
    const keys: string[] = [];
    for (const name of names) {
      const storageKey = requirePersistentImageAssetStorageKey(`${prefix}${name}`);
      const info = await FileSystem.getInfoAsync(`${getPersistentMediaRoot()}${storageKey}`);
      if (info.exists && !info.isDirectory) {
        keys.push(storageKey);
      }
    }
    return keys.sort();
  }

  async ensureDirectory(directoryUri?: string): Promise<string> {
    const targetDirectory = directoryUri || getPersistentMediaRoot();
    const info = await FileSystem.getInfoAsync(targetDirectory);

    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(targetDirectory, { intermediates: true });
    }

    return targetDirectory;
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

    return trimmed;
  }

  async getInfo(uri?: string | null): Promise<PersistentImageInfo> {
    const normalizedUri = this.resolveFileUri(uri);

    if (!normalizedUri) {
      return {
        normalizedUri: null,
        exists: false,
        isDirectory: false,
        uri: null,
        size: null,
        modificationTime: null,
        md5: null,
      };
    }

    try {
      const info = (await FileSystem.getInfoAsync(normalizedUri, { md5: true })) as FileInfoLike;

      return {
        normalizedUri,
        exists: Boolean(info.exists),
        isDirectory: Boolean(info.isDirectory),
        uri: info.uri || normalizedUri,
        size: info.exists ? info.size ?? null : null,
        modificationTime: info.exists ? info.modificationTime ?? null : null,
        md5: info.exists && typeof info.md5 === 'string' ? info.md5 : null,
      };
    } catch (error) {
      console.warn('[PersistentImageStore] Failed to get info:', error);
      return {
        normalizedUri,
        exists: false,
        isDirectory: false,
        uri: normalizedUri,
        size: null,
        modificationTime: null,
        md5: null,
      };
    }
  }

  async deleteIfExists(uri?: string | null): Promise<boolean> {
    const info = await this.getInfo(uri);
    if (!info.exists || !info.normalizedUri) return false;

    await withMediaFileLifetime(() => FileSystem.deleteAsync(info.normalizedUri!, { idempotent: true }));
    return true;
  }

  isManagedUri(uri?: string | null): boolean {
    const normalizedUri = this.resolveFileUri(uri);
    return Boolean(normalizedUri?.startsWith(getPersistentMediaRoot()));
  }

  async deleteManagedIfExists(uri?: string | null): Promise<boolean> {
    if (!this.isManagedUri(uri)) {
      return false;
    }
    return this.deleteIfExists(uri);
  }

  async copyPickedImageToAppStorage({
    sourceUri,
    category,
    entityId,
    compression,
  }: CopyPickedImageParams): Promise<string> {
    const normalizedSourceUri = this.resolveFileUri(sourceUri);
    if (!normalizedSourceUri) {
      throw new Error('无效的图片 URI，无法持久化');
    }

    let sourceUriToCopy = normalizedSourceUri;
    let temporaryOptimizedUri: string | null = null;
    let targetExtension = extractFileExtension(normalizedSourceUri);

    if (compression) {
      const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
      const shouldResize =
        typeof compression.sourceWidth === 'number'
          ? compression.sourceWidth > compression.maxWidth
          : true;
      const manipulator = ImageManipulator.manipulate(normalizedSourceUri);

      if (shouldResize) {
        manipulator.resize({ width: compression.maxWidth });
      }

      const imageRef = await manipulator.renderAsync();
      const optimizedImage = await imageRef.saveAsync({
        compress: normalizeCompressionQuality(compression.quality),
        format: SaveFormat.JPEG,
      });

      sourceUriToCopy = optimizedImage.uri;
      temporaryOptimizedUri = optimizedImage.uri;
      targetExtension = '.jpg';
    }

    const targetDirectory = buildCategoryDirectory(category);
    await this.ensureDirectory(targetDirectory);

    const targetUri = `${targetDirectory}${buildTargetFilename(
      entityId,
      targetExtension
    )}`;

    if (sourceUriToCopy === targetUri) {
      return targetUri;
    }

    try {
      await this.deleteIfExists(targetUri);
      await FileSystem.copyAsync({
        from: sourceUriToCopy,
        to: targetUri,
      });
    } finally {
      if (temporaryOptimizedUri) {
        await FileSystem.deleteAsync(temporaryOptimizedUri, { idempotent: true });
      }
    }

    return targetUri;
  }
}

export const persistentImageStore = new PersistentImageStore();
