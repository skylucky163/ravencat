import ServiceConnectionPicker from './ServiceConnectionPicker';
/** 翻译资产编辑复用辅助模型命令与自动保存，业务选择不随编辑改变。 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TRANSLATION_PROVIDERS, testTranslationModelConnection, type TranslationProvider } from '@features/integrations';
import { fetchModelList, type ModelInfo } from '@platform/ai';
import { KeyboardAvoidingContainer, Button, DropdownField, InputField, ModelPickerModal, NavigationHeader, showAppDialog } from '@shared/ui';
import { useTheme } from '@shared/theme';
import { useAutoSaveDraft, useAutoSaveNavigation } from '@shared/ui/useAutoSaveDraft';
import { useAutoSaveFeedback } from '@shared/ui/useAutoSaveFeedback';
import { AutoSaveErrors } from '@shared/ui/AutoSaveErrors';
import { buildTranslationConfiguration, getTranslationModelDraft, parseTranslationModelDraft, switchTranslationProvider, type TranslationModelDraft } from './translationModelDraft';
import type { AuxiliaryModelConfig, UpdateAuxiliaryModelConfigInput } from '../../domain/AuxiliaryModel';
import type { AuxiliaryModelFormData } from './types';

interface Props {
  modelId?: string;
  initialData: AuxiliaryModelConfig | null;
  saving: boolean;
  onSave(data: UpdateAuxiliaryModelConfigInput): Promise<void>;
  onCreate(data: AuxiliaryModelFormData): Promise<void>;
  onDelete?: () => Promise<void>;
  onBack(): void;
}
export default function TranslationModelEditScreen({ modelId, initialData, saving, onSave, onCreate, onDelete, onBack }: Props) {
  const theme = useTheme();
  const initial = useMemo(() => getTranslationModelDraft(initialData), [initialData]);
  const editor = useAutoSaveDraft({ initial, parse: parseTranslationModelDraft, save: onSave, enabled: !!modelId });
  const { draft, errors, change, commit, flush, restore, validateAll } = editor;
  const feedback = useAutoSaveFeedback(errors);
  const { back } = useAutoSaveNavigation(flush, onBack, () => feedback.revealErrors(editor.getSnapshot().errors), !!modelId);
  const [advanced, setAdvanced] = useState(false);
  const [creationError, setCreationError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const requestRevision = useRef(0);
  useEffect(() => {
    setModels([]); setRequestError(null); setLoadingModels(false); setTesting(false);
    requestRevision.current++;
  }, [draft.provider, draft.baseUrl, draft.apiKey]);
  useEffect(() => () => { requestRevision.current++; }, []);
  const provider = TRANSLATION_PROVIDERS.find((entry) => entry.provider === draft.provider)!;
  const ai = draft.provider === 'aiModel';
  const blur = () => { if (modelId) void commit(); };
  const set = useCallback(<K extends keyof TranslationModelDraft>(key: K, value: TranslationModelDraft[K], immediate = false) => {
    setRequestError(null);
    change({ [key]: value, ...(['baseUrl', 'apiKey', 'secretId'].includes(key) ? { serviceConfigId: '' } : {}) } as Pick<TranslationModelDraft, K>, immediate);
  }, [change]);
  const field = (key: keyof TranslationModelDraft, label: string, placeholder = '', hint?: string) => (
    <View key={key} onLayout={feedback.fieldLayout([key])}>
      <InputField label={label} value={String(draft[key])} onChangeText={(value) => set(key, value)} onBlur={blur}
        error={errors[key]} placeholder={placeholder} hint={hint} autoGrow autoCapitalize="none" autoCorrect={false} />
    </View>
  );
  const validatedConfiguration = () => {
    if (!validateAll()) { setAdvanced(true); feedback.revealErrors(editor.getSnapshot().errors); return null; }
    const config = buildTranslationConfiguration(draft);
    return { ...config, temperature: initialData?.temperature ?? null, topP: initialData?.topP ?? null, maxTokens: initialData?.maxTokens ?? null };
  };
  const loadModels = async () => {
    if (!draft.baseUrl.trim() || !draft.apiKey.trim()) { setRequestError('请先填写 API 地址和 API Key'); return; }
    const revision = ++requestRevision.current;
    setLoadingModels(true); setRequestError(null);
    try {
      const result = await fetchModelList(draft.baseUrl.trim(), draft.apiKey.trim());
      if (revision === requestRevision.current) { setModels(result); setShowModelPicker(true); }
    } catch (error) {
      if (revision === requestRevision.current) setRequestError(error instanceof Error ? error.message : '获取模型列表失败');
    } finally { if (revision === requestRevision.current) setLoadingModels(false); }
  };
  const create = async () => {
    if (saving) return;
    const config = validatedConfiguration();
    if (!config) return;
    setCreationError(null);
    const { baseURL, ...settings } = config;
    try { await onCreate({ ...settings, baseUrl: baseURL, name: draft.name.trim(), serviceConfigId: draft.serviceConfigId || null }); }
    catch (error) { setCreationError(error instanceof Error ? error.message : '创建失败，你的输入已保留'); }
  };
  const test = async () => {
    const config = validatedConfiguration();
    if (!config) return;
    const revision = ++requestRevision.current;
    setTesting(true); setRequestError(null);
    try {
      const text = await testTranslationModelConnection(config);
      if (revision === requestRevision.current) showAppDialog({ title: '翻译测试成功', message: text, tone: 'success' });
    } catch (error) {
      if (revision === requestRevision.current) setRequestError(error instanceof Error ? error.message : '翻译测试失败');
    } finally { if (revision === requestRevision.current) setTesting(false); }
  };
  const reset = () => { void restore().then(() => feedback.setBlocked(false)); };
  const remove = () => showAppDialog({ title: '删除配置', message: `确定删除「${draft.name}」？`, buttons: [
    { text: '取消', style: 'cancel' },
    { text: '删除', style: 'destructive', onPress: () => { void restore().then(onDelete); } },
  ] });
  const rightButton = modelId ? feedback.blocked ? <Button title="恢复" variant="text" onPress={reset} /> : undefined
    : <Button title={saving ? '创建中…' : '创建'} variant="text" disabled={saving} onPress={() => { void create(); }} />;
  return <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background.app }} edges={['top', 'left', 'right']}>
    <KeyboardAvoidingContainer style={{ flex: 1 }}>
      <NavigationHeader title={`${modelId ? '编辑' : '新建'}翻译模型`} onGoBack={back} rightButton={rightButton} />
      <AutoSaveErrors error={editor.saveError || creationError} blocked={!!modelId && feedback.blocked}
        retry={modelId ? blur : () => { void create(); }} restore={modelId ? reset : undefined} />
      <ScrollView ref={feedback.scrollRef} contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: theme.spacing.xl }}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <View onLayout={feedback.fieldLayout(['provider'])}><DropdownField label="翻译方式" value={draft.provider}
          options={TRANSLATION_PROVIDERS.map((entry) => ({ value: entry.provider, label: entry.label }))} error={errors.provider}
          onChange={(value) => { if (value !== draft.provider) change(switchTranslationProvider(value as TranslationProvider), true); }} /></View>
        {field('name', '配置名称', `例如：${provider.label}`)}
        {ai ? field('baseUrl', 'API 地址', 'https://你的服务地址/v1', '填写服务商提供的 OpenAI 兼容接口地址') : field('secretId', 'SecretId', 'AKID...')}
        {field('apiKey', ai ? 'API Key' : 'SecretKey', ai ? '填写服务商提供的 API Key' : 'SecretKey')}
        {ai && <ServiceConnectionPicker baseUrl={draft.baseUrl} apiKey={draft.apiKey} disabled={testing || loadingModels}
          onFill={service => change({ serviceConfigId: service.id, baseUrl: service.baseUrl, apiKey: service.apiKey }, true)} />}
        {ai && <>
          <Button title={loadingModels ? '获取中…' : models.length ? '重新获取模型列表' : '获取模型列表'} variant="text"
            disabled={loadingModels || testing} onPress={() => { void loadModels(); }} />
          {field('model', '模型名称', '填写模型 ID，或从模型列表选择')}
          {models.length > 0 && <Button title="从已获取的列表选择" variant="text" onPress={() => setShowModelPicker(true)} />}
        </>}
        {provider.optionFields.filter((entry) => !entry.advanced || advanced)
          .map((entry) => field(entry.key as keyof TranslationModelDraft, entry.label, entry.placeholder, entry.hint))}
        {provider.optionFields.some((entry) => entry.advanced) && <TouchableOpacity accessibilityRole="button"
          accessibilityState={{ expanded: advanced }} onPress={() => setAdvanced(!advanced)}>
          <Text style={{ color: theme.colors.text.secondary, paddingVertical: theme.spacing.md }}>{advanced ? '收起高级参数' : '展开高级参数'}</Text>
        </TouchableOpacity>}
        {requestError && <Text accessibilityRole="alert" style={{ color: theme.colors.feedback.error }}>{requestError}</Text>}
        <Button title={testing ? '测试中…' : '测试翻译'} variant="secondary" disabled={testing || loadingModels}
          onPress={() => { void test(); }} />
        {modelId && <Button title="删除配置" variant="danger" onPress={remove} />}
      </ScrollView>
    </KeyboardAvoidingContainer>
    <ModelPickerModal visible={showModelPicker} models={models} selectedModel={draft.model}
      onSelect={(value) => { set('model', value, true); setShowModelPicker(false); }} onClose={() => setShowModelPicker(false)}
      emptyText="服务商未返回模型，请直接填写模型 ID" />
  </SafeAreaView>;
}
