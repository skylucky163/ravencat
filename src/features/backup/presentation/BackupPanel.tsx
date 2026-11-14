import { showAppDialog } from '@shared/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { FolderOpen, HardDriveDownload, Trash2 } from 'lucide-react-native';

import { ThemedSurface, useTheme, useWallpaper } from '@shared/theme';
import NavigationHeaderHelp from '@shared/ui/NavigationHeaderHelp';
import { BACKUP_TARGET_CATALOG } from '../application/BackupTargetCatalog';
import type { BackupRuntime } from '../application/BackupRuntime';
import type { BackupArtifactHandle, BackupArtifactSummary } from '../domain/BackupTarget';
import { BackupRestoreModal } from './BackupRestoreModal';
import { createBackupPanelStyles } from './BackupPanel.styles';

interface BackupPanelProps {
  runtime: BackupRuntime;
  disabled: boolean;
  onBusyChange(busy: boolean): void;
}

export function BackupHelp() {
  return <NavigationHeaderHelp title="备份与恢复" sections={[{
    title: '完整本地备份',
    body: '备份包含消息、图片、文件、数据库配置、联网搜索 Key、MCP Token，以及 AI 请求诊断的开关和最近 10 条完整记录，无需密码。模型 API Key、联网搜索 Key、MCP Token 等凭据以明文保存，诊断记录可能包含私密聊天和提示词，请妥善保管备份文件。',
  }]} />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type RestoreCandidate =
  | { kind: 'local'; artifactId: string; fileName: string }
  | { kind: 'external'; artifact: BackupArtifactHandle; fileName: string };

export function BackupPanel({ runtime, disabled, onBusyChange }: BackupPanelProps) {
  const theme = useTheme();
  const { refreshWallpapers } = useWallpaper();
  const styles = useMemo(() => createBackupPanelStyles(theme), [theme]);
  const localTarget = BACKUP_TARGET_CATALOG[0];
  const [isCreating, setIsCreating] = useState(false);
  const [backups, setBackups] = useState<BackupArtifactSummary[]>([]);
  const [restoreCandidate, setRestoreCandidate] = useState<RestoreCandidate | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const operationBusy = isCreating || isRestoring || isSelecting || isClearing || deletingId !== null;
  const isBusy = disabled || operationBusy;

  // 备份与清空现在处于同一页面，由页面互斥它们的操作入口。
  useEffect(() => { onBusyChange(operationBusy); }, [onBusyChange, operationBusy]);

  const refreshBackups = useCallback(async () => {
    try {
      setBackups(await runtime.listLocalBackups());
    } catch (error) {
      showAppDialog({ title: '无法读取备份列表', message: error instanceof Error ? error.message : '未知错误' });
    }
  }, [runtime]);

  useEffect(() => {
    void refreshBackups();
  }, [refreshBackups]);

  const createBackup = useCallback(async () => {
    setIsCreating(true);
    try {
      await runtime.createLocalBackup();
      await refreshBackups();
      showAppDialog({ title: '备份完成', message: '备份已保存到 下载 / RavenCat。' });
    } catch (error) {
      console.error('[Backup] 创建完整备份失败：', error);
      showAppDialog({ title: '备份失败', message: error instanceof Error ? error.message : '未知错误', tone: 'error' });
    } finally {
      setIsCreating(false);
    }
  }, [refreshBackups, runtime]);

  const clearCachedSelections = useCallback(() => {
    showAppDialog({
      title: '清除旧缓存图片选择',
      message: '仍使用临时缓存图片的旧通话背景、壁纸和时刻封面将恢复默认，包括缓存中仍可读取的图片。已保存到长期存储的图片、聊天记录和文件会保留。确定清除吗？',
      buttons: [
        { text: '取消', style: 'cancel' },
        { text: '清除选择', style: 'destructive', onPress: async () => {
          setIsClearing(true);
          try {
            const result = await runtime.clearLegacyCachedImageSelections();
            await refreshWallpapers();
            const count = Number(result.callBackground) + result.wallpapers + Number(result.momentsCover);
            showAppDialog({
              title: count > 0 ? '清除完成' : '没有旧缓存图片选择',
              message: count > 0
                ? `旧通话背景：${result.callBackground ? '已清除' : '无需清除'}\n壁纸：清除 ${result.wallpapers} 项\n时刻封面：${result.momentsCover ? '已清除' : '无需清除'}\n\n现在可以再次创建备份，也可以重新选择图片。`
                : '没有找到需要清除的旧缓存图片选择。如果备份仍失败，请查看具体错误。',
            });
          } catch (error) {
            showAppDialog({ title: '清除未全部完成', message: `已完成的清除会保留，可再次执行。\n${error instanceof Error ? error.message : '未知错误'}`, tone: 'error' });
          } finally {
            setIsClearing(false);
          }
        } },
      ],
    });
  }, [refreshWallpapers, runtime]);

  const deleteBackup = useCallback((backup: BackupArtifactSummary) => {
    showAppDialog({ title: '删除备份', message: `确定删除 ${backup.fileName}？当前应用数据不会受影响。`, buttons: [
      { text: '取消', style: 'cancel' },
      {
        text: '删除', style: 'destructive', onPress: () => {
          setDeletingId(backup.artifactId);
          void runtime.deleteLocalBackup(backup.artifactId)
            .then(refreshBackups)
            .catch((error: unknown) => {
              showAppDialog({ title: '删除失败', message: error instanceof Error ? error.message : '未知错误', tone: 'error' });
            })
            .finally(() => setDeletingId(null));
        },
      },
    ] });
  }, [refreshBackups, runtime]);

  const pickExternalBackup = useCallback(async () => {
    setIsSelecting(true);
    try {
      const artifact = await runtime.pickExternalBackup();
      if (artifact) setRestoreCandidate({
        kind: 'external', artifact, fileName: artifact.fileName,
      });
    } catch (error) {
      showAppDialog({ title: '无法打开备份', message: error instanceof Error ? error.message : '未知错误' });
    } finally {
      setIsSelecting(false);
    }
  }, [runtime]);

  const restoreBackup = useCallback(async () => {
    if (!restoreCandidate) return;
    setIsRestoring(true);
    try {
      if (restoreCandidate.kind === 'local') {
        await runtime.restoreLocalBackup(restoreCandidate.artifactId);
      } else {
        await runtime.restoreExternalBackup(restoreCandidate.artifact);
      }
    } catch (error) {
      setIsRestoring(false);
      showAppDialog({ title: '恢复失败', message: error instanceof Error ? error.message : '未知错误', tone: 'error' });
    }
  }, [restoreCandidate, runtime]);

  return (
    <>
      <View style={styles.content}>
        <ThemedSurface variant="card" style={styles.targetCard}>
          <View style={styles.targetHeader}>
            <View style={styles.targetIcon}>
              <HardDriveDownload color={theme.colors.brand.primary} size={22} />
            </View>
            <View style={styles.targetTextBlock}>
              <View style={styles.targetTitleRow}>
                <Text style={styles.targetTitle}>{localTarget.title}</Text>
              </View>
              <Text style={styles.targetDescription}>{localTarget.description}</Text>
            </View>
          </View>
          <Pressable
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.primaryButtonPressed,
              isBusy && styles.primaryButtonDisabled,
            ]}
            onPress={() => void createBackup()}
            disabled={isBusy}
          >
            {isCreating ? (
              <ActivityIndicator color={theme.colors.text.inverse} />
            ) : (
              <Text style={styles.primaryButtonText}>创建备份</Text>
            )}
          </Pressable>
        </ThemedSurface>

        <Text style={styles.sectionTitle}>已有备份</Text>
        <ThemedSurface variant="card" style={styles.targetCard}>
          {backups.length === 0 ? (
            <Text style={styles.emptyText}>下载 / RavenCat 中还没有备份。</Text>
          ) : backups.map((backup) => (
            <View key={backup.artifactId} style={styles.backupRow}>
              <View style={styles.backupTextBlock}>
                <Text style={styles.backupName} numberOfLines={1}>{backup.fileName}</Text>
                <Text style={styles.backupMeta}>
                  {new Date(backup.createdAt).toLocaleString()} · {formatBytes(backup.byteLength)}
                </Text>
              </View>
              <Pressable
                style={styles.restoreButton}
                disabled={isBusy}
                onPress={() => setRestoreCandidate({
                  kind: 'local', artifactId: backup.artifactId, fileName: backup.fileName,
                })}
              >
                <Text style={styles.restoreButtonText}>恢复</Text>
              </Pressable>
              <Pressable
                style={styles.deleteButton}
                accessibilityLabel={`删除备份 ${backup.fileName}`}
                disabled={isBusy}
                onPress={() => deleteBackup(backup)}
              >
                {deletingId === backup.artifactId
                  ? <ActivityIndicator size="small" color={theme.colors.feedback.error} />
                  : <Trash2 size={18} color={theme.colors.feedback.error} />}
              </Pressable>
            </View>
          ))}
          <Pressable style={styles.externalButton} disabled={isBusy} onPress={() => void pickExternalBackup()}>
            <FolderOpen color={theme.colors.text.secondary} size={17} />
            <Text style={styles.externalButtonText}>选择外部备份包</Text>
          </Pressable>
        </ThemedSurface>

        <Text style={styles.sectionTitle}>备份修复</Text>
        <ThemedSurface variant="card" style={styles.targetCard}>
          <Text style={styles.targetTitle}>清除旧缓存图片选择</Text>
          <Text style={styles.targetDescription}>
            旧版背景或封面可能仍引用临时缓存图片，导致备份失败。清除这些选择后恢复默认，再尝试备份。
          </Text>
          <Pressable
            style={[styles.externalButton, isBusy && styles.primaryButtonDisabled]}
            disabled={isBusy}
            onPress={clearCachedSelections}
          >
            {isClearing
              ? <ActivityIndicator size="small" color={theme.colors.text.secondary} />
              : <Trash2 size={17} color={theme.colors.text.secondary} />}
            <Text style={styles.externalButtonText}>{isClearing ? '正在清除…' : '清除旧缓存图片选择'}</Text>
          </Pressable>
        </ThemedSurface>

      </View>
      <BackupRestoreModal
        key={restoreCandidate?.fileName ?? 'closed'}
        fileName={restoreCandidate?.fileName ?? null}
        isRestoring={isRestoring}
        onCancel={() => setRestoreCandidate(null)}
        onRestore={() => void restoreBackup()}
      />
    </>
  );
}
