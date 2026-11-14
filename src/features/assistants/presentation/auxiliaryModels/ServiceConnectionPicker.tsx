/** 连接与快捷填 Key 共用配置折叠列表；只有具体 Key 可选。 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { Check, ChevronDown, ChevronRight, Plus } from 'lucide-react-native';
import { ThemedSurface, useTheme } from '@shared/theme';
import { Button, ModalSheet, showAppDialog } from '@shared/ui';
import { subscribeAuxiliaryModelsChanged } from '../../AuxiliaryModelsChanged';
import { getModelServiceConfig, listModelServiceGroupConfigs, type ModelServiceConfig, type ModelServiceConnection, type ModelServiceGroup } from '../../ModelServices';

function matchingAddress(left: string, right: string): boolean {
  return left.trim().replace(/\/+$/, '') === right.trim().replace(/\/+$/, '');
}

export default function ServiceConnectionPicker({ baseUrl, apiKey, serviceConfigId, authType = 'apiKey', mode = 'connection', onFill, disabled = false }: {
  baseUrl: string; apiKey: string; serviceConfigId?: string | null;
  mode?: 'connection' | 'key';
  authType?: ModelServiceConnection['authType']; onFill(service: ModelServiceConfig): void; disabled?: boolean;
}) {
  const theme = useTheme();
  const keyOnly = mode === 'key';
  const triggerDisabled = disabled || (keyOnly && !baseUrl.trim());
  const [visible, setVisible] = useState(false), [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<ModelServiceGroup[]>([]), [error, setError] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<ModelServiceConfig | null>(null);
  useEffect(() => {
    if (!serviceConfigId) { setSelected(null); return; }
    let alive = true, revision = 0;
    const load = () => {
      const current = ++revision;
      void getModelServiceConfig(serviceConfigId).then(value => { if (alive && current === revision) setSelected(value); }, () => { if (alive && current === revision) setSelected(null); });
    };
    load();
    const unsubscribe = subscribeAuxiliaryModelsChanged(load);
    return () => { alive = false; unsubscribe(); };
  }, [serviceConfigId]);
  const open = async () => {
    setVisible(true); setLoading(true); setError(null);
    try {
      const available = (await listModelServiceGroupConfigs()).filter(group => group.authType === authType && group.keys.length > 0
        && (!keyOnly || matchingAddress(group.baseUrl, baseUrl)));
      setGroups(available);
      setExpandedGroups(new Set());
    }
    catch { setError('读取服务配置失败，请重试。'); }
    finally { setLoading(false); }
  };
  const select = async (id: string) => {
    setLoading(true);
    try {
      const key = await getModelServiceConfig(id);
      // 列表打开后服务地址仍可能被编辑；凭据只能填入当前匹配的地址。
      if (keyOnly && !matchingAddress(key.baseUrl, baseUrl)) {
        setError('此 Key 的服务地址已变更，请重新读取配置。');
        return;
      }
      onFill(key); setSelected(key); setVisible(false);
    } catch { showAppDialog({ title: '选择失败', message: '此 Key 可能已被删除，请重新读取配置。', tone: 'error' }); }
    finally { setLoading(false); }
  };
  return <>
    {!keyOnly && (!baseUrl.trim() || !apiKey.trim()) && <Text style={{ color: theme.colors.text.secondary, marginBottom: theme.spacing.sm }}>未配置连接，请选择服务或手动填写地址与凭据。</Text>}
    {keyOnly ? <Pressable accessibilityRole="button" accessibilityLabel="从相同地址填入 Key" accessibilityState={{ disabled: triggerDisabled || loading }}
      disabled={triggerDisabled || loading} onPress={() => { void open(); }}
      style={({ pressed }) => ({ width: 44, height: 48, marginLeft: theme.spacing.sm, borderRadius: theme.radius.md,
        alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surface.input, opacity: triggerDisabled || pressed ? 0.5 : 1 })}>
      {loading ? <ActivityIndicator size="small" color={theme.colors.brand.primary} /> : <Plus size={20} color={theme.colors.brand.primary} />}
    </Pressable> : <Button title={selected && serviceConfigId === selected.id ? `${selected.name} · ${selected.keyName}` : '选择已有服务'}
      variant="secondary" style={{ marginBottom: theme.spacing.lg }} disabled={disabled || loading} onPress={() => { void open(); }} />}
    <ModalSheet visible={visible} title="选择模型连接" onClose={() => { if (!loading) setVisible(false); }} style={{ maxHeight: '70%' }}>
      <FlatList data={loading || error ? [] : groups} keyExtractor={group => group.id}
        contentContainerStyle={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md, paddingBottom: theme.spacing.sm }}
        ListEmptyComponent={<View style={{ padding: theme.spacing.lg, alignItems: 'center' }}>{loading
          ? <ActivityIndicator color={theme.colors.brand.primary} />
          : <><Text style={{ color: theme.colors.text.secondary }}>{error || (keyOnly ? '已有服务配置中没有相同地址的 Key，请手动填写。' : '暂无服务 Key，请先在服务配置中添加。')}</Text>
            {error && <Button title="重新读取" variant="text" onPress={() => { void open(); }} />}</>}</View>}
        renderItem={({ item: group }) => {
          const expanded = expandedGroups.has(group.id);
          return <ThemedSurface variant="card" style={{ borderRadius: theme.radius.lg, overflow: 'hidden', marginBottom: theme.spacing.md }}>
            <Pressable accessibilityRole="button" accessibilityLabel={`${group.name}，${group.baseUrl}`} accessibilityState={{ expanded }}
              onPress={() => setExpandedGroups(current => {
                const next = new Set(current);
                if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
                return next;
              })}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', minHeight: 64, padding: theme.spacing.md,
                backgroundColor: pressed ? theme.colors.brand.primary + '12' : 'transparent' })}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={2} style={{ color: theme.colors.text.primary, fontSize: 15, lineHeight: 21,
                  includeFontPadding: false, fontWeight: '600' }}>{group.name}</Text>
                <Text numberOfLines={1} ellipsizeMode="middle" style={{ marginTop: theme.spacing.xs, color: theme.colors.text.tertiary,
                  fontSize: 12, lineHeight: 18, includeFontPadding: false }}>{group.baseUrl}</Text>
              </View>
              <View style={{ width: 20, height: 20, alignItems: 'center', justifyContent: 'center', marginLeft: theme.spacing.sm }}>
                {expanded ? <ChevronDown size={18} color={theme.colors.text.secondary} /> : <ChevronRight size={18} color={theme.colors.text.secondary} />}
              </View>
            </Pressable>
            {expanded && <View style={{ borderTopWidth: 0.5, borderTopColor: theme.colors.border.light, paddingBottom: theme.spacing.xs }}>
              {group.keys.map(key => {
                const checked = keyOnly ? apiKey.trim() === key.apiKey : serviceConfigId === key.id;
                return <Pressable key={key.id} accessibilityRole="radio" accessibilityLabel={`${group.name} · ${key.keyName}`} accessibilityState={{ checked, disabled: disabled || loading }}
                  disabled={disabled || loading} onPress={() => { void select(key.id); }}
                  style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', minHeight: 64,
                    paddingVertical: theme.spacing.md, paddingLeft: theme.spacing.md + theme.spacing.sm, paddingRight: theme.spacing.md,
                    backgroundColor: checked || pressed ? theme.colors.brand.primary + '12' : 'transparent' })}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={2} style={{ color: checked ? theme.colors.brand.primary : theme.colors.text.secondary,
                      fontSize: 12, lineHeight: 18, includeFontPadding: false, fontWeight: '500' }}>{key.keyName}</Text>
                    <Text style={{ marginTop: theme.spacing.xs, color: theme.colors.text.primary, fontSize: 13, lineHeight: 20,
                      includeFontPadding: false, fontFamily: 'monospace' }}>{key.apiKey}</Text>
                  </View>
                  <View style={{ width: 20, height: 20, alignItems: 'center', justifyContent: 'center', marginLeft: theme.spacing.sm }}>
                    {checked && <Check size={18} color={theme.colors.brand.primary} />}
                  </View>
                </Pressable>;
              })}
            </View>}
          </ThemedSurface>;
        }} />
    </ModalSheet>
  </>;
}
