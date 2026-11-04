/** 构造图片 OCR 内部模型任务使用的受保护 Prompt Blocks。 */

import type {
  PromptPackBlock,
  PromptScenarioId,
} from '@shared/prompt';

export const VISION_OCR_SYSTEM_PROMPT = [
  '你是图片 OCR 与视觉转述模型。',
  '只根据本轮图片输出可靠结果，不得根据文件名、上下文或常识猜测。',
  '用中文读取全部可见文字，并简洁补充理解图片所必需的可见画面线索。',
].join('\n');

export const VISION_OCR_OUTPUT_CONTRACT = [
  '无法确认的内容必须明确说无法识别。',
  '只输出转述正文，不要输出 XML、Markdown 围栏或前后说明。',
].join('\n');

/** 正文由提示词中心解析后传入；输出契约始终锁定，不随正文覆盖改变。 */
export function buildVisionOCRPromptBlocks(content: string): PromptPackBlock[] {
  return [
    block(
      'vision.ocr',
      'internal.vision_ocr',
      '图片 OCR 与视觉转述',
      content,
      'foundation',
      'overridable',
    ),
    block(
      'vision.ocr',
      'output.vision_ocr_plain_text',
      'OCR 纯文本输出',
      VISION_OCR_OUTPUT_CONTRACT,
      'output_contract',
      'locked',
    ),
  ];
}

function block(
  scenario: PromptScenarioId,
  definitionId: string,
  title: string,
  content: string,
  slot: 'foundation' | 'scenario' | 'output_contract',
  protection: 'overridable' | 'locked',
): PromptPackBlock {
  return {
    key: 'persona',
    instanceId: `chatTask:${definitionId}`,
    definitionId,
    slot,
    protection,
    title,
    content,
    required: true,
    status: 'ready',
    source: 'ReplyTaskPromptBlocks',
    truncatable: protection !== 'locked',
    scenario,
    placement: 'system',
  };
}
