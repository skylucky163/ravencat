import React, { useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { showAppDialog, SliderField, ToggleField } from '@shared/ui';
import { CHAT_TEXT_ATTACHMENT_MAX_LENGTH } from '../../../messages/domain/ChatAttachment';
import { DEFAULT_CHAT_LONG_PASTE_THRESHOLD, isChatLongPasteThreshold } from './chatInputLimits';
import { setLongPastePreference, useLongPastePreference } from './longPastePreference';

const thresholdRange = `1～${CHAT_TEXT_ATTACHMENT_MAX_LENGTH.toLocaleString('zh-CN')}`;

export function LongPasteToggle({ style }: { style?: StyleProp<ViewStyle> }) {
  const preference = useLongPastePreference();
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const draftNumber = draft !== null && /^\d+$/.test(draft.trim()) ? Number(draft) : null;
  const draftThreshold = isChatLongPasteThreshold(draftNumber) ? draftNumber : null;

  async function save(patch: Parameters<typeof setLongPastePreference>[0]) {
    setSaving(true);
    try {
      await setLongPastePreference(patch);
      setDraft(null);
      setError(undefined);
    } catch {
      showAppDialog({ title: '设置保存失败', message: '请再试一次。', tone: 'error' });
    } finally {
      setSaving(false);
    }
  }

  function saveThreshold(threshold: number) {
    setError(undefined);
    if (threshold === preference?.threshold) {
      setDraft(null);
      return;
    }
    setDraft(String(threshold));
    void save({ threshold });
  }

  function commitDraft() {
    if (draft === null || saving) return;
    if (draftThreshold === null) {
      setError(`请输入 ${thresholdRange} 之间的整数。`);
      return;
    }
    saveThreshold(draftThreshold);
  }

  return (
    <View style={style}>
      <ToggleField layout="inline" style={{ paddingVertical: 0 }} label="长文本粘贴转为 TXT"
        hint="单聊和群聊共用。粘贴后正文超过设定长度时，粘贴内容会转为待发送附件"
        value={preference?.enabled === true} disabled={preference === null || saving}
        onValueChange={(enabled) => { void save({ enabled }); }} />
      {preference?.enabled ? (
        <SliderField label="转为 TXT 的字符阈值"
          description={`默认 ${DEFAULT_CHAT_LONG_PASTE_THRESHOLD.toLocaleString('zh-CN')} 字符。`}
          style={{ paddingHorizontal: 0, paddingBottom: 0, borderBottomWidth: 0 }}
          min={1} max={CHAT_TEXT_ATTACHMENT_MAX_LENGTH} step={1} integerInput
          value={draftThreshold ?? preference.threshold} inputValue={draft ?? String(preference.threshold)}
          disabled={saving} error={error}
          onInputChange={(text) => { setDraft(text); setError(undefined); }}
          onBlur={commitDraft} onSetValue={saveThreshold} />
      ) : null}
    </View>
  );
}
