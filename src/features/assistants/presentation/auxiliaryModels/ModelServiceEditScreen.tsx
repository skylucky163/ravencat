/** 配置管理共享地址，独立 Key 编辑器只负责自己的凭据与引用。 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ThemedSurface, useTheme } from '@shared/theme';
import { Button, DropdownField, InputField, KeyboardAvoidingContainer, NavigationHeader, showAppDialog } from '@shared/ui';
import { useAutoSaveDraft, useAutoSaveNavigation } from '@shared/ui/useAutoSaveDraft';
import { AutoSaveErrors } from '@shared/ui/AutoSaveErrors';
import { useAutoSaveFeedback } from '@shared/ui/useAutoSaveFeedback';
import { createCommonStyles } from '@shared/ui/commonStyles';
import type { DraftErrors } from '@shared/ui/AutoSaveDraftEditor';
import { createModelServiceGroupConfig, deleteModelServiceGroupConfig, getModelServiceGroupConfig, updateModelServiceGroupConfig,
  type ModelServiceGroup, type ModelServiceKeyInput } from '../../ModelServices';
import { modelServiceFailureMessage } from '../../ModelServiceErrors';
import ModelServiceKeyEditor, { ServiceKeyFields, type KeyEditorControl } from './ModelServiceKeyEditor';
import { parseServiceGroupDraft, parseServiceKeyDraft, type ServiceGroupDraft, type ServiceKeyDraft } from './modelServiceDraft';

function warnRefresh(message: string | null) { if (message) showAppDialog({ title: '配置已提交', message }); }
function emptyKey(): ServiceKeyDraft { return { name: '', apiKey: '', secretId: '', appId: '' }; }
const help = { sections: [{ title: '配置与 Key', body: '配置名称和地址供组内所有 Key 共用。每个 Key 可命名，留空时显示默认编号；选择连接时选择具体 Key。修改地址影响组内全部引用，修改 Key 只影响使用该 Key 的用途。' }] };

function CreateServiceForm({ onBack }: { onBack(): void }) {
  const theme = useTheme();
  const commonStyles = useMemo(() => createCommonStyles(theme), [theme]);
  const [draft, setDraft] = useState<ServiceGroupDraft>({ name: '', baseUrl: '' });
  const [errors, setErrors] = useState<DraftErrors<ServiceGroupDraft>>({});
  const [keys, setKeys] = useState([{ ordinal: 1, draft: emptyKey(), errors: {} as DraftErrors<ServiceKeyDraft> }]);
  const nextOrdinal = useRef(2);
  const [authType, setAuthType] = useState<'apiKey' | 'tencentCloud'>('apiKey'), [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null);
  const { back } = useAutoSaveNavigation(async () => true, onBack, () => {}, false);
  const create = async () => {
    const group = parseServiceGroupDraft(draft, ['name', 'baseUrl']);
    setErrors(group.errors);
    const parsedKeys = keys.map(key => ({ ...key, parsed: parseServiceKeyDraft(key.draft, [], authType, true) }));
    setKeys(parsedKeys.map(key => ({ ordinal: key.ordinal, draft: key.draft, errors: key.parsed.errors })));
    if (Object.keys(group.errors).length || parsedKeys.some(key => Object.keys(key.parsed.errors).length)) return;
    setBusy(true); setFailure(null);
    try {
      const result = await createModelServiceGroupConfig({ name: group.patch.name!, baseUrl: group.patch.baseUrl!, authType,
        keys: parsedKeys.map(key => ({ ...key.parsed.patch as ModelServiceKeyInput, ordinal: key.ordinal })) });
      warnRefresh(result.refreshWarning); onBack();
    } catch (error) { setFailure(`${modelServiceFailureMessage(error)} 输入已保留。`); }
    finally { setBusy(false); }
  };
  return <KeyboardAvoidingContainer style={{ flex: 1 }}>
    <NavigationHeader title="新增服务配置" onGoBack={back} help={help}
      rightButton={<Button title="创建" variant="text" disabled={busy} onPress={() => { void create(); }} />} />
    <AutoSaveErrors error={failure} blocked={false} retry={() => { void create(); }} />
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      <ThemedSurface variant="card" style={[commonStyles.formSurface, { padding: theme.spacing.lg }]}>
      <InputField label="配置名称" placeholder="例如：月之暗面" value={draft.name} error={errors.name} editable={!busy} onChangeText={name => setDraft(current => ({ ...current, name }))} autoGrow />
      <InputField label="Base URL" value={draft.baseUrl} error={errors.baseUrl} editable={!busy} onChangeText={baseUrl => setDraft(current => ({ ...current, baseUrl }))}
        autoGrow autoCapitalize="none" autoCorrect={false} />
      {keys.map(key => <ThemedSurface key={key.ordinal} variant="card" style={{ borderRadius: theme.radius.lg, padding: theme.spacing.md, marginBottom: theme.spacing.md,
        borderWidth: 1, borderColor: theme.colors.border.light }}>
        <ServiceKeyFields draft={key.draft} errors={key.errors} ordinal={key.ordinal} authType={authType} disabled={busy}
          onChange={patch => setKeys(current => current.map(row => row.ordinal === key.ordinal ? { ...row, draft: { ...row.draft, ...patch } } : row))} />
        {keys.length > 1 && <Button title="移除此 Key" variant="text" disabled={busy} onPress={() => setKeys(current => current.filter(row => row.ordinal !== key.ordinal))} />}
      </ThemedSurface>)}
      <Button title="＋ 添加 API Key" variant="secondary" disabled={busy} onPress={() => {
        const ordinal = nextOrdinal.current++;
        setKeys(current => [...current, { ordinal, draft: emptyKey(), errors: {} }]);
      }} />
      <View style={{ marginTop: theme.spacing.lg }}>{advanced
        ? <DropdownField label="认证方式" value={authType} options={[{ value: 'apiKey', label: 'API Key' }, { value: 'tencentCloud', label: '腾讯云签名' }]}
          onChange={value => setAuthType(value as typeof authType)} disabled={busy} />
        : <Button title="其他认证方式" variant="text" disabled={busy} onPress={() => setAdvanced(true)} />}</View>
      </ThemedSurface>
    </ScrollView>
  </KeyboardAvoidingContainer>;
}

function EditServiceForm({ group, onBack }: { group: ModelServiceGroup; onBack(): void }) {
  const theme = useTheme();
  const commonStyles = useMemo(() => createCommonStyles(theme), [theme]);
  const [rows, setRows] = useState(() => group.keys.map(config => ({ localId: config.id, config: config as typeof config | null, ordinal: config.ordinal })));
  const nextOrdinal = useRef(group.nextKeyOrdinal), controls = useRef(new Map<string, KeyEditorControl>());
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null);
  const initial = useMemo(() => ({ name: group.name, baseUrl: group.baseUrl }), [group]);
  const editor = useAutoSaveDraft({ initial, parse: parseServiceGroupDraft, save: async patch => {
    setFailure(null);
    try { warnRefresh((await updateModelServiceGroupConfig(group.id, patch)).refreshWarning); }
    catch (error) { setFailure(modelServiceFailureMessage(error)); throw error; }
  } });
  const { flush, restore } = editor;
  const flushAll = useCallback(async () => {
    if (!await flush()) return false;
    for (const control of controls.current.values()) if (!await control.flush()) return false;
    return true;
  }, [flush]);
  const feedback = useAutoSaveFeedback(editor.errors);
  const { back } = useAutoSaveNavigation(flushAll, onBack, () => feedback.revealErrors(editor.getSnapshot().errors));
  const reset = async () => {
    await restore();
    for (const control of controls.current.values()) await control.restore();
    setFailure(null); feedback.setBlocked(false);
  };
  const remove = () => showAppDialog({ title: '删除服务配置', message: `删除「${editor.draft.name}」和其中全部 Key 后，引用它们的用途将失去 API 连接；角色、模型参数和聊天数据会保留。`, buttons: [
    { text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: async () => {
      setBusy(true); await reset();
      try { warnRefresh((await deleteModelServiceGroupConfig(group.id)).refreshWarning); onBack(); }
      catch (error) { showAppDialog({ title: '无法删除配置', message: modelServiceFailureMessage(error), tone: 'error' }); }
      finally { setBusy(false); }
    } },
  ] });
  return <KeyboardAvoidingContainer style={{ flex: 1 }}>
    <NavigationHeader title="编辑服务配置" onGoBack={back} help={help} />
    <AutoSaveErrors error={editor.saveError ? failure || editor.saveError : null} blocked={feedback.blocked}
      retry={() => { void flushAll(); }} restore={() => { void reset(); }} />
    <ScrollView ref={feedback.scrollRef} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      <ThemedSurface variant="card" style={[commonStyles.formSurface, { padding: theme.spacing.lg }]}>
      <InputField label="配置名称" value={editor.draft.name} error={editor.errors.name} editable={!busy} onChangeText={name => editor.change({ name })}
        onBlur={() => { void editor.commit(); }} autoGrow />
      <InputField label="Base URL" value={editor.draft.baseUrl} error={editor.errors.baseUrl} editable={!busy} onChangeText={baseUrl => editor.change({ baseUrl })}
        onBlur={() => { void editor.commit(); }} autoGrow autoCapitalize="none" autoCorrect={false} />
      {rows.map(row => <ModelServiceKeyEditor key={row.localId} groupId={group.id} config={row.config} ordinal={row.ordinal} authType={group.authType}
        register={control => { controls.current.set(row.localId, control); return () => { controls.current.delete(row.localId); }; }}
        onWarning={warnRefresh} onRemoved={() => setRows(current => current.filter(item => item.localId !== row.localId))} />)}
      <Button title="＋ 添加 API Key" variant="secondary" disabled={busy} onPress={() => {
        const ordinal = nextOrdinal.current++;
        setRows(current => [...current, { localId: `draft-${ordinal}`, config: null, ordinal }]);
      }} />
      <View style={{ marginTop: theme.spacing.xl }}><Button title="删除整个配置" variant="danger" disabled={busy} onPress={remove} /></View>
      </ThemedSurface>
    </ScrollView>
  </KeyboardAvoidingContainer>;
}
export default function ModelServiceEditScreen({ serviceId, onBack }: { serviceId?: string; onBack(): void }) {
  const theme = useTheme();
  const [group, setGroup] = useState<ModelServiceGroup | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!serviceId) return;
    let alive = true;
    void getModelServiceGroupConfig(serviceId).then(value => { if (alive) setGroup(value); }, () => { if (alive) setError('读取配置失败，请重新打开页面。'); });
    return () => { alive = false; };
  }, [serviceId]);
  return <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background.screen }} edges={['top', 'left', 'right']}>
    {!serviceId ? <CreateServiceForm onBack={onBack} /> : group ? <EditServiceForm key={group.id} group={group} onBack={onBack} /> : error
      ? <><NavigationHeader title="服务配置" onGoBack={onBack} /><Text style={{ color: theme.colors.feedback.error, padding: theme.spacing.lg }}>{error}</Text></>
      : <ActivityIndicator color={theme.colors.brand.primary} />}
  </SafeAreaView>;
}
