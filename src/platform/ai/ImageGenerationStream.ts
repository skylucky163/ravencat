import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
export interface ImageGenerationPreview { base64: string; mimeType: string; index: number }
export class ImageGenerationStreamError extends Error {
  constructor(public readonly kind: 'provider' | 'invalid_response', message: string) { super(message); }
}

/** GPT Image 的预览与最终事件不是百分比；只交付服务器实际返回的图像。 */
export async function readImageGenerationStream(response: Response, signal: AbortSignal, eventType: 'image_generation' | 'image_edit', onPreview?: (preview: ImageGenerationPreview) => void): Promise<unknown> {
  if (!response.body) throw new ImageGenerationStreamError('invalid_response', '图片流式响应为空');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalImage: string | null = null;
  const consume = (event: string) => {
    const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let value: unknown;
    try { value = JSON.parse(data); } catch { throw new ImageGenerationStreamError('invalid_response', '图片流式事件不是有效 JSON'); }
    if (typeof value !== 'object' || value === null || !('type' in value)) throw new ImageGenerationStreamError('invalid_response', '图片流式事件格式无效');
    const record = value as Record<string, unknown>;
    if (record.type === 'error' || record.error) throw new ImageGenerationStreamError('provider', JSON.stringify(record.error ?? record));
    if (record.type === `${eventType}.partial_image` || record.type === `${eventType}.completed`) {
      if (typeof record.b64_json !== 'string' || !record.b64_json.trim()) throw new ImageGenerationStreamError('invalid_response', '图片流式事件缺少内容');
      if (record.type === `${eventType}.completed`) {
        if (finalImage !== null) throw new ImageGenerationStreamError('invalid_response', '图片流返回了多个最终结果');
        finalImage = record.b64_json;
      } else {
        if (!Number.isInteger(record.partial_image_index) || Number(record.partial_image_index) < 0 || Number(record.partial_image_index) > 2
          || !['png', 'jpeg', 'webp'].includes(String(record.output_format))) throw new ImageGenerationStreamError('invalid_response', '图片预览事件格式无效');
        throwIfAbortSignalAborted(signal);
        onPreview?.({ base64: record.b64_json, mimeType: `image/${record.output_format}`, index: Number(record.partial_image_index) });
      }
    }
  };
  try {
    while (true) {
      throwIfAbortSignalAborted(signal);
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
      if (chunk.done) break;
    }
    if (buffer.trim()) consume(buffer);
    if (finalImage === null) throw new ImageGenerationStreamError('invalid_response', '图片流已中断，未收到最终图片');
    return { data: [{ b64_json: finalImage }] };
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
}
