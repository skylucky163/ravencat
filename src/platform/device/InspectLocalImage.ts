import { File } from 'expo-file-system';
import { Image } from 'react-native';
import { detectImageAnimation } from './ImageAnimation';

export class ImageFileReadError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'ImageFileReadError'; }
}

function readPngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 33 || bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) {
    throw new ImageFileReadError('PNG 图片文件头损坏，请重新选择图片');
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: header.getUint32(16), height: header.getUint32(20) };
}

/** 读取期间文件也可能被外部移除；在文件边界转换为可处理的图片错误。 */
export async function readLocalImageAsBase64(uri: string): Promise<string> {
  try {
    return await new File(uri).base64();
  } catch (error) {
    throw new ImageFileReadError('图片无法读取，可能已被删除，请重新发送或下载', { cause: error });
  }
}

/** 文件是外部边界：按真实容器和解码结果读取，不相信扩展名或模型给出的 MIME。 */
export async function inspectLocalImage(uri: string, { maxByteSize = 50 * 1024 * 1024 }: { maxByteSize?: number } = {}) {
  try {
    const file = new File(uri);
    if (!file.exists) throw new ImageFileReadError('找不到图片文件，请重新发送或下载');
    if (file.size > maxByteSize) throw new ImageFileReadError(`图片超过 ${maxByteSize / (1024 * 1024)} MiB，请缩小文件后重新选择`);
    const bytes = await file.bytes();
    let mimeType: string;
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mimeType = 'image/jpeg';
    else if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) mimeType = 'image/png';
    else if (bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) mimeType = 'image/gif';
    else if (bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70
      && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) mimeType = 'image/webp';
    else throw new ImageFileReadError('图片格式不支持；请使用 JPEG、PNG、WebP 或 GIF');
    // Android 的 getSize 返回已解码位图尺寸，大 PNG 可能被降采样为原图的一半。
    // PNG 的导入/缩放/尺寸限制必须以 IHDR 原始尺寸为准，不能把降采样结果当作文件尺寸。
    const dimensions = mimeType === 'image/png' ? readPngDimensions(bytes) : await Image.getSize(uri);
    if (dimensions.width > 8192 || dimensions.height > 8192) throw new ImageFileReadError('图片尺寸超过视觉输入的单边 8192 像素限制；长截图请分段截取或缩小后重新发送');
    // 文件头只提供尺寸，PNG 内容是否可解码仍交给原生图片解码器确认。
    if (mimeType === 'image/png') await Image.getSize(uri);
    return { mimeType, byteSize: bytes.length, width: dimensions.width, height: dimensions.height, isAnimated: detectImageAnimation(bytes) };
  } catch (error) {
    if (error instanceof ImageFileReadError) throw error;
    throw new ImageFileReadError('图片无法读取或已损坏，请重新发送或下载', { cause: error });
  }
}
