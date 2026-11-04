/** 表情包分组管理：创建、重命名、删除分组。 */

import React, { useCallback, useEffect, useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ThemedSurface, useTheme } from '@shared/theme';
import { ModalSheet, showAppDialog } from '@shared/ui';
import {
  createStickerGroup,
  deleteStickerGroup,
  renameStickerGroup,
} from '../../application/StickerCommands';
import { listStickerGroups, listStickerGroupsForAI } from '../../application/StickerQueries';
import type { StickerGroup } from '../../domain/Sticker';
import { useStickerSystemStyles } from './styles';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function StickerSystemGroupsScreen() {
  const styles = useStickerSystemStyles();
  const theme = useTheme();
  const [groups, setGroups] = useState<StickerGroup[]>([]);
  const [readyCounts, setReadyCounts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [renaming, setRenaming] = useState<StickerGroup | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const reload = useCallback(async () => {
    // 分组管理展示全部分组（含空分组）；ready 数量只用于展示。
    const [allGroups, readySummaries] = await Promise.all([
      listStickerGroups(),
      listStickerGroupsForAI(),
    ]);
    setGroups(allGroups);
    setReadyCounts(new Map(readySummaries.map((item) => [item.groupId, item.stickerCount])));
  }, []);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    reload().catch((error) => {
      showAppDialog({ title: '加载失败', message: getErrorMessage(error), tone: 'error' });
    }).finally(() => {
      if (mounted) setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, [reload]);

  const handleCreate = useCallback(async () => {
    try {
      await createStickerGroup({ name: draftName });
      setCreating(false);
      setDraftName('');
      await reload();
    } catch (error) {
      showAppDialog({ title: '创建失败', message: getErrorMessage(error), tone: 'error' });
    }
  }, [draftName, reload]);

  const handleRename = useCallback(async () => {
    if (!renaming) return;
    try {
      await renameStickerGroup(renaming.id, renameDraft);
      setRenaming(null);
      await reload();
    } catch (error) {
      showAppDialog({ title: '重命名失败', message: getErrorMessage(error), tone: 'error' });
    }
  }, [reload, renameDraft, renaming]);

  const handleDelete = useCallback((group: StickerGroup) => {
    showAppDialog({
      title: '删除分组',
      message: `删除「${group.name}」后，组内表情包会回到未分组。继续吗？`,
      buttons: [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            deleteStickerGroup(group.id).then(reload).catch((error) => {
              showAppDialog({ title: '删除失败', message: getErrorMessage(error), tone: 'error' });
            });
          },
        },
      ],
    });
  }, [reload]);

  return (
    <View style={styles.container}>
      {loading ? (
        <Text style={styles.stateText}>正在加载…</Text>
      ) : (
        <View style={{ marginTop: theme.spacing.sm }}>
          <ThemedSurface variant="card" style={styles.card}>
            {groups.length === 0 ? (
              <Text style={styles.stateText}>还没有包含可用表情包的分组。</Text>
            ) : (
              groups.map((group, index) => (
                <View
                  key={group.id}
                  style={[styles.row, index === groups.length - 1 && styles.rowLast]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle}>{group.name}</Text>
                    <Text style={styles.rowSubtitle}>
                      {readyCounts.get(group.id) ?? 0} 张可用表情包
                    </Text>
                  </View>
                  <View style={styles.rowRight}>
                    <TouchableOpacity
                      accessibilityLabel="重命名分组"
                      style={styles.rowIconButton}
                      onPress={() => {
                        setRenaming(group);
                        setRenameDraft(group.name);
                      }}
                    >
                      <Ionicons
                        name="create-outline"
                        size={20}
                        color={theme.colors.text.secondary}
                      />
                    </TouchableOpacity>
                    <TouchableOpacity
                      accessibilityLabel="删除分组"
                      style={styles.rowIconButton}
                      onPress={() => handleDelete(group)}
                    >
                      <Ionicons name="trash-outline" size={20} color={theme.colors.text.secondary} />
                    </TouchableOpacity>
                  </View>
                </View>
              ))
            )}
          </ThemedSurface>

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => {
                setDraftName('');
                setCreating(true);
              }}
            >
              <Text style={styles.actionButtonText}>新建分组</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <ModalSheet
        visible={creating || renaming !== null}
        onClose={() => {
          setCreating(false);
          setRenaming(null);
        }}
        title={creating ? '新建分组' : '重命名分组'}
      >
        <Text style={styles.formLabel}>分组名称</Text>
        <TextInput
          style={styles.input}
          value={creating ? draftName : renameDraft}
          onChangeText={creating ? setDraftName : setRenameDraft}
          placeholder="不超过 80 个字符"
          placeholderTextColor={theme.colors.text.tertiary}
        />
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => {
              setCreating(false);
              setRenaming(null);
            }}
          >
            <Text style={styles.actionButtonText}>取消</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => void (creating ? handleCreate() : handleRename())}
          >
            <Text style={styles.actionButtonText}>保存</Text>
          </TouchableOpacity>
        </View>
      </ModalSheet>
    </View>
  );
}
