import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { DEFAULT_CHAT_LONG_PASTE_THRESHOLD, isChatLongPasteThreshold } from './chatInputLimits';

interface LongPastePreference {
  enabled: boolean;
  threshold: number;
}

const storageKey = 'chat.longPasteAsAttachment';
const defaultPreference: LongPastePreference = { enabled: false, threshold: DEFAULT_CHAT_LONG_PASTE_THRESHOLD };
const preferenceChanges = new Set<(preference: LongPastePreference) => void>();
let saveQueue = Promise.resolve();

async function readLongPastePreference(): Promise<LongPastePreference> {
  const raw = await AsyncStorage.getItem(storageKey);
  if (raw === null) return defaultPreference;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return defaultPreference;
  }
  // 旧版本在同一个键下只存开关；升级时沿用开关状态并采用新默认阈值。
  if (typeof stored === 'boolean') return { ...defaultPreference, enabled: stored };
  if (!stored || typeof stored !== 'object') return defaultPreference;
  return {
    enabled: 'enabled' in stored && stored.enabled === true,
    threshold: 'threshold' in stored && isChatLongPasteThreshold(stored.threshold)
      ? stored.threshold
      : DEFAULT_CHAT_LONG_PASTE_THRESHOLD,
  };
}

export function useLongPastePreference() {
  const [preference, setPreference] = useState<LongPastePreference | null>(null);
  useEffect(() => {
    let acceptInitialRead = true;
    const onChange = (value: LongPastePreference) => {
      acceptInitialRead = false;
      setPreference(value);
    };
    preferenceChanges.add(onChange);
    void readLongPastePreference()
      .then((value) => { if (acceptInitialRead) setPreference(value); })
      .catch((error) => {
        console.warn('[LongPastePreference] 读取失败：', error);
        if (acceptInitialRead) setPreference(defaultPreference);
      });
    return () => {
      acceptInitialRead = false;
      preferenceChanges.delete(onChange);
    };
  }, []);
  return preference;
}

export function setLongPastePreference(patch: Partial<LongPastePreference>): Promise<void> {
  // 单聊和群聊的设置页可能同时挂载，更新必须合并到上一笔实际保存的值。
  const saved = saveQueue.then(async () => {
    const value = { ...await readLongPastePreference(), ...patch };
    await AsyncStorage.setItem(storageKey, JSON.stringify(value));
    for (const onChange of preferenceChanges) onChange(value);
  });
  saveQueue = saved.catch(() => {});
  return saved;
}
