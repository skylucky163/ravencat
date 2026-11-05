/** 消息背景绘制的 Android 平台出口。 */
import * as FileSystem from 'expo-file-system/legacy';
import { ImageFileReadError, inspectLocalImage } from './InspectLocalImage';
import { createRandomUUID } from './randomUUID';
import { prepareBubbleImage as prepareNativeBubbleImage } from '../../../modules/message-bubble-background';

export { MessageBubbleBackground, prepareBubbleImage } from '../../../modules/message-bubble-background';
export type { BubbleBackgroundSource } from '../../../modules/message-bubble-background';
type BubbleImageKind = 'background' | 'decoration';
const DECORATION_MAX_BYTES = 2 * 1024 * 1024;
const DECORATION_MAX_EDGE = 512;

/**
 * 导入边界把大原图转为适合反复绘制的 PNG；不改写原图，也不改变已有皮肤的源像素坐标。
 * 底图超预算时适配至 1024 像素；装饰源文件先限制 2 MiB，目标最长边 512 像素。
 * 512 边长的 RGBA 像素最多约 1 MiB，避免压缩文件很小但列表解码内存很大。
 * 返回的临时副本由导入用例在持久化或失败后释放；小图沿用原文件，不接管其所有权。
 */
export async function prepareBubbleSkinImport(sourceUri: string, kind: BubbleImageKind = 'background') {
  const decoration = kind === 'decoration';
  const image = await inspectLocalImage(sourceUri, decoration ? { maxByteSize: DECORATION_MAX_BYTES } : undefined);
  if (decoration && image.isAnimated) throw new ImageFileReadError('气泡装饰仅支持静态 PNG，请选择静态图片');
  const maxEdge = decoration ? DECORATION_MAX_EDGE : 2048;
  // 选择器负责 PNG 筛选；文件提供方的类型标记与容器可能不同，导入层只负责产出绘制所需的 PNG。
  if (image.mimeType === 'image/png' && image.width <= maxEdge && image.height <= maxEdge && (decoration || image.byteSize <= 8 * 1024 * 1024)) {
    return { uri: sourceUri, dispose: async () => {} };
  }
  const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
  const context = ImageManipulator.manipulate(sourceUri);
  try {
    const targetEdge = decoration ? DECORATION_MAX_EDGE : 1024;
    if (Math.max(image.width, image.height) > targetEdge) {
      context.resize(image.width >= image.height ? { width: targetEdge } : { height: targetEdge });
    }
    const rendered = await context.renderAsync();
    try {
      // 保持 PNG，保留透明角和半透明边框；不使用有损 JPEG 或裁剪。
      const output = await rendered.saveAsync({ format: SaveFormat.PNG, compress: 1 });
      return { uri: output.uri, dispose: async () => {
        try { await FileSystem.deleteAsync(output.uri, { idempotent: true }); }
        catch (error) { console.warn('[BubbleSkin] 导入临时图清理失败：', error); }
      } };
    } finally { rendered.release(); }
  } finally { context.release(); }
}

/** 编辑会话拥有缓存副本，选择器退出即可清理自己的文件，不提前改变已启用组合。 */
export async function prepareBubbleDraftImage(sourceUri: string, kind: BubbleImageKind) {
  const prepared = await prepareBubbleSkinImport(sourceUri, kind);
  const uri = `${FileSystem.cacheDirectory}bubble-draft-${createRandomUUID()}.png`;
  const dispose = () => FileSystem.deleteAsync(uri, { idempotent: true });
  try {
    await FileSystem.copyAsync({ from: prepared.uri, to: uri });
    const dimensions = await prepareNativeBubbleImage(uri);
    return { uri, ...dimensions, dispose };
  } catch (error) {
    await dispose();
    throw error;
  } finally { await prepared.dispose(); }
}
