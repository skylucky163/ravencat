/** AI 正文与代码围栏共用确定性分段；气泡边界由客户端决定。 */
import type { BubbleDeliveryMode } from '@shared/prompt';
import { splitReplyContentBlocks } from '../../messages/domain/ChatCodeBlock';

/**
 * 把模型输出的纯文本切成气泡段：
 * 1. 代码围栏始终独立成泡，内部原样保留；
 * 2. 普通正文只按空行分泡，不按长度或句末标点切分，避免拆开段内 Markdown；
 * 3. single-bubble 只合并普通正文，不合并代码卡片。
 *
 * 增量展示与最终提交保留相同段落边界，不回头移动已显示的内容。
 */
export function segmentAssistantReplyText(
  rawText: string,
  bubbleDeliveryMode: BubbleDeliveryMode,
): string[] {
  return segmentAssistantReplyProgress(rawText, bubbleDeliveryMode, true).map(segment => segment.text);
}

/** 增量展示与最终落库共用边界；completed 表示后续文字不会再进入这一泡。 */
export function segmentAssistantReplyProgress(
  rawText: string,
  bubbleDeliveryMode: BubbleDeliveryMode,
  completed: boolean,
): { text: string; completed: boolean }[] {
  return splitReplyContentBlocks(rawText, completed).flatMap(block => {
    if (block.kind === 'code') return [{ text: block.text, completed: block.completed }];
    return segmentPlainText(block.text, bubbleDeliveryMode, block.completed);
  });
}

function segmentPlainText(
  rawText: string,
  bubbleDeliveryMode: BubbleDeliveryMode,
  completed: boolean,
): { text: string; completed: boolean }[] {
  if (bubbleDeliveryMode === 'single-bubble') {
    const text = rawText.trim();
    return text ? [{ text, completed }] : [];
  }
  // 保留末尾空行的分隔事实；先 trim 整段会使刚闭合的气泡重新成为活动尾段。
  const paragraphs = rawText.split(/\n\s*\n/);
  return paragraphs.flatMap((rawParagraph, index) => {
    const paragraph = rawParagraph.trim();
    return paragraph ? [{ text: paragraph, completed: completed || index < paragraphs.length - 1 }] : [];
  });
}
