/** 只派发系统闹钟 Intent，不持有闹钟事实或自建后台计时。 */
import DeviceControl, { type SystemAlarmResult } from '../../../modules/device-control';

export interface SystemAlarmRequest {
  hour: number;
  minute: number;
  label?: string;
  /** ISO 星期：1=周一，7=周日；省略或空数组表示一次性。 */
  daysOfWeek?: number[];
}

export type SystemAlarmTarget =
  | { mode: 'next' | 'all' }
  | { mode: 'time'; hour: number; minute: number }
  | { mode: 'label'; label: string };

export function showSystemAlarms(): Promise<SystemAlarmResult> {
  return DeviceControl.showSystemAlarms();
}

export function dismissSystemAlarm(target: SystemAlarmTarget): Promise<SystemAlarmResult> {
  return DeviceControl.dismissSystemAlarm(target.mode,
    target.mode === 'time' ? target.hour : null,
    target.mode === 'time' ? target.minute : null,
    target.mode === 'label' ? target.label : null);
}

export function snoozeSystemAlarm(minutes?: number): Promise<SystemAlarmResult> {
  return DeviceControl.snoozeSystemAlarm(minutes ?? null);
}

export function getNextSystemAlarm() {
  return DeviceControl.getNextSystemAlarm();
}

export function setSystemAlarm(request: SystemAlarmRequest): Promise<SystemAlarmResult> {
  return DeviceControl.setSystemAlarm(
    request.hour, request.minute, request.label ?? null, request.daysOfWeek ?? [],
  );
}
