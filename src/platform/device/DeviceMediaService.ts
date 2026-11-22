/** 为界面层提供图片、附件选择与持久化所需的设备媒体门面。 */
import {
  PERSISTENT_IMAGE_CATEGORY,
  PERSISTENT_MEDIA_CATEGORY,
  captureChatPhoto,
  persistentImageStore,
  persistentMediaStore,
  selectChatDocument,
  selectChatImages,
} from './index';

export { PERSISTENT_IMAGE_CATEGORY, PERSISTENT_MEDIA_CATEGORY };
export { pickCroppedImage } from './pickCroppedImage';
export { isAppCacheFileUri } from './PersistentImageStore';
export {
  usePersistentAvatarDraft,
  type PickPersistentAvatarResult,
  type PersistentAvatarDraft,
} from './usePersistentAvatarDraft';

export async function copyPickedImageToAppStorage(params: Parameters<typeof persistentImageStore.copyPickedImageToAppStorage>[0]) {
  return persistentImageStore.copyPickedImageToAppStorage(params);
}

export async function deletePersistentImageIfExists(uri?: string | null) {
  return persistentImageStore.deleteIfExists(uri);
}

export async function deleteManagedPersistentImageIfExists(uri?: string | null) {
  return persistentImageStore.deleteManagedIfExists(uri);
}

export function isManagedPersistentImageUri(uri?: string | null) {
  return persistentImageStore.isManagedUri(uri);
}

export async function getPersistentImageInfo(uri?: string | null) {
  return persistentImageStore.getInfo(uri);
}

/** 已受管图片 URI → backing-relative storageKey；不属于本 backing 时返回 null。 */
export function toPersistentImageStorageKey(uri?: string | null) {
  return persistentImageStore.toManagedStorageKey(uri);
}

/** backing-relative storageKey 是否属于 persistent-image backing。 */
export function isPersistentImageStorageKey(storageKey: string) {
  return persistentImageStore.isAssetStorageKey(storageKey);
}

/** backing-relative storageKey → 当前设备上真实存在的 persistent-media URI；缺失返回 null。 */
export function resolvePersistentImageStorageKey(storageKey: string) {
  return persistentImageStore.resolveAssetStorageKey(storageKey);
}

/** 在显式给定的 persistent-media 根（例如 restore staging）下查询 storageKey 的文件信息。 */
export function getPersistentImageInfoInRoot(mediaRootUri: string, storageKey: string) {
  return persistentImageStore.getInfoInRoot(mediaRootUri, storageKey);
}

export { getPersistentImageCategoryPrefix } from './PersistentImageStore';

export function resolvePersistentImageUri(uri?: string | null) {
  return persistentImageStore.resolveFileUri(uri);
}

export async function getPersistentMediaInfo(uri?: string | null) {
  return persistentMediaStore.getInfo(uri);
}

export async function persistDeviceMedia(params: Parameters<typeof persistentMediaStore.persistMedia>[0]) {
  return persistentMediaStore.persistMedia(params);
}

export function writeChatTextDraft(id: string, text: string) {
  return persistentMediaStore.writeChatTextDraft(id, text);
}

export async function deletePersistentMediaIfExists(uri?: string | null) {
  return persistentMediaStore.deleteIfExists(uri);
}

export async function readPersistentMediaAsText(uri: string) {
  return persistentMediaStore.readAsText(uri);
}

export async function pickChatImagesFromDevice(selectionLimit: number) {
  return selectChatImages(selectionLimit);
}

export async function captureChatPhotoFromDevice() {
  return captureChatPhoto();
}

export async function pickChatDocumentFromDevice() {
  return selectChatDocument();
}
