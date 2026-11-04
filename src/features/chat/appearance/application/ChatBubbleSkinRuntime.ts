import { prepareMediaAssetBatch, MEDIA_ASSET_STORAGE_BACKEND, releaseMediaAssetCandidates, resolveMediaAsset } from '@features/media';
import { databaseCoordinator } from '@platform/persistence';
import { prepareBubbleImage } from '@platform/device/MessageBubbleBackground';
import { createRandomUUID } from '@platform/device';
import { createRuntimeSlot } from '@shared/runtime/RuntimeSlot';
import { DEFAULT_BUBBLE_TEXT_COLORS, defaultBubbleSkinConfig, parseBubbleDecorationConfig, parseBubbleSkinConfig, parseBubbleTextColor,
  type BubbleDecoration, type BubbleSkinRole, type BubbleSkinPreset,
  type ChatBubbleSkin, type ChatBubbleSkinRepository } from '../domain/ChatBubbleSkin';
import type { BubbleDraftImage, BubbleSkinDraft } from './BubbleSkinDraft';

export interface ResolvedBubbleDecoration extends BubbleDecoration { uri: string | null; error: string | null }
export interface ResolvedBubbleSkin extends Omit<ChatBubbleSkin, 'decorations'> {
  uri: string | null; error: string | null; decorations: ResolvedBubbleDecoration[];
}
export interface BubbleSkinSnapshot {
  user: ResolvedBubbleSkin | null;
  ai: ResolvedBubbleSkin | null;
  presets: BubbleSkinPreset[];
  error: string | null;
}
const repository = createRuntimeSlot<ChatBubbleSkinRepository>('ChatBubbleSkin');
export const configureChatBubbleSkins = (port: ChatBubbleSkinRepository) => repository.configure(port);
let snapshot: BubbleSkinSnapshot = { user: null, ai: null, presets: [], error: null };
let loading: Promise<void> | null = null;
let revision = 0;
const listeners = new Set<() => void>();
export const getBubbleSkinSnapshot = () => snapshot;
export const subscribeBubbleSkins = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function publish(next: BubbleSkinSnapshot) { snapshot = next; listeners.forEach(listener => listener()); }
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

async function resolveImage(reference: { mediaAssetId: string; width: number; height: number }) {
  try {
    const { localUri } = await resolveMediaAsset(reference.mediaAssetId);
    const image = await prepareBubbleImage(localUri);
    if (image.width !== reference.width || image.height !== reference.height) throw new Error('气泡文件尺寸与保存记录不符，请重新导入');
    return { uri: localUri, error: null };
  } catch (error) {
    // 文件/原生边界失效统一发布；不让每个消息实例重复重试或弹窗。
    return { uri: null, error: errorMessage(error) };
  }
}
async function resolvePreset(preset: BubbleSkinPreset): Promise<ResolvedBubbleSkin> {
  const [image, decorations] = await Promise.all([resolveImage(preset),
    Promise.all(preset.decorations.map(async decoration => ({ ...decoration, ...await resolveImage(decoration) })))]);
  return { ...preset, ...image, decorations };
}
async function reload() {
  const request = ++revision;
  const { presets, selected } = await repository.get().list();
  const active = await Promise.all((['user', 'ai'] as const).map(role => {
    const id = selected[role];
    return id === null ? null : resolvePreset(presets.find(preset => preset.id === id)!);
  }));
  if (request === revision) publish({ user: active[0], ai: active[1], presets, error: null });
}

export function loadChatBubbleSkins(): Promise<void> {
  if (!loading) loading = reload().catch(error => { publish({ ...snapshot, error: errorMessage(error) }); });
  return loading;
}

export async function openBubbleSkinDraft(role: BubbleSkinRole, presetId: string | null): Promise<BubbleSkinDraft> {
  if (presetId === null) {
    const names = new Set(snapshot.presets.filter(item => item.role === role).map(item => item.name));
    let number = 1;
    while (names.has(`气泡组合${number}`)) number++;
    return { id: createRandomUUID(), revision: 0, name: `气泡组合${number}`, role,
      textColor: DEFAULT_BUBBLE_TEXT_COLORS[role], image: null, config: defaultBubbleSkinConfig(120, 90), decorations: [] };
  }
  const preset = snapshot.presets.find(item => item.id === presetId && item.role === role);
  if (!preset) throw new Error('这个气泡组合已不存在');
  const resolved = await resolvePreset(preset);
  if (!resolved.uri) throw new Error(resolved.error!);
  const decorations = resolved.decorations.map(decoration => {
    if (!decoration.uri) throw new Error(decoration.error!);
    return { ...decoration, uri: decoration.uri };
  });
  return { id: preset.id, revision: preset.revision, name: preset.name, role,
    textColor: preset.textColor,
    image: { mediaAssetId: preset.mediaAssetId, uri: resolved.uri, width: preset.width, height: preset.height },
    config: preset.config, decorations };
}

/** 只在保存边界准备 canonical backing，作品、媒体和启用选择在同一事务中提交。 */
export async function saveBubbleSkinDraft(draft: BubbleSkinDraft): Promise<void> {
  const { image } = draft;
  if (!image) throw new Error('请先上传气泡底图');
  const name = draft.name.trim();
  if (!name || name.length > 32) throw new Error('组合名称需为 1–32 个字');
  const config = parseBubbleSkinConfig(draft.config, image.width, image.height);
  const slots = new Set<number>();
  const decorations = draft.decorations.map(decoration => {
    if (!Number.isInteger(decoration.slot) || decoration.slot < 0 || decoration.slot > 3 || slots.has(decoration.slot)) throw new Error('饰品槽位无效');
    slots.add(decoration.slot);
    return { ...decoration, config: parseBubbleDecorationConfig(decoration.config) };
  });
  const images = [image, ...decorations];
  const imported = images.filter(item => item.mediaAssetId === null);
  const batch = await prepareMediaAssetBatch(imported.map(item => ({ storageBackend: MEDIA_ASSET_STORAGE_BACKEND.persistentMedia,
    sourceUri: item.uri, fileName: 'bubble.png', mimeType: 'image/png', width: item.width, height: item.height, durationMs: null })));
  let oldAssetIds: string[];
  try {
    oldAssetIds = await databaseCoordinator.transaction({ name: 'chat.bubbleSkin.save', feature: 'chat', priority: 'interactive' }, async tx => {
      const { assets } = await batch.commitInTransaction(tx);
      const ids = new Map<BubbleDraftImage, string>(imported.map((item, index) => [item, assets[index].id]));
      const assetId = (item: BubbleDraftImage) => item.mediaAssetId ?? ids.get(item)!;
      return repository.get().save(tx, { id: draft.id, role: draft.role, name, revision: draft.revision,
        textColor: parseBubbleTextColor(draft.textColor),
        mediaAssetId: assetId(image), width: image.width, height: image.height, config,
        decorations: decorations.map(item => ({ id: item.id, slot: item.slot, mediaAssetId: assetId(item),
          width: item.width, height: item.height, config: item.config })) });
    });
  } catch (error) {
    await batch.discardAfterRollback();
    throw error;
  }
  try { await batch.finalizeAfterCommit(); }
  catch (error) { console.warn('[BubbleSkin] 提交后的媒体暂存清理失败：', error); }
  await releaseMediaAssetCandidates(oldAssetIds);
  await reload();
}

export async function selectChatBubblePreset(role: BubbleSkinRole, presetId: string | null): Promise<void> {
  await repository.get().select(role, presetId);
  await reload();
}

export async function setChatBubblePresetTextColor(presetId: string, color: string): Promise<void> {
  await repository.get().setTextColor(presetId, parseBubbleTextColor(color));
  await reload();
}

export async function removeChatBubblePreset(presetId: string): Promise<void> {
  const oldAssetIds = await repository.get().remove(presetId);
  await releaseMediaAssetCandidates(oldAssetIds);
  await reload();
}

export function reportBubbleSkinLoadError(uri: string, message: string): void {
  const next = { ...snapshot };
  let changed = false;
  for (const role of ['user', 'ai'] as const) {
    const current = next[role];
    if (current?.uri === uri) { next[role] = { ...current, uri: null, error: message }; changed = true; }
    if (current && current.decorations.some(decoration => decoration.uri === uri)) {
      next[role] = { ...next[role]!, decorations: current.decorations.map(decoration => decoration.uri === uri
        ? { ...decoration, uri: null, error: message } : decoration) };
      changed = true;
    }
  }
  if (changed) publish(next);
}
