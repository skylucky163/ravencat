/** MediaAsset 第一版稳定 backing 标识。标识与 storageKey 的解释一经落库便不可静默变更。 */
export const MEDIA_ASSET_STORAGE_BACKEND = {
  persistentMedia: 'persistent-media',
  persistentImage: 'persistent-image',
} as const;

export type MediaAssetStorageBackend =
  (typeof MEDIA_ASSET_STORAGE_BACKEND)[keyof typeof MEDIA_ASSET_STORAGE_BACKEND];

export interface PrepareMediaAssetBackingInput {
  assetId: string;
  sourceUri: string;
  fileName?: string | null;
}

export interface PreparedMediaAssetBacking {
  storageBackend: string;
  storageKey: string;
  localUri: string;
}

export interface ResolvedMediaAssetBacking {
  localUri: string;
}

/** locator 合法且 backing 可访问，但对应普通文件已经不存在。 */
export class MediaAssetBackingNotFoundError extends Error {
  constructor(
    readonly storageBackend: string,
    readonly storageKey: string,
  ) {
    super(`MediaAsset backing 内容不存在：${storageBackend}/${storageKey}`);
    this.name = 'MediaAssetBackingNotFoundError';
  }
}

/** 一个 backing 对已持久化相对 key 的当前设备解析能力。 */
export interface MediaAssetBackingResolver {
  readonly storageBackend: string;
  resolve(storageKey: string): Promise<ResolvedMediaAssetBacking>;
}

/**
 * 可参与统一创建流程的 backing；prepare 抛错前必须自行清理未完成文件。
 *
 * in-flight 不变量：canonical backing 文件第一次可能被目录枚举看见之前，它的 storageKey
 * 就必须已经进入 reservation；只有 catalog 事务提交（commitPrepared）或删除（delete）
 * 才解除。实现不能在 copy 完成之后才登记 reservation——那段时间里文件已经可见却没有
 * catalog 行，会被 audit 误判成 physical orphan。
 */
export interface MediaAssetBackingWriter extends MediaAssetBackingResolver {
  prepare(input: PrepareMediaAssetBackingInput): Promise<PreparedMediaAssetBacking>;
  /** catalog 与业务引用提交成功后，解除 prepared key 的 in-flight 保护。 */
  commitPrepared(storageKey: string): void;
  /** 删除无论成功失败都必须解除该 key 的 in-flight 保护，供后续 audit 重试。 */
  delete(storageKey: string): Promise<void>;
  /** 由 backing 权威声明该 key 是否属于 canonical create 独占、可自动回收的命名空间。 */
  ownsStorageKeyLifecycle(storageKey: string): boolean;
  /**
   * 该 key 当前是否仍被本 backing 的 in-flight prepare 持有。
   *
   * audit 的快照会过滤 in-flight key，但快照本身可能已经过期：真正删除前必须再问一次，
   * 否则「audit 时还是 orphan → 期间 prepare 又 reserve 了同一个 key」会删掉 live backing。
   */
  isStorageKeyInFlight(storageKey: string): boolean;
  /**
   * 只枚举该 backing 中由 MediaAsset canonical create 独占的命名空间。
   * legacy 目录可能仍被裸 URI consumer 使用，不能仅因没有 catalog row 就删除。
   */
  listCanonicalStorageKeys(): Promise<readonly string[]>;
}

export interface MediaAssetBackingRegistryInput {
  writers: readonly MediaAssetBackingWriter[];
}

/** registry 是 storageBackend 唯一解释者；重复标识属于装配错误。 */
export class MediaAssetBackingRegistry {
  private readonly resolvers = new Map<string, MediaAssetBackingResolver>();
  private readonly writers = new Map<string, MediaAssetBackingWriter>();

  constructor(input: MediaAssetBackingRegistryInput) {
    for (const writer of input.writers) {
      this.addResolver(writer);
      this.writers.set(writer.storageBackend, writer);
    }
  }

  requireResolver(storageBackend: string): MediaAssetBackingResolver {
    const resolver = this.resolvers.get(storageBackend);
    if (!resolver) {
      throw new Error(`MediaAsset backing 未注册：${storageBackend}`);
    }
    return resolver;
  }

  requireWriter(storageBackend: string): MediaAssetBackingWriter {
    const writer = this.writers.get(storageBackend);
    if (!writer) {
      throw new Error(`MediaAsset backing 不支持创建：${storageBackend}`);
    }
    return writer;
  }

  findWriter(storageBackend: string): MediaAssetBackingWriter | null {
    return this.writers.get(storageBackend) ?? null;
  }

  listWriters(): readonly MediaAssetBackingWriter[] {
    return [...this.writers.values()];
  }

  private addResolver(resolver: MediaAssetBackingResolver): void {
    if (this.resolvers.has(resolver.storageBackend)) {
      throw new Error(`MediaAsset backing 重复注册：${resolver.storageBackend}`);
    }
    this.resolvers.set(resolver.storageBackend, resolver);
  }
}
