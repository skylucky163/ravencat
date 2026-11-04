import type { DatabaseTransactionExecutor } from '@platform/persistence';

export type BubbleSkinRole = 'user' | 'ai';
export const DEFAULT_BUBBLE_TEXT_COLORS = { user: '#FFFFFF', ai: '#1C1C1E' } as const;

export function parseBubbleTextColor(value: unknown): string {
  if (typeof value !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) throw new Error('气泡文字颜色无效');
  return value;
}
export interface BubbleInsets { left: number; top: number; right: number; bottom: number }
export interface BubbleSkinConfig {
  /** 源 PNG 像素；与内容留白各自独立。 */
  slices: BubbleInsets;
  /** 目标 dp。 */
  padding: BubbleInsets;
  /** 一个源像素对应的 dp。 */
  scale: number;
}
export interface BubbleDecorationConfig {
  anchor: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** 最长边的最大显示尺寸，单位 dp；短气泡中的尺寸和偏移等比收敛。 */
  size: number;
  /** 相对跟随角的内向偏移，负数允许装饰破形；不限制在气泡内部。 */
  offsetX: number;
  offsetY: number;
}
export interface BubbleDecoration {
  id: string;
  slot: number;
  mediaAssetId: string;
  width: number;
  height: number;
  config: BubbleDecorationConfig;
}
export const MAX_BUBBLE_DECORATIONS = 4;
export const DEFAULT_BUBBLE_DECORATION_CONFIG: BubbleDecorationConfig = {
  anchor: 'bottom-left', size: 64, offsetX: 0, offsetY: 0,
};
export interface BubbleSkinImage {
  mediaAssetId: string;
  width: number;
  height: number;
  config: BubbleSkinConfig;
}
export interface BubbleSkinPreset extends BubbleSkinImage {
  id: string;
  role: BubbleSkinRole;
  name: string;
  revision: number;
  textColor: string;
  decorations: BubbleDecoration[];
}
export type ChatBubbleSkin = BubbleSkinPreset;
export interface BubbleSkinCollection {
  presets: BubbleSkinPreset[];
  selected: Record<BubbleSkinRole, string | null>;
}
export interface ChatBubbleSkinRepository {
  list(): Promise<BubbleSkinCollection>;
  /** 结构、饰品与启用选择一起提交；已有作品保留即时提交的最新字色，revision 保护结构草稿。 */
  save(transaction: DatabaseTransactionExecutor, preset: BubbleSkinPreset): Promise<string[]>;
  select(role: BubbleSkinRole, presetId: string | null): Promise<void>;
  setTextColor(presetId: string, color: string): Promise<void>;
  remove(presetId: string): Promise<string[]>;
}

export function parseBubbleDecorationConfig(value: unknown): BubbleDecorationConfig {
  if (!value || typeof value !== 'object') throw new Error('装饰位置配置无效');
  const config = value as BubbleDecorationConfig;
  if (!['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(config.anchor)
    || !Number.isFinite(config.size) || config.size < 16 || config.size > 160
    || !Number.isFinite(config.offsetX) || !Number.isFinite(config.offsetY)) {
    throw new Error('装饰大小或位置超出可调整范围');
  }
  return { anchor: config.anchor, size: config.size, offsetX: config.offsetX, offsetY: config.offsetY };
}

/** 用户主动应用时补足固定边框的安全距离，不把切线调整与文字留白自动联动。 */
export function bubblePaddingOutsideFrame(config: BubbleSkinConfig): BubbleInsets {
  const { slices, scale, padding } = config;
  return { left: Math.max(padding.left, Math.ceil(slices.left * scale) + 4),
    right: Math.max(padding.right, Math.ceil(slices.right * scale) + 4),
    top: Math.max(padding.top, Math.ceil(slices.top * scale) + 4),
    bottom: Math.max(padding.bottom, Math.ceil(slices.bottom * scale) + 4) };
}

export function defaultBubbleSkinConfig(width: number, height: number): BubbleSkinConfig {
  return { slices: { left: 0, right: 0, top: 0, bottom: 0 },
    // 按原图最长边确定固定显示标尺，后续调整切线不改变比例。
    // 文字留白与 daylight/night 默认气泡保持一致，底图切线交给用户按需调整。
    padding: { left: 10, right: 10, top: 8, bottom: 8 }, scale: Math.min(1, 48 / Math.max(width, height)) };
}

/** 用户编辑和 SQLite JSON 均为边界；渲染器接收通过此处校验的配置。 */
export function parseBubbleSkinConfig(value: unknown, width: number, height: number): BubbleSkinConfig {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3 || width > 2048 || height > 2048) {
    throw new Error('气泡图片尺寸无效');
  }
  if (!value || typeof value !== 'object') throw new Error('气泡配置无效');
  const candidate = value as BubbleSkinConfig;
  for (const [name, max, integers] of [['slices', 2048, true], ['padding', 256, false]] as const) {
    const insets = candidate[name];
    if (!insets || typeof insets !== 'object') throw new Error('气泡边距配置无效');
    for (const side of ['left', 'top', 'right', 'bottom'] as const) {
      const n = insets[side];
      if (!Number.isFinite(n) || n < 0 || n > max || (integers && !Number.isInteger(n))) {
        throw new Error(name === 'slices' ? '拉伸切线必须是图片内的整数像素' : '内容留白应在 0–256 dp 之间');
      }
    }
  }
  if (candidate.slices.left + candidate.slices.right >= width || candidate.slices.top + candidate.slices.bottom >= height) {
    throw new Error('两侧固定区域之间至少需要保留一个可拉伸像素');
  }
  if (!Number.isFinite(candidate.scale) || candidate.scale < 0.02 || candidate.scale > 2) {
    throw new Error('显示比例应在 0.02–2 dp/像素之间');
  }
  if ((candidate.slices.left + candidate.slices.right) * candidate.scale > 160
    || (candidate.slices.top + candidate.slices.bottom) * candidate.scale > 240) {
    throw new Error('固定边框过大，请减小显示比例或固定区域（宽度合计最多 160 dp，高度 240 dp）');
  }
  return {
    slices: { left: candidate.slices.left, top: candidate.slices.top, right: candidate.slices.right, bottom: candidate.slices.bottom },
    padding: { left: candidate.padding.left, top: candidate.padding.top, right: candidate.padding.right, bottom: candidate.padding.bottom },
    scale: candidate.scale,
  };
}
