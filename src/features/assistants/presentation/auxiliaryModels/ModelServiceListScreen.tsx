/** 服务列表是管理入口，模型选择弹窗不承载管理跳转。 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ThemedSurface, useTheme } from '@shared/theme';
import { Button, EmptyState, HeaderAddButton, ListItem, NavigationHeader, ToggleField, showAppDialog } from '@shared/ui';
import { getAutoSaveServiceConfigs, listModelServiceConfigs, setAutoSaveServiceConfigs, type ModelServiceConfig } from '../../ModelServices';

export default function ModelServiceListScreen({ onBack, onEdit, refreshRevision }: {
  onBack(): void; onEdit(id?: string): void; refreshRevision: number;
}) {
  const theme = useTheme();
  const [services, setServices] = useState<ModelServiceConfig[]>([]);
  const [autoSave, setAutoSave] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try { const [items, enabled] = await Promise.all([listModelServiceConfigs(), getAutoSaveServiceConfigs()]); setServices(items); setAutoSave(enabled); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '读取服务配置失败'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload, refreshRevision]);
  const toggle = async (enabled: boolean) => {
    setSaving(true);
    try { await setAutoSaveServiceConfigs(enabled); setAutoSave(enabled); }
    catch { showAppDialog({ title: '保存失败', message: '未能更新自动保存设置', tone: 'error' }); }
    finally { setSaving(false); }
  };
  return <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background.app }} edges={['top', 'left', 'right']}>
    <NavigationHeader title="服务配置" onGoBack={onBack}
      rightButton={<HeaderAddButton accessibilityLabel="新增服务配置" onPress={() => onEdit()} />} />
    <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}>
      <ThemedSurface variant="card" style={{ borderRadius: theme.radius.lg, paddingHorizontal: theme.spacing.md }}>
        <ToggleField label="自动保存服务配置" hint="模型配置保存时自动收录新连接，相同连接直接复用。" value={autoSave} disabled={loading || saving} onValueChange={value => { void toggle(value); }} />
      </ThemedSurface>
      {loading ? <ActivityIndicator color={theme.colors.brand.primary} /> : error ? <EmptyState title="读取失败" description={error} />
        : services.length === 0 ? <EmptyState title="暂无服务配置" description="点击右上角新增，或在保存模型时自动收录。" />
          : <ThemedSurface variant="card" style={{ borderRadius: theme.radius.lg, overflow: 'hidden' }}>
            {services.map(service => <ListItem key={service.id} title={service.name} subtitle={service.baseUrl} showArrow onPress={() => onEdit(service.id)} />)}
          </ThemedSurface>}
      {error && <View><Button title="重新读取" variant="text" onPress={() => { void reload(); }} /></View>}
    </ScrollView>
  </SafeAreaView>;
}
