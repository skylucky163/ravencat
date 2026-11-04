import ServiceConnectionPicker from './ServiceConnectionPicker';
/** 辅助模型编辑：已有资产自动保存，新资产在完整校验后显式创建。 */
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@shared/theme';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { KeyboardAvoidingContainer, Button, InputField, ModelPickerModal, SliderField, showAppDialog } from '@shared/ui';
import { createCommonStyles } from '@shared/ui/commonStyles';
import type { AuxiliaryModelConfig, UpdateAuxiliaryModelConfigInput } from '../../domain/AuxiliaryModel';
import type { ModelInfo } from '../../application/modelTypes';
import type { AuxiliaryModelFormData } from './types';
import MaxTokensSection from '../management/AIModelSettings/MaxTokensSection';
import { createModelSettingsStyles } from '../management/AIModelSettings/styles';
import { fetchModelsWithConfig } from '../management/sharedModelConfig';
import { useAutoSaveDraft, useAutoSaveNavigation } from '@shared/ui/useAutoSaveDraft';
import { useAutoSaveFeedback } from '@shared/ui/useAutoSaveFeedback';
import { AutoSaveErrors } from '@shared/ui/AutoSaveErrors';
import { readDraftNumber } from '@shared/ui/draftValidation';
import { getAuxiliaryModelDraft, parseAuxiliaryModelDraft, type AuxiliaryModelDraft } from './auxiliaryModelDraft';

interface AuxiliaryModelEditScreenProps {
  capabilityKind: 'summary' | 'embedding' | 'ocr';
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
  const modelSettingsStyles = useMemo(() => createModelSettingsStyles(theme), [theme]);
  const isEdit = !!modelId;
  const isEmbeddingCapability = capabilityKind === 'embedding';
  const initial = useMemo(() => getAuxiliaryModelDraft(initialData), [initialData]);
  const parse = useCallback((draft: AuxiliaryModelDraft, changed: (keyof AuxiliaryModelDraft)[]) => parseAuxiliaryModelDraft(capabilityKind, draft, changed), [capabilityKind]);
  const editor = useAutoSaveDraft({ initial, parse, save: onSave, enabled: isEdit });
  const { draft, errors, commit, flush, restore, change, validateAll } = editor;
  const { name, baseUrl, apiKey, model, tempInput, topPInput, maxTokens } = draft;
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
  const handleFetchModels = async () => {
    if (!baseUrl.trim() || !apiKey.trim()) { setTestInputError('获取模型列表需要填写 API 地址和 Key。'); return; }
    setIsLoadingModels(true);
    try {
      const result = await fetchModelsWithConfig({ apiBaseUrl: baseUrl, apiKey });
      if (result.errorInfo) { setTestInputError(result.errorInfo.message || '无法获取模型列表。'); return; }
      setAvailableModels(result.models);
      if (result.models.length > 0) setShowModelPicker(true);
      else setTestInputError('未获取到模型，请检查地址和 Key。');
    } catch (error) { setTestInputError(error instanceof Error ? error.message : '获取模型列表失败。'); }
    finally { setIsLoadingModels(false); }
  };
  const handleSelectModel = (modelId: string) => { setField('model', modelId, true); setShowModelPicker(false); };
  const buildFormData = (): AuxiliaryModelFormData | null => {
    const values = validateAll();
    if (!values) return null;
    return {
      id: modelId || undefined, serviceConfigId: values.serviceConfigId, name: values.name, baseUrl: values.baseUrl, model: values.model,
      apiKey: values.apiKey ?? '', temperature: values.temperature ?? null,
      topP: values.topP ?? null, maxTokens: values.maxTokens ?? null, metadataJson: values.metadataJson,
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
          contentContainerStyle={modelSettingsStyles.contentContainer}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* 配置名称 */}
          <View style={modelSettingsStyles.section} onLayout={feedback.fieldLayout(['name'])}>
            <InputField
              label="配置名称"
              value={name}
              onChangeText={setName}
              {...fieldProps('name')}
              placeholder={capabilityKind === 'summary' ? '如：聊天摘要模型' : isEmbeddingCapability ? '如：记忆向量模型' : '如：图片理解模型'}
              inputStyle={modelSettingsStyles.borderedInput}
            />
          </View>

          <View style={modelSettingsStyles.section} onLayout={feedback.fieldLayout(['baseUrl'])}>
            <InputField
              label="API 地址"
              value={baseUrl}
              onChangeText={setBaseUrl}
              {...fieldProps('baseUrl')}
              placeholder="https://api.example.cn/v1"
              hint="支持填写 OpenAI 兼容格式地址，也支持带 /v4 的厂商地址"
              autoCapitalize="none"
              autoCorrect={false}
              inputStyle={modelSettingsStyles.borderedInput}
            />
          </View>


          <View style={modelSettingsStyles.section} onLayout={feedback.fieldLayout(['apiKey'])}>
            <InputField
              label="API Key"
              value={apiKey}
              onChangeText={setApiKey}
              {...fieldProps('apiKey')}
              placeholder="sk-..."
              autoGrow
              autoCapitalize="none"
              inputStyle={modelSettingsStyles.borderedInput}
            />
          </View>



          <ServiceConnectionPicker baseUrl={baseUrl} apiKey={apiKey} disabled={isLoadingModels || testing}
            onFill={service => { change({ serviceConfigId: service.id, baseUrl: service.baseUrl, apiKey: service.apiKey }, true); setAvailableModels([]); setShowModelPicker(false); setTestInputError(null); }} />
          <View style={modelSettingsStyles.section} onLayout={feedback.fieldLayout(['model'])}>
            {isEmbeddingCapability && <Text style={{ color: theme.colors.text.secondary, lineHeight: 22 }}>
              修改正在使用的模型或连接配置后，记忆、表情包等功能的原向量可能不再适用。旧向量会保留，不会自动重新向量化；请到对应功能中手动重建。此处需要选择支持向量化的模型。
            </Text>}
            <InputField label="模型名称" value={model} onChangeText={setModel} {...fieldProps('model')}
              placeholder={isEmbeddingCapability ? '填写向量模型 ID' : '填写模型 ID，或从列表选择'} autoCapitalize="none" autoCorrect={false} />
            <Button title={isLoadingModels ? '获取中…' : '获取模型列表'} variant="text" disabled={isLoadingModels} onPress={() => { void handleFetchModels(); }} />
            {availableModels.length > 0 && <Button title="从已获取的列表选择" variant="text" onPress={() => setShowModelPicker(true)} />}
          </View>

          {!isEmbeddingCapability ? (
            <>
              <View onLayout={feedback.fieldLayout(['tempInput'])}><SliderField
              {...fieldProps('tempInput')}
                label="Temperature"
                description="留空使用服务商默认值。"
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
                description="留空使用服务商默认值。"
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
            </>
          ) : null}

          {/* 删除模型（仅编辑时显示） */}
          {isEdit && onDelete ? (
            <View style={[modelSettingsStyles.section, { borderBottomWidth: 0 }]}>
              <Button
                title="删除该模型"
                variant="danger"
                onPress={handleDelete}
                style={{ backgroundColor: theme.colors.background.app }}
                textStyle={{ color: theme.colors.feedback.error }}
              />
            </View>
          ) : null}

          {testInputError ? <Text accessibilityRole="alert" style={{ color: theme.colors.feedback.error, padding: theme.spacing.lg, fontSize: 13 }}>{testInputError}</Text> : null}
          {/* 测试连接 */}
          <View style={modelSettingsStyles.section}>
            <Button
              title={testing ? '测试中…' : '测试连接'}
              variant="secondary"
              disabled={testing}
              onPress={handleTestConnection}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingContainer>

      {/* 模型选择弹窗 */}
      <ModelPickerModal
          visible={showModelPicker}
          models={availableModels}
          selectedModel={model}
          onSelect={handleSelectModel}
          onClose={() => setShowModelPicker(false)}
          title="选择模型"
          emptyText="暂无可用模型"
        />
    </SafeAreaView>
  );
}
