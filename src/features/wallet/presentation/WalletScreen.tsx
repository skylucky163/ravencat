/** 羽库主屏幕；历史页面由宿主 Router 负责导航。 */

import React, { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import NavigationHeader from '@shared/ui/NavigationHeader';
import { EmptyState, showAppDialog } from '@shared/ui';
import { ThemedSurface, useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import type { AIProfile } from '@features/assistants';
import type { QuickAction, WalletCategories, WalletRecord } from '../domain/WalletRecord';
import { DEFAULT_WALLET_CATEGORIES } from '../domain/WalletRecord';
import type { UpdateWalletRecordInput } from '../domain/LedgerRepository';
import { setLedgerAIAssistant } from '@features/assistants';
import {
  addWalletQuickAction,
  deleteWalletQuickAction,
  getWalletScreenData,
  addWalletRecord,
  applyQuickActionAndReply,
} from '../composition';
import AddRecordModal from './AddRecordModal';
import Overview from './Overview';
import QuickActionModal from './QuickActionModal';
import QuickActions from './QuickActions';
import RecordList from './RecordList';
import SettingsModal from './SettingsModal';
import { useWalletRecordActions } from './useWalletRecordActions';

interface WalletScreenProps {
  onOpenHistory?: () => void;
}

interface MonthlyStats {
  expense: number;
  income: number;
}

const createStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.background.app },
    scroll: { flex: 1 },
    initialLoading: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    bottomBar: {
      flexDirection: 'row',
      padding: theme.spacing.md,
      paddingHorizontal: theme.spacing.lg,
      borderTopWidth: 0.5,
      borderTopColor: theme.colors.border.light,
      alignItems: 'center',
    },
    settingBtn: { paddingVertical: theme.spacing.md, paddingRight: theme.spacing.lg },
    settingText: { fontSize: 15, color: theme.colors.text.secondary },
    addBtn: {
      flex: 1,
      backgroundColor: theme.colors.text.primary,
      paddingVertical: theme.spacing.md,
      borderRadius: 24,
      alignItems: 'center',
    },
    addBtnText: { color: theme.colors.text.inverse, fontSize: 16, fontWeight: '500' },
  });

const WalletScreen: React.FC<WalletScreenProps> = ({ onOpenHistory }) => {
  const styles = useThemedStyles(createStyles);
  const theme = useTheme();

  const [records, setRecords] = useState<WalletRecord[]>([]);
  const [quickActions, setQuickActions] = useState<QuickAction[]>([]);
  const [categories, setCategories] = useState<WalletCategories>(DEFAULT_WALLET_CATEGORIES);
  const [monthlyStats, setMonthlyStats] = useState<MonthlyStats>({ expense: 0, income: 0 });
  const [aiList, setAiList] = useState<AIProfile[]>([]);
  const [ledgerAI, setLedgerAIState] = useState<AIProfile | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showQuickModal, setShowQuickModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [addType, setAddType] = useState<'expense' | 'income'>('expense');
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutatingQuickActionId, setMutatingQuickActionId] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  const loadData = useCallback(async (showRefreshIndicator = false) => {
    if (hasLoadedRef.current && showRefreshIndicator) {
      setRefreshing(true);
    } else if (!hasLoadedRef.current) {
      setInitialLoading(true);
    }

    try {
      const data = await getWalletScreenData(new Date());
      setRecords(data.records);
      setQuickActions(data.quickActions);
      setCategories(data.categories);
      setMonthlyStats(data.monthlyStats);
      setAiList(data.aiList);
      setLedgerAIState(data.ledgerAI);
      hasLoadedRef.current = true;
      setLoadError(null);
    } catch (error) {
      console.error('[Wallet] Failed to load wallet data:', error);
      setLoadError('读取羽库数据失败，请稍后重试。');
    } finally {
      setInitialLoading(false);
      setRefreshing(false);
    }
  }, []);

  const recordActions = useWalletRecordActions(loadData);

  useFocusEffect(useCallback(() => {
    void loadData();
  }, [loadData]));

  const handleAddRecord = async (data: Required<UpdateWalletRecordInput>): Promise<boolean> => {
    const result = await addWalletRecord(data);

    if (!result.success || !result.record) {
      showAppDialog({ title: '错误', message: result.error || '保存记账失败', tone: 'error' });
      return false;
    }

    await loadData();
    return true;
  };

  const handleQuickAction = async (action: QuickAction): Promise<void> => {
    if (mutatingQuickActionId) {
      return;
    }

    setMutatingQuickActionId(action.id);
    try {
      const result = await applyQuickActionAndReply({ quickActionId: action.id });

      if (!result.success) {
        showAppDialog({ title: '错误', message: result.error || '快捷记账失败', tone: 'error' });
        return;
      }

      await loadData();
    } catch (error) {
      console.error('[Wallet] Failed to apply quick action:', error);
      showAppDialog({ title: '错误', message: '快捷记账失败', tone: 'error' });
    } finally {
      setMutatingQuickActionId(null);
    }
  };

  const handleAddQuick = async (
    data: Omit<QuickAction, 'id' | 'sortOrder' | 'createdAt' | 'updatedAt'>
  ): Promise<void> => {
    try {
      await addWalletQuickAction(data);
      await loadData();
      setShowQuickModal(false);
    } catch (error) {
      console.error('[Wallet] Failed to add quick action:', error);
      showAppDialog({ title: '错误', message: '添加快捷记账失败', tone: 'error' });
    }
  };

  const handleDeleteQuick = (id: string): void => {
    showAppDialog({ title: '删除快捷记账', message: '确定删除这个快捷记账？', buttons: [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteWalletQuickAction(id);
            await loadData();
          } catch (error) {
            console.error('[Wallet] Failed to delete quick action:', error);
            showAppDialog({ title: '错误', message: '删除快捷记账失败', tone: 'error' });
          }
        },
      },
    ] });
  };

  const handleSetLedgerAI = async (aiId: string | null): Promise<void> => {
    console.log('[Wallet] Setting ledger AI:', aiId);
    try {
      await setLedgerAIAssistant(aiId);
      await loadData();
    } catch (error) {
      console.error('[Wallet] Failed to set ledger AI:', error);
      showAppDialog({ title: '错误', message: '设置记账 AI 失败', tone: 'error' });
    }
  };

  if (initialLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <NavigationHeader title="羽库" />
        <View style={styles.initialLoading}>
          <ActivityIndicator size="large" color={theme.colors.brand.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!hasLoadedRef.current && loadError) {
    return (
      <SafeAreaView style={styles.container}>
        <NavigationHeader title="羽库" />
        <EmptyState
          title="暂时无法读取羽库"
          description={loadError}
          actionText="重试"
          onAction={() => void loadData()}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <NavigationHeader title="羽库" />

      <ScrollView
        style={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void loadData(true)}
            tintColor={theme.colors.brand.primary}
            colors={[theme.colors.brand.primary]}
          />
        )}
      >
        <Overview
          expense={monthlyStats.expense}
          income={monthlyStats.income}
          onPress={onOpenHistory}
        />
        <QuickActions
          actions={quickActions}
          onAction={handleQuickAction}
          onManage={() => setShowQuickModal(true)}
          mutatingActionId={mutatingQuickActionId}
        />
        <RecordList
          records={records}
          onLongPress={recordActions.showRecordActions}
          mutatingRecordId={recordActions.mutatingRecordId}
        />
      </ScrollView>

      <ThemedSurface variant="inputBar" cornerRadius={0} style={styles.bottomBar}>
        <TouchableOpacity style={styles.settingBtn} onPress={() => setShowSettingsModal(true)}>
          <Text style={styles.settingText}>设置</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => {
            setAddType('expense');
            setShowAddModal(true);
          }}
        >
          <Text style={styles.addBtnText}>收入 / 支出</Text>
        </TouchableOpacity>
      </ThemedSurface>

      <AddRecordModal
        visible={showAddModal}
        availableCategories={categories}
        onClose={() => setShowAddModal(false)}
        onSave={handleAddRecord}
        initialType={addType}
      />
      <AddRecordModal
        visible={recordActions.editingRecord !== null}
        availableCategories={categories}
        initialRecord={recordActions.editingRecord}
        onClose={recordActions.closeEditor}
        onSave={recordActions.saveRecord}
      />
      <QuickActionModal
        visible={showQuickModal}
        onClose={() => setShowQuickModal(false)}
        quickActions={quickActions}
        availableCategories={categories}
        onAdd={handleAddQuick}
        onDelete={handleDeleteQuick}
      />
      <SettingsModal
        visible={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        aiList={aiList}
        ledgerAI={ledgerAI}
        onSetLedgerAI={handleSetLedgerAI}
      />
    </SafeAreaView>
  );
};

export default WalletScreen;
