import { getImageSizeRatio, isCustomImageParameterValue, type CustomImageParameterField } from './imageGenerationConfig';

export interface ImageParameterCheck { field: CustomImageParameterField; value: string }
export type ImageParameterCheckResult =
  | { status: 'confirmed' | 'uncertain'; reason: string }
  | ImageParameterRejection;
export interface ImageParameterRejection {
  status: 'rejected'; scope: 'field' | 'value'; reason: string; supportedValues: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function readImageRequestError(raw: string): Record<string, unknown> | null {
  try {
    const response = asRecord(JSON.parse(raw));
    return asRecord(response?.error) ?? response;
  } catch { return null; }
}

export function readImageParameterRejection(error: Record<string, unknown>, check: ImageParameterCheck): ImageParameterRejection | undefined {
  const parameter = check.field === 'outputFormat' ? 'output_format' : check.field;
  if (error.param != null && error.param !== parameter) return;
  const message = typeof error.message === 'string' ? error.message : '';
  const fieldMention = `['"\`]?${parameter}['"\`]?(?![\\w])`;
  const code = typeof error.code === 'string' ? error.code : '';
  const rejectsField = error.param === parameter && ['unknown_parameter', 'unsupported_parameter'].includes(code)
    || new RegExp(`^\\s*(?:unknown|unrecognized|unsupported) parameter\\s*:?\\s*${fieldMention}`, 'i').test(message)
    || new RegExp(`^\\s*(?:the )?(?:parameter ${fieldMention}|${fieldMention} parameter) is not supported\\b`, 'i').test(message);
  const rejectsValue = error.param === parameter && ['invalid_value', 'unsupported_value', 'invalid_parameter_value'].includes(code)
    || new RegExp(`^\\s*(?:(?:invalid|unsupported) (?:value for (?:parameter )?)?${fieldMention}\\s*:|${fieldMention} must be one of\\b)`, 'i').test(message);
  if (!rejectsField && !rejectsValue) return;
  const advertised = message.match(/(?:supported values|allowed values|must be one of)(?: (?:are|include))?\s*:?\s*([^.!?\n]+)/i)?.[1];
  const offered = Array.isArray(error.supported_values) ? error.supported_values
    : advertised?.match(/\b\w+\b/g) ?? [];
  const supportedValues = [...new Set(offered.filter((value): value is string =>
    typeof value === 'string' && (value === 'auto' && check.field !== 'outputFormat' || isCustomImageParameterValue(check.field, value))))];
  return rejectsField
    ? { status: 'rejected', scope: 'field', reason: '接口明确拒绝此字段，生成时使用服务默认。', supportedValues }
    : { status: 'rejected', scope: 'value', reason: '接口明确拒绝当前取值，生成时使用服务默认。可改选其他值检测。', supportedValues };
}

export function readImageResponseQuality(body: unknown): string | undefined {
  const quality = asRecord(body)?.quality;
  return typeof quality === 'string' && isCustomImageParameterValue('quality', quality) ? quality : undefined;
}

export interface GeneratedImageDetails { width: number; height: number; mimeType: string }
export function verifyImageParameter(check: ImageParameterCheck, image: GeneratedImageDetails, quality: string | undefined): ImageParameterCheckResult {
  if (check.field === 'size') {
    const actualSize = `${image.width} × ${image.height}`;
    if (getImageSizeRatio(`${image.width}x${image.height}`) !== getImageSizeRatio(check.value)) {
      return { status: 'uncertain', reason: `实际成图为 ${actualSize}，与所选比例不同。` };
    }
    return { status: 'confirmed', reason: `实际成图为 ${actualSize}，与所选比例一致。` };
  } else if (check.field === 'outputFormat') {
    if (image.mimeType !== `image/${check.value}`) return { status: 'uncertain', reason: `实际成图格式为 ${image.mimeType}，与所选值不同。` };
  } else if (quality !== check.value) {
    return { status: 'uncertain', reason: quality ? `服务报告实际画质为 ${quality}。可选 ${quality} 或使用服务默认。` : '服务已出图，但响应未确认实际使用的画质。' };
  }
  return { status: 'confirmed', reason: check.field === 'quality' ? '响应确认使用了所选画质。' : '实际成图与所选值一致。' };
}
