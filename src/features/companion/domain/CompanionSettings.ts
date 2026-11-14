/** 定义“本地伴随”正式设置及其严格数据边界。 */
import { DEFAULT_FOLLOW_UP_MINUTES, isFollowUpInterval } from './AIScheduleTiming';

export const COMPANION_SETTINGS_ID = 'default';
export const DEFAULT_QUIET_HOURS_ENABLED = true;
export const DEFAULT_QUIET_HOURS_START_MINUTES = 23 * 60;
export const DEFAULT_QUIET_HOURS_END_MINUTES = 8 * 60;

export interface CompanionSettings {
  id: string;
  quietHoursEnabled: boolean;
  quietHoursStartMinutes: number;
  quietHoursEndMinutes: number;
  userScreenCaptureBlacklist: string[];
  followUpEnabled: boolean;
  followUpIntervalMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export type UpdateCompanionSettingsInput = Partial<Pick<
  CompanionSettings,
  | 'quietHoursEnabled'
  | 'quietHoursStartMinutes'
  | 'quietHoursEndMinutes'
  | 'userScreenCaptureBlacklist'
  | 'followUpEnabled'
  | 'followUpIntervalMinutes'
>>;

export interface CompanionSettingsRow {
  id: string;
  quiet_hours_enabled: number;
  quiet_hours_start_minutes: number;
  quiet_hours_end_minutes: number;
  user_screen_capture_blacklist_json: string;
  follow_up_enabled: number;
  follow_up_interval_minutes: number;
  created_at: string;
  updated_at: string;
}

export function createCompanionSettings(
  data: Partial<CompanionSettings> = {}
): CompanionSettings {
  const now = new Date().toISOString();
  const settings: CompanionSettings = {
    id: data.id ?? COMPANION_SETTINGS_ID,
    quietHoursEnabled:
      data.quietHoursEnabled ?? DEFAULT_QUIET_HOURS_ENABLED,
    quietHoursStartMinutes:
      data.quietHoursStartMinutes ?? DEFAULT_QUIET_HOURS_START_MINUTES,
    quietHoursEndMinutes:
      data.quietHoursEndMinutes ?? DEFAULT_QUIET_HOURS_END_MINUTES,
    userScreenCaptureBlacklist: normalizePackageList(
      data.userScreenCaptureBlacklist ?? []
    ),
    followUpEnabled: data.followUpEnabled ?? false,
    followUpIntervalMinutes: data.followUpIntervalMinutes ?? DEFAULT_FOLLOW_UP_MINUTES,
    createdAt: data.createdAt ?? now,
    updatedAt: data.updatedAt ?? now,
  };
  assertCompanionSettings(settings);
  return settings;
}

export function createCompanionSettingsFromRow(
  row: CompanionSettingsRow | null
): CompanionSettings | null {
  if (!row) return null;

  return createCompanionSettings({
    id: row.id,
    followUpEnabled: row.follow_up_enabled === 1,
    followUpIntervalMinutes: row.follow_up_interval_minutes,
    quietHoursEnabled: row.quiet_hours_enabled === 1,
    quietHoursStartMinutes: row.quiet_hours_start_minutes,
    quietHoursEndMinutes: row.quiet_hours_end_minutes,
    userScreenCaptureBlacklist: parsePackageList(
      row.user_screen_capture_blacklist_json
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function assertCompanionSettings(
  settings: Pick<
    CompanionSettings,
    | 'quietHoursEnabled'
    | 'quietHoursStartMinutes'
    | 'quietHoursEndMinutes'
    | 'followUpIntervalMinutes'
  >
): void {
  if (!isFollowUpInterval(settings.followUpIntervalMinutes)) throw new Error('续轮间隔必须为 2 至 43200 分钟的整数');
  assertIntegerInRange(
    settings.quietHoursStartMinutes,
    0,
    1439,
    'quietHoursStartMinutes'
  );
  assertIntegerInRange(
    settings.quietHoursEndMinutes,
    0,
    1439,
    'quietHoursEndMinutes'
  );
  if (settings.quietHoursStartMinutes === settings.quietHoursEndMinutes) {
    throw new Error('RavenCat 勿扰开始时间和结束时间不能相同');
  }
}

function parsePackageList(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('RavenCat 用户截图黑名单数据损坏');
  }
  return normalizePackageList(parsed);
}

function normalizePackageList(packages: readonly string[]): string[] {
  return [...new Set(packages.map((item) => item.trim()).filter(Boolean))].sort();
}

function assertIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  fieldName: string
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`RavenCat ${fieldName} 超出合法范围`);
  }
}
