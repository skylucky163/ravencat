// 添加新AI助手界面 - 简洁风格

import React, { useCallback, useEffect } from 'react';
import {
  ScrollView,
  Keyboard,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { KeyboardAvoidingContainer, ModelPickerModal, Button } from '@shared/ui';
import useAddAIForm from './useAddAIForm';
import StepIndicator from './StepIndicator';
import {
  NameInput,
  ApiUrlInput,
  ApiKeyInput,
  SystemPromptInput,
  FetchModelsButton,
  SelectedModel,
  ModelSelectHint,
  TestConnectionButton,
  TipSection,
} from './FormFields';
import { createStyles } from './styles';
import { createCommonStyles } from '@shared/ui/commonStyles';
import { useTheme, useThemedStyles } from '@shared/theme';
import ServiceConnectionPicker from '../auxiliaryModels/ServiceConnectionPicker';

const STEPS = ['基本信息', '选择模型', '测试连接'];



interface AddAIScreenProps {
  onBack?: () => void;
  onAdded?: () => void;
}

/**
 * 添加AI助手主组件
 */
export default function AddAIScreen({ onBack, onAdded }: AddAIScreenProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const commonStyles = React.useMemo(() => createCommonStyles(theme), [theme]);

  const {
    // 表单字段
    name,
    setName,
    apiKey,
    apiBaseUrl,
    selectedModel,
    systemPrompt,
    setSystemPrompt,

    // 状态
    availableModels,
    isLoadingModels,
    showModelPicker,
    setShowModelPicker,
    isTesting,
    testResult,
    currentStep,

    // 处理方法
    handleApiBaseUrlChange,
    handleApiKeyChange,
    handleFetchModels,
    handleSelectModel,
    handleTestConnection,
    handleSave, handleFillServiceConnection,
  } = useAddAIForm({ onAdded, onBack });

  useEffect(() => {
    return () => {
      Keyboard.dismiss();
    };
  }, []);

  const handleBack = useCallback(() => {
    Keyboard.dismiss();
    onBack?.();
  }, [onBack]);

  const handleSavePress = useCallback(async () => {
    Keyboard.dismiss();
    await handleSave();
  }, [handleSave]);

  const handleFetchModelsPress = useCallback(async () => {
    Keyboard.dismiss();
    await handleFetchModels();
  }, [handleFetchModels]);

  const handleOpenModelPicker = useCallback(() => {
    Keyboard.dismiss();
    setShowModelPicker(true);
  }, [setShowModelPicker]);

  const handleCloseModelPicker = useCallback(() => {
    Keyboard.dismiss();
    setShowModelPicker(false);
  }, [setShowModelPicker]);

  const handleSelectModelPress = useCallback((modelId: string) => {
    Keyboard.dismiss();
    handleSelectModel(modelId);
  }, [handleSelectModel]);

  const handleTestConnectionPress = useCallback(async () => {
    Keyboard.dismiss();
    await handleTestConnection();
  }, [handleTestConnection]);

  return (
    <SafeAreaView style={commonStyles.screenContainer} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingContainer
        style={commonStyles.screenContainer}
        keyboardVerticalOffset={0}
      >
        <NavigationHeader
          title="添加AI助手"
          onGoBack={handleBack}
          rightButton={
            <Button title="保存" variant="text" onPress={handleSavePress} style={commonStyles.navSaveBtn} />
          }
        />

        <ScrollView
          style={commonStyles.screenContainer}
          contentContainerStyle={styles.contentContainer}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* 步骤指示器 */}
          <StepIndicator currentStep={currentStep} steps={STEPS} />

          {/* AI名称 */}
          <NameInput value={name} onChangeText={setName} />

          <View style={styles.section}>
            <ServiceConnectionPicker baseUrl={apiBaseUrl} apiKey={apiKey} onFill={handleFillServiceConnection} disabled={isTesting || isLoadingModels} />
          </View>

          {/* API 地址 */}
          <ApiUrlInput
            value={apiBaseUrl}
            onChangeText={handleApiBaseUrlChange}
          />

          {/* API Key */}
          <ApiKeyInput value={apiKey} onChangeText={handleApiKeyChange} />

          {/* 获取模型列表 */}
          <FetchModelsButton
            onPress={handleFetchModelsPress}
            isLoading={isLoadingModels}
            hasModels={availableModels.length > 0}
          />

          {/* 已选择的模型 / 选择提示 */}
          {selectedModel ? (
            <SelectedModel
              modelId={selectedModel}
              onChangePress={handleOpenModelPicker}
            />
          ) : availableModels.length > 0 ? (
            <ModelSelectHint />
          ) : null}

          {/* 测试连接 */}
          {selectedModel && (
            <TestConnectionButton
              onPress={handleTestConnectionPress}
              isTesting={isTesting}
              testResult={testResult}
            />
          )}

          {/* 系统提示词 */}
          <SystemPromptInput
            value={systemPrompt}
            onChangeText={setSystemPrompt}
          />

          {/* 提示信息 */}
          <TipSection />
        </ScrollView>
      </KeyboardAvoidingContainer>

      {/* 模型选择弹窗 */}
      <ModelPickerModal
        visible={showModelPicker}
        models={availableModels}
        selectedModel={selectedModel}
        onSelect={handleSelectModelPress}
        onClose={handleCloseModelPicker}
      />

    </SafeAreaView>
  );
}

export { default as StepIndicator } from './StepIndicator';
export { default as useAddAIForm } from './useAddAIForm';
export * from './FormFields';
