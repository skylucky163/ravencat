import { normalizeAIBaseURL } from './baseUrl';
import { File } from 'expo-file-system';
import { getImageGenerationSize, getSiliconflowImageSize, type ImageGenerationProfile, type ImageGenerationParameters } from './imageGenerationConfig';
export interface ImageGenerationReference { uri: string; mimeType: string; base64: string }
export interface ImageGenerationConnection { baseURL: string; apiKey: string; model: string; profile: ImageGenerationProfile }

/** 业务输入在 Media 边界检查；这里只映射厂商的真实字段和上传协议。 */
export function buildImageGenerationRequest(config: ImageGenerationConnection, prompt: string, parameters: ImageGenerationParameters,
  reference: ImageGenerationReference | undefined, preview: boolean): { url: string; body: string | FormData; json: boolean; stream: boolean; diagnosticBody: string } {
  const profile = config.profile;
  if (profile.provider === 'customOpenAIImages') {
    const url = new URL(config.baseURL);
    url.pathname = url.pathname.replace(/\/+$/, '') + '/images/generations';
    const data = { model: config.model, prompt, n: 1, size: parameters.custom?.size,
      quality: parameters.custom?.quality, output_format: parameters.custom?.outputFormat };
    return { url: url.toString(), body: JSON.stringify(data), json: true, stream: false,
      diagnosticBody: JSON.stringify({ ...data, prompt: '[提示词已省略]' }) };
  }
  if (profile.provider === 'kling') {
    const contents: ({ type: 'prompt'; text: string } | { type: 'refer_image'; url: string; id: string })[] = [{ type: 'prompt', text: prompt }];
    if (reference) contents.push({ type: 'refer_image', url: reference.base64, id: 'reference' });
    const data = { contents, settings: {
      result_type: 'single', n: 1, resolution: parameters.resolution?.toLowerCase(), aspect_ratio: parameters.aspectRatio,
    } };
    return { url: new URL('/image-generation/kling-4.0', config.baseURL).toString(),
      body: JSON.stringify(data), json: true, stream: false,
      diagnosticBody: JSON.stringify(data, (key, value) => key === 'text' ? '[提示词已省略]' : key === 'url' ? '[参考图已省略]' : value) };
  }
  const base = normalizeAIBaseURL(config.baseURL);
  if (profile.provider === 'qwen') {
    const content: ({ image: string } | { text: string })[] = [];
    if (reference) content.push({ image: `data:${reference.mimeType};base64,${reference.base64}` });
    content.push({ text: prompt });
    const data = { model: config.model, input: { messages: [{ role: 'user', content }] },
      parameters: { n: 1, ...(parameters.aspectRatio || parameters.resolution
        ? { size: getImageGenerationSize(parameters.aspectRatio ?? '1:1', parameters.resolution ?? '1K').replace('x', '*') } : {}) } };
    // 资产保留已有百炼服务连接；图片走该服务的原生同步路径，不迁移凭据或探测其他协议。
    return { url: new URL('/api/v1/services/aigc/multimodal-generation/generation', base).toString(),
      body: JSON.stringify(data), json: true, stream: false,
      diagnosticBody: JSON.stringify(data, (key, value) => key === 'text' ? '[提示词已省略]' : key === 'image' ? '[参考图已省略]' : value) };
  }
  const data: Record<string, unknown> = { model: config.model, prompt };
  const gpt = profile.provider === 'openai';
  if (profile.provider !== 'seedream' && profile.provider !== 'siliconflow') data.n = 1;
  if (profile.provider === 'siliconflow') {
    const size = getSiliconflowImageSize(config.model, parameters.aspectRatio ?? '1:1');
    if (size !== undefined) data.image_size = size;
    if (config.model === 'Qwen/Qwen-Image') { data.num_inference_steps = 50; data.cfg = 4; }
  }
  if (parameters.aspectRatio || parameters.resolution) {
    if (profile.provider === 'minimax') {
      if (parameters.resolution) {
        const [width, height] = getImageGenerationSize(parameters.aspectRatio ?? '1:1', parameters.resolution).split('x').map(Number);
        const [ratioWidth, ratioHeight] = (parameters.aspectRatio ?? '1:1').split(':').map(Number);
        const unit = Math.floor(Math.min(width / ratioWidth, height / ratioHeight, 2048 / Math.max(ratioWidth, ratioHeight)) / 8) * 8;
        data.width = ratioWidth * unit; data.height = ratioHeight * unit;
      } else data.aspect_ratio = parameters.aspectRatio;
    }
    else if (profile.provider !== 'siliconflow') data.size = getImageGenerationSize(parameters.aspectRatio ?? '1:1', parameters.resolution ?? (profile.provider === 'seedream' ? '2K' : '1K'));
  }
  if (parameters.quality) data.quality = parameters.quality;
  if (parameters.outputFormat) data.output_format = parameters.outputFormat;
  if (parameters.outputCompression != null) data.output_compression = parameters.outputCompression;
  if (profile.provider === 'seedream' && config.model === 'doubao-seedream-4-5-251128') data.sequential_image_generation = 'disabled';
  const stream = gpt && preview;
  if (stream) { data.stream = true; data.partial_images = 2; }
  if (reference && !gpt) {
    const image = `data:${reference.mimeType};base64,${reference.base64}`;
    if (profile.provider === 'minimax') data.subject_reference = [{ type: 'character', image_file: image }];
    else data.image = image;
  }
  const path = profile.provider === 'minimax' ? 'image_generation' : reference && gpt ? 'images/edits' : 'images/generations';
  const diagnosticBody = JSON.stringify(data, (key, value) => key === 'prompt' ? '[提示词已省略]' : key === 'image' || key === 'subject_reference' ? '[参考图已省略]' : value);
  if (reference && gpt) {
    const body = new FormData();
    for (const [key, value] of Object.entries(data)) body.append(key, String(value));
    // expo/fetch 支持 Blob/File，不支持 RN 的 { uri } 上传对象。
    body.append('image[]', new File(reference.uri), `reference.${reference.mimeType.split('/')[1]}`);
    return { url: `${base}/${path}`, body, json: false, stream, diagnosticBody };
  }
  return { url: `${base}/${path}`, body: JSON.stringify(data), json: true, stream, diagnosticBody };
}
