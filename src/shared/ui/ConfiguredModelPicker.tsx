/** 通用模型选择展示；选择与可用性由调用方所属业务系统提供。 */
import { showAppDialog } from './appDialogStore';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { ThemedSurface, useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import ModelPickerModal from './ModelPickerModal';
import type { ModelSelectionSettings } from './modelSelectionTypes';

interface Props {
  title: string;
  /** 只在选择弹窗内需要解释时提供；页面顶部已有说明时留空，弹窗不显示问号。 */
  description?: string;
  unconfiguredLabel?: string;
  clearSelectionLabel?: string;
  getSettings(): Promise<ModelSelectionSettings>;
  onSelect(modelConfigId: string | null): Promise<void>;
  subscribeChanged(listener: () => void): () => void;
  disabled?: boolean;
}

export default function ConfiguredModelPicker({ title, description, unconfiguredLabel = '未选择模型', clearSelectionLabel = '取消选择', getSettings, onSelect, subscribeChanged, disabled = false }: Props) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const [settings, setSettings] = useState<ModelSelectionSettings | null>(null);
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef({ revision: 0 });
  const selection = useRef({ active: false, changed: false });
  const reload = useCallback(async () => {
    const revision = ++request.current.revision;
    setLoading(true);
    try {
      const next = await getSettings();
      if (revision === request.current.revision) { setSettings(next); setError(null); }
    } catch (failure) {
      if (revision === request.current.revision) setError(failure instanceof Error ? failure.message : '读取模型选择失败');
    } finally {
      if (revision === request.current.revision) setLoading(false);
    }
  }, [getSettings]);
  useEffect(() => {
    void reload();
    const requests = request.current;
    const unsubscribe = subscribeChanged(() => {
      // 选择期间的通知由随后一次显式刷新覆盖；失败时补读，避免重复请求。
      if (selection.current.active) { selection.current.changed = true; return; }
      void reload();
    });
    return () => { unsubscribe(); requests.revision++; };
  }, [reload, subscribeChanged]);

  const select = async (modelConfigId: string | null) => {
    setSaving(true);
    selection.current = { active: true, changed: false };
    let refreshed = false;
    try {
      await onSelect(modelConfigId);
      await reload();
      refreshed = true;
      setVisible(false);
    } catch (failure) {
      showAppDialog({ title: '选择失败', message: failure instanceof Error ? failure.message : '保存模型选择失败', tone: 'error' });
    } finally {
      const shouldReload = !refreshed && selection.current.changed;
      selection.current.active = false;
      if (shouldReload) void reload();
      setSaving(false);
    }
  };
  const selectionLabel = settings?.status === 'active' ? `${settings.selectedModelName} · 配置可用`
    : settings?.status === 'unavailable' ? `${settings.selectedModelName ?? '所选模型'} · ${settings.unavailableReason}`
      : settings ? unconfiguredLabel : '无法读取当前选择';
  return <>
    <ThemedSurface variant="card" style={styles.card}>
      <Pressable accessibilityRole="button" accessibilityLabel={`选择${title}`} disabled={disabled || saving} style={styles.button} onPress={() => { setVisible(true); void reload(); }}>
        <View style={styles.row}>
          <View style={styles.grow}><Text style={styles.label}>{title}</Text><Text style={styles.subtitle}>{loading && !settings ? '正在读取…' : selectionLabel}</Text></View>
          <ChevronRight size={20} color={theme.colors.text.tertiary} />
        </View>
        {error && <Text style={styles.danger}>{error}</Text>}
      </Pressable>
    </ThemedSurface>
    <ModelPickerModal visible={visible} onClose={() => setVisible(false)} title={`选择${title}`}
      description={description} models={settings?.models ?? []} selectedModel={settings?.selectedModelId}
      loading={loading} error={error} disabled={disabled || saving} onRetry={() => { void reload(); }}
      onSelect={id => { void select(id); }} onClear={settings ? () => { void select(null); } : undefined}
      clearSelectionLabel={clearSelectionLabel} />
  </>;
}

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  // 玻璃材质和边框归主题表面拥有，普通主题保留原有卡片轮廓。
  card: { marginVertical: theme.spacing.sm, borderRadius: theme.radius.lg, overflow: 'hidden',
    ...(!theme.effects.glass.enabled ? { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border.light } : {}) },
  button: { padding: theme.spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  grow: { flex: 1 },
  label: { fontSize: 16, fontWeight: '600', color: theme.colors.text.primary },
  subtitle: { fontSize: 13, lineHeight: 20, marginTop: theme.spacing.xs, color: theme.colors.text.secondary },
  danger: { fontSize: 13, color: theme.colors.feedback.error },
});
