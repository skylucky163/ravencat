import ServiceConnectionPicker from './ServiceConnectionPicker';
/** 辅助模型编辑：已有资产自动保存，新资产在完整校验后显式创建。 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ThemedSurface, useTheme } from '@shared/theme';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { KeyboardAvoidingContainer, Button, DropdownField, InputField, ModelPickerField, ModelPickerModal, SliderField, showAppDialog } from '@shared/ui';
import { IMAGE_GENERATION_PROVIDERS } from '@platform/ai/imageGenerationConfig';
import { createCommonStyles } from '@shared/ui/commonStyles';
import type { AuxiliaryModelConfig, UpdateAuxiliaryModelConfigInput } from '../../domain/AuxiliaryModel';
import type { ModelInfo } from '../../application/modelTypes';
import type { AuxiliaryModelFormData } from './types';
import MaxTokensSection from '../management/AIModelSettings/MaxTokensSection';
import ModelFormSection from './ModelFormSection';
import { fetchModelsWithConfig } from '../management/sharedModelConfig';
import { useAutoSaveDraft, useAutoSaveNavigation } from '@shared/ui/useAutoSaveDraft';
import { useAutoSaveFeedback } from '@shared/ui/useAutoSaveFeedback';
import { AutoSaveErrors } from '@shared/ui/AutoSaveErrors';
import { readDraftNumber } from '@shared/ui/draftValidation';
import { getAuxiliaryModelDraft, parseAuxiliaryModelDraft, type AuxiliaryModelDraft } from './auxiliaryModelDraft';

interface AuxiliaryModelEditScreenProps {
  capabilityKind: 'summary' | 'embedding' | 'ocr' | 'image_generation';
  capabilityLabel: string;
  modelId?: string | null;
  initialData?: AuxiliaryModelConfig | null;
  saving?: boolean;
  testing?: boolean;
  onBack(): void;
  onSave(data: UpdateAuxiliaryModelConfigInput): Promise<void>;
  onCreate(data: AuxiliaryModelFormData): Promise<void>;
  onTest(data: AuxiliaryModelFormData): Promise<void> | void;
  onDelete?: () => Promise<void> | void;
}
export default function AuxiliaryModelEditScreen({ capabilityKind, capabilityLabel, modelId, initialData = null,
  saving = false, testing = false, onBack, onSave, onCreate, onTest, onDelete,
}: AuxiliaryModelEditScreenProps) {
  const theme = useTheme();
  const commonStyles = useMemo(() => createCommonStyles(theme), [theme]);
  const isEdit = !!modelId;
  const isEmbeddingCapability = capabilityKind === 'embedding';
  const isImageGeneration = capabilityKind === 'image_generation';
  const hasSamplingParams = !isEmbeddingCapability && !isImageGeneration;
  const initial = useMemo(() => getAuxiliaryModelDraft(initialData), [initialData]);
  const parse = useCallback((draft: AuxiliaryModelDraft, changed: (keyof AuxiliaryModelDraft)[]) => parseAuxiliaryModelDraft(capabilityKind, draft, changed), [capabilityKind]);
  const editor = useAutoSaveDraft({ initial, parse, save: onSave, enabled: isEdit });
  const { draft, errors, commit, flush, restore, change, validateAll } = editor;
  const { name, baseUrl, apiKey, model, tempInput, topPInput, maxTokens } = draft;
  const imageProvider = IMAGE_GENERATION_PROVIDERS.find(provider => provider.id === draft.imageProvider);
  const temperatureInput = readDraftNumber(tempInput, 'Temperature', 0, 2, true);
  const topPNumberInput = readDraftNumber(topPInput, 'Top P', 0, 1, true);
  const temperature = temperatureInput.error ? initialData?.temperature ?? null : temperatureInput.value;
  const topP = topPNumberInput.error ? initialData?.topP ?? null : topPNumberInput.value;
  const feedback = useAutoSaveFeedback(errors);
  const { back } = useAutoSaveNavigation(flush, onBack, () => feedback.revealErrors(editor.getSnapshot().errors), isEdit);
  const [creationError, setCreationError] = useState<string | null>(null);
  const [testInputError, setTestInputError] = useState<string | null>(null);
  const blur = () => { if (isEdit) void commit(); };
  const restoreDraft = () => { void restore().then(() => feedback.setBlocked(false)); };
  const fieldProps = (key: keyof AuxiliaryModelDraft) => ({ error: errors[key], onBlur: blur });
  const setField = <K extends keyof AuxiliaryModelDraft>(key: K, value: AuxiliaryModelDraft[K], immediate = false) => {
    setTestInputError(null);
    change({ [key]: value } as Pick<AuxiliaryModelDraft, K>, immediate);
  };
  const setName = (value: string) => setField('name', value);
  const setBaseUrl = (value: string) => change({ baseUrl: value, serviceConfigId: '' });
  const setApiKey = (value: string) => change({ apiKey: value, serviceConfigId: '' });
  const setModel = (value: string) => setField('model', value);
  const handleTempChange = (value: string, immediate = false) => setField('tempInput', value, immediate);
  const handleTopPChange = (value: string, immediate = false) => setField('topPInput', value, immediate);
  const handleMaxTokensChange = (value: string, immediate = false) => setField('maxTokens', value, immediate);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const modelRequest = useRef(0);
  useEffect(() => {
    modelRequest.current++;
    setAvailableModels([]); setIsLoadingModels(false);
  }, [baseUrl, apiKey]);
  useEffect(() => () => { modelRequest.current++; }, []);
  const selectImageProvider = (id: string) => {
    const provider = IMAGE_GENERATION_PROVIDERS.find(value => value.id === id)!;
    // 切换供应商意味着新的认证边界，旧 Key 不随地址一起带给新供应商。
    change({ imageProvider: id, baseUrl: provider.baseURL,
      model: provider.models[0] ?? '', apiKey: '', serviceConfigId: '',
      ...(!name.trim() || name === imageProvider?.label ? { name: provider.label } : {}) }, true);
    setAvailableModels([]); setShowModelPicker(false);
  };
  const handleFetchModels = async () => {
    if (!baseUrl.trim() || !apiKey.trim()) { setTestInputError('获取模型列表需要填写 API 地址和 Key。'); return; }
    const revision = ++modelRequest.current;
    setIsLoadingModels(true); setTestInputError(null);
    try {
      const result = await fetchModelsWithConfig({ apiBaseUrl: baseUrl, apiKey });
      if (revision !== modelRequest.current) return;
      if (result.errorInfo) { setTestInputError(result.errorInfo.message || '无法获取模型列表。'); return; }
      setAvailableModels(result.models);
      if (result.models.length === 0) setTestInputError('未获取到模型，请检查地址和 Key。');
    } catch (error) { if (revision === modelRequest.current) setTestInputError(error instanceof Error ? error.message : '获取模型列表失败。'); }
    finally { if (revision === modelRequest.current) setIsLoadingModels(false); }
  };
  const openModelPicker = () => {
    setTestInputError(null); setShowModelPicker(true);
    if (isImageGeneration) setAvailableModels(imageProvider!.models.map(id => ({ id, name: id })));
    else if (availableModels.length === 0) void handleFetchModels();
  };
  const handleSelectModel = (modelId: string) => { setField('model', modelId, true); setShowModelPicker(false); };
  const buildFormData = (): AuxiliaryModelFormData | null => {
    const values = validateAll();
    if (!values) return null;
    return {
      id: modelId || undefined, serviceConfigId: values.serviceConfigId, name: values.name, baseUrl: values.baseUrl, model: values.model,
      apiKey: values.apiKey ?? '', temperature: hasSamplingParams ? values.temperature ?? null : null,
      topP: hasSamplingParams ? values.topP ?? null : null, maxTokens: hasSamplingParams ? values.maxTokens ?? null : null, metadataJson: values.metadataJson,
    };
  };
  const handleTestConnection = async () => {
    const data = buildFormData();
    if (!data) { feedback.revealErrors(editor.getSnapshot().errors); return; }
    if (!data.apiKey) { setTestInputError('测试连接需要填写 API Key。'); return; }
    await onTest(data);
  };
  const handleCreate = async () => {
    if (saving) return;
    const data = buildFormData();
    if (!data) { feedback.revealErrors(editor.getSnapshot().errors); return; }
    setCreationError(null);
    try { await onCreate(data); }
    catch (error) {
      console.error('[辅助模型] 创建失败', error);
      setCreationError('创建未能完成，你的输入已保留。');
    }
  };
  const handleDelete = () => {
    if (!onDelete) return;
    showAppDialog({ title: '确认删除', message: `确定要删除「${name || '该模型'}」吗？删除后无法恢复。`, buttons: [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: async () => {
        // 删除是资产终态，先结束本页已经提交的写入，避免删除后仍有定时保存。
        await restore();
        await onDelete();
      } },
    ] });
  };
  const rightButton = !isEdit
    ? <Button title={saving ? '创建中…' : '创建'} variant="text" onPress={handleCreate} disabled={saving} />
    : feedback.blocked && (editor.saveError || Object.keys(errors).length > 0)
      ? <Button title="恢复" variant="text" onPress={restoreDraft} /> : undefined;

  return (
    <SafeAreaView style={commonStyles.screenContainer} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingContainer
        style={commonStyles.screenContainer}
        keyboardVerticalOffset={0}
      >
        <NavigationHeader
          title={isEdit ? `编辑${capabilityLabel}` : `新建${capabilityLabel}`}
          onGoBack={back}
          rightButton={rightButton}
        />

        <AutoSaveErrors error={editor.saveError || creationError} blocked={isEdit && feedback.blocked && Object.keys(errors).length > 0}
          retry={isEdit ? blur : () => { void handleCreate(); }} restore={isEdit ? restoreDraft : undefined} />
        <ScrollView
          ref={feedback.scrollRef}
          style={commonStyles.screenContainer}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <ThemedSurface variant="card" style={[commonStyles.formSurface, { padding: theme.spacing.lg, paddingBottom: theme.spacing.xl }]}>
          <ModelFormSection title="配置">
          {isImageGeneration && <View>
            <DropdownField label="提供方" value={draft.imageProvider} options={IMAGE_GENERATION_PROVIDERS.map(provider => ({ value: provider.id, label: provider.label }))}
              disabled={isEdit} onChange={selectImageProvider} error={errors.imageProvider} />
            {!imageProvider && isEdit && <Text style={{ color: theme.colors.feedback.error, lineHeight: 22 }}>旧自定义生图接口已停用，请新建供应商明确的配置。</Text>}
          </View>}
          {/* 配置名称 */}
          <View onLayout={feedback.fieldLayout(['name'])}>
            <InputField
              label="配置名称"
              value={name}
              onChangeText={setName}
              {...fieldProps('name')}
              placeholder={capabilityKind === 'summary' ? '如：聊天摘要模型' : isEmbeddingCapability ? '如：记忆向量模型' : isImageGeneration ? '如：文生图模型' : '如：图片理解模型'}
            />
          </View>
          </ModelFormSection>

          <ModelFormSection title="连接">
          <View onLayout={feedback.fieldLayout(['baseUrl'])}>
            <InputField
              label="API 地址"
              value={baseUrl}
              onChangeText={setBaseUrl}
              {...fieldProps('baseUrl')}
              placeholder="https://api.example.com/v1"
              editable={!isImageGeneration}
              autoCapitalize="none"
              autoCorrect={false}
              autoGrow
            />
          </View>


          <View onLayout={feedback.fieldLayout(['apiKey'])}>
            <InputField
              label="API Key"
              value={apiKey}
              onChangeText={setApiKey}
              {...fieldProps('apiKey')}
              placeholder="填写服务商提供的 API Key"
              autoGrow
              autoCapitalize="none"
              autoCorrect={false}
              rightAccessory={isImageGeneration && imageProvider ? <ServiceConnectionPicker mode="key" baseUrl={baseUrl} apiKey={apiKey} disabled={saving || testing}
                onFill={service => { change({ apiKey: service.apiKey, serviceConfigId: '' }, true); setTestInputError(null); }} /> : undefined}
            />
            {!isImageGeneration && <ServiceConnectionPicker baseUrl={baseUrl} apiKey={apiKey} serviceConfigId={draft.serviceConfigId} disabled={isLoadingModels || testing}
              onFill={service => { change({ serviceConfigId: service.id, baseUrl: service.baseUrl, apiKey: service.apiKey }, true); setAvailableModels([]); setShowModelPicker(false); setTestInputError(null); }} />}
          </View>
          </ModelFormSection>



          <ModelFormSection title="模型">
          <View onLayout={feedback.fieldLayout(['model'])}>
            <ModelPickerField label="模型名称" value={model} disabled={isImageGeneration && !imageProvider}
              onPress={openModelPicker} loading={isLoadingModels} error={errors.model}
              onChangeText={isImageGeneration ? undefined : setModel} onBlur={blur} placeholder="模型 ID" />
          </View>
          </ModelFormSection>

          {hasSamplingParams ? (
            <ModelFormSection title="参数">
              <View onLayout={feedback.fieldLayout(['tempInput'])}><SliderField
              {...fieldProps('tempInput')}
                label="Temperature"
                value={temperature}
                inputValue={tempInput}
                onInputChange={handleTempChange}
                min={0}
                max={2}
                step={0.1}
                onSetValue={(val) => handleTempChange(String(val), true)}
              /></View>

              <View onLayout={feedback.fieldLayout(['topPInput'])}><SliderField
              {...fieldProps('topPInput')}
                label="Top P"
                value={topP}
                inputValue={topPInput}
                onInputChange={handleTopPChange}
                min={0}
                max={1}
                step={0.1}
                onSetValue={(val) => handleTopPChange(String(val), true)}
              /></View>

              <View onLayout={feedback.fieldLayout(['maxTokens'])}><MaxTokensSection
              {...fieldProps('maxTokens')}
                onSelectPreset={(value) => handleMaxTokensChange(value, true)}
                value={maxTokens}
                onChangeText={handleMaxTokensChange}
              /></View>
            </ModelFormSection>
          ) : null}

          {!isImageGeneration && <ModelFormSection title="测试">
            {testInputError ? <Text accessibilityRole="alert" style={{ color: theme.colors.feedback.error, marginBottom: theme.spacing.md, fontSize: 13 }}>{testInputError}</Text> : null}
            <Button
              title={testing ? '检查中…' : '测试连接'}
              variant="secondary"
              disabled={testing}
              onPress={handleTestConnection}
            />
          </ModelFormSection>}
          {isEdit && onDelete && <Button title="删除配置" variant="text" onPress={handleDelete}
            style={{ marginTop: theme.spacing.lg }} textStyle={{ color: theme.colors.feedback.error }} />}
          </ThemedSurface>
        </ScrollView>
      </KeyboardAvoidingContainer>

      {/* 模型选择弹窗 */}
      <ModelPickerModal
          visible={showModelPicker}
          models={availableModels}
          selectedModel={model}
          onSelect={handleSelectModel}
          onClose={() => setShowModelPicker(false)}
          loading={isLoadingModels} error={testInputError}
          onRefresh={isImageGeneration ? undefined : () => { void handleFetchModels(); }} onRetry={isImageGeneration ? undefined : () => { void handleFetchModels(); }}
          title="选择模型"
          emptyText="暂无可用模型"
        />
    </SafeAreaView>
  );
}
