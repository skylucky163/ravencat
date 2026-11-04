/**
 * @fileoverview GetLedgerContextTool - 获取账本记录和统计信息
 * 
 * @module features/wallet/aiTools/GetLedgerContextTool
 */

import type { ToolContext, ToolExecuteResult } from '@shared/aiTools';
import type { WalletRecord, WalletRecordType } from '../domain/WalletRecord';
import { getWalletRecordDate } from '../domain/WalletRecord';
import type {
  ILedgerRepository,
  LedgerKeywordSearchStats,
  MonthlyLedgerStats,
  YearlyLedgerStats,
} from '../domain/LedgerRepository';

/**
 * 工具定义参数类型
 */
interface GetLedgerContextArgs {
  mode: 'recent' | 'stats' | 'keyword' | 'categories' | 'quickActions';
  timeDescription?: string;
  keyword?: string;
  type?: WalletRecordType;
  category?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}

/**
 * 时间解析结果
 */
interface TimeResolution {
  year?: number;
  month?: number;
  startDate?: string;
  endDate?: string;
}

/**
 * 账本记录汇总
 */
interface LedgerSummary {
  count: number;
  totalExpense: number;
  totalIncome: number;
  balance: number;
  topCategories: {
    category: string;
    count: number;
    amount: number;
  }[];
}

/**
 * 构建过滤器的选项
 */
interface FilterOptions {
  limit?: number;
}

/**
 * 工具定义（JSON Schema）
 */
export const definition = {
  name: 'getLedgerContext',
  description: '获取账本记录、统计、已有分类或快捷记账模板；categories 返回预设及全部已用自定义分类，记账时优先复用原名；quickActions 返回模板及真实快捷记账 ID；recent 或 keyword 返回真实账单 ID。',
  parameters: {
    type: 'object' as const,
    properties: {
      mode: {
        type: 'string' as const,
        enum: ['recent', 'stats', 'keyword', 'categories', 'quickActions'] as const,
        description: '查询模式：recent最近记录、stats统计、keyword关键词搜索、categories已有分类（仅 type 生效）、quickActions快捷记账模板（支持 type、category、keyword，不按时间筛选）',
      },
      timeDescription: {
        type: 'string' as const,
        description: '时间描述，如"本月"、"最近7天"、"2024年1月"',
      },
      keyword: {
        type: 'string' as const,
        description: '搜索关键词；keyword 模式搜索账单，quickActions 模式搜索模板名称、分类和备注',
      },
      type: {
        type: 'string' as const,
        enum: ['income', 'expense'] as const,
        description: '筛选类型：收入或支出',
      },
      category: {
        type: 'string' as const,
        description: '分类筛选',
      },
      startDate: {
        type: 'string' as const,
        format: 'date',
        description: 'keyword 模式的开始日期，YYYY-MM-DD；与 endDate 一起使用时优先于 timeDescription',
      },
      endDate: {
        type: 'string' as const,
        format: 'date',
        description: 'keyword 模式的结束日期，YYYY-MM-DD；与 startDate 一起使用时优先于 timeDescription',
      },
      limit: {
        type: 'number' as const,
        minimum: 1,
        maximum: 50,
        default: 10,
        description: 'keyword 模式返回的账单数量，1–50，默认 10；统计仍计算全部命中记录',
      },
    },
    required: ['mode'] as const,
  },
};

/**
 * 执行工具
 * @param args - 工具参数
 * @param context - 工具执行上下文
 * @returns 工具执行结果
 */
export async function execute(
  args: GetLedgerContextArgs,
  context: ToolContext
): Promise<ToolExecuteResult> {
  const ledgerRepo = context.repositories.ledger as ILedgerRepository | null;
  if (!ledgerRepo) {
    return { success: false, error: '账本仓储未注入，无法查询账本' };
  }

  try {
    const mode = args?.mode;
    if (mode === 'quickActions') {
      const keyword = args.keyword?.trim();
      const quickActions = (await ledgerRepo.getQuickActions()).filter((action) =>
        (!args.type || action.type === args.type)
        && (!args.category || action.category === args.category)
        && (!keyword || [action.name, action.category, action.detail].some((value) => value.includes(keyword)))
      );
      return {
        success: true,
        message: quickActions.length
          ? `快捷记账模板（非账单记录）：${JSON.stringify(quickActions)}`
          : '没有找到匹配的快捷记账模板。',
        data: { quickActions },
      };
    }
    if (mode === 'categories') {
      const categories = await ledgerRepo.getCategories(args.type);
      return {
        success: true,
        message: `已有分类：${JSON.stringify(categories)}。请优先复用原名；具体消费内容写入备注，只有已有分类确实不适用或用户明确要求时才另创新分类。`,
        data: { categories },
      };
    }
    const resolved = resolveTimeDescription(args.timeDescription);

    if (mode === 'keyword') {
      if (!args?.keyword) {
        return { success: false, error: 'keyword 模式需要 keyword 参数' };
      }

      const hasExactRange = args.startDate !== undefined && args.endDate !== undefined;
      const startDate = args.startDate ?? resolved.startDate;
      const endDate = args.endDate ?? resolved.endDate;
      const year = hasExactRange ? undefined : resolved.year;
      const month = hasExactRange ? undefined : resolved.month;
      const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10)));
      const matchedRecords = await ledgerRepo.getRecords({
        keyword: args.keyword,
        type: args.type,
        category: args.category,
        startDate,
        endDate,
        year,
        month,
        limit,
      });

      const stats = await ledgerRepo.searchByKeyword(args.keyword, {
        year,
        month,
        startDate,
        endDate,
      });

      return {
        success: true,
        message: buildKeywordMessage(args.keyword, matchedRecords, stats,
          hasExactRange ? `${args.startDate} 至 ${args.endDate}` : args.timeDescription),
        data: {
          records: matchedRecords,
          stats,
        },
      };
    }

    if (mode === 'recent') {
      const filters = buildLedgerFilters(args, { limit: 20 });
      const records = await ledgerRepo.getRecords(filters);

      return {
        success: true,
        message: buildRecentMessage(records, args.timeDescription),
        data: {
          filters,
          records,
          summary: summarizeRecords(records),
        },
      };
    }

    if (mode === 'stats') {
      if (!args.type && !args.category && resolved.year && resolved.month) {
        const stats = await ledgerRepo.getMonthlyStats(resolved.year, resolved.month);
        return {
          success: true,
          message: buildMonthlyStatsMessage(stats, args.timeDescription),
          data: stats,
        };
      }

      if (!args.type && !args.category && resolved.year && !resolved.month && !resolved.startDate) {
        const stats = await ledgerRepo.getYearlyStats(resolved.year);
        return {
          success: true,
          message: buildYearlyStatsMessage(stats, args.timeDescription),
          data: stats,
        };
      }

      const filters = buildLedgerFilters(args, { limit: 500 });
      const records = await ledgerRepo.getRecords(filters);
      const summary = summarizeRecords(records);

      return {
        success: true,
        message: buildStatsMessage(summary, args.timeDescription),
        data: {
          filters,
          summary,
          sampleRecords: records.slice(0, 10),
        },
      };
    }

    return { success: false, error: `未知模式: ${mode}` };
  } catch (error) {
    console.error('[GetLedgerContextTool] Failed:', error);
    return {
      success: false,
      error: '账本查询失败，请稍后再试。',
    };
  }
}

/**
 * 工具对象（定义 + 执行）
 */
export const GetLedgerContextTool = {
  name: definition.name,
  definition,
  execute,
};

function buildLedgerFilters(
  args: Partial<GetLedgerContextArgs> = {},
  options: FilterOptions = {}
): Record<string, unknown> {
  const resolved = resolveTimeDescription(args.timeDescription);
  return {
    limit: options.limit || 20,
    type: args.type,
    category: args.category,
    year: resolved.year,
    month: resolved.month,
    startDate: resolved.startDate,
    endDate: resolved.endDate,
  };
}

function resolveTimeDescription(timeDescription: string | undefined): TimeResolution {
  const text = (timeDescription || '').trim();
  if (!text) {
    return {};
  }

  const now = new Date();
  const today = getWalletRecordDate(now);

  if (text === '今天' || text === '今日') {
    return { startDate: today, endDate: today };
  }

  if (text === '昨天') {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const date = getWalletRecordDate(yesterday);
    return { startDate: date, endDate: date };
  }

  if (text === '本月' || text === '这个月') {
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  }

  if (text === '上月') {
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { year: lastMonth.getFullYear(), month: lastMonth.getMonth() + 1 };
  }

  if (text === '今年') {
    return { year: now.getFullYear() };
  }

  if (text === '去年') {
    return { year: now.getFullYear() - 1 };
  }

  const recentDaysMatch = /^最近\s*(\d+)\s*天$/.exec(text);
  if (recentDaysMatch) {
    const days = Math.max(1, Number(recentDaysMatch[1]));
    const start = new Date(now);
    start.setDate(start.getDate() - (days - 1));
    return { startDate: getWalletRecordDate(start), endDate: today };
  }

  const exactDateMatch = /^(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})日?$/.exec(text);
  if (exactDateMatch) {
    const [, year, month, day] = exactDateMatch;
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { startDate: date, endDate: date };
  }

  const monthMatch = /^(\d{4})[-\/年](\d{1,2})月?$/.exec(text);
  if (monthMatch) {
    return {
      year: Number(monthMatch[1]),
      month: Number(monthMatch[2]),
    };
  }

  const yearMatch = /^(\d{4})年?$/.exec(text);
  if (yearMatch) {
    return { year: Number(yearMatch[1]) };
  }

  return {};
}

function buildRecentMessage(records: WalletRecord[], timeDescription: string | undefined): string {
  const label = timeDescription ? `时间范围：${timeDescription}` : '时间范围：最近记录';
  if (!records.length) {
    return `${label}\n没有找到相关账本记录。`;
  }

  const lines = records.map((record) => {
    const typeLabel = record.type === 'expense' ? '支出' : '收入';
    const detail = record.detail ? `（${record.detail}）` : '';
    return `- ID=${record.id} ${record.recordDate} ${typeLabel} ${record.category}${detail} ¥${Number(record.amount).toFixed(2)}`;
  });

  return [label, `共找到 ${records.length} 条记录：`, ...lines].join('\n');
}

function buildStatsMessage(summary: LedgerSummary, timeDescription: string | undefined): string {
  const label = timeDescription ? `统计范围：${timeDescription}` : '统计范围：当前筛选结果';
  return [
    label,
    `总笔数：${summary.count}`,
    `总支出：¥${summary.totalExpense.toFixed(2)}`,
    `总收入：¥${summary.totalIncome.toFixed(2)}`,
    `结余：¥${summary.balance.toFixed(2)}`,
    summary.topCategories.length
      ? `高频分类：${summary.topCategories.map((item) => `${item.category}(${item.count}笔)`).join('、')}`
      : '高频分类：暂无',
  ].join('\n');
}

function buildMonthlyStatsMessage(
  stats: MonthlyLedgerStats,
  timeDescription: string | undefined
): string {
  const label = timeDescription
    ? `统计范围：${timeDescription}`
    : `统计范围：${stats.year}年${stats.month}月`;
  const topCategories = (stats.categories || []).slice(0, 5);
  return [
    label,
    `总笔数：${stats.count}`,
    `总支出：¥${Number(stats.totalExpense || 0).toFixed(2)}`,
    `总收入：¥${Number(stats.totalIncome || 0).toFixed(2)}`,
    `结余：¥${Number(stats.balance || 0).toFixed(2)}`,
    topCategories.length
      ? `高频分类：${topCategories.map((item) => `${item.category}(${item.count}笔)`).join('、')}`
      : '高频分类：暂无',
  ].join('\n');
}

function buildYearlyStatsMessage(
  stats: YearlyLedgerStats,
  timeDescription: string | undefined
): string {
  const label = timeDescription ? `统计范围：${timeDescription}` : `统计范围：${stats.year}年`;
  const topCategories = (stats.categories || []).slice(0, 5);
  return [
    label,
    `总笔数：${stats.count}`,
    `总支出：¥${Number(stats.totalExpense || 0).toFixed(2)}`,
    `总收入：¥${Number(stats.totalIncome || 0).toFixed(2)}`,
    `结余：¥${Number(stats.balance || 0).toFixed(2)}`,
    topCategories.length
      ? `高频分类：${topCategories.map((item) => `${item.category}(${item.count}笔)`).join('、')}`
      : '高频分类：暂无',
  ].join('\n');
}

function buildKeywordMessage(
  keyword: string,
  records: WalletRecord[],
  stats: LedgerKeywordSearchStats,
  timeDescription: string | undefined
): string {
  const label = timeDescription ? `范围：${timeDescription}` : '范围：全部记录';
  const recordLines = records.map((record) => {
    const typeLabel = record.type === 'expense' ? '支出' : '收入';
    const detail = record.detail ? `（${record.detail}）` : '';
    return `- ID=${record.id} ${record.recordDate} ${typeLabel} ${record.category}${detail} ¥${Number(record.amount).toFixed(2)}`;
  });

  return [
    `关键词：${keyword}`,
    label,
    `命中记录数：${stats.count}`,
    `相关支出：¥${Number(stats.totalExpense || 0).toFixed(2)}`,
    `相关收入：¥${Number(stats.totalIncome || 0).toFixed(2)}`,
    recordLines.length ? '命中示例：' : '命中示例：暂无',
    ...recordLines,
  ].join('\n');
}

function summarizeRecords(records: WalletRecord[]): LedgerSummary {
  const summary: LedgerSummary = {
    count: records.length,
    totalExpense: 0,
    totalIncome: 0,
    balance: 0,
    topCategories: [],
  };

  const categoryMap = new Map<string, { category: string; count: number; amount: number }>();

  records.forEach((record) => {
    const amount = Number(record.amount) || 0;
    if (record.type === 'expense') {
      summary.totalExpense += amount;
    } else {
      summary.totalIncome += amount;
    }

    const current = categoryMap.get(record.category) || { category: record.category, count: 0, amount: 0 };
    current.count += 1;
    current.amount += amount;
    categoryMap.set(record.category, current);
  });

  summary.balance = summary.totalIncome - summary.totalExpense;
  summary.topCategories = Array.from(categoryMap.values())
    .sort((a, b) => b.count - a.count || b.amount - a.amount)
    .slice(0, 5);

  return summary;
}
