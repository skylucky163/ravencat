/** 私有下载素材是持久业务引用；角色删除后由媒体 owner 裁决共享文件回收。 */
export const AI_DOWNLOADED_IMAGES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ai_downloaded_images (
    id TEXT PRIMARY KEY NOT NULL,
    assistant_id TEXT NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
    media_asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
    source_url TEXT NOT NULL,
    file_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;
/** 用户生图只写相册；这里仅保存共享选择与角色的私有生成引用。 */
export const IMAGE_GENERATION_SETTINGS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS media_image_generation_settings (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    model_config_id TEXT
  );
`;

export const AI_GENERATED_IMAGES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ai_generated_images (
    id TEXT PRIMARY KEY NOT NULL,
    assistant_id TEXT NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
    media_asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
    file_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

export const AI_GENERATED_IMAGES_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_ai_generated_images_assistant_created ON ai_generated_images(assistant_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ai_generated_images_media_asset ON ai_generated_images(media_asset_id);
`;
