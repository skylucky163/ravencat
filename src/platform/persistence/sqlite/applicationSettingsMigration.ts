import type { DatabaseWriteExecutor } from '../runtime';

/** 设置工具身份升级只迁移用户选择，不保留旧运行入口或扩大已有权限。 */
export async function migrateApplicationSettingsTools(db: DatabaseWriteExecutor): Promise<void> {
  await db.execAsync(`
    INSERT OR IGNORE INTO assistant_tool_permissions (assistant_id, tool_name, enabled, updated_at)
      SELECT assistant_id, 'set_ai_avatar', enabled, updated_at
      FROM assistant_tool_permissions WHERE tool_name = 'change_own_avatar';
    DELETE FROM assistant_tool_permissions WHERE tool_name = 'change_own_avatar';
    INSERT OR IGNORE INTO assistant_direct_tools (assistant_id, tool_name)
      SELECT assistant_id, 'set_ai_avatar' FROM assistant_direct_tools WHERE tool_name = 'change_own_avatar';
    DELETE FROM assistant_direct_tools WHERE tool_name = 'change_own_avatar';
    INSERT OR IGNORE INTO prompt_default_switches (key, enabled)
      SELECT 'tool:set_ai_avatar', enabled FROM prompt_default_switches WHERE key = 'tool:change_own_avatar';
    DELETE FROM prompt_default_switches WHERE key = 'tool:change_own_avatar';
    INSERT OR IGNORE INTO assistant_tool_permissions (assistant_id, tool_name, enabled, updated_at)
      SELECT assistant_id,
        CASE tool_name WHEN 'get_own_profile_cover' THEN 'get_own_space_cover' ELSE 'set_own_space_cover' END,
        enabled, updated_at
      FROM assistant_tool_permissions WHERE tool_name IN ('get_own_profile_cover', 'set_own_profile_cover');
    DELETE FROM assistant_tool_permissions WHERE tool_name IN ('get_own_profile_cover', 'set_own_profile_cover');
    INSERT OR IGNORE INTO assistant_direct_tools (assistant_id, tool_name)
      SELECT assistant_id,
        CASE tool_name WHEN 'get_own_profile_cover' THEN 'get_own_space_cover' ELSE 'set_own_space_cover' END
      FROM assistant_direct_tools WHERE tool_name IN ('get_own_profile_cover', 'set_own_profile_cover');
    DELETE FROM assistant_direct_tools WHERE tool_name IN ('get_own_profile_cover', 'set_own_profile_cover');
    INSERT OR IGNORE INTO prompt_default_switches (key, enabled)
      SELECT CASE key WHEN 'tool:get_own_profile_cover' THEN 'tool:get_own_space_cover' ELSE 'tool:set_own_space_cover' END, enabled
      FROM prompt_default_switches WHERE key IN ('tool:get_own_profile_cover', 'tool:set_own_profile_cover');
    DELETE FROM prompt_default_switches WHERE key IN ('tool:get_own_profile_cover', 'tool:set_own_profile_cover');
  `);
}
