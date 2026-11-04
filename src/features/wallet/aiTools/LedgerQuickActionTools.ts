/** 快捷记账工具复用 Wallet 仓储与提交用例；模型参数由 Runtime schema 边界校验。 */
import type { Tool, ToolContext } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { applyQuickActionAndReply } from '../application/UseQuickAction';
import type { ILedgerRepository, UpdateQuickActionInput } from '../domain/LedgerRepository';
import type { QuickAction } from '../domain/WalletRecord';

type CreateQuickActionArgs = Pick<QuickAction, 'name' | 'type' | 'category' | 'amount'>
  & Partial<Pick<QuickAction, 'detail' | 'sortOrder'>>;

const quickActionFields = {
  name: { type: 'string', pattern: '\\S', description: '快捷记账名称，如早餐、地铁' },
  type: { type: 'string', enum: ['expense', 'income'], description: '支出或收入' },
  category: {
    type: 'string', pattern: '\\S',
    description: '分类标签，优先复用 getLedgerContext categories 模式返回的原名；具体消费内容写入 detail，避免另创同义分类',
  },
  amount: { type: 'number', exclusiveMinimum: 0, description: '模板金额（元），必须来自用户提供的信息，不能猜测' },
  detail: { type: 'string', description: '账单备注；未填写或设为空字符串时，使用模板生成的账单以快捷记账名称作为备注' },
  sortOrder: { type: 'integer', minimum: 0, description: '显示排序权重，越小越靠前；不是唯一编号，允许同值和空缺。创建时通常省略，由系统排到末尾；仅用户要求调整顺序时指定' },
};

const quickActionIdField = {
  type: 'string', pattern: '\\S',
  description: 'getLedgerContext quickActions 模式或创建工具返回的真实快捷记账 ID，不能编造或使用账单 ID',
};

const updateQuickActionParameters = {
  type: 'object', properties: { quickActionId: quickActionIdField, ...quickActionFields },
  required: ['quickActionId'], additionalProperties: false,
  anyOf: Object.keys(quickActionFields).map((field) => ({ required: [field] })),
};

export const CreateLedgerQuickActionTool: Tool<CreateQuickActionArgs, ToolContext> = {
  name: 'createLedgerQuickAction',
  definition: {
    name: 'createLedgerQuickAction',
    description: '创建可重复使用的快捷记账模板，不会新增账单。先查询 getLedgerContext 的 quickActions 模式避免重复，并用 categories 模式复用分类。',
    parameters: {
      type: 'object', properties: quickActionFields,
      required: ['name', 'type', 'category', 'amount'], additionalProperties: false,
    },
  },
  async execute(args, context) {
    const repository = context.repositories.ledger as ILedgerRepository | null;
    if (!repository) return { success: false, error: '账本仓储未注入，无法创建快捷记账' };
    throwIfAbortSignalAborted(context.abortSignal);
    const quickAction = await repository.insertQuickAction(args);
    return {
      success: true,
      message: `已创建快捷记账模板（未新增账单）：${JSON.stringify(quickAction)}`,
      data: { quickAction },
    };
  },
};

export const UpdateLedgerQuickActionTool: Tool<UpdateQuickActionInput & { quickActionId: string }, ToolContext> = {
  name: 'updateLedgerQuickAction',
  definition: {
    name: 'updateLedgerQuickAction',
    description: '编辑快捷记账模板，只传需要修改的字段，其余保持原值；不影响已有账单。修改分类前查询 categories 模式，多条候选无法区分时先询问。',
    parameters: updateQuickActionParameters,
  },
  async execute({ quickActionId, ...updates }, context) {
    const repository = context.repositories.ledger as ILedgerRepository | null;
    if (!repository) return { success: false, error: '账本仓储未注入，无法编辑快捷记账' };
    throwIfAbortSignalAborted(context.abortSignal);
    const changed = await repository.updateQuickAction(quickActionId, updates);
    if (!changed) return { success: false, error: '快捷记账不存在，可能已被删除，请重新查询' };
    return {
      success: true,
      message: `已编辑快捷记账 ID=${quickActionId}，修改字段：${JSON.stringify(updates)}；已有账单不受影响。`,
      data: { quickActionId, updates },
    };
  },
};

export const DeleteLedgerQuickActionTool: Tool<{ quickActionId: string }, ToolContext> = {
  name: 'deleteLedgerQuickAction',
  definition: {
    name: 'deleteLedgerQuickAction',
    description: '删除快捷记账模板，不删除由它产生的已有账单；多条候选无法区分时先询问。',
    parameters: {
      type: 'object', properties: { quickActionId: quickActionIdField },
      required: ['quickActionId'], additionalProperties: false,
    },
  },
  async execute({ quickActionId }, context) {
    const repository = context.repositories.ledger as ILedgerRepository | null;
    if (!repository) return { success: false, error: '账本仓储未注入，无法删除快捷记账' };
    throwIfAbortSignalAborted(context.abortSignal);
    const changed = await repository.deleteQuickAction(quickActionId);
    if (!changed) return { success: false, error: '快捷记账不存在，可能已被删除，请重新查询' };
    return {
      success: true,
      message: `已删除快捷记账 ID=${quickActionId}；已有账单不受影响。`,
      data: { quickActionId },
    };
  },
};

export const UseLedgerQuickActionTool: Tool<{ quickActionId: string; recordDate?: string }, ToolContext> = {
  name: 'useLedgerQuickAction',
  definition: {
    name: 'useLedgerQuickAction',
    description: '使用快捷记账模板，按其当前收支类型、分类、金额和备注新增一笔账单，未填写备注时以模板名称作为备注，返回真实账单 ID；每次调用都会新增，不要为同一笔消费重复调用。多条候选无法区分时先询问。',
    parameters: {
      type: 'object',
      properties: {
        quickActionId: quickActionIdField,
        recordDate: { type: 'string', format: 'date', description: '账单日期，YYYY-MM-DD；省略表示用户当地今天' },
      },
      required: ['quickActionId'], additionalProperties: false,
    },
  },
  async execute(args, context) {
    const repository = context.repositories.ledger as ILedgerRepository | null;
    if (!repository) return { success: false, error: '账本仓储未注入，无法使用快捷记账' };
    throwIfAbortSignalAborted(context.abortSignal);
    const result = await applyQuickActionAndReply(args, {}, { repository });
    if (!result.success) return { success: false, error: result.error! };
    return {
      success: true,
      message: `已使用快捷记账 ID=${args.quickActionId} 新增账单：${JSON.stringify(result.record!)}`,
      data: { quickActionId: args.quickActionId, record: result.record! },
    };
  },
};
