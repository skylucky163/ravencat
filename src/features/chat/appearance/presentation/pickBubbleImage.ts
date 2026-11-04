import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';

/** 选择器暂存归入口持有，应用副本与媒体身份由导入用例持有。 */
export async function withPickedBubbleImage<T>(importImage: (uri: string) => Promise<T>): Promise<T | null> {
  const picked = await DocumentPicker.getDocumentAsync({ type: 'image/png', multiple: false, copyToCacheDirectory: true });
  if (picked.canceled) return null;
  const uri = picked.assets[0].uri;
  try { return await importImage(uri); }
  finally {
    try { await FileSystem.deleteAsync(uri, { idempotent: true }); }
    catch (error) { console.warn('[BubbleSkin] 选择器临时图清理失败：', error); }
  }
}
