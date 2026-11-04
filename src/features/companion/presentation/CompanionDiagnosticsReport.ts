/** 仅格式化原生阶段事实；未记录与成功、未投递与尚未观测不能互相替代。 */
import type { CompanionNativeHealth, CompanionScheduleDiagnostic, CompanionScheduleDiagnostics } from '../application/CompanionNativePort';

const stages: Record<string, string> = {
  PROJECTION_ARMED: '系统调度已登记', ALARM_RECEIVED: '闹钟广播到达',
  ALARM_WORK_ENQUEUED: '闹钟已提交执行任务', ALARM_ENQUEUE_FAILED: '闹钟提交任务失败',
  WORKER_STARTED: '后台任务开始', GATE_REJECTED: '重复或过期投递被拦截',
  HOST_STARTED: '执行宿主开始', FOREGROUND_REQUESTED: '请求建立执行期前台服务',
  FOREGROUND_STARTED: '执行期前台服务已建立', FOREGROUND_REJECTED: '执行期前台服务被拒绝',
  HEADLESS_REQUESTED: '请求启动 JS 任务', HEADLESS_ACCEPTED: '系统接受 JS 任务启动',
  HEADLESS_REJECTED: 'JS 任务启动被拒绝', RUNNER_COMPLETED: '收到 JS 终态回执',
  CANCELLATION_REQUESTED: '宿主请求取消', HOST_FINISHED: '执行宿主收口',
};

export function buildCompanionDiagnosticsReport(health: CompanionNativeHealth, diagnostics: CompanionScheduleDiagnostics, capturedAt: Date): string {
  const { device } = diagnostics;
  const groups = new Map<string, CompanionScheduleDiagnostic[]>();
  for (const event of diagnostics.events) {
    const group = groups.get(event.deliveryEventId);
    if (group) group.push(event);
    else groups.set(event.deliveryEventId, [event]);
  }
  return [
    'RavenCat 日程运行诊断',
    `采集时间：${capturedAt.toLocaleString('zh-CN', { hour12: false })}`,
    `时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    `版本：${device.versionName} (${device.versionCode}) / ${device.packageName}`,
    `设备：${device.manufacturer} ${device.model} / Android API ${device.apiLevel}`,
    `当前状态：${powerState(device)}`,
    `伴随调度开关：${yesNo(diagnostics.companionSchedulingEnabled)}`,
    `剩余系统投影：${health.companionSchedulerActive ? '有' : '无'}；最近计划时间：${time(health.nextCompanionWakeAtEpochMs)}`,
    `应用持续后台运行：${yesNo(health.applicationBackgroundRunning)}`,
    `悬浮窗前台服务：${yesNo(health.overlayForegroundServiceRunning)}（独立于日程执行）`,
    `最近宿主收口：${health.lastCompanionExecutionOutcome ?? '未记录'} / ${time(health.lastCompanionExecutionAtEpochMs)}`,
    `该次投递：${health.lastCompanionExecutionDeliveryEventId ?? '未记录'}；收口时前台服务：${yesNo(health.lastCompanionExecutionForegroundRunning)}`,
    '',
    `阶段记录（${diagnostics.events.length} 条，最多保留最近 80 条）：`,
    '系统接受 JS 启动、收到终态回执、模型成功和实际发出消息是不同事实。',
    '未记录不等于未发生；旧阶段可能已被保留上限淘汰，升级前的过程无法补录。',
    ...[...groups.entries()].reverse().flatMap(([id, events]) => {
      const planned = events.find(event => event.expectedRemindAtEpochMs !== null)?.expectedRemindAtEpochMs ?? null;
      const worker = events.find(event => event.stage === 'WORKER_STARTED');
      return [
        '', `投递：${id}`, `原定时间：${planned === null ? '未记录' : time(planned)}`,
        ...(planned !== null && worker ? [`后台任务延迟：${Math.round((worker.recordedAtEpochMs - planned) / 1000)} 秒`] : []),
        ...events.map(event => `${time(event.recordedAtEpochMs)} ${stages[event.stage] ?? event.stage}${event.outcome === null ? '' : ` [${event.outcome}]`}\n  ${powerState(event)}`),
      ];
    }),
    ...(groups.size === 0 ? ['尚无阶段记录，请在此版本安排一次未来日程后测试。'] : []),
  ].join('\n');
}

function powerState(value: { deviceIdleMode: boolean; powerSaveMode: boolean; batteryOptimizationExempt: boolean }): string {
  return `Doze=${yesNo(value.deviceIdleMode)}，省电模式=${yesNo(value.powerSaveMode)}，电池优化豁免=${yesNo(value.batteryOptimizationExempt)}`;
}

function yesNo(value: boolean): string { return value ? '是' : '否'; }
function time(epochMs: number): string {
  return epochMs === 0 ? '未记录' : new Date(epochMs).toLocaleString('zh-CN', { hour12: false });
}
