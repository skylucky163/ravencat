import type {
  DatabaseTransactionExecutor,
  DatabaseWriteExecutor,
} from '@platform/persistence';

import type { MediaAsset } from './MediaAsset';
import type { MediaAssetStorageLocatorQuery } from './MediaAssetRepository';

export type MediaAssetReferenceKind =
  | 'moments_cover'
  | 'wallpaper'
  | 'call_background'
  | 'call_ringtone'
  | 'call_audio'
  | 'call_snapshot'
  | 'user_avatar'
  | 'assistant_avatar'
  | 'assistant_profile_cover'
  | 'group_avatar'
  | 'moment_media'
  | 'sticker'
  | 'ai_download'
  | 'chat_attachment'
  | 'chat_thumbnail'
  | 'chat_voice'
  | 'chat_sticker'
  | 'chat_favorite'
  | 'chat_reply_version'
  | 'chat_bubble_skin'
  | 'chat_bubble_decoration';

/**
 * 一条真实业务引用。ownerId 只用于诊断，不承担级联删除语义。
 * Chat Sticker 是语义 snapshot，但其中的 mediaAssetId 仍是 live 媒体引用。
 */
export interface MediaAssetReference {
  assetId: string;
  kind: MediaAssetReferenceKind;
  ownerId: string;
  location: string;
}

export interface InvalidMediaAssetReferenceSource {
  kind: 'chat_metadata';
  ownerId: string;
}

export interface MediaAssetDatabaseAudit {
  assets: readonly MediaAsset[];
  references: readonly MediaAssetReference[];
  orphanAssets: readonly MediaAsset[];
  danglingReferences: readonly MediaAssetReference[];
  /**
   * 无法解析的 SQLite 边界数据。若原文包含某个 asset id，该资产会被保守地排除出
   * orphan 集合；审计仍报告来源，提醒调用方修复损坏的业务事实。
   */
  invalidReferenceSources: readonly InvalidMediaAssetReferenceSource[];
}

export interface MediaAssetLifecycleRepository {
  /** 角色删除前在同一事务收集头像和角色背景；提交后仍按所有 live 引用裁决释放。 */
  listAssistantMediaAssetIds(assistantId: string, transaction: DatabaseTransactionExecutor): Promise<readonly string[]>;
  auditDatabase(executor?: DatabaseWriteExecutor): Promise<MediaAssetDatabaseAudit>;
  markMissingAssetsInTransaction(transaction: DatabaseTransactionExecutor, assets: readonly MediaAsset[]): Promise<void>;

  /** 调用方已持有独占事务；只删除审计确认没有任何 live reference 的 catalog 行。 */
  deleteOrphanAssetsInTransaction(
    transaction: DatabaseTransactionExecutor,
  ): Promise<readonly MediaAsset[]>;

  /**
   * 删除 physical backing 前的最后一道裁决：该 locator 现在是否已有 catalog 行。
   *
   * audit 的物理快照会随时间过期，快照之后提交的 asset 可能已经接管了同一个 key；
   * 只依赖快照会删掉已经 live 的文件。
   */
  hasAssetAtLocator(locator: MediaAssetStorageLocatorQuery): Promise<boolean>;

  /**
   * targeted release：只针对给定候选 asset id 探测全部引用源，并在同一事务内删除已经
   * 没有任何 live reference 的 catalog 行。不扫描其它 asset，也不解析无关消息的 metadata。
   *
   * 仍然必须检查所有引用来源：共享资产只有最后一个引用消失才能释放。
   */
  releaseUnreferencedAssetsInTransaction(
    transaction: DatabaseTransactionExecutor,
    assetIds: readonly string[],
  ): Promise<readonly MediaAsset[]>;

  /**
   * 级联删除时的候选收集：这些 chat session 的消息一旦被删除，其 metadata 中的媒体引用
   * 也会消失。只读取这些 session 的消息，不做全库 metadata 扫描。
   *
   * 调用方必须传入正在执行删除的那个 transaction，使「收集候选 + 删除事实」属于同一个
   * exclusive transaction；否则窗口期内新提交的消息引用会漏出候选集。
   */
  listChatSessionMediaAssetIds(
    sessionIds: readonly string[],
    executor?: DatabaseWriteExecutor,
  ): Promise<readonly string[]>;
}
