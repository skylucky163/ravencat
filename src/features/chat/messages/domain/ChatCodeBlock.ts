/** 代码围栏是聊天内容边界；源码内部不参与自然语言分泡。 */
export interface ChatCodeBlock {
  language: string;
  source: string;
  complete: boolean;
}

export interface ReplyContentBlock {
  kind: 'text' | 'code';
  text: string;
  completed: boolean;
}

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/;

/** 保留原文切片；闭合行尚未收齐时不宣布代码块完成，避免流式终态重新搬动内容。 */
export function splitReplyContentBlocks(text: string, completed: boolean): ReplyContentBlock[] {
  const blocks: ReplyContentBlock[] = [];
  let textStart = 0;
  let fence: { start: number; marker: string; length: number } | null = null;
  let offset = 0;
  const pushText = (end: number, closed: boolean) => {
    const content = text.slice(textStart, end);
    if (content.trim()) blocks.push({ kind: 'text', text: content, completed: closed });
  };
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(offset, lineEnd).replace(/\r$/, '');
    const lineComplete = newline !== -1 || completed;
    if (fence) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (lineComplete && closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
        blocks.push({ kind: 'code', text: text.slice(fence.start, lineEnd), completed: true });
        textStart = newline === -1 ? lineEnd : newline + 1;
        fence = null;
      }
    } else {
      const opening = OPEN_FENCE.exec(line);
      if (lineComplete && opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
        pushText(offset, true);
        fence = { start: offset, marker: opening[1][0], length: opening[1].length };
      } else if (!lineComplete && /^ {0,3}(?:`{1,2}|~{1,2}|`{3,}[^`]*|~{3,}.*)$/.test(line)) {
        // 跨 delta 的围栏候选暂不当作正文显示；确认前也不闭合前面的文字。
        pushText(offset, false);
        return blocks;
      }
    }
    offset = newline === -1 ? text.length : newline + 1;
  }
  if (fence) blocks.push({ kind: 'code', text: text.slice(fence.start), completed });
  else pushText(text.length, completed);
  return blocks;
}

/** 独立代码消息只解析自己的围栏；普通正文和行内代码不转换为卡片。 */
export function readChatCodeBlock(text: string): ChatCodeBlock | null {
  const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/.exec(text);
  if (!opening || (opening[1][0] === '`' && opening[2].includes('`'))) return null;
  const closingPattern = new RegExp('^ {0,3}' + opening[1][0] + '{' + opening[1].length + ',}[ \\t]*\\r?$', 'gm');
  closingPattern.lastIndex = opening[0].length;
  const closing = closingPattern.exec(text);
  if (closing && text.slice(closing.index + closing[0].length).trim()) return null;
  return {
    language: opening[2].trim().split(/\s+/)[0].toLowerCase(),
    source: text.slice(opening[0].length, closing ? closing.index : text.length),
    complete: closing !== null,
  };
}

/** HTML 文档和 HTML 片段均可运行；其他语言只进入源码查看。 */
export function canRenderChatCode(block: ChatCodeBlock): boolean {
  return block.complete && (block.language === 'html' || block.language === 'htm'
    || (!block.language && /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(block.source)));
}

export function chatCodePreviewId(message: { id: number; clientMessageId?: string | null }): string {
  return message.clientMessageId ?? `message:${message.id}`;
}

export function chatCodeTitle(block: ChatCodeBlock): string {
  if (!canRenderChatCode(block)) return `${block.language || '纯文本'} 代码`;
  const title = /<title\b[^>]*>([^<]*)<\/title\s*>/i.exec(block.source)?.[1].trim();
  return title ? title.slice(0, 80) : 'HTML 网页';
}

/** 后续模型历史只携带已提交网页的稳定引用；列表查询可找回已离开上下文的作品。 */
export function buildChatCodeWorkReference(message: {
  id: number; clientMessageId?: string | null; text: string; senderType: string; status: string;
}): string | null {
  if (message.senderType !== 'assistant' || message.status !== 'sent') return null;
  const block = readChatCodeBlock(message.text);
  if (!block || !canRenderChatCode(block)) return null;
  return '[网页作品引用] ' + JSON.stringify({ id: chatCodePreviewId(message), titleAtCreation: chatCodeTitle(block),
    notice: '源码按需用 get_code_work 分页读取；当前名称和收纳状态以 list_code_works 查询为准。此引用不表示已入库。' });
}
