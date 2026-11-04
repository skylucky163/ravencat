// 协议空间管理界面。

import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, type ListRenderItemInfo } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { AIProfile } from '@features/assistants';
import type { Protocol } from '../domain/ProtocolRepository';
import {
  deleteProtocol,
  listProtocolsByAI,
  PROTOCOL_MAX_LENGTH,
  saveProtocol,
} from '../composition';
import NavigationHeader from '@shared/ui/NavigationHeader';
import EmptyState from '@shared/ui/EmptyState';
import ListItem from '@shared/ui/ListItem';
import { ModalSheet, useBusyBackHandler, showAppDialog } from '@shared/ui';
import { useTheme, useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import { AddIcon } from './parts/AddIcon';

interface ProtocolViewProps {
  onBack?: () => void;
  aiAssistant?: AIProfile | null;
  onConvertToMemory: (protocol: Protocol, values: { content: string; summary: string | null }) => Promise<void>;
}

const createStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background.screen,
    },
    headerBtn: {
      padding: theme.spacing.sm,
      marginRight: -theme.spacing.sm,
    },
    list: {
      flex: 1,
    },
    emptyList: {
      flex: 1,
    },
    protocolText: {
      fontSize: 15,
      color: theme.colors.text.primary,
      lineHeight: 22,
    },
    protocolTime: {
      fontSize: 12,
      color: theme.colors.text.tertiary,
      marginTop: 4,
    },
    protocolSummary: {
      fontSize: 12,
      color: theme.colors.text.secondary,
      marginTop: 4,
    },
    protocolItem: {
      paddingVertical: 16,
      paddingHorizontal: theme.spacing.lg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border.light,
    },
    modalBody: {
      flexShrink: 1,
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: 24,
    },
    modalScroll: {
      flexShrink: 1,
    },
    input: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border.default,
      borderRadius: 12,
      padding: theme.spacing.lg,
      fontSize: 15,
      color: theme.colors.text.primary,
      backgroundColor: theme.colors.surface.muted,
      minHeight: 100,
      lineHeight: 22,
    },
    summaryInput: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border.default,
      borderRadius: 12,
      padding: theme.spacing.md,
      fontSize: 15,
      color: theme.colors.text.primary,
      backgroundColor: theme.colors.surface.muted,
      marginTop: theme.spacing.md,
    },
    charCount: {
      fontSize: 12,
      color: theme.colors.text.tertiary,
      textAlign: 'right',
      marginTop: 4,
    },
    saveBtn: {
      backgroundColor: theme.colors.brand.primary,
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: theme.spacing.xl,
    },
    saveBtnText: {
      color: theme.colors.brand.onPrimary,
      fontSize: 16,
      fontWeight: '600',
    },
  });

export default function ProtocolView({ onBack, aiAssistant, onConvertToMemory }: ProtocolViewProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);

  const [protocols, setProtocols] = useState<Protocol[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingProtocol, setEditingProtocol] = useState<Protocol | null>(null);
  const [inputContent, setInputContent] = useState('');
  const [inputSummary, setInputSummary] = useState('');
  useBusyBackHandler(saving);

  const loadProtocols = useCallback(async () => {
    try {
      setLoading(true);
      if (!aiAssistant?.id) {
        setProtocols([]);
        return;
      }

      const list = await listProtocolsByAI(aiAssistant.id);
      setProtocols(list);
    } catch (error) {
      console.error('Failed to load protocols:', error);
      showAppDialog({ title: '错误', message: '加载协议失败', tone: 'error' });
    } finally {
      setLoading(false);
    }
  }, [aiAssistant?.id]);

  useEffect(() => {
    void loadProtocols();
  }, [loadProtocols]);

  const resetForm = useCallback(() => {
    setEditingProtocol(null);
    setInputContent('');
    setInputSummary('');
  }, []);

  const handleAdd = useCallback(() => {
    if (saving) return;
    resetForm();
    setModalVisible(true);
  }, [resetForm, saving]);

  const handleCloseModal = useCallback(() => {
    if (saving) {
      return;
    }

    setModalVisible(false);
    resetForm();
  }, [resetForm, saving]);

  const handleEdit = useCallback((protocol: Protocol) => {
    if (saving) return;
    setEditingProtocol(protocol);
    setInputContent(protocol.content);
    setInputSummary(protocol.summary || '');
    setModalVisible(true);
  }, [saving]);

  const handleSave = useCallback(async () => {
    if (saving) {
      return;
    }

    try {
      if (!inputContent.trim()) {
        showAppDialog({ title: '提示', message: '协议内容不能为空' });
        return;
      }

      if (!editingProtocol && !aiAssistant?.id) {
        showAppDialog({ title: '错误', message: '未选择 AI 助手，无法添加协议', tone: 'error' });
        return;
      }

      setSaving(true);
      await saveProtocol({
        protocolId: editingProtocol?.id || null,
        aiAssistantId: aiAssistant?.id || '',
        content: inputContent.trim(),
        summary: inputSummary.trim() || null,
      });

      setModalVisible(false);
      resetForm();
      await loadProtocols();
    } catch (error) {
      showAppDialog({ title: '错误', message: (error as Error).message || '保存失败', tone: 'error' });
    } finally {
      setSaving(false);
    }
  }, [
    aiAssistant?.id,
    editingProtocol,
    inputContent,
    inputSummary,
    loadProtocols,
    resetForm,
    saving,
  ]);

  const handleDelete = useCallback((protocol: Protocol) => {
    showAppDialog({ title: '删除协议', message: '确定要删除这条协议吗？', buttons: [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteProtocol(protocol.aiAssistantId, protocol.id);
            await loadProtocols();
          } catch (error) {
            console.error('Failed to delete protocol:', error);
            showAppDialog({ title: '错误', message: '删除失败', tone: 'error' });
          }
        },
      },
    ] });
  }, [loadProtocols]);

  const handleConvert = useCallback((protocol: Protocol, content: string, summary: string | null) => {
    if (saving) return;
    showAppDialog({ title: '转为记忆', message: '摘要和正文将存入当前 AI 的记忆空间，原协议同时删除，之后按需召回。', buttons: [
      { text: '取消', style: 'cancel' },
      { text: '转换', onPress: async () => {
        setSaving(true);
        try {
          await onConvertToMemory(protocol, { content, summary });
          setModalVisible(false);
          resetForm();
          await loadProtocols();
          showAppDialog({ title: '已转为记忆', message: '可在当前 AI 的记忆空间查看和编辑。', tone: 'success' });
        } catch (error) {
          showAppDialog({ title: '转换失败', message: (error as Error).message, tone: 'error' });
        } finally { setSaving(false); }
      } },
    ] });
  }, [saving, onConvertToMemory, resetForm, loadProtocols]);

  const handleLongPress = useCallback((protocol: Protocol) => {
    showAppDialog({
      title: '协议选项',
      message: protocol.content.substring(0, 30) + (protocol.content.length > 30 ? '...' : ''),
      buttons: [
        { text: '转为记忆', onPress: () => handleConvert(protocol, protocol.content, protocol.summary ?? null) },
        { text: '删除', style: 'destructive', onPress: () => handleDelete(protocol) },
        { text: '取消', style: 'cancel' },
      ],
    });
  }, [handleDelete, handleConvert]);

  const renderItem = useCallback(({ item }: ListRenderItemInfo<Protocol>) => (
    <ListItem
      style={styles.protocolItem}
      onPress={() => handleEdit(item)}
      onLongPress={() => handleLongPress(item)}
      title={item.content}
      subtitle={item.summary || new Date(item.updatedAt).toLocaleDateString('zh-CN')}
      titleNumberOfLines={2}
      subtitleNumberOfLines={1}
      titleStyle={styles.protocolText}
      subtitleStyle={item.summary ? styles.protocolSummary : styles.protocolTime}
    />
  ), [handleEdit, handleLongPress, styles]);

  const rightButton = (
    <TouchableOpacity onPress={handleAdd} style={styles.headerBtn} activeOpacity={0.7}>
      <AddIcon />
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <NavigationHeader
        title="协议空间"
        help={{ sections: [
          { title: '持续生效的提示词', body: '这里的全部内容都会作为常驻提示词注入当前 AI，直到修改或删除。你与 AI 均可编辑。' },
        ] }}
        onGoBack={() => { if (!saving) onBack?.(); }}
        rightButton={rightButton}
      />

      <FlatList
        data={protocols}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        style={styles.list}
        refreshing={loading}
        onRefresh={() => void loadProtocols()}
        contentContainerStyle={protocols.length === 0 ? styles.emptyList : undefined}
        ListEmptyComponent={
          <EmptyState
            title="暂无协议"
          />
        }
      />

      <ModalSheet
        visible={modalVisible}
        onClose={handleCloseModal}
        title={editingProtocol ? '编辑协议' : '新增协议'}
      >
        <View style={styles.modalBody}>
          <ScrollView
            style={styles.modalScroll}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
                <TextInput
                  style={styles.input}
                  multiline
                  placeholder="固定注入的提示词或信息"
                  placeholderTextColor={theme.colors.text.tertiary}
                  value={inputContent}
                  onChangeText={setInputContent}
                  editable={!saving}
                  maxLength={PROTOCOL_MAX_LENGTH}
                  textAlignVertical="top"
                />
                <Text style={styles.charCount}>
                  {inputContent.length}/{PROTOCOL_MAX_LENGTH}
                </Text>

                <TextInput
                  style={styles.summaryInput}
                  placeholder="摘要（用于检索）"
                  placeholderTextColor={theme.colors.text.tertiary}
                  value={inputSummary}
                  onChangeText={setInputSummary}
                  editable={!saving}
                  maxLength={50}
                />

                <TouchableOpacity
                  style={styles.saveBtn}
                  onPress={() => void handleSave()}
                  disabled={saving}
                  activeOpacity={0.7}
                >
                  <Text style={styles.saveBtnText}>{saving ? '处理中...' : '保存'}</Text>
                </TouchableOpacity>
                {editingProtocol && <TouchableOpacity
                  style={styles.saveBtn}
                  onPress={() => handleConvert(editingProtocol, inputContent, inputSummary)}
                  disabled={saving}
                  activeOpacity={0.7}
                >
                  <Text style={styles.saveBtnText}>转为记忆并删除协议</Text>
                </TouchableOpacity>}
          </ScrollView>
        </View>
      </ModalSheet>
    </SafeAreaView>
  );
}
