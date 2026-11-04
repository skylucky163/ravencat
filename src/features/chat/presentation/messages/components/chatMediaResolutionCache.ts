/** 列表持有已解析的媒体地址，避免 FlashList 回收卡片后重复进入加载态。 */
import { createContext } from 'react';
import type { ResolvedChatImageAttachmentUris } from '../../../messages/application/ResolveChatAttachmentMedia';

const RESOLVED_MEDIA_CAPACITY = 200;

class ResolvedChatMediaCache<T> {
  private readonly entries = new Map<string, T>();

  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > RESOLVED_MEDIA_CAPACITY) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

/** 只缓存成功解析的地址，不持有文件或位图；随会话列表换代、卸载释放。 */
export function createChatMediaResolutionCache() {
  return {
    images: new ResolvedChatMediaCache<ResolvedChatImageAttachmentUris>(),
    stickers: new ResolvedChatMediaCache<string>(),
    assets: new ResolvedChatMediaCache<string>(),
  };
}

// 列表外的引用或版本预览卡片仍使用自己的解析生命周期。
export const ChatMediaResolutionCacheContext = createContext<ReturnType<typeof createChatMediaResolutionCache> | null>(null);
