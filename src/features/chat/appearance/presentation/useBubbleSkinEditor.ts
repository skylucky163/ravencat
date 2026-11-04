import { useCallback, useEffect, useRef, useState } from 'react';
import { createRandomUUID } from '@platform/device';
import { prepareBubbleDraftImage } from '@platform/device/MessageBubbleBackground';
import { bubbleDraftFingerprint, type BubbleSkinDraft } from '../application/BubbleSkinDraft';
import { loadChatBubbleSkins, openBubbleSkinDraft, saveBubbleSkinDraft, setChatBubblePresetTextColor } from '../application/ChatBubbleSkinRuntime';
import { useChatBubbleSkins } from './useChatBubbleSkins';
import { DEFAULT_BUBBLE_DECORATION_CONFIG, defaultBubbleSkinConfig, type BubbleSkinRole } from '../domain/ChatBubbleSkin';
import { withPickedBubbleImage } from './pickBubbleImage';

export interface BubbleEditorNavigationState { dirty: boolean; requestLeave(): Promise<boolean> }

/** 图片与结构编辑先留在页面草稿；已保存组合的字色直接提交同一作品字段。 */
export function useBubbleSkinEditor(role: BubbleSkinRole, presetId: string | null) {
  const skins = useChatBubbleSkins();
  const [draft, setDraft] = useState<BubbleSkinDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [savePrompt, setSavePrompt] = useState<'save' | 'leave' | null>(null);
  const [saveName, setSaveName] = useState('');
  const promptResult = useRef<{ promise: Promise<boolean>; resolve(value: boolean): void } | null>(null);
  const current = useRef(draft);
  current.current = draft;
  const baseline = useRef('');
  const working = useRef(false);
  const alive = useRef(true);
  const cacheFiles = useRef(new Set<() => Promise<void>>());
  useEffect(() => {
    alive.current = true;
    const ownedFiles = cacheFiles.current;
    return () => {
      alive.current = false;
      promptResult.current?.resolve(false);
      for (const dispose of ownedFiles) void dispose().catch(reason => console.warn('[BubbleSkin] 编辑缓存清理失败：', reason));
    };
  }, []);
  useEffect(() => {
    let canceled = false;
    void loadChatBubbleSkins().then(() => openBubbleSkinDraft(role, presetId)).then(value => {
      if (canceled) return;
      baseline.current = bubbleDraftFingerprint(value);
      setDraft(value); setSelectedId(value.decorations[0]?.id ?? null);
    }).catch(reason => { if (!canceled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { canceled = true; };
  }, [role, presetId]);
  const update = useCallback((value: BubbleSkinDraft | ((before: BubbleSkinDraft) => BubbleSkinDraft)) => {
    const next = typeof value === 'function' ? value(current.current!) : value;
    current.current = next;
    setDraft(next);
  }, []);
  const save = useCallback(async (name: string): Promise<boolean> => {
    if (working.current || !current.current) return false;
    working.current = true; setBusy(true); setError(null);
    try {
      const value = { ...current.current, name: name.trim() };
      await saveBubbleSkinDraft(value);
      const saved = { ...value, revision: value.revision + 1 };
      baseline.current = bubbleDraftFingerprint(saved);
      update(saved);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally { working.current = false; if (alive.current) setBusy(false); }
  }, [update]);
  const openSavePrompt = useCallback((reason: 'save' | 'leave'): Promise<boolean> => {
    if (working.current) return Promise.resolve(false);
    if (promptResult.current) return promptResult.current.promise;
    setSaveName(current.current!.name);
    setSavePrompt(reason);
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>(complete => { resolve = complete; });
    promptResult.current = { promise, resolve };
    return promise;
  }, []);
  const finishPrompt = useCallback((leave: boolean) => {
    promptResult.current!.resolve(leave);
    promptResult.current = null;
    setSavePrompt(null);
  }, []);
  const requestLeave = useCallback(async (): Promise<boolean> => {
    if (working.current) return false;
    if (!current.current || bubbleDraftFingerprint(current.current) === baseline.current) return true;
    return openSavePrompt('leave');
  }, [openSavePrompt]);
  const importImage = async (slot: number | null) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError(null);
    try {
      await withPickedBubbleImage(async uri => {
        const image = await prepareBubbleDraftImage(uri, slot === null ? 'background' : 'decoration');
        if (!alive.current) { await image.dispose(); return; }
        cacheFiles.current.add(image.dispose);
        const value = { mediaAssetId: null, uri: image.uri, width: image.width, height: image.height };
        const before = current.current!;
        if (slot === null) update({ ...before, image: value, config: defaultBubbleSkinConfig(image.width, image.height) });
        else {
          const id = createRandomUUID();
          update({ ...before, decorations: [...before.decorations, { ...value, id, slot,
            config: { ...DEFAULT_BUBBLE_DECORATION_CONFIG, anchor: role === 'user' ? 'bottom-right' : 'bottom-left' } }] });
          setSelectedId(id);
        }
      });
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  };
  const setTextColor = async (color: string) => {
    if (working.current) return;
    if (current.current!.revision === 0) { update(before => ({ ...before, textColor: color })); return; }
    working.current = true; setBusy(true); setError(null);
    try { await setChatBubblePresetTextColor(current.current!.id, color); }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  };
  const textColor = draft?.revision === 0 ? draft.textColor : skins.presets.find(item => item.id === draft?.id)?.textColor;
  return { draft, textColor, setTextColor, update, busy, error, selectedId, setSelectedId, requestLeave, importImage,
    dirty: draft !== null && bubbleDraftFingerprint(draft) !== baseline.current,
    savePrompt, saveName, setSaveName,
    requestSave: () => openSavePrompt('save'),
    cancelSave: () => { if (!working.current) finishPrompt(false); },
    discardChanges: () => { if (!working.current) finishPrompt(true); },
    confirmSave: async () => { if (await save(saveName)) finishPrompt(true); },
  };
}
