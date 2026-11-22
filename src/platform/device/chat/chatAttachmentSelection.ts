/** 三个选择入口共享限额；只在文件进入应用的边界检查实际字节数。 */
const MAX_CHAT_IMAGE_SIZE = 50 * 1024 * 1024;
const MAX_CHAT_FILE_SIZE = 15 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp']);

export function isChatImageFile(fileName: string, mimeType?: string | null): boolean {
  return Boolean(mimeType?.startsWith('image/'))
    || IMAGE_EXTENSIONS.has(fileName.toLowerCase().split('.').pop() ?? '');
}

export function assertChatAttachmentSize(fileSize: number, type: 'image' | 'file'): void {
  const limit = type === 'image' ? MAX_CHAT_IMAGE_SIZE : MAX_CHAT_FILE_SIZE;
  if (fileSize > limit) {
    throw new Error(type === 'image' ? '图片不能超过 50MB' : '文件不能超过 15MB');
  }
}
