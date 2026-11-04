/** 暴露 OCR 等 Chat 回复内部模型任务的提示词元数据。 */

import type { PromptDefinitionDescriptor } from '@shared/prompt';
import {
  VISION_OCR_OUTPUT_CONTRACT,
  VISION_OCR_SYSTEM_PROMPT,
} from './ReplyTaskPromptBlocks';

export const REPLY_TASK_PROMPT_DEFINITIONS = [
  {
    id: 'internal.vision_ocr',
    version: 3,
    name: '图片识别提示词',
    description: '读取本轮图片可见文字，并只补充可靠的必要画面线索。',
    owner: 'chat',
    category: 'internal',
    supportedScenarios: ['vision.ocr'],
    defaultSlot: 'foundation',
    placement: 'system',
    protection: 'overridable',
    protectionReason: '正文由提示词中心管理；输出契约仍锁定，不随正文覆盖改变。',
    contentKind: 'static',
    content: VISION_OCR_SYSTEM_PROMPT,
    defaultContent: VISION_OCR_SYSTEM_PROMPT,
    sourcePath: 'src/features/chat/reply/application/ReplyTaskPromptBlocks.ts',
  },
  {
    id: 'output.vision_ocr_plain_text',
    version: 2,
    name: 'OCR 纯文本输出',
    description: '只输出视觉转述正文，不返回聊天 XML、Markdown 围栏或额外说明。',
    owner: 'chat',
    category: 'output',
    supportedScenarios: ['vision.ocr'],
    defaultSlot: 'output_contract',
    placement: 'system',
    protection: 'locked',
    protectionReason: '主模型接收的是可信边界明确的 OCR 文本。',
    contentKind: 'static',
    content: VISION_OCR_OUTPUT_CONTRACT,
    sourcePath: 'src/features/chat/reply/application/ReplyTaskPromptBlocks.ts',
  },
] satisfies PromptDefinitionDescriptor[];
