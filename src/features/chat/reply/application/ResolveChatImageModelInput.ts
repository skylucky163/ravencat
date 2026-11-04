/** 按角色的图片识别选择决定直接传图或先由视觉模型转述。 */

import { createAIClient } from '@platform/ai';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import {
  getChatReplyRuntimeDependencies,
  type ChatMediaReadInput,
} from './ChatReplyRuntimeDependencies';
import { buildVisionOCRPromptBlocks } from './ReplyTaskPromptBlocks';

export type ChatImageModelInputPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * 未选择视觉模型时直接传图；选择后先转述。
 * 已选择的模型失效时进入 vision_unavailable，识别请求失败时保留失败文本。
 */
export type ChatImageModelInputRoute = 'direct_vision' | 'ocr' | 'vision_unavailable';

export interface ResolveChatImageModelInputResult {
  parts: ChatImageModelInputPart[];
  route: ChatImageModelInputRoute;
  ocrSucceeded: boolean | null;
}

interface ResolveChatImageModelInputBaseParams {
  assistantId: string;
  contextText: string;
  signal?: AbortSignal;
}

export type ResolveChatImageModelInputParams = ResolveChatImageModelInputBaseParams & (
  | { imageUri: string; mediaAssetId?: never }
  | { mediaAssetId: string; imageUri?: never }
);

function toDataUrl(base64: string, mimeType: string): string {
  return `data:${mimeType};base64,${base64}`;
}

function buildDirectVisionContext(contextText: string): string {
  return [
    contextText,
    '',
    '[视觉输入状态：原图已直接提供]',
  ].join('\n');
}

function buildOCRContext(params: {
  contextText: string;
  ocrText: string;
}): string {
  return [
    params.contextText,
    '',
    '[视觉输入状态：仅收到 OCR 转述，未收到原图]',
    '以下文字由已绑定的 OCR 模型根据图片生成。请把它视为可能不完整的视觉转述，不要声称自己直接看见了原图，也不要补充转述中不存在的细节。',
    '',
    '[OCR 转述开始]',
    params.ocrText,
    '[OCR 转述结束]',
  ].join('\n');
}

function buildOCRFailureContext(contextText: string): string {
  return [
    contextText,
    '',
    '[视觉输入状态：OCR 失败，未向主模型提供原图]',
    '本轮视觉能力暂时失效：已绑定的 OCR 模型没有返回可靠的图片转述。',
    '你没有收到图片内容或可靠的 OCR 转述。请简短说明暂时看不到这张图片；不得描述、推断或假装看见。',
  ].join('\n');
}

function buildVisionUnavailableContext(contextText: string): string {
  return [
    contextText,
    '',
    '[视觉输入状态：视觉识别不可用，未向主模型提供原图]',
    '当前角色配置要求先进行视觉识别，但已选择的视觉识别模型不可用，因此本轮没有获得图片内容。',
    '你没有收到图片内容或任何视觉转述。请说明暂时无法处理这张图片；不得描述、推断或假装看见。',
  ].join('\n');
}

export async function resolveChatImageModelInput(
  params: ResolveChatImageModelInputParams,
): Promise<ResolveChatImageModelInputResult> {
  throwIfAbortSignalAborted(params.signal);
  const mediaInput: ChatMediaReadInput = 'mediaAssetId' in params
    ? { kind: 'media_asset', assetId: params.mediaAssetId }
    : { kind: 'legacy_uri', uri: params.imageUri };
  const image = await getChatReplyRuntimeDependencies().media.readVisionImage(mediaInput);
  const imagePart: ChatImageModelInputPart = {
    type: 'image_url',
    image_url: { url: toDataUrl(image.base64, image.mimeType) },
  };
  const selection = await getChatReplyRuntimeDependencies().vision.resolveOCRModel(params.assistantId);

  if (selection.status === 'unconfigured') {
    console.info('[ChatImageInput] direct vision route selected', {
      assistantId: params.assistantId,
    });
    return {
      route: 'direct_vision',
      ocrSucceeded: null,
      parts: [
        { type: 'text', text: buildDirectVisionContext(params.contextText) },
        imagePart,
      ],
    };
  }

  if (selection.status === 'unavailable') {
    console.warn('[ChatImageInput] selected vision model is unavailable', {
      assistantId: params.assistantId,
    });
    return {
      route: 'vision_unavailable',
      ocrSucceeded: null,
      parts: [{ type: 'text', text: buildVisionUnavailableContext(params.contextText) }],
    };
  }

  const ocrModel = selection.model;
  const ocrTaskInput = '读取本轮提供的图片，只输出可靠的 OCR 与必要视觉转述。';
  const promptPack = await getChatReplyRuntimeDependencies().prompt.assembleStandalone({
    scenarioId: 'vision.ocr',
    assistantId: params.assistantId,
    blocks: buildVisionOCRPromptBlocks(
      await getChatReplyRuntimeDependencies().prompt.resolveVisionOCRPrompt(params.assistantId),
    ),
    currentInput: ocrTaskInput,
  });
  const client = createAIClient({
    baseURL: ocrModel.baseURL,
    apiKey: ocrModel.apiKey,
    model: ocrModel.model,
    temperature: ocrModel.temperature,
    topP: ocrModel.topP,
    maxTokens: ocrModel.maxTokens,
    systemPrompt: promptPack.systemPrompt,
  });

  try {
    const response = await client.chat(
      [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '请读取这张图片中的全部可见文字，并补充理解图片所必需的可见画面线索。无法确认的内容不要猜测。',
            },
            imagePart,
          ],
        },
      ],
      { allowImageContentFallback: false, allowReasoningLengthRetry: false, signal: params.signal },
    );
    const ocrText = response.text.trim();
    if (!response.success || !ocrText) {
      const error = response.error?.trim() || 'OCR 模型没有返回可靠文本';
      console.warn('[ChatImageInput] OCR failed', {
        assistantId: params.assistantId,
        modelConfigId: ocrModel.modelConfigId,
        error,
      });
      return {
        route: 'ocr',
        ocrSucceeded: false,
        parts: [{ type: 'text', text: buildOCRFailureContext(params.contextText) }],
      };
    }

    console.info('[ChatImageInput] OCR route completed', {
      assistantId: params.assistantId,
      modelConfigId: ocrModel.modelConfigId,
    });
    return {
      route: 'ocr',
      ocrSucceeded: true,
      parts: [{ type: 'text', text: buildOCRContext({ contextText: params.contextText, ocrText }) }],
    };
  } catch (error) {
    throwIfAbortSignalAborted(params.signal);
    const message = error instanceof Error ? error.message : 'OCR 请求发生未知错误';
    console.warn('[ChatImageInput] OCR request failed', {
      assistantId: params.assistantId,
      modelConfigId: ocrModel.modelConfigId,
      error: message,
    });
    return {
      route: 'ocr',
      ocrSucceeded: false,
      parts: [{ type: 'text', text: buildOCRFailureContext(params.contextText) }],
    };
  }
}
