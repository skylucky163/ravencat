import type { DatabaseWriteExecutor } from '../runtime';
import { CHAT_BUBBLE_SKINS_SCHEMA } from './chatBubbleSkinSchema';

/** 老版本每侧唯一皮肤原样成为第一份作品，不丢掉切线、留白和已有小装饰。 */
export async function migrateChatBubbleSkinPresets(db: DatabaseWriteExecutor, version: number): Promise<void> {
  if (version < 151) return;
  await db.execAsync(`
    INSERT INTO chat_bubble_presets (id, role, name, revision, media_asset_id, width, height, config_json)
      SELECT 'migrated-' || role, role, CASE role WHEN 'user' THEN '我的气泡' ELSE 'AI 的气泡' END,
        1, media_asset_id, width, height, config_json FROM chat_bubble_skins;
    INSERT INTO chat_bubble_selections (role, preset_id) SELECT role, 'migrated-' || role FROM chat_bubble_skins;
  `);
  if (version >= 153) await db.execAsync(`
    INSERT INTO chat_bubble_preset_decorations (id, preset_id, slot, media_asset_id, width, height, config_json)
      SELECT d.id, 'migrated-' || d.role,
        (SELECT COUNT(*) FROM chat_bubble_decorations earlier WHERE earlier.role = d.role AND earlier.rowid < d.rowid),
        d.media_asset_id, d.width, d.height, d.config_json FROM chat_bubble_decorations d;
    DROP TABLE chat_bubble_decorations;
  `);
  await db.execAsync('DROP TABLE chat_bubble_skins;');
}

/** 154 的共享收藏各侧保留独立作品；仅共享媒体，不再共享配置和编辑身份。 */
export async function migrateChatBubbleSkinOwnership(db: DatabaseWriteExecutor): Promise<void> {
  await db.execAsync(`
    ALTER TABLE chat_bubble_presets RENAME TO chat_bubble_shared_presets;
    ALTER TABLE chat_bubble_preset_decorations RENAME TO chat_bubble_shared_decorations;
    ALTER TABLE chat_bubble_selections RENAME TO chat_bubble_shared_selections;
  `);
  await db.execAsync(CHAT_BUBBLE_SKINS_SCHEMA);
  await db.execAsync(`
    INSERT INTO chat_bubble_presets (id, role, name, revision, media_asset_id, width, height, config_json)
      SELECT r.role || ':' || p.id, r.role, p.name, p.revision, p.media_asset_id, p.width, p.height, p.config_json
      FROM chat_bubble_shared_presets p CROSS JOIN (SELECT 'user' AS role UNION ALL SELECT 'ai') r;
    INSERT INTO chat_bubble_preset_decorations (id, preset_id, slot, media_asset_id, width, height, config_json)
      SELECT p.role || ':' || d.id, p.id, d.slot, d.media_asset_id, d.width, d.height, d.config_json
      FROM chat_bubble_shared_decorations d JOIN chat_bubble_presets p ON p.id = p.role || ':' || d.preset_id;
    INSERT INTO chat_bubble_selections (role, preset_id)
      SELECT role, role || ':' || preset_id FROM chat_bubble_shared_selections;
    DROP TABLE chat_bubble_shared_selections;
    DROP TABLE chat_bubble_shared_decorations;
    DROP TABLE chat_bubble_shared_presets;
  `);
}
