/** 生图协议与参数契约；供应商选择来自资产配置，不按地址或错误猜测协议。 */
export const IMAGE_GENERATION_PROVIDERS = [
  { id: 'siliconflow', label: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1', models: ['Tongyi-MAI/Z-Image', 'Tongyi-MAI/Z-Image-Turbo', 'Qwen/Qwen-Image', 'Qwen/Qwen-Image-Edit', 'Qwen/Qwen-Image-Edit-2509', 'Kwai-Kolors/Kolors'] },
  { id: 'minimax', label: 'MiniMax', baseURL: 'https://api.minimax.cn/v1', models: ['image-01', 'image-01-live'] },
  // 4.5 已停止新购，新建配置默认使用 Flash；已有资产的模型仍由用户显式选择。
  { id: 'seedream', label: '火山引擎 · 豆包 Seedream', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-seedream-5-0-flash-260915', 'doubao-seedream-4-5-251128'] },
  { id: 'qwen', label: '阿里百炼 · 千问图像', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-image-2.1-pro', 'qwen-image-2.1-turbo'] },
  { id: 'openai', label: 'OpenAI · GPT Image', baseURL: 'https://api.openai.com/v1', models: ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2'] },
] as const;
export type ImageGenerationProvider = typeof IMAGE_GENERATION_PROVIDERS[number]['id'];
export interface ImageGenerationProfile { provider: ImageGenerationProvider }
export function readImageGenerationProfile(metadataJson: string | null | undefined): ImageGenerationProfile | null {
  // 旧自定义配置保留供用户修改，不能继续猜测协议或自动转成某个供应商。
  if (metadataJson == null) return null;
  const value: unknown = JSON.parse(metadataJson);
  if (typeof value === 'object' && value !== null && 'provider' in value && value.provider === 'openaiCompatible') return null;
  if (typeof value !== 'object' || value === null || !('provider' in value)
    || !IMAGE_GENERATION_PROVIDERS.some(provider => provider.id === value.provider)) throw new Error('生图供应商配置无效，请新建生图配置');
  return { provider: value.provider as ImageGenerationProvider };
}
/** 固定供应商的连接和模型在进入计费请求前校验，旧配置只保留修复入口。 */
export function getImageGenerationConfigurationError(profile: ImageGenerationProfile | null, baseURL: string, model: string): string | null {
  if (profile === null) return '自定义生图接口已停用，请新建并选择生图配置';
  const provider = IMAGE_GENERATION_PROVIDERS.find(item => item.id === profile.provider)!;
  if (baseURL.trim().replace(/\/+$/, '') !== provider.baseURL) return `API 地址与${provider.label}不匹配，请检查服务地址或新建配置`;
  if (!(provider.models as readonly string[]).includes(model.trim())) return '当前供应商尚未适配此模型，请选择列表中的模型';
  return null;
}
export const IMAGE_ASPECT_RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'] as const;
export type ImageAspectRatio = typeof IMAGE_ASPECT_RATIOS[number];
export type ImageResolution = '1K' | '1.5K' | '2K' | '4K';
export interface ImageGenerationParameters {
  aspectRatio?: ImageAspectRatio;
  resolution?: ImageResolution;
  quality?: 'low' | 'medium' | 'high';
  outputFormat?: 'png' | 'jpeg' | 'webp';
  outputCompression?: number;
}
export interface ImageGenerationCapabilities {
  aspectRatios: readonly ImageAspectRatio[]; resolutions: readonly ImageResolution[];
  references: boolean; referenceRequired: boolean; preview: boolean; quality: boolean; outputFormat: boolean; promptMaxLength: number;
  imageSizes?: Partial<Record<ImageAspectRatio, string>>;
}
export interface ImageGenerationReferenceInfo { mimeType: string; width: number; height: number; byteSize: number }

/** 文件真实性由 Device 检查；这里只检查供应商引入的上传限制，不重新读取或解码图片。 */
export function validateImageGenerationReference(profile: ImageGenerationProfile, reference: ImageGenerationReferenceInfo): string | null {
  const { mimeType, width, height, byteSize } = reference;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)
    || profile.provider === 'minimax' && mimeType === 'image/webp') return '当前参考图请使用 JPEG 或 PNG 格式';
  if (profile.provider === 'minimax' && byteSize >= 10_000_000) return 'MiniMax 参考图必须小于 10 MB';
  if (profile.provider === 'qwen') {
    if (byteSize > 10_000_000) return '千问参考图不能超过 10 MB';
    if (width > 8000 || height > 8000) return '千问参考图的单边不能超过 8000 像素';
    if (Math.max(width, height) / Math.min(width, height) > 10) return '千问参考图的长短边比例不能超过 10:1';
  }
  if (profile.provider === 'seedream') {
    if (byteSize > 30_000_000) return 'Seedream 参考图不能超过 30 MB';
    if (width <= 14 || height <= 14 || width * height > 36_000_000) return 'Seedream 参考图每边须大于 14 像素，总像素不能超过 3600 万';
    if (Math.max(width, height) / Math.min(width, height) > 16) return 'Seedream 参考图的长短边比例不能超过 16:1';
  }
  if (profile.provider === 'openai' && byteSize >= 50_000_000) return 'GPT Image 参考图必须小于 50 MB';
  return null;
}

export function getImageGenerationCapabilities(profile: ImageGenerationProfile, model: string): ImageGenerationCapabilities {
  if (profile.provider === 'siliconflow') {
    const config = SILICONFLOW_IMAGE_MODELS[model as SiliconflowImageModel];
    return { aspectRatios: Object.keys(config.sizes) as ImageAspectRatio[], imageSizes: config.sizes, resolutions: [],
      references: config.reference !== 'none', referenceRequired: config.reference === 'required', preview: false, quality: false, outputFormat: false, promptMaxLength: 2000 };
  }
  const gpt = profile.provider === 'openai';
  return {
    aspectRatios: (profile.provider === 'minimax' && model === 'image-01' || profile.provider === 'seedream') ? IMAGE_ASPECT_RATIOS : IMAGE_ASPECT_RATIOS.slice(0, 7),
    resolutions: profile.provider === 'minimax' ? model === 'image-01' ? ['1K', '2K'] : [] : profile.provider === 'seedream'
      ? model === 'doubao-seedream-5-0-flash-260915' ? ['1K', '1.5K', '2K'] : ['2K', '4K']
      : profile.provider === 'qwen' ? ['1K'] : ['1K', '2K'],
    references: true, referenceRequired: false, preview: gpt, quality: gpt, outputFormat: gpt,
    promptMaxLength: profile.provider === 'minimax' ? 1500 : 2000,
  };
}
const SIZES_1K: Record<ImageAspectRatio, readonly [number, number]> = {
  '1:1': [1024, 1024], '3:2': [1248, 832], '2:3': [832, 1248], '4:3': [1152, 864], '3:4': [864, 1152], '16:9': [1280, 720], '9:16': [720, 1280], '21:9': [1512, 648],
};
const SIZES_2K: Record<ImageAspectRatio, readonly [number, number]> = {
  '1:1': [2048, 2048], '3:2': [2496, 1664], '2:3': [1664, 2496], '4:3': [2304, 1728], '3:4': [1728, 2304], '16:9': [2848, 1600], '9:16': [1600, 2848], '21:9': [3136, 1344],
};
const SIZES_4K: Record<ImageAspectRatio, readonly [number, number]> = {
  '1:1': [4096, 4096], '3:2': [4992, 3328], '2:3': [3328, 4992], '4:3': [4704, 3520], '3:4': [3520, 4704], '16:9': [5504, 3040], '9:16': [3040, 5504], '21:9': [6240, 2656],
};
export function getImageGenerationSize(ratio: ImageAspectRatio, resolution: ImageResolution): string {
  const size = resolution === '4K' ? SIZES_4K[ratio] : resolution === '2K' ? SIZES_2K[ratio] : SIZES_1K[ratio];
  return (resolution === '1.5K' ? size.map(edge => Math.round(edge * 1.5 / 16) * 16) : size).join('x');
}
type SiliconflowImageModel = typeof IMAGE_GENERATION_PROVIDERS[0]['models'][number];
const SILICONFLOW_Z_SIZES = Object.fromEntries(IMAGE_ASPECT_RATIOS.slice(0, 7).map(ratio => [ratio, getImageGenerationSize(ratio, '1K')]));
/** 同一服务内按完整模型 ID 映射能力；编辑模型不接收 image_size，也不能省略参考图。 */
const SILICONFLOW_IMAGE_MODELS: Record<SiliconflowImageModel, { sizes: Partial<Record<ImageAspectRatio, string>>; reference: 'none' | 'optional' | 'required' }> = {
  'Tongyi-MAI/Z-Image': { sizes: SILICONFLOW_Z_SIZES, reference: 'none' },
  'Tongyi-MAI/Z-Image-Turbo': { sizes: SILICONFLOW_Z_SIZES, reference: 'none' },
  'Qwen/Qwen-Image': { sizes: { '1:1': '1328x1328', '16:9': '1664x928', '9:16': '928x1664', '4:3': '1472x1140', '3:4': '1140x1472', '3:2': '1584x1056', '2:3': '1056x1584' }, reference: 'none' },
  'Qwen/Qwen-Image-Edit': { sizes: {}, reference: 'required' },
  'Qwen/Qwen-Image-Edit-2509': { sizes: {}, reference: 'required' },
  'Kwai-Kolors/Kolors': { sizes: { '1:1': '1024x1024', '3:4': '960x1280', '9:16': '720x1280' }, reference: 'optional' },
};
export function getSiliconflowImageSize(model: string, ratio: ImageAspectRatio): string | undefined {
  return SILICONFLOW_IMAGE_MODELS[model as SiliconflowImageModel].sizes[ratio];
}
/** 用户参数只在进入协议前按已选择的能力校验；不静默丢字段或改用别的模型。 */
export function validateImageGenerationParameters(capabilities: ImageGenerationCapabilities, parameters: ImageGenerationParameters, hasReference: boolean): string | null {
  if (parameters.aspectRatio && !capabilities.aspectRatios.includes(parameters.aspectRatio)) return '当前配置不支持这个图片比例';
  if (parameters.resolution && !capabilities.resolutions.includes(parameters.resolution)) return '当前配置不支持这个清晰度';
  if (hasReference && !capabilities.references) return '当前配置未启用参考图能力';
  if (capabilities.referenceRequired && !hasReference) return '当前模型用于编辑图片，请先添加一张参考图';
  if (parameters.quality && !capabilities.quality) return '当前配置不支持画质参数';
  if (parameters.outputFormat && !capabilities.outputFormat) return '当前配置不支持输出格式参数';
  if (parameters.outputCompression != null && (!capabilities.outputFormat || parameters.outputFormat !== 'jpeg' && parameters.outputFormat !== 'webp'
    || !Number.isInteger(parameters.outputCompression) || parameters.outputCompression < 0 || parameters.outputCompression > 100)) return '压缩质量只适用于 JPEG／WebP，范围为 0–100';
  return null;
}
