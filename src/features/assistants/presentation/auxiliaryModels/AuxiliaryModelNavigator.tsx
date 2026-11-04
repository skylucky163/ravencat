import ModelServiceListScreen from './ModelServiceListScreen';
import ModelServiceEditScreen from './ModelServiceEditScreen';
/** 辅助模型中心只管理资产，路由适配由 Host 负责。 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Button, showAppDialog } from '@shared/ui';
import { TranslationModelPicker } from '@features/integrations';
import { SpeechRecognitionModelPicker } from '@features/speech';
import { canCommitPresentationLoad } from '@shared/utils/presentationLoadRevision';
import AuxiliaryModelCenterScreen from './AuxiliaryModelCenterScreen';
import AuxiliaryModelPoolScreen from './AuxiliaryModelPoolScreen';
import AuxiliaryModelEditScreen from './AuxiliaryModelEditScreen';
import SpeechModelEditScreen from './SpeechModelEditScreen';
import TranslationModelEditScreen from './TranslationModelEditScreen';
import { CAPABILITY_KINDS, type AuxiliaryModelConfig, type CapabilityKind, type UpdateAuxiliaryModelConfigInput } from '../../domain/AuxiliaryModel';
import { deleteAuxiliaryModelConfig, listAuxiliaryModelConfigs, createAuxiliaryModelConfig, updateAuxiliaryModelConfig } from '../../ManageAuxiliaryModelConfigs';
import { testAuxiliaryModelConnection } from '../../TestAuxiliaryModelConnection';
import { CAPABILITY_META } from './constants';
import type { AuxiliaryModelFormData, CapabilityEntryItem } from './types';

export type AuxiliaryModelRoute =
  | { screen: 'center' }
  | { screen: 'services' }
  | { screen: 'service-edit'; serviceId?: string }
  | { screen: 'pool'; kind: CapabilityKind }
  | { screen: 'edit'; capabilityKind: CapabilityKind; modelId?: string };
function getErrorMessage(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }
interface Props {
  onBack(): void;
  route: AuxiliaryModelRoute;
  onNavigate(route: AuxiliaryModelRoute): void;
  refreshRevision?: number;
}
export default function AuxiliaryModelNavigator({ onBack, route, onNavigate, refreshRevision = 0 }: Props) {
  const [modelConfigs, setModelConfigs] = useState<AuxiliaryModelConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingModel, setSavingModel] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const mountedRef = useRef(false);
  const loadRequest = useRef({ revision: 0 });
  const previousRefreshRevisionRef = useRef(refreshRevision);
  const loadData = useCallback(async (showLoading = true) => {
    const revision = ++loadRequest.current.revision;
    if (showLoading) setLoading(true);
    try {
      const configs = await listAuxiliaryModelConfigs();
      if (canCommitPresentationLoad(mountedRef.current, loadRequest.current.revision, revision)) setModelConfigs(configs);
    } catch (error) {
      if (canCommitPresentationLoad(mountedRef.current, loadRequest.current.revision, revision)) showAppDialog({ title: '加载失败', message: getErrorMessage(error, '无法读取辅助模型配置。'), tone: 'error' });
    } finally {
      if (showLoading && canCommitPresentationLoad(mountedRef.current, loadRequest.current.revision, revision)) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    const request = loadRequest.current;
    void loadData();
    return () => { mountedRef.current = false; request.revision++; };
  }, [loadData]);
  useEffect(() => {
    if (previousRefreshRevisionRef.current === refreshRevision) return;
    previousRefreshRevisionRef.current = refreshRevision;
    void loadData(false);
  }, [loadData, refreshRevision]);
  const modelConfigMap = useMemo(() => new Map(modelConfigs.map((config) => [config.id, config])), [modelConfigs]);
  const capabilityItems = useMemo<CapabilityEntryItem[]>(() => CAPABILITY_KINDS.map((kind) => ({ kind, ...CAPABILITY_META[kind] })), []);
  const goCenter = useCallback(() => onNavigate({ screen: 'center' }), [onNavigate]);
  const handleBackFromEdit = useCallback(() => {
    if (route.screen === 'edit') onNavigate({ screen: 'pool', kind: route.capabilityKind });
  }, [onNavigate, route]);
  const showConnectionTestResult = useCallback((modelName: string, message: string, success: boolean) => {
    showAppDialog({ title: success ? '连接成功' : '连接失败', message: success ? `模型「${modelName}」连接正常。` : message, tone: success ? 'success' : 'error' });
  }, []);
  const handleDeleteModel = useCallback(async () => {
    if (route.screen !== 'edit' || !route.modelId) return;
    try {
      await deleteAuxiliaryModelConfig({ id: route.modelId });
      await loadData(false);
      onNavigate({ screen: 'pool', kind: route.capabilityKind });
    } catch (error) { showAppDialog({ title: '删除失败', message: getErrorMessage(error, '无法删除该模型配置。'), tone: 'error' }); }
  }, [loadData, onNavigate, route]);
  const handleCreateModel = useCallback(async (formData: AuxiliaryModelFormData) => {
    if (route.screen !== 'edit') return;
    setSavingModel(true);
    try {
      await createAuxiliaryModelConfig({ ...formData, capabilityKind: route.capabilityKind, apiKey: formData.apiKey || null });
      onNavigate({ screen: 'pool', kind: route.capabilityKind });
    } finally { setSavingModel(false); }
  }, [onNavigate, route]);
  const handleUpdateModel = useCallback(async (settings: UpdateAuxiliaryModelConfigInput) => {
    if (route.screen !== 'edit' || !route.modelId) return;
    const updated = await updateAuxiliaryModelConfig({ id: route.modelId, settings });
    setModelConfigs((configs) => configs.map((config) => config.id === updated.id ? updated : config));
  }, [route]);

  const handleTestDraftModel = useCallback(async (formData: AuxiliaryModelFormData) => {
    if (testingConnection) {
      return;
    }

    setTestingConnection(true);
    try {
      const result = await testAuxiliaryModelConnection({
        capabilityKind: route.screen === 'edit' && (route.capabilityKind === 'embedding' || route.capabilityKind === 'ocr') ? route.capabilityKind : undefined,
        baseUrl: formData.baseUrl,
        apiKey: formData.apiKey,
        model: formData.model,
        temperature: formData.temperature,
        topP: formData.topP,
        maxTokens: formData.maxTokens,
        metadataJson: formData.metadataJson,
      });

      if (result.skipped) {
        showAppDialog({ title: '提示', message: result.skipReason || '请先补全 Base URL、API Key 和模型名称。' });
        return;
      }

      if (result.success) {
        showConnectionTestResult(formData.name || formData.model, '', true);
        return;
      }

      showConnectionTestResult(
        formData.name || formData.model,
        result.errorInfo?.message || result.rawError || '连接测试失败。',
        false
      );
    } catch (error) {
      showAppDialog({ title: '连接失败', message: getErrorMessage(error, '测试连接时发生错误。'), tone: 'error' });
    } finally {
      setTestingConnection(false);
    }
  }, [route, showConnectionTestResult, testingConnection]);

  switch (route.screen) {
    case 'services':
      return <ModelServiceListScreen onBack={() => onNavigate({ screen: 'center' })} onEdit={serviceId => onNavigate({ screen: 'service-edit', serviceId })} refreshRevision={refreshRevision} />;
    case 'service-edit':
      return <ModelServiceEditScreen serviceId={route.serviceId} onBack={() => onNavigate({ screen: 'services' })} />;
    case 'center':
      return <AuxiliaryModelCenterScreen onOpenServices={() => onNavigate({ screen: 'services' })} capabilityItems={capabilityItems} loading={loading} onBack={onBack} onOpenCapabilityPool={(kind) => onNavigate({ screen: 'pool', kind })} />;
    case 'pool':
      return <AuxiliaryModelPoolScreen label={CAPABILITY_META[route.kind].label} description={CAPABILITY_META[route.kind].description}
        models={modelConfigs.filter((model) => model.capabilityKind === route.kind)} loading={loading} onBack={goCenter}
        selection={route.kind === 'translation' ? <TranslationModelPicker /> : route.kind === 'stt' ? <SpeechRecognitionModelPicker /> : undefined}
        onAddModel={() => onNavigate({ screen: 'edit', capabilityKind: route.kind })}
        onEditModel={(id) => onNavigate({ screen: 'edit', capabilityKind: route.kind, modelId: id })} />;
    case 'edit':
      if (route.modelId && !modelConfigMap.has(route.modelId)) {
        return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          {loading ? <ActivityIndicator /> : <><Text>模型不存在或读取失败。</Text><Button title="返回" onPress={handleBackFromEdit} /></>}
        </View>;
      }
      if (route.capabilityKind === 'stt' || route.capabilityKind === 'tts') return <SpeechModelEditScreen key={`${route.capabilityKind}:${route.modelId ?? 'new'}`} kind={route.capabilityKind}
        modelId={route.modelId} initialData={route.modelId ? modelConfigMap.get(route.modelId)! : null} saving={savingModel}
        onSave={handleUpdateModel} onCreate={handleCreateModel} onDelete={route.modelId ? handleDeleteModel : undefined} onBack={handleBackFromEdit} />;
      if (route.capabilityKind === 'translation') return <TranslationModelEditScreen key={`translation:${route.modelId ?? 'new'}`}
        modelId={route.modelId} initialData={route.modelId ? modelConfigMap.get(route.modelId)! : null} saving={savingModel}
        onSave={handleUpdateModel} onCreate={handleCreateModel} onDelete={route.modelId ? handleDeleteModel : undefined} onBack={handleBackFromEdit} />;
      return <AuxiliaryModelEditScreen key={`${route.capabilityKind}:${route.modelId ?? 'new'}`} capabilityKind={route.capabilityKind} capabilityLabel={CAPABILITY_META[route.capabilityKind].label}
        modelId={route.modelId} initialData={route.modelId ? modelConfigMap.get(route.modelId) ?? null : null}
        saving={savingModel} testing={testingConnection} onBack={handleBackFromEdit} onSave={handleUpdateModel} onCreate={handleCreateModel}
        onTest={handleTestDraftModel} onDelete={route.modelId ? handleDeleteModel : undefined} />;
  }
}
