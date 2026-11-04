/** 展示群聊管理员模型与上下文设置。 */

import React from 'react';
import {
  View,
  Text,
  ScrollView,
  } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { GroupChatAdminConfig, UpdateGroupChatAdminConfigInput } from '../../group/domain/GroupChat';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { KeyboardAvoidingContainer, ModelPickerModal, Button, InputField, SliderField } from '@shared/ui';
import { createCommonStyles } from '@shared/ui/commonStyles';
import { ThemedSurface, useTheme } from '@shared/theme';
import { AutoSaveErrors } from '@shared/ui/AutoSaveErrors';

import { ModelSection, ServiceConnectionPicker } from '@features/assistants';
import NumberInputPresetsSection from './NumberInputPresetsSection';
import useGroupAdminSettings from './useGroupAdminSettings';

interface GroupAdminSettingsProps {
  adminConfig?: GroupChatAdminConfig | null;
  onBack?: () => void;
  onUpdate(input: UpdateGroupChatAdminConfigInput): Promise<void>;
}

export default function GroupAdminSettings({
  adminConfig,
  onBack,
  onUpdate,
}: GroupAdminSettingsProps) {
  const theme = useTheme();
  const commonStyles = React.useMemo(() => createCommonStyles(theme), [theme]);
  const {
    apiBaseUrl,
    setApiBaseUrl,
    apiKey,
    setApiKey,
    selectedModel,
    temperature,
    tempInput,
    topP,
    topPInput,
    maxTokens,
    contextMessageCount,
    systemPrompt,
    setSystemPrompt,
    availableModels,
    isLoadingModels,
    showModelPicker,
    setShowModelPicker,
    isTesting,
    testResult,
    handleTempChange,
    handleTopPChange,
    handleMaxTokensChange,
    handleContextMessageCountChange,
    handleFetchModels,
    handleSelectModel,
    handleTestConnection,
    fillServiceConnection,
    errors, saveError, commit, back, restoreDraft, feedback, connectionError,
  } = useGroupAdminSettings({ adminConfig, onUpdate, onBack });
  const blur = () => { void commit(); };

  return (
    <SafeAreaView style={commonStyles.screenContainer} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingContainer
        style={commonStyles.screenContainer}
        keyboardVerticalOffset={0}
      >
        <NavigationHeader title="管理员设置" onGoBack={back}
          rightButton={feedback.blocked && Object.keys(errors).length > 0 ? <Button title="恢复" variant="text" onPress={() => void restoreDraft()} /> : undefined} />
        <AutoSaveErrors error={saveError} blocked={feedback.blocked && Object.keys(errors).length > 0}
          retry={blur} restore={() => void restoreDraft()} />

        <ScrollView
          ref={feedback.scrollRef}
          style={commonStyles.screenContainer}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {/* API 地址 */}
          <View style={commonStyles.section}>
            <InputField
              label="API 地址"
              value={apiBaseUrl}
              onChangeText={setApiBaseUrl}
              onBlur={blur}
              placeholder="https://api.example.cn/v1"
              autoGrow
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          {/* API Key */}
          <View style={commonStyles.section}>
            <InputField
              label="API Key"
              value={apiKey}
              onChangeText={setApiKey}
              onBlur={blur}
              placeholder="sk-..."
              autoGrow
              autoCapitalize="none"
            />
          </View>

          <View style={commonStyles.section}>
            <ThemedSurface variant="card" style={{ borderRadius: theme.radius.lg, overflow: 'hidden' }}>
              <ServiceConnectionPicker baseUrl={apiBaseUrl} apiKey={apiKey} onFill={fillServiceConnection} disabled={isTesting || isLoadingModels} />
            </ThemedSurface>
          </View>

          {/* 模型选择 + 测试连接 */}
          <View onLayout={feedback.fieldLayout(['selectedModel'])}><ModelSection
            selectedModel={selectedModel}
            hasAvailableModels={availableModels.length > 0}
            isLoadingModels={isLoadingModels}
            testResult={testResult === 'success' ? 'success' : testResult === 'error' ? 'error' : null}
            isTesting={isTesting}
            onFetchModels={handleFetchModels}
            onShowPicker={() => setShowModelPicker(true)}
            onTestConnection={handleTestConnection}
          />
          {errors.selectedModel || connectionError ? <Text accessibilityRole="alert" style={{ color: theme.colors.feedback.error, paddingHorizontal: theme.spacing.lg, fontSize: 13 }}>{errors.selectedModel || connectionError}</Text> : null}
          </View>

          {/* Temperature */}
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
            onSetValue={(val) => handleTempChange(String(val), true)}
          /></View>

          {/* Top P */}
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
            onSetValue={(val) => handleTopPChange(String(val), true)}
          /></View>

          {/* Max Tokens */}
          <View onLayout={feedback.fieldLayout(['maxTokens'])}><NumberInputPresetsSection
            onBlur={blur}
            error={errors.maxTokens}
            onSelectPreset={(value) => handleMaxTokensChange(value, true)}
            label="Max Tokens"
            value={maxTokens}
            onChangeText={handleMaxTokensChange}
            presets={['2000', '4000', '8000', '无限制']}
          /></View>

          {/* 管理员上下文消息数量 */}
          <View onLayout={feedback.fieldLayout(['contextMessageCount'])}><NumberInputPresetsSection
            onBlur={blur}
            error={errors.contextMessageCount}
            onSelectPreset={(value) => handleContextMessageCountChange(value, true)}
            label="管理员上下文消息数量"
            value={contextMessageCount}
            onChangeText={handleContextMessageCountChange}
            presets={['0', '20', '50', '100']}
            maxLength={3}
          /></View>

          {/* 系统提示词 */}
          <View style={commonStyles.section}>
            <InputField
              label="系统提示词"
              value={systemPrompt}
              onChangeText={setSystemPrompt}
              onBlur={blur}
              placeholder="设置管理员的系统提示词，定义其调度行为..."
              hint="系统提示词用于定义管理员的角色和调度策略，修改后自动保存。"
              multiline
              numberOfLines={6}
              textAlignVertical="top"
            />
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
