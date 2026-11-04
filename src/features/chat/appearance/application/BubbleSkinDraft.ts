import type { BubbleDecorationConfig, BubbleSkinConfig, BubbleSkinRole } from '../domain/ChatBubbleSkin';

/** 已保存图片仅引用媒体身份；新图片在编辑会话的缓存中持有，保存时才物化媒体引用。 */
export interface BubbleDraftImage { mediaAssetId: string | null; uri: string; width: number; height: number }
export interface BubbleDraftDecoration extends BubbleDraftImage { id: string; slot: number; config: BubbleDecorationConfig }
export interface BubbleSkinDraft {
  id: string;
  revision: number;
  role: BubbleSkinRole;
  name: string;
  /** 新组合的初始字色；已保存组合的字色独立即时提交，不由结构草稿覆盖。 */
  textColor: string;
  image: BubbleDraftImage | null;
  config: BubbleSkinConfig;
  decorations: BubbleDraftDecoration[];
}

export function bubbleDraftFingerprint(draft: BubbleSkinDraft): string { return JSON.stringify(draft); }
