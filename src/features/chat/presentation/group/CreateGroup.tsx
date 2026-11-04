/** 创建群聊页面，负责选择成员并配置、测试管理员模型后创建群组。 */

import React, { useState, useCallback, useRef } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Keyboard } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import NavigationHeader from '@shared/ui/NavigationHeader';
import { KeyboardAvoidingContainer, Button, InputField, AIAvatar, GroupAvatar, ModelPickerModal, showAppDialog } from '@shared/ui';
import { createCommonStyles } from '@shared/ui/commonStyles';
import { useTheme, useThemedStyles } from '@shared/theme';
import { createStyles } from './CreateGroup.styles';
import type { GroupChatDetails } from '../../group/domain/GroupChat';
import { createGroupChat } from '../../group/application';
import { getAssistantDisplayName,
  fetchModelsWithConfig,
  runConnectionTestByConfig,
  FetchModelsButton,
  ServiceConnectionPicker,
  ModelSelectHint,
  SelectedModel,
  TestConnectionButton,
  type AIProfile,
} from '@features/assistants';
import {
  PERSISTENT_IMAGE_CATEGORY,
  usePersistentAvatarDraft,
} from '@platform/device/DeviceMediaService';

interface CreateGroupProps {
  aiList: AIProfile[];
  onBack?: () => void;
  onCreated?: (group: GroupChatDetails) => void;
}

export default function CreateGroup({ aiList, onBack, onCreated }: CreateGroupProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const commonStyles = React.useMemo(() => createCommonStyles(theme), [theme]);

  const [groupName, setGroupName] = useState('');
  const [adminServiceConfigId, setAdminServiceConfigId] = useState('');
  const [adminUrl, setAdminUrl] = useState('');
  const [adminApiKey, setAdminApiKey] = useState('');
  const [adminModel, setAdminModel] = useState('');
  const [availableModels, setAvailableModels] = useState<{ id: string; name: string }[]>([]);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const avatarDraftIdRef = useRef(
    `new_group_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
  const {
    avatarUri,
    isPickingAvatar,
    isCommittingAvatar,
    pickAvatar,
    resetAvatar,
    commitAvatar,
  } = usePersistentAvatarDraft({
    category: PERSISTENT_IMAGE_CATEGORY.groupAvatar,
    entityId: avatarDraftIdRef.current,
    committedUri: null,
  });

  React.useEffect(() => {
    return () => {
      Keyboard.dismiss();
    };
  }, []);

  const toggleAI = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleBack = useCallback(() => {
    Keyboard.dismiss();
    onBack?.();
  }, [onBack]);

  const resetModelFlow = useCallback(() => {
    setAdminModel('');
    setAvailableModels([]);
    setShowModelPicker(false);
    setTestResult(null);
  }, []);

  const handleAdminUrlChange = useCallback((text: string) => {
    setAdminUrl(text); setAdminServiceConfigId('');
    resetModelFlow();
  }, [resetModelFlow]);

  const handleAdminApiKeyChange = useCallback((text: string) => {
    setAdminApiKey(text); setAdminServiceConfigId('');
    resetModelFlow();
  }, [resetModelFlow]);

  const handleFetchModels = useCallback(async () => {
    const apiBaseUrl = adminUrl.trim();
    const apiKey = adminApiKey.trim();
    if (!apiBaseUrl || !apiKey) {
      showAppDialog({ title: '无法获取模型', message: '请先填写管理员 API 地址和 API Key。' });
      return;
    }

    setIsLoadingModels(true);
    setTestResult(null);
    try {
      const { models, errorInfo } = await fetchModelsWithConfig({
        apiBaseUrl,
        apiKey,
      });

      if (errorInfo) {
        showAppDialog({ title: errorInfo.title, message: errorInfo.message, tone: 'error' });
        return;
      }

      setAvailableModels(models);
      if (models.length > 0) {
        setShowModelPicker(true);
        return;
      }

      showAppDialog({ title: '未获取到模型', message: '当前接口没有返回可用模型，请检查账号权限或接口配置。', tone: 'warning' });
    } finally {
      setIsLoadingModels(false);
    }
  }, [adminApiKey, adminUrl]);

  const handleSelectModel = useCallback((modelId: string) => {
    setAdminModel(modelId);
    setShowModelPicker(false);
    setTestResult(null);
  }, []);

  const handleTestConnection = useCallback(async () => {
    const apiBaseUrl = adminUrl.trim();
    const apiKey = adminApiKey.trim();
    const selectedModel = adminModel.trim();
    if (!apiBaseUrl || !apiKey || !selectedModel) {
      showAppDialog({ title: '无法测试连接', message: '请先填写管理员 API 地址、API Key，并选择模型。' });
      return;
    }

    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await runConnectionTestByConfig({
        apiBaseUrl,
        apiKey,
        selectedModel,
        requestOptions: { skipParams: true },
      });

      if (result.success) {
        setTestResult('success');
        showAppDialog({ title: '连接成功', message: `管理员模型「${selectedModel}」连接正常，可以保存。`, tone: 'success' });
        return;
      }

      setTestResult('error');
      const errorInfo = result.errorInfo;
      showAppDialog({ title: errorInfo?.title || '连接失败', message: errorInfo?.message || '管理员模型连接失败。', tone: 'error' });
    } catch (error) {
      setTestResult('error');
      showAppDialog({ title: '连接错误', message: error instanceof Error ? error.message : '测试连接时发生错误。', tone: 'error' });
    } finally {
      setIsTesting(false);
    }
  }, [adminApiKey, adminModel, adminUrl]);

  const handlePickAvatar = useCallback(async () => {
    try {
      const result = await pickAvatar();
      if (result.status === 'permission-denied') {
        showAppDialog({ title: '需要权限', message: '请允许访问相册以选择群头像', tone: 'warning' });
      }
    } catch (error) {
      console.error('Failed to pick group avatar:', error);
      showAppDialog({ title: '错误', message: '选择群头像失败，请稍后重试', tone: 'error' });
    }
  }, [pickAvatar]);

  const handleResetAvatar = useCallback(() => {
    void resetAvatar().catch((error) => {
      console.error('Failed to reset group avatar:', error);
      showAppDialog({ title: '错误', message: '恢复默认群头像失败', tone: 'error' });
    });
  }, [resetAvatar]);

  const handleAvatarPress = useCallback(() => {
    showAppDialog({ title: '群聊头像', message: '你可以从相册选择群头像，或恢复默认头像。', buttons: [
      { text: '取消', style: 'cancel' },
      { text: '恢复默认', onPress: handleResetAvatar },
      { text: '从相册选择', onPress: () => void handlePickAvatar() },
    ] });
  }, [handlePickAvatar, handleResetAvatar]);

  const handleSave = useCallback(async () => {
    if (isSaving) {
      return;
    }

    if (testResult !== 'success') {
      showAppDialog({ title: '请先测试连接', message: '管理员模型连接成功后才能保存群聊。', tone: 'warning' });
      return;
    }

    setIsSaving(true);
    try {
      const group = await commitAvatar((avatar, draft) => createGroupChat({
        name: groupName,
        avatar,
        avatarDraft: draft,
        memberAIIds: Array.from(selectedIds),
        admin: {
          apiBaseUrl: adminUrl,
          serviceConfigId: adminServiceConfigId || null,
          apiKey: adminApiKey,
          model: adminModel,
        },
      }), (details) => details.group.avatar);

      Keyboard.dismiss();
      onCreated?.(group);
    } catch (error) {
      showAppDialog({ title: '创建群聊失败', message: error instanceof Error ? error.message : '请稍后重试', tone: 'error' });
    } finally {
      setIsSaving(false);
    }
  }, [adminApiKey, adminModel, adminUrl, adminServiceConfigId, commitAvatar, groupName, isSaving, onCreated, selectedIds, testResult]);

  const avatarBusy = isPickingAvatar || isCommittingAvatar;

  return (
    <SafeAreaView style={commonStyles.screenContainer} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingContainer
        style={commonStyles.screenContainer}
        keyboardVerticalOffset={0}
      >
        <NavigationHeader
          title="创建群聊"
          rightButton={
            <Button
              title={isSaving ? '保存中' : '保存'}
              variant="text"
              onPress={handleSave}
              disabled={isSaving || avatarBusy}
              style={commonStyles.navSaveBtn}
            />
          }
          onGoBack={handleBack}
        />

        <ScrollView
          style={commonStyles.screenContainer}
          contentContainerStyle={styles.contentContainer}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* 群聊头像 */}
          <View style={styles.avatarSection}>
            <TouchableOpacity
              activeOpacity={0.8}
              style={styles.avatarWrapper}
              onPress={handleAvatarPress}
              disabled={avatarBusy}
            >
              <GroupAvatar
                name={groupName || '群聊'}
                avatarUrl={avatarUri}
                size="large"
                style={styles.avatarImage}
              />
              <View style={styles.avatarEditBadge}>
                <Ionicons name="camera" size={14} color={theme.colors.brand.onPrimary} />
              </View>
            </TouchableOpacity>
          </View>

          {/* 群聊名称 */}
          <View style={styles.section}>
            <InputField
              label="群聊名称"
              placeholder="请输入群聊名称"
              value={groupName}
              onChangeText={setGroupName}
              style={{ marginBottom: 0 }}
            />
          </View>

          {/* 群管理员 */}
          <View style={styles.section}>
            <Text style={commonStyles.sectionTitle}>群管理员</Text>
            <ServiceConnectionPicker baseUrl={adminUrl} apiKey={adminApiKey} onFill={service => { setAdminServiceConfigId(service.id); setAdminUrl(service.baseUrl); setAdminApiKey(service.apiKey); resetModelFlow(); }} disabled={isTesting || isLoadingModels || isSaving} />
          </View>
          <View style={styles.section}>
            <InputField
              label="API 地址"
              placeholder="https://api.example.com/v1"
              value={adminUrl}
              onChangeText={handleAdminUrlChange}
              autoGrow
              style={{ marginBottom: 0 }}
            />
          </View>
          <View style={styles.section}>
            <InputField
              label="API Key"
              placeholder="sk-..."
              value={adminApiKey}
              onChangeText={handleAdminApiKeyChange}
              autoGrow
              autoCapitalize="none"
              style={{ marginBottom: 0 }}
            />
          </View>
          <FetchModelsButton
            onPress={handleFetchModels}
            isLoading={isLoadingModels}
            hasModels={availableModels.length > 0}
          />
          {adminModel ? (
            <SelectedModel
              modelId={adminModel}
              onChangePress={() => setShowModelPicker(true)}
            />
          ) : availableModels.length > 0 ? (
            <ModelSelectHint />
          ) : null}
          {adminModel ? (
            <TestConnectionButton
              onPress={handleTestConnection}
              isTesting={isTesting}
              testResult={testResult}
            />
          ) : null}

          {/* 邀请 AI 助手 */}
          <View style={styles.section}>
            <Text style={commonStyles.sectionTitle}>邀请 AI 助手</Text>
            {aiList.length === 0 ? (
              <Text style={styles.emptyHint}>暂无 AI 助手可邀请</Text>
            ) : (
              aiList.map((ai) => (
                <TouchableOpacity
                  key={ai.id}
                  style={styles.aiRow}
                  activeOpacity={0.7}
                  onPress={() => toggleAI(ai.id)}
                >
                  <AIAvatar
                    name={getAssistantDisplayName(ai)}
                    avatarUrl={ai.avatar}
                    size="small"
                  />
                  <Text style={styles.aiName} numberOfLines={1}>
                    {getAssistantDisplayName(ai)}
                  </Text>
                  <View
                    style={[
                      styles.checkbox,
                      selectedIds.has(ai.id) && styles.checkboxChecked,
                    ]}
                  >
                    {selectedIds.has(ai.id) && (
                      <Ionicons name="checkmark" size={14} color={theme.colors.brand.onPrimary} />
                    )}
                  </View>
                </TouchableOpacity>
              ))
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingContainer>
      <ModelPickerModal
        visible={showModelPicker}
        models={availableModels}
        selectedModel={adminModel}
        onSelect={handleSelectModel}
        onClose={() => setShowModelPicker(false)}
      />
    </SafeAreaView>
  );
}
