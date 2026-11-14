/** 每个 Key 拥有独立草稿与提交资格；编辑一个 Key 不携带其他 Key 的旧快照。 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { ThemedSurface, useTheme } from '@shared/theme';
import { Button, InputField, showAppDialog } from '@shared/ui';
import { AutoSaveErrors } from '@shared/ui/AutoSaveErrors';
import { useAutoSaveDraft } from '@shared/ui/useAutoSaveDraft';
import type { DraftErrors } from '@shared/ui/AutoSaveDraftEditor';
import { deleteModelServiceKeyConfig, saveModelServiceKeyConfig, type ModelServiceConfig } from '../../ModelServices';
import { modelServiceFailureMessage } from '../../ModelServiceErrors';
import { parseServiceKeyDraft, type ServiceKeyDraft } from './modelServiceDraft';

export interface KeyEditorControl { flush(): Promise<boolean>; restore(): Promise<void> }
export function ServiceKeyFields({ draft, errors, ordinal, authType, onChange, onBlur, disabled = false }: {
  draft: ServiceKeyDraft; errors: DraftErrors<ServiceKeyDraft>; ordinal: number; authType: 'apiKey' | 'tencentCloud';
  onChange(patch: Partial<ServiceKeyDraft>): void; onBlur?(): void; disabled?: boolean;
}) {
  const field = (key: keyof ServiceKeyDraft, label: string, placeholder?: string) => <InputField label={label} value={draft[key]}
    error={errors[key]} onChangeText={value => onChange({ [key]: value })} onBlur={onBlur} placeholder={placeholder}
    editable={!disabled} autoGrow autoCapitalize="none" autoCorrect={false} />;
  return <>
    {field('name', 'Key 名称（选填）', String(ordinal))}
    {field('apiKey', authType === 'apiKey' ? 'API Key' : 'SecretKey')}
    {authType === 'tencentCloud' && <>{field('secretId', 'SecretId')}{field('appId', 'AppID（选填）')}</>}
  </>;
}
export default function ModelServiceKeyEditor({ groupId, config, ordinal, authType, register, onRemoved, onWarning }: {
  groupId: string; config: ModelServiceConfig | null; ordinal: number; authType: 'apiKey' | 'tencentCloud';
  register(control: KeyEditorControl): () => void; onRemoved(): void; onWarning(message: string | null): void;
}) {
  const theme = useTheme();
  const persistedId = useRef(config?.id ?? null);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null);
  const initial = useMemo<ServiceKeyDraft>(() => {
    const credentials = JSON.parse(config?.credentialsJson ?? '{}') as Record<string, string>;
    return { name: config?.keyName ?? '', apiKey: config?.apiKey ?? '', secretId: credentials.secretId ?? '', appId: credentials.appId ?? '' };
  }, [config]);
  const editor = useAutoSaveDraft({ initial,
    parse: (draft, changed) => parseServiceKeyDraft(draft, changed, authType, persistedId.current === null),
    save: async patch => {
      setFailure(null);
      try {
        const result = await saveModelServiceKeyConfig(groupId, persistedId.current, { ...patch, ...(!persistedId.current ? { ordinal } : {}) });
        persistedId.current = result.config.id;
        onWarning(result.refreshWarning);
      } catch (error) { setFailure(modelServiceFailureMessage(error)); throw error; }
    },
  });
  const { flush, restore, getSnapshot } = editor;
  useEffect(() => register({ flush: () => !persistedId.current && !getSnapshot().dirty ? Promise.resolve(true) : flush(), restore }), [register, flush, restore, getSnapshot]);
  const remove = async () => {
    setBusy(true);
    await restore();
    try {
      if (persistedId.current) onWarning((await deleteModelServiceKeyConfig(persistedId.current)).refreshWarning);
      onRemoved();
    } catch (error) { showAppDialog({ title: '无法删除 Key', message: modelServiceFailureMessage(error), tone: 'error' }); }
    finally { setBusy(false); }
  };
  const confirmRemove = () => {
    if (!persistedId.current) return remove();
    showAppDialog({ title: '删除 API Key', message: `删除「${editor.draft.name.trim() || ordinal}」后，仅使用这个 Key 的用途失去连接，模型和聊天数据会保留。`,
      buttons: [{ text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: remove }] });
  };
  return <ThemedSurface variant="card" style={{ borderRadius: theme.radius.lg, padding: theme.spacing.md, marginBottom: theme.spacing.md,
    borderWidth: 1, borderColor: theme.colors.border.light }}>
    <ServiceKeyFields draft={editor.draft} errors={editor.errors} ordinal={ordinal} authType={authType}
      onChange={editor.change} onBlur={() => { void editor.commit(); }} disabled={busy} />
    <AutoSaveErrors error={editor.saveError ? failure || editor.saveError : null} blocked={Object.keys(editor.errors).length > 0}
      retry={() => { void editor.commit(); }} restore={() => { void restore().then(() => setFailure(null)); }} />
    <View><Button title="移除此 Key" variant="text" disabled={busy} onPress={confirmRemove} /></View>
  </ThemedSurface>;
}
