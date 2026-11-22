import React, { useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArchiveRestore, History, Trash2 } from 'lucide-react-native';
import { BackupPanel, BackupHelp, type BackupRuntime } from '@features/backup';
import { ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import { showAppDialog } from '@shared/ui';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { createDataManagementStyles } from './DataManagementScreen.styles';

interface Props {
  onBack(): void;
  backupRuntime: BackupRuntime;
  onClearData(): Promise<void>;
  onOpenAIRecycleBin(): void;
}

export function DataManagementScreen({ onBack, backupRuntime, onClearData, onOpenAIRecycleBin }: Props) {
  const theme = useTheme();
  const styles = useThemedStyles(createDataManagementStyles);
  const [backupBusy, setBackupBusy] = useState(false);
  const [clearing, setClearing] = useState(false);
  const busy = clearing || backupBusy;

  const confirmClear = () => showAppDialog({
    title: '清空所有数据',
    message: '将永久删除应用内的全部本地数据，包括 AI、聊天记录和设置。此操作不可恢复，建议先备份。是否继续？',
    tone: 'warning',
    buttons: [
      { text: '取消', style: 'cancel' },
      { text: '永久删除', style: 'destructive', emphasis: 'strong', onPress: async () => {
        setClearing(true);
        try { await onClearData(); }
        catch (error) {
          console.error('[数据管理] 清空失败', error);
          showAppDialog({ title: '清空失败', message: '清空数据未完整完成，请重试。', tone: 'error' });
        } finally { setClearing(false); }
      } },
    ],
  });

  return <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
    <NavigationHeader title="数据管理" onGoBack={onBack} />
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <ThemedSurface nativeGlass variant="card" style={styles.section}>
        <TouchableOpacity style={styles.row} onPress={onOpenAIRecycleBin} disabled={busy} accessibilityRole="button"
          accessibilityState={{ disabled: busy }} accessibilityLabel="AI 回收站，恢复 7 天内删除的 AI">
          <History size={20} color={theme.colors.text.primary} />
          <View style={styles.textBlock}>
            <Text style={styles.title}>AI 回收站</Text>
            <Text style={styles.description}>恢复或彻底删除 7 天内移除的 AI</Text>
          </View>
        </TouchableOpacity>
      </ThemedSurface>

      <ThemedSurface nativeGlass variant="card" style={styles.section}>
        <View style={styles.backupHeader}>
          <View style={styles.backupTitle}>
            <ArchiveRestore size={20} color={theme.colors.text.primary} />
            <Text style={styles.title} accessibilityRole="header">备份与恢复</Text>
          </View>
          <BackupHelp />
        </View>
        <BackupPanel runtime={backupRuntime} disabled={clearing} onBusyChange={setBackupBusy} />
      </ThemedSurface>

      <Text style={styles.dangerHeading}>危险操作</Text>
      <ThemedSurface nativeGlass variant="card" style={styles.section}>
        <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={confirmClear} disabled={busy}
          accessibilityRole="button" accessibilityState={{ disabled: busy, busy: clearing }}
          accessibilityLabel="清空所有数据，永久删除应用内的全部本地数据">
          <Trash2 size={20} color={theme.colors.feedback.error} />
          <View style={styles.textBlock}>
            <Text style={styles.dangerTitle}>{clearing ? '正在清空…' : '清空所有数据'}</Text>
            <Text style={styles.description}>永久删除应用内的全部本地数据</Text>
          </View>
        </TouchableOpacity>
      </ThemedSurface>
    </ScrollView>
  </SafeAreaView>;
}
