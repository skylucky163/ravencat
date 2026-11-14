import ServiceConnectionPicker from './ServiceConnectionPicker';
/** 翻译资产编辑复用辅助模型命令与自动保存，业务选择不随编辑改变。 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TRANSLATION_PROVIDERS, testTranslationModelConnection, type TranslationProvider } from '@features/integrations';
import { fetchModelList, type ModelInfo } from '@platform/ai';
import { KeyboardAvoidingContainer, Button, DropdownField, InputField, ModelPickerField, ModelPickerModal, NavigationHeader, showAppDialog } from '@shared/ui';
import { ThemedSurface, useTheme } from '@shared/theme';
import { createCommonStyles } from '@shared/ui/commonStyles';
import { useAutoSaveDraft, useAutoSaveNavigation } from '@shared/ui/useAutoSaveDraft';
import { useAutoSaveFeedback } from '@shared/ui/useAutoSaveFeedback';
import { AutoSaveErrors } from '@shared/ui/AutoSaveErrors';
import { buildTranslationConfiguration, getTranslationModelDraft, parseTranslationModelDraft, createTranslationProviderDraft, type TranslationModelDraft } from './translationModelDraft';
import type { AuxiliaryModelConfig, UpdateAuxiliaryModelConfigInput } from '../../domain/AuxiliaryModel';
import type { AuxiliaryModelFormData } from './types';
import ModelFormSection from './ModelFormSection';

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
  const commonStyles = useMemo(() => createCommonStyles(theme), [theme]);
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
  const field = (key: keyof TranslationModelDraft, label: string, placeholder = '', editable = true) => (
    <View key={key} onLayout={feedback.fieldLayout([key])}>
      <InputField label={label} value={String(draft[key])} onChangeText={(value) => set(key, value)} onBlur={blur}
        error={errors[key]} placeholder={placeholder} editable={editable} autoGrow autoCapitalize="none" autoCorrect={false} />
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
      if (revision === requestRevision.current) setModels(result);
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
  return <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background.screen }} edges={['top', 'left', 'right']}>
    <KeyboardAvoidingContainer style={{ flex: 1 }}>
      <NavigationHeader title={`${modelId ? '编辑' : '新建'}翻译模型`} onGoBack={back} rightButton={rightButton} />
      <AutoSaveErrors error={editor.saveError || creationError} blocked={!!modelId && feedback.blocked}
        retry={modelId ? blur : () => { void create(); }} restore={modelId ? reset : undefined} />
      <ScrollView ref={feedback.scrollRef}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <ThemedSurface variant="card" style={[commonStyles.formSurface, { padding: theme.spacing.lg, paddingBottom: theme.spacing.xl }]}>
        <ModelFormSection title="配置">
        <View onLayout={feedback.fieldLayout(['provider'])}><DropdownField label="提供方" value={draft.provider}
          disabled={!!modelId}
          options={TRANSLATION_PROVIDERS.map((entry) => ({ value: entry.provider, label: entry.label }))} error={errors.provider}
          onChange={(value) => { if (value !== draft.provider) change(createTranslationProviderDraft(value as TranslationProvider), true); }} /></View>
        {field('name', '配置名称', `例如：${provider.label}`)}
        </ModelFormSection>
        <ModelFormSection title="连接">
        {field('baseUrl', 'API 地址', 'https://api.example.com/v1', ai)}
        {!ai && field('secretId', 'SecretId', 'AKID...')}
        {field('apiKey', ai ? 'API Key' : 'SecretKey', ai ? '填写服务商提供的 API Key' : 'SecretKey')}
        {ai && <ServiceConnectionPicker baseUrl={draft.baseUrl} apiKey={draft.apiKey} serviceConfigId={draft.serviceConfigId} disabled={testing || loadingModels}
          onFill={service => change({ serviceConfigId: service.id, baseUrl: service.baseUrl, apiKey: service.apiKey }, true)} />}
        </ModelFormSection>
        {ai && <>
          <ModelFormSection title="模型">
          <View onLayout={feedback.fieldLayout(['model'])}><ModelPickerField label="模型名称" value={draft.model} placeholder="模型 ID"
            onChangeText={value => set('model', value)} onBlur={blur} error={errors.model} loading={loadingModels} disabled={testing}
            onPress={() => { setShowModelPicker(true); setRequestError(null); if (!models.length) void loadModels(); }} /></View>
          </ModelFormSection>
        </>}
        <ModelFormSection title="参数">
        {provider.optionFields.filter((entry) => !entry.advanced || advanced)
          .map((entry) => field(entry.key as keyof TranslationModelDraft, entry.label, entry.placeholder))}
        {provider.optionFields.some((entry) => entry.advanced) && <TouchableOpacity accessibilityRole="button"
          accessibilityState={{ expanded: advanced }} onPress={() => setAdvanced(!advanced)}>
          <Text style={{ color: theme.colors.text.secondary, paddingVertical: theme.spacing.md }}>{advanced ? '收起' : '高级参数'}</Text>
        </TouchableOpacity>}
        </ModelFormSection>
        <ModelFormSection title="测试">
        {requestError && <Text accessibilityRole="alert" style={{ color: theme.colors.feedback.error }}>{requestError}</Text>}
        <Button title={testing ? '测试中…' : '测试翻译'} variant="secondary" disabled={testing || loadingModels}
          onPress={() => { void test(); }} />
        </ModelFormSection>
        {modelId && <Button title="删除配置" variant="text" onPress={remove}
          style={{ marginTop: theme.spacing.lg }} textStyle={{ color: theme.colors.feedback.error }} />}
        </ThemedSurface>
      </ScrollView>
    </KeyboardAvoidingContainer>
    <ModelPickerModal visible={showModelPicker} models={models} selectedModel={draft.model}
      onSelect={(value) => { set('model', value, true); setShowModelPicker(false); }} onClose={() => setShowModelPicker(false)}
      loading={loadingModels} error={requestError} onRefresh={() => { void loadModels(); }} onRetry={() => { void loadModels(); }}
      emptyText="服务商未返回模型，请直接填写模型 ID" />
  </SafeAreaView>;
}
