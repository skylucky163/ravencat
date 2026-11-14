import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = 'src/features/companion/aiTools/AIScheduleTools.ts';
const compiled = ts.transpileModule(
  fs.readFileSync(path.join(repoRoot, sourcePath), 'utf8'),
  {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
    reportDiagnostics: true,
  },
);
assert.deepEqual(
  (compiled.diagnostics ?? []).filter(({ category }) => category === ts.DiagnosticCategory.Error),
  [],
);

let currentHostAIId = 'host-ai';
const calls = [];
const schedule = {
  scheduleId: 'schedule-a',
  ownerAIId: 'host-ai',
  systemCalendar: true,
  remindAt: '2026-09-10T09:00:00.000Z',
  summary: '考试',
  details: '数据库考试',
  sourceConversationId: null,
  sourceMessageIds: null,
  sourceExcerpt: null,
  status: 'scheduled',
  claimedByRunId: null,
  claimedAt: null,
  consumedAt: null,
  cancelledAt: null,
  createdAt: '2026-09-09T08:00:00.000Z',
  updatedAt: '2026-09-09T08:00:00.000Z',
};
const application = {
  setAIScheduleFollowUpInterval: async (input) => {
    calls.push(['interval',input]);
    return { status:'updated',schedule:{...schedule,nextFollowUpMinutes:input.minutes} };
  },
  listAISchedulesQuery: async (input) => {
    calls.push(['list', input]);
    return {
      status: 'listed',
      page: {
        items: [{ scheduleId: schedule.scheduleId, remindAt: schedule.remindAt, summary: schedule.summary, status: schedule.status }],
        nextCursor: null,
        hasMore: false,
      },
    };
  },
  getAIScheduleQuery: async (input) => {
    calls.push(['get', input]);
    return { status: 'found', schedule };
  },
};

let projectionMode = 'projected';
let calendarMode = 'synced';
let createError = null;
function projectionFor(operation) {
  return projectionMode === 'failed'
    ? { status: 'projection_failed', operation, error: new Error('native unavailable') }
    : { status: operation === 'cancel' ? 'canceled' : 'projected' };
}

const projectionOwner = {
  removeAIScheduleCalendarEvents: async (input) => {
    calls.push(['remove-calendar',input]);
    return {status:'updated',matchedCount:3,updatedCount:2,removedCount:calendarMode==='synced'?3:0,
      pendingCount:calendarMode==='synced'?0:null,calendar:calendarMode};
  },
  createAIScheduleWithProjection: async (input) => {
    calls.push(['create', input]);
    if (createError) return { status: 'error', code: createError, projection: null };
    return { status: 'created', schedule: { ...schedule, systemCalendar: input.systemCalendar }, calendar: calendarMode, projection: projectionFor('schedule') };
  },
  updateAIScheduleWithProjection: async (input) => {
    calls.push(['update', input]);
    return { status: 'updated', schedule: { ...schedule, summary: input.summary ?? schedule.summary }, calendar: 'synced', projection: projectionFor('schedule') };
  },
  cancelAIScheduleWithProjection: async (input) => {
    calls.push(['cancel', input]);
    return { status: 'cancelled', schedule: { ...schedule, status: 'cancelled' }, calendar: 'synced', projection: projectionFor('cancel') };
  },
};

const module = { exports: {} };
new Function('exports', 'require', 'module', compiled.outputText)(
  module.exports,
  (specifier) => {
    if (specifier === '@features/assistants') {
      return {
        runAsCurrentHostAuthority: async (actorAIId, action) => (
          actorAIId === currentHostAIId
            ? { status: 'authorized', value: await action() }
            : { status: 'not_current_host' }
        ),
      };
    }
    if (specifier === '@shared/runtime/abortSignal') {
      return {
        throwIfAbortSignalAborted: (signal) => {
          if (signal.aborted) throw signal.reason;
        },
      };
    }
    if (specifier === '../application/AIScheduleApplication') return application;
    if (specifier === '../application/AIScheduleProjectionOwner') return projectionOwner;
    throw new Error(`未声明的运行时依赖：${specifier}`);
  },
  module,
);

const tools = [
  module.exports.CreateAIScheduleTool,
  module.exports.ListAISchedulesTool,
  module.exports.GetAIScheduleTool,
  module.exports.UpdateAIScheduleTool,
  module.exports.CancelAIScheduleTool,
  module.exports.RemoveAIScheduleCalendarEventsTool,
];
assert.deepEqual(tools.map(({ name }) => name), [
  'create_ai_schedule',
  'list_ai_schedules',
  'get_ai_schedule',
  'update_ai_schedule',
  'cancel_ai_schedule',
  'remove_ai_schedule_calendar_events',
]);
assert.ok(tools.every((tool) => tool.definition.parameters.additionalProperties === false));

const context = {
  runId: 'run-a',
  toolCallId: 'call-a',
  abortSignal: new AbortController().signal,
  task: {
    id: 'task-a',
    type: 'chat',
    source: 'chat',
    goal: 'test',
    assistantId: 'host-ai',
    sessionId: 'session-a',
    allowedToolNames: tools.map(({ name }) => name),
    modelTransport: 'complete',
    maxSteps: 4,
    maxToolCalls: 8,
    maxToolCallsPerStep: 4,
    createdAt: '2026-09-09T08:00:00.000Z',
  },
};

assert.equal((await tools[0].execute({
  remind_at: schedule.remindAt,
  summary: schedule.summary,
  details: schedule.details,
  source_message_ids: ['11'],
}, context)).status, 'success');
const listResult = await tools[1].execute({
  from: '2026-09-09T00:00:00.000Z',
  to: '2026-09-12T00:00:00.000Z',
  status: 'all',
}, context);
assert.equal(listResult.status, 'success');
assert.deepEqual(Object.keys(listResult.data.items[0]).sort(), ['remindAt', 'scheduleId', 'status', 'summary']);
assert.equal((await tools[2].execute({ schedule_id: 'schedule-a' }, context)).status, 'success');
assert.equal((await tools[3].execute({ schedule_id: 'schedule-a', summary: '改期考试' }, context)).status, 'success');
assert.equal((await tools[4].execute({ schedule_id: 'schedule-a' }, context)).status, 'success');
assert.deepEqual(calls.map(([name]) => name), ['create', 'list', 'get', 'update', 'cancel']);
assert.equal(calls[0][1].sourceConversationId, 'session-a');
assert.equal(calls[0][1].systemCalendar, true);
await tools[0].execute({ remind_at: schedule.remindAt, summary: schedule.summary, details: schedule.details, system_calendar: false }, context);
assert.equal(calls.at(-1)[1].systemCalendar, false);
const repeat = { frequency:'daily',timeZone:'Asia/Shanghai',hour:9,minute:0 };
await tools[0].execute({ remind_at:schedule.remindAt,summary:schedule.summary,details:schedule.details,recurrence:repeat },context);
assert.deepEqual(calls.at(-1)[1].recurrence,repeat,'重复规则交给唯一日程应用入口');
const interval = await tools[3].execute({schedule_id:schedule.scheduleId,next_follow_up_minutes:2},context);
assert.equal(interval.status,'success');
assert.deepEqual(calls.at(-1),['interval',{scheduleId:schedule.scheduleId,ownerAIId:'host-ai',runId:context.runId,minutes:2}]);
assert.match(interval.modelContent,/用户默认值和系统日历未改变/);
assert.equal((await tools[3].execute({schedule_id:schedule.scheduleId,next_follow_up_minutes:2,summary:'混合修改'},context)).status,'error');

// native projection 失败仍返回 durable degraded success；模型必须知道不要重复业务操作。
projectionMode = 'failed';
const degradedCreate = await tools[0].execute({
  remind_at: schedule.remindAt,
  summary: schedule.summary,
  details: schedule.details,
}, context);
assert.equal(degradedCreate.status, 'success');
assert.equal(degradedCreate.data.projectionStatus, 'projection_failed');
assert.equal(degradedCreate.data.projectionOperation, 'schedule');
assert.match(degradedCreate.modelContent, /不要重复创建/);

const degradedUpdate = await tools[3].execute({
  schedule_id: schedule.scheduleId,
  summary: '暂时更新',
}, context);
assert.equal(degradedUpdate.status, 'success');
assert.equal(degradedUpdate.data.projectionStatus, 'projection_failed');
assert.equal(degradedUpdate.data.projectionOperation, 'schedule');
assert.match(degradedUpdate.modelContent, /不要重复更新/);

const degradedCancel = await tools[4].execute({ schedule_id: schedule.scheduleId }, context);
assert.equal(degradedCancel.status, 'success');
assert.equal(degradedCancel.data.projectionStatus, 'projection_failed');
assert.equal(degradedCancel.data.projectionOperation, 'cancel');
assert.match(degradedCancel.modelContent, /不要重复取消/);
projectionMode = 'projected';

// 模型可明确区分提交前拒绝与提交后系统提醒未同步，避免生成重复日程。
createError = 'calendar_permission_required';
const missingCalendarPermission = await tools[0].execute({
  remind_at: schedule.remindAt, summary: schedule.summary, details: schedule.details,
}, context);
assert.equal(missingCalendarPermission.status, 'error');
assert.equal(missingCalendarPermission.code, 'CALENDAR_PERMISSION_REQUIRED');
assert.match(missingCalendarPermission.modelContent, /system_calendar=false/);
createError = null;
calendarMode = 'failed';
const calendarPartialSuccess = await tools[0].execute({
  remind_at: schedule.remindAt, summary: schedule.summary, details: schedule.details,
}, context);
assert.equal(calendarPartialSuccess.status, 'success');
assert.equal(calendarPartialSuccess.data.scheduleId, schedule.scheduleId);
assert.equal(calendarPartialSuccess.data.calendarStatus, 'failed');
assert.match(calendarPartialSuccess.modelContent, /不要重复创建/);

calendarMode='synced';
const removed=await tools[5].execute({scope:'series',schedule_id:'schedule-a'},context);
assert.equal(removed.status,'success');
assert.deepEqual(calls.at(-1),['remove-calendar',{ownerAIId:'host-ai',scope:'series',scheduleId:'schedule-a'}]);
assert.equal(removed.data.removedCount,3);
assert.match(removed.modelContent,/未取消任何内部日程/);
calendarMode='permission_required';
const removalPending=await tools[5].execute({scope:'all'},context);
assert.equal(removalPending.status,'success');
assert.equal(removalPending.data.calendar,'permission_required');
assert.match(removalPending.modelContent,/尚未全部移除/);
assert.match(removalPending.modelContent,/不要取消内部日程/);

currentHostAIId = 'other-ai';
const denied = await tools[1].execute({
  from: '2026-09-09T00:00:00.000Z',
  to: '2026-09-12T00:00:00.000Z',
}, context);
assert.equal(denied.status, 'error');
assert.equal(denied.code, 'NOT_CURRENT_HOST');
const beforeDeniedRemoval=calls.length;
assert.equal((await tools[5].execute({scope:'all'},context)).code,'NOT_CURRENT_HOST');
assert.equal(calls.length,beforeDeniedRemoval,'撤销的主理身份不能执行清理');

console.log('AI Schedule 日程及独立系统日历移除工具行为检查通过。');
