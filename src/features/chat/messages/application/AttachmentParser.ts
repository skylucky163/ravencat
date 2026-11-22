/** 新上传文件必须完整读取；长度超限明确拒绝，预览摘要独立截短。 */
import { persistentMediaStore } from '@platform/device';
import { CHAT_TEXT_ATTACHMENT_MAX_LENGTH, isChatTextDocumentFileName } from '../domain/ChatAttachment';

const MAX_PREVIEW_LENGTH = 240;
// 导入的 HTML 走纯文字预览，保留源码，不在应用内执行。
const PREVIEWABLE_TEXT_FILE_EXTENSIONS = new Set(['txt', 'md', 'json', 'csv', 'html', 'htm']);
const SUPPORTED_TEXT_FILE_LABEL = 'TXT 和 MD';

export interface ParseAttachmentResult {
  parseStatus: 'success' | 'failed' | 'skipped';
  parsedText: string | null;
  previewText: string | null;
  parserName: string | null;
  parseError: string | null;
}

export interface AttachmentParserService {
  parseFile(input: {
    localUri: string;
    fileName: string;
    mimeType?: string | null;
  }): Promise<ParseAttachmentResult>;
}

export function isChatAttachmentFileSupported(input: {
  fileName: string;
}): boolean {
  return isChatTextDocumentFileName(input.fileName);
}

export function assertChatAttachmentFileSupported(input: {
  fileName: string;
}): void {
  if (!isChatAttachmentFileSupported(input)) {
    throw new Error(`此文件无法解析，无法发送。当前支持 ${SUPPORTED_TEXT_FILE_LABEL} 文件`);
  }
}

/** 已发送文件仍可查看，不因新上传策略收紧而丢失历史预览能力。 */
export function isChatAttachmentFilePreviewable(input: { fileName: string }): boolean {
  return PREVIEWABLE_TEXT_FILE_EXTENSIONS.has(getExtension(input.fileName));
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}…`;
}

function getExtension(fileName: string): string {
  const match = String(fileName || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return match?.[1] || '';
}

function normalizeTextContent(text: string): string {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .trim();
}

class AttachmentParser implements AttachmentParserService {
  async parseFile(input: {
    localUri: string;
    fileName: string;
    mimeType?: string | null;
  }): Promise<ParseAttachmentResult> {
    const extension = getExtension(input.fileName);
    const parserName = extension || input.mimeType || 'unknown';

    // 选择边界已确认 TXT/MD；这里只负责读取文件字节与完整正文，不重复验证类型。
    try {
      const rawText = await persistentMediaStore.readAsText(input.localUri);
      if (rawText.includes('\u0000')) throw new Error('文件包含无法读取的内容，请使用 UTF-8 编码的 TXT/MD 文件');
      const parsedText = normalizeTextContent(rawText);
      if (parsedText.length > CHAT_TEXT_ATTACHMENT_MAX_LENGTH) {
        throw new Error(`文件正文不能超过 ${CHAT_TEXT_ATTACHMENT_MAX_LENGTH.toLocaleString('zh-CN')} 个字符，请拆分后发送`);
      }
      return { parseStatus: 'success', parsedText,
        previewText: truncateText(parsedText.replace(/\n+/g, ' '), MAX_PREVIEW_LENGTH), parserName, parseError: null };
    } catch (error) {
      return {
        parseStatus: 'failed',
        parsedText: null,
        previewText: null,
        parserName,
        parseError: error instanceof Error ? error.message : '文件解析失败',
      };
    }
  }
}

export const attachmentParser = new AttachmentParser();
