/** MCP 私有多选：配置页与列表共用，不绑定群聊的成员规则。 */
import { getAssistantDisplayName } from '@features/assistants';
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Check, ChevronDown, ChevronUp, Square } from 'lucide-react-native';
import type { AIAssistantSummary } from '@features/assistants';
import { AIAvatar } from '@shared/ui';
import { useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  container: { paddingVertical: 8 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36 },
  label: { fontSize: 13, color: theme.colors.text.secondary },
  summary: { flex: 1, fontSize: 13, color: theme.colors.text.tertiary, textAlign: 'right' },
  options: { marginTop: 8 },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10,
  },
  checkbox: {
    width: 20, height: 20, borderRadius: 5, alignItems: 'center', justifyContent: 'center',
  },
  selected: { backgroundColor: theme.colors.brand.primary },
  disabled: { opacity: 0.5 },
  name: { flex: 1, fontSize: 14, color: theme.colors.text.primary },
  hint: { fontSize: 12, color: theme.colors.text.tertiary, marginTop: 8 },
});

interface Props {
  assistants: readonly AIAssistantSummary[];
  selectedIds: readonly string[];
  disabled: boolean;
  required?: boolean;
  collapsible?: boolean;
  onToggle: (assistantId: string, enabled: boolean) => void;
}

export default function McpAssistantSelection({ assistants, selectedIds, disabled, required = false, collapsible = false, onToggle }: Props) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const [selectionExpanded, setSelectionExpanded] = useState(false);
  const expanded = !collapsible || selectionExpanded;
  const selectedNames = assistants.filter((assistant) => selectedIds.includes(assistant.id)).map((assistant) => getAssistantDisplayName(assistant));
  const summary = selectedNames.length === 0 ? '未选择' : selectedNames.join('、');
  const Chevron = expanded ? ChevronUp : ChevronDown;
  return (
    <View style={styles.container}>
      {collapsible ? (
        <TouchableOpacity style={styles.header} accessibilityRole="button"
          accessibilityLabel={`生效 AI${required ? '（必选）' : ''}：${summary}`} accessibilityState={{ expanded }}
          onPress={() => setSelectionExpanded((current) => !current)} activeOpacity={0.7}>
          <Text style={styles.label}>生效 AI{required ? '（必选）' : ''}</Text>
          <Text style={styles.summary} numberOfLines={1}>{summary}</Text>
          <Chevron size={16} color={theme.colors.text.tertiary} />
        </TouchableOpacity>
      ) : <Text style={styles.label}>生效 AI{required ? '（必选，可多选）' : '（可多选）'}</Text>}
      {expanded && (
        <>
          <View style={styles.options}>
            {assistants.map((assistant) => {
              const selected = selectedIds.includes(assistant.id);
              return (
                <TouchableOpacity key={assistant.id} accessibilityRole="checkbox"
                  accessibilityLabel={getAssistantDisplayName(assistant)} accessibilityState={{ checked: selected, disabled }}
                  style={[styles.option, disabled && styles.disabled]}
                  disabled={disabled} onPress={() => onToggle(assistant.id, !selected)} activeOpacity={0.7}>
                  <AIAvatar name={getAssistantDisplayName(assistant)} avatarUrl={assistant.avatar} size="small" />
                  <Text style={styles.name} numberOfLines={1}>{getAssistantDisplayName(assistant)}</Text>
                  <View style={[styles.checkbox, selected && styles.selected]}>
                    {selected ? <Check size={14} color={theme.colors.brand.onPrimary} />
                      : <Square size={20} color={theme.colors.text.tertiary} />}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={styles.hint}>
            {assistants.length === 0 ? '暂无 AI，请先添加 AI 助手。'
              : selectedIds.length === 0 ? (required ? '请至少选择一位 AI 后测试连接。' : '未选择生效对象，任何 AI 都不会注入此服务。')
                : '仅所选 AI 可注入并使用此服务。'}
          </Text>
        </>
      )}
    </View>
  );
}
