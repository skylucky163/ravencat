/** 模型参数由 Agent Runtime 的 schema 边界校验；账单写入仍由 Wallet 用例和仓储负责。 */
import type { Tool, ToolContext } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { addWalletRecord } from '../application/AddRecord';
import type { ILedgerRepository, UpdateWalletRecordInput } from '../domain/LedgerRepository';
import { DEFAULT_WALLET_CATEGORIES, type WalletRecordType } from '../domain/WalletRecord';

interface AddLedgerRecordArgs {
  type: WalletRecordType;
  category: string;
  amount: number;
  detail?: string;
  recordDate?: string;
}

interface UpdateLedgerRecordArgs extends UpdateWalletRecordInput {
  recordId: string;
}

// 「不能猜测金额」与「必须用真实账单 ID」由下面参数 schema 表达，工具 description 不再复述。
const recordFields = {
  type: { type: 'string', enum: ['expense', 'income'], description: '支出或收入' },
  category: {
    type: 'string', pattern: '\\S',
    description: `分类标签。支出预设：${DEFAULT_WALLET_CATEGORIES.expense.join('、')}；收入预设：${DEFAULT_WALLET_CATEGORIES.income.join('、')}。优先复用预设或已有自定义分类的原名，不为同义概念另创名称；具体消费内容写入 detail。只有已有分类确实不适用或用户明确要求时才使用新分类。`,
  },
  amount: { type: 'number', exclusiveMinimum: 0, description: '实际金额（元），必须来自用户提供的信息，不能猜测' },
  detail: { type: 'string', description: '备注，如午餐吃牛肉面；空字符串可清除备注' },
  recordDate: { type: 'string', format: 'date', description: '账单日期，YYYY-MM-DD；新增时省略表示用户当地今天' },
};

const recordIdField = {
  type: 'string', pattern: '\\S',
  description: '查询或新增工具返回的账单 ID；必须使用真实 ID，不能编造',
};

const updateRecordParameters = {
  type: 'object', properties: { recordId: recordIdField, ...recordFields },
  required: ['recordId'], additionalProperties: false,
  // 编辑必须包含至少一个业务字段，不能只更新时间戳。
  anyOf: Object.keys(recordFields).map((field) => ({ required: [field] })),
};

export const AddLedgerRecordTool: Tool<AddLedgerRecordArgs, ToolContext> = {
  name: 'addLedgerRecord',
  definition: {
    name: 'addLedgerRecord',
    description: '把用户告知/要求的消费或收入记入羽库；已有账单不要重复新增。记账前用 getLedgerContext 的 categories 模式查询已有分类，尽量复用，避免另创同义标签。成功后返回账单 ID。',
    parameters: {
      type: 'object', properties: recordFields,
      required: ['type', 'category', 'amount'], additionalProperties: false,
    },
  },
  async execute(args, context) {
    const repository = context.repositories.ledger as ILedgerRepository | null;
    if (!repository) return { success: false, error: '账本仓储未注入，无法新增账单' };
    throwIfAbortSignalAborted(context.abortSignal);
    // 本轮聊天已经负责回应用户，不安排记账自动回复。
    const result = await addWalletRecord(args, {}, { repository });
    if (!result.success) return { success: false, error: result.error! };
    const record = result.record!;
    return {
      success: true,
      message: `已新增账单：${JSON.stringify(record)}`,
      data: { record },
    };
  },
};

export const UpdateLedgerRecordTool: Tool<UpdateLedgerRecordArgs, ToolContext> = {
  name: 'updateLedgerRecord',
  definition: {
    name: 'updateLedgerRecord',
    description: '编辑账单；只传需要改的字段，其余保持原值。修改分类前用 getLedgerContext 的 categories 模式查询已有分类，尽量复用，避免另创同义标签。多条无法区分时先询问。',
    parameters: updateRecordParameters,
  },
  async execute({ recordId, ...updates }, context) {
    const ledgerRepository = context.repositories.ledger as ILedgerRepository | null;
    if (!ledgerRepository) return { success: false, error: '账本仓储未注入，无法编辑账单' };
    throwIfAbortSignalAborted(context.abortSignal);
    const changed = await ledgerRepository.updateRecord(recordId, updates);
    if (!changed) return { success: false, error: '账单不存在，可能已被删除，请重新查询' };
    return {
      success: true,
      message: `已编辑账单 ID=${recordId}，修改字段：${JSON.stringify(updates)}`,
      data: { recordId, updates },
    };
  },
};

export const DeleteLedgerRecordTool: Tool<{ recordId: string }, ToolContext> = {
  name: 'deleteLedgerRecord',
  definition: {
    name: 'deleteLedgerRecord',
    description: '删除账单；多条候选无法区分时先询问，不要随意删除。',
    parameters: {
      type: 'object', properties: { recordId: recordIdField },
      required: ['recordId'], additionalProperties: false,
    },
  },
  async execute({ recordId }, context) {
    const ledgerRepository = context.repositories.ledger as ILedgerRepository | null;
    if (!ledgerRepository) return { success: false, error: '账本仓储未注入，无法删除账单' };
    throwIfAbortSignalAborted(context.abortSignal);
    const changed = await ledgerRepository.deleteRecord(recordId);
    if (!changed) return { success: false, error: '账单不存在，可能已被删除，请重新查询' };
    return { success: true, message: `已删除账单 ID=${recordId}`, data: { recordId } };
  },
};
