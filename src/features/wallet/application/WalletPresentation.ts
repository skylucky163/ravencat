/** 首页与历史详情共用的读取组装；写入命令由 composition 直接装配仓储。 */
import type { AIProfile, IAIAssistantRepository } from '@features/assistants';
import type { QuickAction, WalletCategories, WalletRecord } from '../domain/WalletRecord';
import type { ILedgerRepository } from '../domain/LedgerRepository';

export interface WalletPresentationDeps {
  assistantRepository: Pick<IAIAssistantRepository, 'getAll' | 'getLedgerAI'>;
  ledgerRepository: ILedgerRepository;
}

export interface WalletScreenData {
  records: WalletRecord[];
  quickActions: QuickAction[];
  categories: WalletCategories;
  monthlyStats: {
    expense: number;
    income: number;
  };
  aiList: AIProfile[];
  ledgerAI: AIProfile | null;
}

export async function getWalletScreenData(
  date: Date,
  deps: WalletPresentationDeps
): Promise<WalletScreenData> {
  const { assistantRepository, ledgerRepository } = deps;
  const [records, quickActions, stats, aiList, ledgerAI, categories] = await Promise.all([
    ledgerRepository.getRecords({
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      limit: 50,
    }),
    ledgerRepository.getQuickActions(),
    ledgerRepository.getMonthlyStats(date.getFullYear(), date.getMonth() + 1),
    assistantRepository.getAll(),
    assistantRepository.getLedgerAI(),
    getWalletCategories(deps),
  ]);

  return {
    records,
    quickActions,
    categories,
    monthlyStats: {
      expense: stats.totalExpense,
      income: stats.totalIncome,
    },
    aiList,
    ledgerAI,
  };
}

export async function getWalletCategories(
  deps: Pick<WalletPresentationDeps, 'ledgerRepository'>
): Promise<WalletCategories> {
  const [expense, income] = await Promise.all([
    deps.ledgerRepository.getCategories('expense'),
    deps.ledgerRepository.getCategories('income'),
  ]);
  return { expense, income };
}
