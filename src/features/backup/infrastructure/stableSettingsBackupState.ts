/** 稳定设置保存未进入 SQLite 的主题、原生装扮、服务凭据与 AI 请求诊断。 */

export interface ParsedStableSettingsBackup {
  /** 仍有真实 legacy owner 时用于数据库重定位，收口后移除。 */
  legacyMediaRootUri: string;
  theme: unknown;
  bubbleSkins: unknown;
  /** 早期 schema 5 未导出搜索凭据，缺少此字段时保留原有恢复行为。 */
  searchCredentials?: unknown;
  /** 早期 schema 5 未导出 MCP 凭据，旧包缺少字段时不改变本机凭据。 */
  mcpCredentials?: unknown;
  /** 旧包没有导出请求诊断，缺少字段时保留本机现有状态。 */
  aiHttpDiagnostics?: unknown;
}

/** schema 5：背景已进入 SQLite，临时快照默认排除；来源根只服务剩余历史头像/附件。 */
export const STABLE_SETTINGS_BACKUP_SCHEMA_VERSION = 5;

export function parseStableSettingsBackupJson(json: string): ParsedStableSettingsBackup {
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('备份稳定设置无效');
  }

  const settings = parsed as Record<string, unknown>;
  if (settings.schemaVersion !== STABLE_SETTINGS_BACKUP_SCHEMA_VERSION) {
    throw new Error('不支持的稳定设置版本');
  }
  const legacyMediaRootUri = settings.legacyMediaRootUri;
  if (typeof legacyMediaRootUri !== 'string'
    || !/^file:\/\/\/.+\/persistent-media\/$/u.test(legacyMediaRootUri)
    || /[\\%?#\u0000-\u001f]/u.test(legacyMediaRootUri)
    || legacyMediaRootUri.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('备份来源长期媒体根无效');
  }
  if (!settings.theme || typeof settings.theme !== 'object') {
    throw new Error('备份主题设置无效');
  }


  if (!settings.bubbleSkins || typeof settings.bubbleSkins !== 'object') {
    throw new Error('备份悬浮球装扮设置无效');
  }

  return {
    legacyMediaRootUri,
    theme: settings.theme,
    bubbleSkins: settings.bubbleSkins,
    ...(Object.hasOwn(settings, 'searchCredentials') ? { searchCredentials: settings.searchCredentials } : {}),
    ...(Object.hasOwn(settings, 'mcpCredentials') ? { mcpCredentials: settings.mcpCredentials } : {}),
    ...(Object.hasOwn(settings, 'aiHttpDiagnostics') ? { aiHttpDiagnostics: settings.aiHttpDiagnostics } : {}),
  };
}
