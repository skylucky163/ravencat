/** 用户打开代码时固定完整快照；路由只携带 ID，不携带整份源码。 */
import { databaseCoordinator } from '@platform/persistence';
import { getPersistentMediaRootUri } from '@platform/device';
import {
  PERSISTENT_IMAGE_CATEGORY,
  copyPickedImageToAppStorage,
  deleteManagedPersistentImageIfExists,
  getPersistentImageCategoryPrefix,
} from '@platform/device/DeviceMediaService';
import { createRuntimeSlot } from '@shared/runtime/RuntimeSlot';
import { ChatCodeWorkError, type ChatCodePreviewRepository, type ChatCodeWorkScope, type ChatCodeWorkWriteAccess } from '../domain/ChatCodePreview';
import { canRenderChatCode, chatCodeTitle, type ChatCodeBlock } from '../domain/ChatCodeBlock';

const repository = createRuntimeSlot<ChatCodePreviewRepository>('Chat code preview');
const libraryListeners = new Set<() => void>();
export const configureChatCodePreview = (value: ChatCodePreviewRepository) => repository.configure(value);
export const getChatCodePreview = (id: string) => repository.get().get(id);
export const listChatCodeLibrary = (assistantId: string) => repository.get().listLibrary(assistantId);
export const listOwnChatCodeWorks = (assistantId: string, scope: ChatCodeWorkScope, offset: number) => repository.get().listWorks(assistantId, scope, offset);
export async function getOwnChatCodeWork(assistantId: string, id: string) {
  const preview = await repository.get().get(id, assistantId);
  if (!preview) throw new ChatCodeWorkError('未找到属于自己的作品，请用 list_code_works 查询有效作品 ID。');
  return preview;
}
export async function setOwnChatCodeInLibrary(id: string, included: boolean, access: ChatCodeWorkWriteAccess): Promise<{ hasCover: boolean }> {
  const previousCover = await repository.get().setInLibrary(id, included, null, access);
  if (!included) await deleteCoverFile(previousCover);
  notifyLibraryChanged();
  return { hasCover: included && previousCover !== null };
}
export function subscribeChatCodeLibraryChanged(listener: () => void): () => void {
  libraryListeners.add(listener);
  return () => { libraryListeners.delete(listener); };
}

/** 封面落在 persistent-media 根的作品目录，随媒体根归档进备份；DB 只存文件名。 */
const COVER_CATEGORY = PERSISTENT_IMAGE_CATEGORY.chatCodeCover;
const coverDirectoryUri = () => `${getPersistentMediaRootUri()}${getPersistentImageCategoryPrefix(COVER_CATEGORY)}`;
export const chatCodeCoverUri = (coverFile: string | null) =>
  coverFile === null ? null : `${coverDirectoryUri()}${coverFile}`;

/** 截图落盘失败只丢封面，不阻断收纳；用户主动上传封面时失败要如实抛出。 */
async function finalizeCover(id: string, sourceUri: string, compression?: { maxWidth: number; quality: number; sourceWidth?: number | null }): Promise<string> {
  const uri = await copyPickedImageToAppStorage({ sourceUri, category: COVER_CATEGORY, entityId: id, compression });
  return uri.slice(coverDirectoryUri().length);
}

function notifyLibraryChanged(): void {
  // 返回作品库可能早于本次保存结束，活动页面必须在 commit 后重新读取收纳事实。
  for (const listener of libraryListeners) listener();
}

async function deleteCoverFile(coverFile: string | null): Promise<void> {
  if (coverFile === null) return;
  try { await deleteManagedPersistentImageIfExists(`${coverDirectoryUri()}${coverFile}`); }
  catch (error) { console.warn('[Chat] 作品封面清理失败：', error); }
}

/** capturedCoverUri 是收纳瞬间预览页截到的临时文件，本函数负责搬进封面目录。 */
export async function setChatCodeInLibrary(id: string, included: boolean, capturedCoverUri: string | null = null): Promise<void> {
  if (included) {
    let coverFile: string | null = null;
    try {
      if (capturedCoverUri !== null) {
        try { coverFile = await finalizeCover(id, capturedCoverUri); }
        catch (error) { console.warn('[Chat] 作品封面保存失败：', error); }
      }
      const previous = await repository.get().setInLibrary(id, true, coverFile);
      if (coverFile !== null && previous !== null && previous !== coverFile) await deleteCoverFile(previous);
    } catch (error) {
      // 事务失败时刚落盘的封面没有引用，必须立刻清掉。
      if (coverFile !== null) await deleteCoverFile(coverFile);
      throw error;
    }
  } else {
    // 封面文件属于收纳关系，在 commit 成功后做 targeted 清理。
    await deleteCoverFile(await repository.get().setInLibrary(id, false));
  }
  notifyLibraryChanged();
}

/** 用户从相册挑选并裁剪的封面替换收纳时的截图；旧封面 commit 后定向删除。 */
export function updateChatCodeCover(id: string, sourceUri: string, sourceWidth?: number | null): Promise<void> {
  return editChatCodeWork(id, { coverUri: sourceUri, sourceWidth });
}

export function editOwnChatCodeWork(id: string, changes: { title?: string; coverUri?: string; sourceWidth?: number }, access: ChatCodeWorkWriteAccess): Promise<void> {
  return editChatCodeWork(id, changes, access);
}

/** 图片准备在事务外；名称与封面引用在同一事务内提交，失败清理无引用文件。 */
async function editChatCodeWork(id: string, changes: { title?: string; coverUri?: string; sourceWidth?: number | null }, access?: ChatCodeWorkWriteAccess): Promise<void> {
  let coverFile: string | null = null;
  try {
    if (changes.coverUri !== undefined) coverFile = await finalizeCover(id, changes.coverUri, { maxWidth: 1080, quality: 0.85, sourceWidth: changes.sourceWidth });
    await deleteCoverFile(await repository.get().editWork(id, { title: changes.title, coverFile: coverFile ?? undefined }, access));
  } catch (error) {
    if (coverFile !== null) await deleteCoverFile(coverFile);
    throw error;
  }
  notifyLibraryChanged();
}

export async function prepareChatCodePreview(id: string, block: ChatCodeBlock, sourceMessageId: number | null, agentId: string | null): Promise<void> {
  if (!block.complete) throw new Error('代码尚未生成完整');
  await databaseCoordinator.transaction({ name: 'chat.code-preview.prepare', feature: 'chat', priority: 'interactive' }, tx => (
    repository.get().saveInTransaction(tx, {
      id, agentId, language: block.language, source: block.source, title: chatCodeTitle(block),
      canRender: canRenderChatCode(block), createdAt: new Date().toISOString(),
    }, sourceMessageId)
  ));
}
