/** Wallet repository adapter backed by the shared SQLite connection. */

import { databaseCoordinator, type CoordinatedDatabaseExecutor, type DatabaseWriteExecutor } from '@platform/persistence';
import {
  createWalletRecord,
  createWalletRecordFromRow,
  createQuickAction,
  createQuickActionFromRow,
  DEFAULT_WALLET_CATEGORIES,
} from '../domain/WalletRecord';
import type { WalletRecord, QuickAction, WalletRecordType } from '../domain/WalletRecord';
import type { 
  ILedgerRepository, 
  LedgerRecordFilters, 
  CreateWalletRecordInput,
  UpdateWalletRecordInput,
  MonthlyLedgerStats,
  YearlyLedgerStats,
  LedgerKeywordSearchStats,
  LedgerRangeSummary,
  CreateQuickActionInput,
  UpdateQuickActionInput,
} from '../domain/LedgerRepository';

/**
 * LedgerRepository
 * 
 * 羽库账本（ledger_records、ledger_quick_actions 表）的 SQLite 实现
 */
export class SQLiteLedgerRepository implements ILedgerRepository {
  // ==================== 账本记录操作 ====================

  /**
   * 插入账本记录
   * @param record - 账本记录对象
   * @returns 保存后的记录
   */
  async insertRecord(record: CreateWalletRecordInput): Promise<WalletRecord> {
    const db: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'wallet.insertRecord', feature: 'wallet', priority: 'runtime' });

    return this.insertRecordWithExecutor(db, record);
  }

  // 普通新增与快捷记账共用写入；事务内必须使用传入的 executor，不能重新排队。
  private async insertRecordWithExecutor(db: DatabaseWriteExecutor, record: CreateWalletRecordInput): Promise<WalletRecord> {
    // 使用实体工厂创建标准格式的记录
    const recordToSave = createWalletRecord(record);

    await db.runAsync(
      `INSERT INTO ledger_records (id, type, category, detail, amount, record_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        recordToSave.id,
        recordToSave.type,
        recordToSave.category,
        recordToSave.detail,
        recordToSave.amount,
        recordToSave.recordDate,
        recordToSave.createdAt,
        recordToSave.updatedAt,
      ]
    );

    return recordToSave;
  }

  /**
   * 获取账本记录列表
   * @param filters - 筛选条件
   * @returns 记录列表
   */
  async getRecords(filters: LedgerRecordFilters = {}): Promise<WalletRecord[]> {
    const db: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'wallet.getRecords', feature: 'wallet', priority: 'runtime' });
    const { ids, year, month, day, type, category, keyword, startDate, endDate, limit = 100 } = filters;
    
    let whereClause = 'WHERE 1=1';
    const params: (string | number)[] = [];

    if (ids) {
      whereClause += ` AND id IN (${ids.map(() => '?').join(',')})`;
      params.push(...ids);
    }

    if (year) {
      whereClause += " AND strftime('%Y', record_date) = ?";
      params.push(year.toString());
    }
    
    if (month) {
      whereClause += " AND strftime('%m', record_date) = ?";
      params.push(month.toString().padStart(2, '0'));
    }
    
    if (day) {
      whereClause += " AND strftime('%d', record_date) = ?";
      params.push(day.toString().padStart(2, '0'));
    }

    if (startDate && endDate) {
      whereClause += " AND record_date BETWEEN ? AND ?";
      params.push(startDate, endDate);
    }

    if (type) {
      whereClause += ' AND type = ?';
      params.push(type);
    }

    if (category) {
      whereClause += ' AND category = ?';
      params.push(category);
    }

    if (keyword) {
      whereClause += ' AND (category LIKE ? OR detail LIKE ?)';
      const likePattern = `%${keyword}%`;
      params.push(likePattern, likePattern);
    }

    const sql = `SELECT * FROM ledger_records ${whereClause} ORDER BY record_date DESC, created_at DESC LIMIT ?`;
    params.push(limit);

    const results = await db.getAllAsync<{
      id: string;
      type: WalletRecordType;
      category: string;
      detail: string | null;
      amount: number;
      record_date: string;
      created_at: string;
      updated_at: string;
    }>(sql, params);
    
    // 使用实体工厂从数据库行创建实体
    return results.map(row => createWalletRecordFromRow(row));
  }

  /**
   * 获取月度统计
   * @param year - 年份
   * @param month - 月份
   * @returns 月度统计
   */
  async getMonthlyStats(year: number, month: number): Promise<MonthlyLedgerStats> {
    const db: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'wallet.getMonthlyStats', feature: 'wallet', priority: 'runtime' });
    const yearStr = year.toString();
    const monthStr = month.toString().padStart(2, '0');

    // 月度汇总
    const summarySql = `SELECT 
      COUNT(*) as count,
      SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as total_expense,
      SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as total_income
      FROM ledger_records 
      WHERE strftime('%Y', record_date) = ? AND strftime('%m', record_date) = ?`;
    
    const summary = await db.getFirstAsync<{ count: number; total_expense: number; total_income: number }>(summarySql, [yearStr, monthStr]);

    // 按分类统计
    const categorySql = `SELECT 
      category,
      COUNT(*) as count,
      SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as expense,
      SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as income
      FROM ledger_records 
      WHERE strftime('%Y', record_date) = ? AND strftime('%m', record_date) = ?
      GROUP BY category
      ORDER BY expense DESC, income DESC`;
    
    const categories = await db.getAllAsync<{ category: string; count: number; expense: number | null; income: number | null }>(categorySql, [yearStr, monthStr]);

    return {
      year,
      month,
      count: summary?.count || 0,
      totalExpense: summary?.total_expense || 0,
      totalIncome: summary?.total_income || 0,
      balance: (summary?.total_income || 0) - (summary?.total_expense || 0),
      categories: categories.map(c => ({
        category: c.category,
        count: c.count,
        expense: c.expense || 0,
        income: c.income || 0,
      })),
    };
  }

  /**
   * 获取年度统计
   * @param year - 年份
   * @returns 年度统计
   */
  async getYearlyStats(year: number): Promise<YearlyLedgerStats> {
    const db: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'wallet.getYearlyStats', feature: 'wallet', priority: 'runtime' });
    const yearStr = year.toString();

    // 年度汇总
    const summarySql = `SELECT 
      COUNT(*) as count,
      SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as total_expense,
      SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as total_income
      FROM ledger_records 
      WHERE strftime('%Y', record_date) = ?`;
    
    const summary = await db.getFirstAsync<{ count: number; total_expense: number; total_income: number }>(summarySql, [yearStr]);

    // 按分类统计
    const categorySql = `SELECT 
      category,
      COUNT(*) as count,
      SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as expense,
      SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as income
      FROM ledger_records 
      WHERE strftime('%Y', record_date) = ?
      GROUP BY category
      ORDER BY expense DESC, income DESC`;
    
    const categories = await db.getAllAsync<{ category: string; count: number; expense: number | null; income: number | null }>(categorySql, [yearStr]);

    return {
      year,
      count: summary?.count || 0,
      totalExpense: summary?.total_expense || 0,
      totalIncome: summary?.total_income || 0,
      balance: (summary?.total_income || 0) - (summary?.total_expense || 0),
      categories: categories.map(c => ({
        category: c.category,
        count: c.count,
        expense: c.expense || 0,
        income: c.income || 0,
      })),
    };
  }

  /**
   * 按关键词统计
   * @param keyword - 搜索关键词
   * @param filters - 筛选条件
   * @returns 统计结果
   */
  async searchByKeyword(
    keyword: string, 
    filters: Omit<LedgerRecordFilters, 'day' | 'type' | 'category' | 'keyword' | 'limit'> = {}
  ): Promise<LedgerKeywordSearchStats> {
    const db: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'wallet.searchByKeyword', feature: 'wallet', priority: 'runtime' });
    const { year, month, startDate, endDate } = filters;
    
    let whereClause = 'WHERE (category LIKE ? OR detail LIKE ?)';
    const params: string[] = [`%${keyword}%`, `%${keyword}%`];

    if (year) {
      whereClause += " AND strftime('%Y', record_date) = ?";
      params.push(year.toString());
    }
    
    if (month) {
      whereClause += " AND strftime('%m', record_date) = ?";
      params.push(month.toString().padStart(2, '0'));
    }

    if (startDate && endDate) {
      whereClause += " AND record_date BETWEEN ? AND ?";
      params.push(startDate, endDate);
    }

    // 总次数和总金额
    const summarySql = `SELECT 
      COUNT(*) as count,
      SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as total_expense,
      SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as total_income
      FROM ledger_records ${whereClause}`;
    
    const summary = await db.getFirstAsync<{ count: number; total_expense: number; total_income: number }>(summarySql, params);

    // 按日期分组统计
    const dateGroupSql = `SELECT 
      record_date,
      COUNT(*) as count,
      SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as expense,
      SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as income
      FROM ledger_records ${whereClause}
      GROUP BY record_date
      ORDER BY record_date DESC`;
    
    const dateGroups = await db.getAllAsync<{ record_date: string; count: number; expense: number | null; income: number | null }>(dateGroupSql, params);

    // 按分类分组统计
    const categoryGroupSql = `SELECT 
      category,
      COUNT(*) as count,
      SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as expense,
      SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as income
      FROM ledger_records ${whereClause}
      GROUP BY category
      ORDER BY count DESC`;
    
    const categoryGroups = await db.getAllAsync<{ category: string; count: number; expense: number | null; income: number | null }>(categoryGroupSql, params);

    return {
      keyword,
      count: summary?.count || 0,
      totalExpense: summary?.total_expense || 0,
      totalIncome: summary?.total_income || 0,
      byDate: dateGroups.map(g => ({
        date: g.record_date,
        count: g.count,
        expense: g.expense || 0,
        income: g.income || 0,
      })),
      byCategory: categoryGroups.map(g => ({
        category: g.category,
        count: g.count,
        expense: g.expense || 0,
        income: g.income || 0,
      })),
    };
  }

  /**
   * 删除账本记录
   * @param id - 记录ID
   */
  async deleteRecord(id: string): Promise<boolean> {
    const db: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'wallet.deleteRecord', feature: 'wallet', priority: 'runtime' });
    const result = await db.runAsync('DELETE FROM ledger_records WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /**
   * 更新账本记录
   * @param id - 记录ID
   * @param updates - 更新字段
   */
  async updateRecord(id: string, updates: UpdateWalletRecordInput): Promise<boolean> {
    const db: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'wallet.updateRecord', feature: 'wallet', priority: 'runtime' });
    const now = new Date().toISOString();
    
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    
    if (updates.type !== undefined) {
      fields.push('type = ?');
      values.push(updates.type);
    }
    if (updates.category !== undefined) {
      fields.push('category = ?');
      values.push(updates.category);
    }
    if (updates.detail !== undefined) {
      fields.push('detail = ?');
      values.push(updates.detail);
    }
    if (updates.amount !== undefined) {
      fields.push('amount = ?');
      values.push(updates.amount);
    }
    if (updates.recordDate !== undefined) {
      fields.push('record_date = ?');
      values.push(updates.recordDate);
    }
    
    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    const result = await db.runAsync(
      `UPDATE ledger_records SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    return result.changes > 0;
  }

  // ==================== 快捷记账操作 ====================

  /**
   * 获取快捷记账列表
   * @returns 快捷记账列表
   */
  async getQuickActions(): Promise<QuickAction[]> {
    const db: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'wallet.getQuickActions', feature: 'wallet', priority: 'runtime' });
    const results = await db.getAllAsync<{
      id: string;
      name: string;
      type: WalletRecordType;
      category: string;
      detail: string | null;
      amount: number | string;
      sort_order: number | null;
      created_at: string;
      updated_at: string;
    }>(
      'SELECT * FROM ledger_quick_actions ORDER BY sort_order ASC, created_at ASC, id ASC'
    );
    
    // 使用实体工厂从数据库行创建实体
    return results.map(row => createQuickActionFromRow(row));
  }

  /**
   * 插入快捷记账
   * @param action - 快捷记账对象
   */
  async insertQuickAction(action: CreateQuickActionInput): Promise<QuickAction> {
    const db: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'wallet.insertQuickAction', feature: 'wallet', priority: 'runtime' });
    
    // 默认排位由仓储拥有；取末尾与写入必须原子执行，不能用页面条数推算。
    return db.withExclusiveTransactionAsync(async (tx) => {
      const sortOrder = action.sortOrder ?? (await tx.getFirstAsync<{ next_order: number }>(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM ledger_quick_actions'
      ))!.next_order;
      const actionToSave = createQuickAction({ ...action, sortOrder });
      await tx.runAsync(
        `INSERT INTO ledger_quick_actions (id, name, type, category, detail, amount, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          actionToSave.id,
          actionToSave.name,
          actionToSave.type,
          actionToSave.category,
          actionToSave.detail,
          actionToSave.amount,
          actionToSave.sortOrder,
          actionToSave.createdAt,
          actionToSave.updatedAt,
        ]
      );
      return actionToSave;
    });
  }

  async updateQuickAction(id: string, updates: UpdateQuickActionInput): Promise<boolean> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'wallet.updateQuickAction', feature: 'wallet', priority: 'runtime' });
    const fields: string[] = [];
    const values: (string | number)[] = [];
    const columns = {
      name: 'name', type: 'type', category: 'category', detail: 'detail', amount: 'amount', sortOrder: 'sort_order',
    } as const;
    for (const key of Object.keys(columns) as (keyof UpdateQuickActionInput)[]) {
      if (updates[key] !== undefined) {
        fields.push(`${columns[key]} = ?`);
        values.push(updates[key]);
      }
    }
    fields.push('updated_at = ?');
    values.push(new Date().toISOString(), id);
    const result = await db.runAsync(`UPDATE ledger_quick_actions SET ${fields.join(', ')} WHERE id = ?`, values);
    return result.changes > 0;
  }

  /** 删除快捷记账，返回是否真正删除。 */
  async deleteQuickAction(id: string): Promise<boolean> {
    const db: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'wallet.deleteQuickAction', feature: 'wallet', priority: 'runtime' });
    const result = await db.runAsync('DELETE FROM ledger_quick_actions WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /**
   * 使用快捷记账创建记录
   * @param quickActionId - 快捷记账ID
   * @param recordDate - 记录日期，默认今天
   */
  async useQuickAction(quickActionId: string, recordDate?: string): Promise<WalletRecord> {
    const db: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'wallet.useQuickAction', feature: 'wallet', priority: 'runtime' });
    // 模板读取与账单提交属于同一原子操作，编辑或删除不能插入两者之间。
    const record = await db.withExclusiveTransactionAsync(async (tx) => {
      const quickAction = await tx.getFirstAsync<{
        name: string;
        type: WalletRecordType;
        category: string;
        detail: string | null;
        amount: number;
      }>('SELECT name, type, category, detail, amount FROM ledger_quick_actions WHERE id = ?', [quickActionId]);
      if (!quickAction) return null;
      return this.insertRecordWithExecutor(tx, { ...quickAction, detail: quickAction.detail || quickAction.name, recordDate });
    });
    if (!record) throw new Error('快捷记账不存在，可能已被删除，请重新查询');
    return record;
  }

  // ==================== 分类管理 ====================

  /**
   * 获取所有分类（去重）
   * @returns 分类列表
   */
  async getCategories(type?: WalletRecordType): Promise<string[]> {
    const db: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'wallet.getCategories', feature: 'wallet', priority: 'runtime' });
    const where = type ? 'WHERE type = ?' : '';
    const results = await db.getAllAsync<{ category: string }>(
      `SELECT category FROM ledger_records ${where}
       UNION SELECT category FROM ledger_quick_actions ${where}
       ORDER BY category`,
      type ? [type, type] : []
    );
    const defaults = type
      ? DEFAULT_WALLET_CATEGORIES[type]
      : [...DEFAULT_WALLET_CATEGORIES.expense, ...DEFAULT_WALLET_CATEGORIES.income];
    return [...new Set([...defaults, ...results.map(r => r.category)])];
  }

  // ==================== 历史记账功能 ====================

  /**
   * 获取时间范围内的汇总数据
   * @param startDate - 开始日期 YYYY-MM-DD
   * @param endDate - 结束日期 YYYY-MM-DD
   * @returns 汇总数据
   */
  async getRangeSummary(startDate: string, endDate: string): Promise<LedgerRangeSummary> {
    // 获取时间范围内的所有记录
    const records = await this.getRecords({ startDate, endDate, limit: 1000 });

    // 计算总支出和总收入
    const totalExpense = records
      .filter(r => r.type === 'expense')
      .reduce((sum, r) => sum + r.amount, 0);
    const totalIncome = records
      .filter(r => r.type === 'income')
      .reduce((sum, r) => sum + r.amount, 0);

    // 按分类和类型分组统计
    const categoryMap = new Map<string, {
      category: string;
      type: 'income' | 'expense';
      amount: number;
      count: number;
    }>();
    
    records.forEach(record => {
      const key = `${record.type}:${record.category}`;
      if (!categoryMap.has(key)) {
        categoryMap.set(key, {
          category: record.category,
          type: record.type,
          amount: 0,
          count: 0,
        });
      }
      const stat = categoryMap.get(key)!;
      stat.amount += record.amount;
      stat.count += 1;
    });

    // 预设颜色数组
    const PIE_COLORS = [
      '#e74c3c', '#3498db', '#f39c12', '#9b59b6', 
      '#1abc9c', '#e91e63', '#ff5722', '#607d8b',
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', 
      '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F'
    ];

    // 分别计算支出和收入的百分比
    const expenseCategories: { category: string; type: 'expense'; amount: number; count: number }[] = [];
    const incomeCategories: { category: string; type: 'income'; amount: number; count: number }[] = [];
    
    categoryMap.forEach(stat => {
      if (stat.type === 'expense') {
        expenseCategories.push(stat as { category: string; type: 'expense'; amount: number; count: number });
      } else {
        incomeCategories.push(stat as { category: string; type: 'income'; amount: number; count: number });
      }
    });

    // 计算百分比并分配颜色
    let colorIndex = 0;
    
    const categoryStats: {
      category: string;
      type: 'income' | 'expense';
      amount: number;
      percentage: number;
      count: number;
      color: string;
    }[] = [];
    
    // 支出分类（按金额降序）
    expenseCategories
      .sort((a, b) => b.amount - a.amount)
      .forEach(stat => {
        categoryStats.push({
          ...stat,
          percentage: totalExpense > 0 ? Math.round((stat.amount / totalExpense) * 100) : 0,
          color: PIE_COLORS[colorIndex % PIE_COLORS.length],
        });
        colorIndex++;
      });

    // 收入分类（按金额降序）
    incomeCategories
      .sort((a, b) => b.amount - a.amount)
      .forEach(stat => {
        categoryStats.push({
          ...stat,
          percentage: totalIncome > 0 ? Math.round((stat.amount / totalIncome) * 100) : 0,
          color: PIE_COLORS[colorIndex % PIE_COLORS.length],
        });
        colorIndex++;
      });

    return {
      totalExpense,
      totalIncome,
      balance: totalIncome - totalExpense,
      categoryStats,
      records,
    };
  }
}

// 单例实例
export const ledgerRepository = new SQLiteLedgerRepository();
