import type { DatabaseTransactionExecutor } from '@platform/persistence';

/** 预览保存源码快照，不持有网页运行状态或游戏存档。 */
export interface ChatCodePreviewSnapshot {
  id: string;
  agentId: string | null;
  language: string;
  source: string;
  title: string;
  canRender: boolean;
  createdAt: string;
}

export interface ChatCodePreview extends ChatCodePreviewSnapshot {
  inLibrary: boolean;
  coverFile: string | null;
}

export type ChatCodeWorkScope = 'saved' | 'unsaved' | 'all';
export interface ChatCodeWorkItem {
  id: string;
  title: string;
  inLibrary: boolean;
  createdAt: string;
}
export interface ChatCodeWorkPage {
  entries: ChatCodeWorkItem[];
  nextOffset: number | null;
}
/** AI 的写入资格在收纳事务中裁决，不依赖事务前读取的旧状态。 */
export interface ChatCodeWorkWriteAccess {
  assistantId: string;
  assertCurrent(tx: DatabaseTransactionExecutor): Promise<void>;
}
export class ChatCodeWorkError extends Error {}
export interface ChatCodeWorkChanges {
  title?: string;
  coverFile?: string;
}

/** 作品库只读取卡片摘要与封面文件名，不将所有已收纳网页的完整源码加载到列表。 */
export interface ChatCodeLibraryItem {
  id: string;
  title: string;
  coverFile: string | null;
  createdAt: string;
  addedAt: string;
}

export interface ChatCodePreviewRepository {
  get(id: string, assistantId?: string): Promise<ChatCodePreview | null>;
  listWorks(assistantId: string, scope: ChatCodeWorkScope, offset: number): Promise<ChatCodeWorkPage>;
  saveInTransaction(tx: DatabaseTransactionExecutor, preview: ChatCodePreviewSnapshot, sourceMessageId: number | null): Promise<void>;
  listLibrary(assistantId: string): Promise<ChatCodeLibraryItem[]>;
  /** 返回此前的封面文件名，调用方负责 commit 后清理被替换或移除的封面文件。 */
  setInLibrary(id: string, included: boolean, coverFile?: string | null, access?: ChatCodeWorkWriteAccess): Promise<string | null>;
  /** 名称与封面同事务提交；只有提供封面时才返回被替换的旧文件。 */
  editWork(id: string, changes: ChatCodeWorkChanges, access?: ChatCodeWorkWriteAccess): Promise<string | null>;
}
