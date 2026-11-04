/**
 * @fileoverview WalletRecord 实体定义
 *
 * 羽库账本（记账）的领域实体，纯数据结构，无业务逻辑。
 * 对应数据库表：ledger_records, ledger_quick_actions
 *
 * @module features/wallet/domain/WalletRecord
 */

export type WalletRecordType = 'income' | 'expense';

export type WalletCategories = Record<WalletRecordType, string[]>;

// 预设只是分类建议；用户和 AI 已使用的自定义分类同样属于账本。
export const DEFAULT_WALLET_CATEGORIES: WalletCategories = {
  expense: ['餐饮', '交通', '购物', '娱乐', '医疗', '教育', '住房', '通讯', '其他'],
  income: ['工资', '奖金', '投资', '兼职', '红包', '其他'],
};

export interface WalletRecord {
  id: string;
  type: WalletRecordType;
  category: string;
  detail: string;
  amount: number;
  recordDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuickAction {
  id: string;
  name: string;
  type: WalletRecordType;
  category: string;
  detail: string;
  amount: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// ==================== 历史记账功能新增类型 ====================

/** 分类统计（用于饼图） */
export interface CategoryStat {
  category: string;
  type: WalletRecordType;
  amount: number;
  percentage: number;  // 占总支出/收入的百分比
  count: number;       // 笔数
  color: string;       // 饼图颜色
}

interface WalletRecordRow {
  id: string;
  type: WalletRecordType;
  category: string;
  detail?: string | null;
  amount: number | string;
  record_date: string;
  created_at: string;
  updated_at: string;
}

interface QuickActionRow {
  id: string;
  name: string;
  type: WalletRecordType;
  category: string;
  detail?: string | null;
  amount: number | string;
  sort_order?: number | null;
  created_at: string;
  updated_at: string;
}

export function getWalletRecordDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function createWalletRecord(data: Partial<WalletRecord> = {}): WalletRecord {
  const now = new Date().toISOString();

  return {
    id: data.id || `ledger_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    type: data.type || 'expense',
    category: data.category || '',
    detail: data.detail || '',
    amount: typeof data.amount === 'number' ? data.amount : 0,
    recordDate: data.recordDate || getWalletRecordDate(),
    createdAt: data.createdAt || now,
    updatedAt: data.updatedAt || now,
  };
}

export function createWalletRecordFromRow(row: WalletRecordRow): WalletRecord {
  return {
    id: row.id,
    type: row.type,
    category: row.category,
    detail: row.detail || '',
    amount: typeof row.amount === 'number' ? row.amount : parseFloat(row.amount) || 0,
    recordDate: row.record_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createQuickAction(data: Partial<QuickAction> = {}): QuickAction {
  const now = new Date().toISOString();

  return {
    id: data.id || `quick_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name: data.name || '',
    type: data.type || 'expense',
    category: data.category || '',
    detail: data.detail || '',
    amount: typeof data.amount === 'number' ? data.amount : 0,
    sortOrder: data.sortOrder ?? 0,
    createdAt: data.createdAt || now,
    updatedAt: data.updatedAt || now,
  };
}

export function createQuickActionFromRow(row: QuickActionRow): QuickAction {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    category: row.category,
    detail: row.detail || '',
    amount: typeof row.amount === 'number' ? row.amount : parseFloat(row.amount) || 0,
    sortOrder: row.sort_order ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function formatAmount(amount: number | string, withSymbol = true): string {
  const value = typeof amount === 'number' ? amount : parseFloat(amount) || 0;
  const formatted = value.toFixed(2);
  return withSymbol ? `¥${formatted}` : formatted;
}

export function getRecordsSummary(records: WalletRecord[] | null | undefined): string {
  if (!records || records.length === 0) {
    return '没有记账记录';
  }

  if (records.length === 1) {
    const r = records[0];
    if (!r) return '没有记账记录';
    const typeText = r.type === 'expense' ? '支出' : '收入';
    return `用户记录了一笔记账：${r.category}${r.detail ? `(${r.detail})` : ''} - ${typeText} ${formatAmount(r.amount)}`;
  }

  const expenseRecords = records.filter(r => r.type === 'expense');
  const incomeRecords = records.filter(r => r.type === 'income');

  let summary = `用户记录了 ${records.length} 笔记账：`;

  if (expenseRecords.length > 0) {
    const totalExpense = expenseRecords.reduce((sum, r) => sum + r.amount, 0);
    summary += `\n支出 ${expenseRecords.length} 笔，共 ${formatAmount(totalExpense)}：`;
    expenseRecords.forEach(r => {
      summary += `\n- ${r.category}${r.detail ? `(${r.detail})` : ''} ${formatAmount(r.amount)}`;
    });
  }

  if (incomeRecords.length > 0) {
    const totalIncome = incomeRecords.reduce((sum, r) => sum + r.amount, 0);
    summary += `\n收入 ${incomeRecords.length} 笔，共 ${formatAmount(totalIncome)}：`;
    incomeRecords.forEach(r => {
      summary += `\n- ${r.category}${r.detail ? `(${r.detail})` : ''} ${formatAmount(r.amount)}`;
    });
  }

  return summary;
}

