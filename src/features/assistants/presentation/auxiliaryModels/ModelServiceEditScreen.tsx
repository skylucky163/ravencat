/** 只有服务管理页能修改共享连接；用途页编辑连接会重新绑定独立服务。 */
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@shared/theme';
import { Button, DropdownField, InputField, KeyboardAvoidingContainer, NavigationHeader, showAppDialog } from '@shared/ui';
import { useAutoSaveDraft, useAutoSaveNavigation } from '@shared/ui/useAutoSaveDraft';
import { AutoSaveErrors } from '@shared/ui/AutoSaveErrors';
import { useAutoSaveFeedback } from '@shared/ui/useAutoSaveFeedback';
import type { DraftCommit, DraftErrors } from '@shared/ui/AutoSaveDraftEditor';
import { deleteModelServiceConfig, getModelServiceConfig, saveModelServiceConfig, type ModelServiceConfig, type SaveModelServiceInput } from '../../ModelServices';

interface Draft { name: string; baseUrl: string; apiKey: string; authType: 'apiKey' | 'tencentCloud'; secretId: string; appId: string }
function parse(draft: Draft, changed: (keyof Draft)[]): DraftCommit<Draft, Partial<SaveModelServiceInput>> {
  const patch: Partial<SaveModelServiceInput> = {}, errors: DraftErrors<Draft> = {}, accepted: (keyof Draft)[] = [];
  if (changed.includes('name')) {
    if (!draft.name.trim()) errors.name = '请填写配置名称';
    else { patch.name = draft.name.trim(); accepted.push('name'); }
  }
  const group = changed.filter(key => key !== 'name');
  if (group.length) {
    try { if (!['https:', 'http:', 'wss:', 'ws:'].includes(new URL(draft.baseUrl.trim()).protocol)) errors.baseUrl = '请填写 HTTP 或 WebSocket 服务地址'; }
    catch { errors.baseUrl = '请填写完整服务地址'; }
    if (!draft.apiKey.trim()) errors.apiKey = '请填写凭据';
    if (draft.authType === 'tencentCloud' && !draft.secretId.trim()) errors.secretId = '请填写 SecretId';
    if (!Object.keys(errors).some(key => key !== 'name')) {
      Object.assign(patch, { baseUrl: draft.baseUrl.trim(), apiKey: draft.apiKey.trim(), authType: draft.authType,
        credentialsJson: JSON.stringify(draft.authType === 'tencentCloud'
          ? { secretId: draft.secretId.trim(), ...(draft.appId.trim() ? { appId: draft.appId.trim() } : {}) } : {}) });
      accepted.push(...group);
    }
  }
  return { patch, errors, accepted };
}
function ServiceForm({ config, onBack }: { config: ModelServiceConfig | null; onBack(): void }) {
  const theme = useTheme();
  const initial = useMemo<Draft>(() => {
    const credentials = JSON.parse(config?.credentialsJson ?? '{}') as Record<string, string>;
    return { name: config?.name ?? '', baseUrl: config?.baseUrl ?? '', apiKey: config?.apiKey ?? '',
      authType: config?.authType ?? 'apiKey', secretId: credentials.secretId ?? '', appId: credentials.appId ?? '' };
  }, [config]);
  const editor = useAutoSaveDraft({ initial, parse, enabled: !!config, save: async patch => {
    await saveModelServiceConfig(config!.id, patch);
  } });
  const { draft, change, commit, flush, restore, validateAll, errors } = editor;
  const feedback = useAutoSaveFeedback(errors);
  const { back } = useAutoSaveNavigation(flush, onBack, () => feedback.revealErrors(editor.getSnapshot().errors), !!config);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const blur = () => { if (config) void commit(); };
  const reset = () => { void restore().then(() => feedback.setBlocked(false)); };
  const create = async () => {
    const values = validateAll();
    if (!values) { feedback.revealErrors(editor.getSnapshot().errors); return; }
    setBusy(true); setError(null);
    try { await saveModelServiceConfig(null, values as SaveModelServiceInput); onBack(); }
    catch { setError('保存失败，请检查是否已经存在相同连接。输入已保留。'); }
    finally { setBusy(false); }
  };
  const remove = () => showAppDialog({ title: '删除服务配置', message: `确定删除「${draft.name}」？仍在使用的服务不能删除。`, buttons: [
    { text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: async () => {
      await restore();
      try { await deleteModelServiceConfig(config!.id); onBack(); }
      catch { showAppDialog({ title: '无法删除', message: '请先为使用此服务的模型、角色或管理员更换连接，再重试。', tone: 'error' }); }
    } },
  ] });
  const field = (key: 'name' | 'baseUrl' | 'apiKey' | 'secretId' | 'appId', label: string) => <View onLayout={feedback.fieldLayout([key])}>
    <InputField label={label} value={draft[key]} error={errors[key]} onBlur={blur} autoGrow autoCapitalize="none" autoCorrect={false}
      onChangeText={value => change({ [key]: value })} />
  </View>;
  return <KeyboardAvoidingContainer style={{ flex: 1 }}>
    <NavigationHeader title={config ? '编辑服务配置' : '新增服务配置'} onGoBack={back}
      help={{ sections: [{ title: '修改范围', body: '此处保存的地址与凭据会供所有引用此服务的配置使用。认证方式创建后固定，更换方式请新增服务。模型名、温度、音色和任务参数仍在各用途中设置。' }] }}
      rightButton={!config ? <Button title="创建" variant="text" disabled={busy} onPress={() => { void create(); }} /> : feedback.blocked ? <Button title="恢复" variant="text" onPress={reset} /> : undefined} />
    <AutoSaveErrors error={editor.saveError || error} blocked={feedback.blocked} retry={config ? blur : () => { void create(); }} restore={config ? reset : undefined} />
    <ScrollView ref={feedback.scrollRef} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ padding: theme.spacing.lg }}>
      {field('name', '配置名称')}
      <DropdownField label="认证方式" value={draft.authType} disabled={!!config} options={[{ value: 'apiKey', label: 'API Key' }, { value: 'tencentCloud', label: '腾讯云签名' }]}
        onChange={value => change({ authType: value as Draft['authType'] }, true)} />
      {field('baseUrl', 'API 地址')}
      {field('apiKey', draft.authType === 'tencentCloud' ? 'SecretKey' : 'API Key')}
      {draft.authType === 'tencentCloud' && <>{field('secretId', 'SecretId')}{field('appId', 'AppID（语音服务）')}</>}
      {config && <Button title="删除服务配置" variant="danger" onPress={remove} />}
    </ScrollView>
  </KeyboardAvoidingContainer>;
}
export default function ModelServiceEditScreen({ serviceId, onBack }: { serviceId?: string; onBack(): void }) {
  const theme = useTheme();
  const [config, setConfig] = useState<ModelServiceConfig | null>(null);
  const [loading, setLoading] = useState(!!serviceId), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!serviceId) return;
    let alive = true;
    void getModelServiceConfig(serviceId).then(value => { if (alive) { setConfig(value); setLoading(false); } }, failure => {
      if (alive) { setError(failure instanceof Error ? failure.message : '读取失败'); setLoading(false); }
    });
    return () => { alive = false; };
  }, [serviceId]);
  return <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background.app }} edges={['top', 'left', 'right']}>
    {loading ? <ActivityIndicator color={theme.colors.brand.primary} /> : error ? <><NavigationHeader title="服务配置" onGoBack={onBack} /><Text style={{ color: theme.colors.feedback.error, padding: theme.spacing.lg }}>{error}</Text></>
      : <ServiceForm config={config} onBack={onBack} />}
  </SafeAreaView>;
}
