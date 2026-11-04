/** 作品归属于一侧并拥有媒体引用；复合外键禁止跨侧启用，恢复默认不会删除组合。 */
export const CHAT_BUBBLE_SKINS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_bubble_presets (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('user', 'ai')),
    name TEXT NOT NULL,
    revision INTEGER NOT NULL,
    media_asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    config_json TEXT NOT NULL,
    UNIQUE (id, role)
  );
  CREATE TABLE IF NOT EXISTS chat_bubble_preset_decorations (
    id TEXT PRIMARY KEY,
    preset_id TEXT NOT NULL REFERENCES chat_bubble_presets(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 3),
    media_asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    config_json TEXT NOT NULL,
    UNIQUE (preset_id, slot)
  );
  CREATE TABLE IF NOT EXISTS chat_bubble_selections (
    role TEXT PRIMARY KEY CHECK (role IN ('user', 'ai')),
    preset_id TEXT NOT NULL,
    FOREIGN KEY (preset_id, role) REFERENCES chat_bubble_presets(id, role) ON DELETE CASCADE
  );
`;
