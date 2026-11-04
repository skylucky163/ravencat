import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react-native';
import { useTheme, useThemedStyles } from '@shared/theme';
import { showAppDialog } from '@shared/ui';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { removeChatBubblePreset, selectChatBubblePreset } from '../application/ChatBubbleSkinRuntime';
import type { BubbleSkinRole } from '../domain/ChatBubbleSkin';
import { useChatBubbleSkins } from './useChatBubbleSkins';
import { createBubbleSkinSettingsStyles } from './ChatBubbleSkinSettings.styles';

export function ChatBubbleSkinSettings({ onBack, onEdit }: {
  onBack(): void; onEdit(role: BubbleSkinRole, presetId: string | null): void;
}) {
  const styles = useThemedStyles(createBubbleSkinSettingsStyles);
  const theme = useTheme();
  const state = useChatBubbleSkins();
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState({ user: true, ai: true });
  async function action(task: () => Promise<void>) {
    setBusy(true);
    try { await task(); } catch (error) {
      showAppDialog({ title: '气泡设置失败', message: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(false); }
  }
  const disabled = busy || !!state.error;
  return <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
    <NavigationHeader title="气泡编辑" onGoBack={onBack} />
    <ScrollView contentContainerStyle={styles.content}>
      {state.error && <Text style={styles.error}>{state.error}</Text>}
      {(['user', 'ai'] as const).map(role => <View key={role} style={styles.group}>
        <Pressable style={styles.heading} accessibilityRole="button" accessibilityLabel={role === 'user' ? '我的气泡组合' : 'AI 的气泡组合'}
          accessibilityState={{ expanded: expanded[role] }} onPress={() => setExpanded(before => ({ ...before, [role]: !before[role] }))}>
          <Text style={styles.title}>{role === 'user' ? '我的气泡组合' : 'AI 的气泡组合'}</Text>
          <ChevronRight size={20} color={theme.colors.text.secondary}
            style={{ transform: [{ rotate: expanded[role] ? '90deg' : '0deg' }] }} />
        </Pressable>
        {expanded[role] && <View style={styles.items}>
          <Pressable style={styles.selection} disabled={disabled} accessibilityRole="button" accessibilityLabel={`${role === 'user' ? '我的' : 'AI 的'}默认气泡`}
            accessibilityState={{ selected: state[role] === null, disabled }}
            onPress={() => { void action(() => selectChatBubblePreset(role, null)); }}>
            <Text style={[styles.name, state[role] === null && styles.selected]}>默认</Text>
          </Pressable>
          {state.presets.filter(preset => preset.role === role).map(preset => {
            const selected = state[role]?.id === preset.id;
            return <View key={preset.id} style={styles.item}>
              <Pressable style={styles.selection} disabled={disabled} accessibilityRole="button" accessibilityLabel={`使用${preset.name}`}
                accessibilityState={{ selected, disabled }} onPress={() => { void action(() => selectChatBubblePreset(role, preset.id)); }}>
                <Text style={[styles.name, selected && styles.selected]} numberOfLines={1}>{preset.name}</Text>
              </Pressable>
              <Pressable style={styles.iconButton} disabled={disabled} accessibilityRole="button" accessibilityLabel={`编辑${preset.name}`}
                onPress={() => onEdit(role, preset.id)}><Pencil size={18} color={selected ? theme.colors.brand.primary : theme.colors.text.secondary} /></Pressable>
              <Pressable style={styles.iconButton} disabled={disabled} accessibilityRole="button" accessibilityLabel={`删除${preset.name}`}
                onPress={() => showAppDialog({ title: '删除气泡组合？', message: '删除后无法恢复。正在使用它的这一侧将恢复默认。',
                  buttons: [{ text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive',
                    onPress: () => { void action(() => removeChatBubblePreset(preset.id)); } }] })}>
                <Trash2 size={18} color={selected ? theme.colors.brand.primary : theme.colors.text.secondary} />
              </Pressable>
            </View>;
          })}
          {state[role]?.error && <Text style={styles.error}>{state[role].error}</Text>}
          <Pressable style={styles.add} disabled={disabled} accessibilityRole="button" accessibilityLabel={`新建${role === 'user' ? '我的' : 'AI 的'}气泡组合`}
            onPress={() => onEdit(role, null)}>
            <Plus size={18} color={theme.colors.brand.primary} /><Text style={styles.selected}>新建组合</Text>
          </Pressable>
        </View>}
      </View>)}
    </ScrollView>
  </SafeAreaView>;
}
