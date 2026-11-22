/** 提示词用户配置表、索引与目标删除清理触发器。 */

export const PROMPTING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS assistant_direct_tools (
    assistant_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    PRIMARY KEY (assistant_id, tool_name),
    FOREIGN KEY (assistant_id) REFERENCES ai_assistants(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS prompt_default_overrides (
    definition_id TEXT PRIMARY KEY,
    content TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS prompt_legacy_group_admin_texts (
    group_id TEXT PRIMARY KEY REFERENCES group_chats(id) ON DELETE CASCADE,
    group_name TEXT NOT NULL,
    content TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS prompt_default_switches (
    key TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
  );
  CREATE TABLE IF NOT EXISTS prompt_default_user_prompts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    sort_order INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS prompt_custom_blocks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    default_slot TEXT NOT NULL CHECK (default_slot IN ('persona', 'user_rules', 'scenario')),
    placement TEXT NOT NULL DEFAULT 'system' CHECK (placement = 'system'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prompt_presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    scenario_id TEXT NOT NULL,
    base_preset_id TEXT,
    token_budget INTEGER CHECK (token_budget IS NULL OR token_budget > 0),
    is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prompt_preset_items (
    id TEXT PRIMARY KEY,
    preset_id TEXT NOT NULL,
    definition_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    condition_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (preset_id) REFERENCES prompt_presets(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS prompt_bindings (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('global', 'assistant', 'group')),
    target_id TEXT,
    preset_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (target_type = 'global' AND target_id IS NULL)
      OR (target_type IN ('assistant', 'group') AND target_id IS NOT NULL AND length(target_id) > 0)
    ),
    FOREIGN KEY (preset_id) REFERENCES prompt_presets(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS assistant_prompt_settings (
    assistant_id TEXT PRIMARY KEY,
    language_mode TEXT NOT NULL DEFAULT 'system'
      CHECK (language_mode IN ('system', 'zh-CN', 'en-US')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (assistant_id) REFERENCES ai_assistants(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS assistant_prompt_definition_states (
    assistant_id TEXT NOT NULL,
    definition_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    sort_order INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (assistant_id, definition_id),
    FOREIGN KEY (assistant_id) REFERENCES ai_assistants(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS assistant_prompt_definition_overrides (
    assistant_id TEXT NOT NULL,
    definition_id TEXT NOT NULL,
    locale TEXT NOT NULL CHECK (locale IN ('zh-CN', 'en-US')),
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (assistant_id, definition_id, locale),
    FOREIGN KEY (assistant_id) REFERENCES ai_assistants(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS assistant_user_prompts (
    id TEXT PRIMARY KEY,
    assistant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    condition TEXT NOT NULL DEFAULT 'always'
      CHECK (condition IN ('always', 'private_chat', 'group_chat', 'call', 'moments', 'image_present', 'tools_enabled')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    sort_order INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (assistant_id) REFERENCES ai_assistants(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS assistant_user_prompt_archive (
    source_prompt_id TEXT PRIMARY KEY,
    assistant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    original_condition TEXT NOT NULL,
    original_enabled INTEGER NOT NULL CHECK (original_enabled IN (0, 1)),
    original_sort_order INTEGER NOT NULL,
    original_created_at TEXT NOT NULL,
    original_updated_at TEXT NOT NULL,
    archive_reason TEXT NOT NULL,
    archived_at TEXT NOT NULL,
    FOREIGN KEY (assistant_id) REFERENCES ai_assistants(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS prompt_migration_orphans (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL CHECK (source_type IN ('custom_block', 'preset', 'binding')),
    source_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assistant_tool_permissions (
    assistant_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (assistant_id, tool_name),
    FOREIGN KEY (assistant_id) REFERENCES ai_assistants(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_prompt_presets_scenario
    ON prompt_presets(scenario_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_prompt_preset_items_preset
    ON prompt_preset_items(preset_id, sort_order, id);
  CREATE INDEX IF NOT EXISTS idx_prompt_preset_items_definition
    ON prompt_preset_items(definition_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_bindings_target
    ON prompt_bindings(scenario_id, target_type, COALESCE(target_id, ''));
  CREATE INDEX IF NOT EXISTS idx_prompt_bindings_preset
    ON prompt_bindings(preset_id);
  CREATE INDEX IF NOT EXISTS idx_assistant_user_prompts_order
    ON assistant_user_prompts(assistant_id, condition, sort_order, id);
  CREATE INDEX IF NOT EXISTS idx_assistant_user_prompt_archive_assistant
    ON assistant_user_prompt_archive(assistant_id);
  CREATE INDEX IF NOT EXISTS idx_prompt_definition_overrides_assistant
    ON assistant_prompt_definition_overrides(assistant_id, definition_id);
  CREATE INDEX IF NOT EXISTS idx_assistant_tool_permissions_assistant
    ON assistant_tool_permissions(assistant_id, enabled, tool_name);

  CREATE TRIGGER IF NOT EXISTS trg_prompt_bindings_delete_assistant
  AFTER DELETE ON ai_assistants
  BEGIN
    DELETE FROM prompt_bindings
    WHERE target_type = 'assistant' AND target_id = OLD.id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_prompt_bindings_delete_group
  AFTER DELETE ON group_chats
  BEGIN
    DELETE FROM prompt_bindings
    WHERE target_type = 'group' AND target_id = OLD.id;
  END;
`;
