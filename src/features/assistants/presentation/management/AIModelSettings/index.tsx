import { getAssistantDisplayName } from '../../../AssistantNickname';
// AI 模型设置 - 主组件（组装层）

import React, { useCallback, useMemo, type ReactNode } from 'react';
import { View, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { AIProfile } from '../../../domain/AIProfile';

import { useTheme } from '@shared/theme';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { KeyboardAvoidingContainer, ModelPickerModal, Button, InputField, ToggleField, AIInfoCard, SliderField, showAppDialog, type AppDialogButton, type AppDialogTone } from '@shared/ui';
import useModelSettings from './useModelSettings';
import { useAutoSaveNavigation } from '@shared/ui/useAutoSaveDraft';
import { useAutoSaveFeedback } from '@shared/ui/useAutoSaveFeedback';
import { AutoSaveErrors } from '@shared/ui/AutoSaveErrors';

import ModelSection from './ModelSection';
import { AssistantVoiceModelPicker } from '../AssistantVoiceModelPicker';
import MaxTokensSection from './MaxTokensSection';

import { createModelSettingsStyles } from './styles';
import { createCommonStyles } from '@shared/ui/commonStyles';
import ServiceConnectionPicker from '../../auxiliaryModels/ServiceConnectionPicker';

interface AIModelSettingsProps {
  aiAssistant: AIProfile;
  onBack: () => void;
  onUpdated?: (updatedAI: Partial<AIProfile>) => void;
  auxiliaryModelSettings: ReactNode;
}

/**
 * AI 模型设置屏幕
 * @param aiAssistant - 当前 AI 助手数据
 * @param onBack - 返回回调
 * @param onUpdated - 更新成功回调
 */
export default function AIModelSettings({
  aiAssistant,
  onBack,
  onUpdated,
  auxiliaryModelSettings,
}: AIModelSettingsProps) {
  const theme = useTheme();
  const styles = useMemo(() => createModelSettingsStyles(theme), [theme]);
  const commonStyles = useMemo(() => createCommonStyles(theme), [theme]);
  // 显示弹窗的回调
  const showAlert = useCallback((title: string, message: string, buttons?: AppDialogButton[], tone: AppDialogTone = 'info') => {
    showAppDialog({ title, message, buttons, tone });
  }, []);

  const {
    // 状态
    temperature,
    topP,
    maxTokens,
    tempInput,
    topPInput,
    selectedModel,
    availableModels,
    isLoadingModels,
    showModelPicker,
    isTesting,
    testResult,
    apiBaseUrl,
    apiKey,
    enableTools,
    disableThinking,
    isHostAI,
    isCheckingHost,
    isChangingHost,

    // setters
    setShowModelPicker,
    setApiBaseUrl,
    setApiKey,
    setEnableTools,
    setDisableThinking,

    // handlers
    handleTempChange,
    handleTopPChange,
    handleMaxTokensChange,
    handleFetchModels,
    handleSelectModel,
    handleTestConnection,
    handleHostAIToggle,
    fillServiceConnection,
    errors, saveError, commit, flush, restore, getSnapshot,
    handleReset,
  } = useModelSettings({ aiAssistant, onUpdated, onShowAlert: showAlert });

  const feedback = useAutoSaveFeedback(errors);
  const { back } = useAutoSaveNavigation(flush, onBack, () => feedback.revealErrors(getSnapshot().errors));
  const blur = () => { void commit(); };
  const restoreDraft = () => { void restore().then(() => feedback.setBlocked(false)); };

  return (
    <SafeAreaView style={commonStyles.screenContainer} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingContainer
        style={commonStyles.screenContainer}
        keyboardVerticalOffset={0}
      >
        <NavigationHeader title="模型设置" onGoBack={back} rightButton={feedback.blocked && (saveError || Object.keys(errors).length > 0) ? <Button title="恢复" variant="text" onPress={restoreDraft} /> : undefined} />
        <AutoSaveErrors error={saveError} blocked={feedback.blocked && Object.keys(errors).length > 0}
          retry={blur} restore={restoreDraft} />

        <ScrollView
          ref={feedback.scrollRef}
          style={commonStyles.screenContainer}
          contentContainerStyle={styles.contentContainer}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {/* AI 信息卡片 */}
          <View style={styles.section}>
            <AIInfoCard
              name={getAssistantDisplayName(aiAssistant)}
              model={aiAssistant.model}
              avatarUrl={aiAssistant.avatar}
            />
          </View>

          {/* API 地址配置 */}
          <View style={styles.section}>
            <InputField
              label="API 地址"
              value={apiBaseUrl}
              onChangeText={setApiBaseUrl}
              onBlur={blur}
              error={errors.apiBaseUrl}
              placeholder="https://api.example.cn/v1"
              hint="支持填写 OpenAI 兼容格式地址，也支持带 /v4 的厂商地址"
              autoGrow
              autoCapitalize="none"
              autoCorrect={false}
              inputStyle={styles.borderedInput}
            />
          </View>

          {/* API Key 配置 */}
          <View style={styles.section}>
            <InputField
              label="API Key"
              value={apiKey}
              onChangeText={setApiKey}
              onBlur={blur}
              error={errors.apiKey}
              placeholder="sk-..."
              autoGrow
              autoCapitalize="none"
              inputStyle={styles.borderedInput}
            />
          </View>

          <View style={styles.section}>
            <ServiceConnectionPicker baseUrl={apiBaseUrl} apiKey={apiKey} onFill={fillServiceConnection} disabled={isTesting || isLoadingModels} />
          </View>

          {/* 模型选择 + 测试连接 */}
          <ModelSection
            selectedModel={selectedModel}
            hasAvailableModels={availableModels.length > 0}
            isLoadingModels={isLoadingModels}
            testResult={testResult}
            isTesting={isTesting}
            onFetchModels={handleFetchModels}
            onShowPicker={() => setShowModelPicker(true)}
            onTestConnection={handleTestConnection}
          />

          <View style={[styles.section, styles.sectionLightBorder]}>
            <ToggleField
              label="启用思维链"
              hint="开启时先思考再回答，关闭时请求直接回答。非思考模型不受影响；固定思考模型无法关闭。"
              value={!disableThinking}
              onValueChange={(enabled) => setDisableThinking(!enabled)}
            />
          </View>

          {/* Temperature 控制 */}
          <View onLayout={feedback.fieldLayout(['tempInput'])}><SliderField
            onBlur={blur}
            error={errors.tempInput}
            label="Temperature"
            description="留空使用服务商默认值。"
            value={temperature}
            inputValue={tempInput}
            onInputChange={handleTempChange}
            min={0}
            max={2}
            step={0.1}
            onSetValue={(val) => {
              handleTempChange(String(val), true);
            }}
          /></View>

          {/* Top P 控制 */}
          <View onLayout={feedback.fieldLayout(['topPInput'])}><SliderField
            onBlur={blur}
            error={errors.topPInput}
            label="Top P"
            description="留空使用服务商默认值。"
            value={topP}
            inputValue={topPInput}
            onInputChange={handleTopPChange}
            min={0}
            max={1}
            step={0.1}
            onSetValue={(val) => {
              handleTopPChange(String(val), true);
            }}
          /></View>

          {/* Max Tokens 控制 */}
          <View onLayout={feedback.fieldLayout(['maxTokens'])}><MaxTokensSection
            onBlur={blur}
            error={errors.maxTokens}
            onSelectPreset={(value) => handleMaxTokensChange(value, true)}
            value={maxTokens}
            onChangeText={handleMaxTokensChange}
          /></View>

          {/* 重置按钮 */}
          <Button
            title="重置为默认值"
            variant="outline"
            onPress={handleReset}
            style={{ margin: theme.spacing.lg }}
          />

          {/* 主理 AI 是独立关系命令，确认后立即生效，不随模型配置保存。 */}
          <View style={[styles.section, styles.sectionLightBorder]}>
            <ToggleField
              label="主理 AI"
              hint="任命或撤销在确认后立即生效。"
              value={isHostAI}
              onValueChange={(value) => void handleHostAIToggle(value)}
              disabled={isCheckingHost || isChangingHost}
            />
          </View>

          {/* 工具调用开关 */}
          <View style={[styles.section, styles.sectionLightBorder]}>
            <ToggleField
              label="允许工具调用"
              hint="开启后，AI 可调用时刻等工具获取上下文。"
              value={enableTools}
              onValueChange={setEnableTools}
            />
          </View>

          <View style={[styles.section, styles.sectionLightBorder]}>
            {auxiliaryModelSettings}
            <AssistantVoiceModelPicker assistantId={aiAssistant.id} />
          </View>

        </ScrollView>
      </KeyboardAvoidingContainer>

      {/* 模型选择弹窗 */}
      <ModelPickerModal
        visible={showModelPicker}
        models={availableModels}
        selectedModel={selectedModel}
        onSelect={handleSelectModel}
        onClose={() => setShowModelPicker(false)}
      />
    </SafeAreaView>
  );
}
