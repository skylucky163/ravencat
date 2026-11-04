import { detachDedicatedModelServices, migrateModelServices, removeRetiredDedicatedServiceCopies } from './modelServiceSchema';
/** 当前数据库基线与之后的增量升级；开源前开发库不再重放历史迁移。 */
import type { DatabaseWriteExecutor } from '../runtime';
import { SCHEMAS, INDEXES } from './schema';
import { migrateChatBubbleSkinPresets, migrateChatBubbleSkinOwnership } from './chatBubbleSkinPresetMigration';
import { DEFAULT_RECORDS_SQL } from './defaultRecords';
import { migrateMemoryTriggerGroups, migrateMemoryEmbeddingVectorSnapshot } from './memoryV3Schema';
import { migrateSecondaryChatSummary, migrateFixedChatContext, migrateChatSummaryModels, migrateChatSummaryPrimaryLimit, migrateChatSummaryWorkQueue } from './chatSummarySchema';
import { migrateStickerOwnership } from './stickerOwnershipMigration';
import { migrateApplicationSettingsTools } from './applicationSettingsMigration';
import { migrateChatTurnObservability } from './chatTurnObservabilitySchema';
import { migrateAssistantNicknameHistory } from './assistantNicknameHistoryMigration';
import { migrateChatTurnPublication, migrateChatTurnDisplayReadState } from './chatTurnPresentationSchema';
import { migrateGroupMembership } from './groupMembershipSchema';
import { migrateMomentAnalysisErrorMessage } from './momentsSchema';
import { migrateAIScheduleContext } from './ravenCatCompanionSchema';
import { migrateStickerEmbeddingIndexControl, migrateStickerRecognitionPolicy } from './stickerSchema';

/** 166 将主页封面工具更名为个人空间封面工具，保留已有授权与特批。167 移除已退出运行契约的辅助模型 enabled 物理列。 */
export const DATABASE_SCHEMA_VERSION = 167;
/** 114/115 是旧代码里的迁移编号；已发布数据库实际停在 user_version=108。 */
const PUBLIC_RELEASE_VERSION = 108;

/** 当前公开版的关键结构。拒绝旧开发库，避免把不完整库误标为新基线。 */
const PUBLIC_RELEASE_COLUMNS: Record<string, readonly string[]> = {
  ai_assistants: ['agent_id', 'disable_thinking', 'is_host_ai', 'private_context_primary_limit', 'group_context_secondary_limit'],
  sessions: ['ai_assistant_id', 'visible_after_message_id', 'visible_after_at', 'pinned_at'],
  messages: ['turn_run_id', 'turn_item_index', 'voice_played_at'],
  memory_items: ['summary', 'normalized_summary'],
  mcp_server_assistants: ['server_id', 'assistant_id'],
  chat_regeneration_requests: ['session_id', 'source_run_id', 'revision'],
  raven_cat_ai_schedules: ['completion_disposition'],
};

/** 检查当前已发布版本的结构特征，不对旧开发库猜测升级路径。 */
async function assertPublicReleaseSchema(db: DatabaseWriteExecutor): Promise<void> {
  for (const [table, expected] of Object.entries(PUBLIC_RELEASE_COLUMNS)) {
    const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info('${table}')`);
    const actual = new Set(columns.map(column => column.name));
    if (expected.some(column => !actual.has(column))) {
      throw new Error('数据库属于不再支持的开发版本，请完全卸载后重新安装；当前公开版的数据无需清除。');
    }
  }
}

/**
 * 初始化入口持有独占写作用域；此处拥有 schema/default/version 的事务。
 * 无升级时只补默认记录，支持恢复出厂后重建，不再扫描或删除历史业务数据。
 */
export async function runMigrations(db: DatabaseWriteExecutor): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const version = row!.user_version;
  if (version === DATABASE_SCHEMA_VERSION) {
    await db.execAsync('BEGIN IMMEDIATE;');
    try {
      await db.execAsync(DEFAULT_RECORDS_SQL);
      await db.execAsync('COMMIT;');
    } catch (error) {
      await db.execAsync('ROLLBACK;');
      throw error;
    }
    return;
  }
  if (version !== 0 && version !== PUBLIC_RELEASE_VERSION && version !== 116 && version !== 117 && version !== 118 && version !== 119 && version !== 120 && version !== 121 && version !== 122 && version !== 123 && version !== 124 && version !== 125 && version !== 126 && version !== 127 && version !== 128 && version !== 129 && version !== 130 && version !== 131 && version !== 132 && version !== 133 && version !== 134 && version !== 135 && version !== 136 && version !== 137 && version !== 138 && version !== 139 && version !== 140 && version !== 141 && version !== 142 && version !== 143 && version !== 144 && version !== 145 && version !== 146 && version !== 147 && version !== 148 && version !== 149 && version !== 150 && version !== 151 && version !== 152 && version !== 153 && version !== 154 && version !== 155 && version !== 156 && version !== 157 && version !== 158 && version !== 159 && version !== 160 && version !== 161 && version !== 162 && version !== 163 && version !== 164 && version !== 165 && version !== 166) {
    throw new Error(`数据库版本 ${version} 不受当前版本支持，请使用匹配的 RavenCat 版本。`);
  }
  const tables = await db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'android_metadata'",
  );
  const fresh = tables.length === 0;
  if (!fresh && version !== 116 && version !== 117 && version !== 118 && version !== 119 && version !== 120 && version !== 121 && version !== 122 && version !== 123 && version !== 124 && version !== 125 && version !== 126 && version !== 127 && version !== 128 && version !== 129 && version !== 130 && version !== 131 && version !== 132 && version !== 133 && version !== 134 && version !== 135 && version !== 136 && version !== 137 && version !== 138 && version !== 139 && version !== 140 && version !== 141 && version !== 142 && version !== 143 && version !== 144 && version !== 145 && version !== 146 && version !== 147 && version !== 148 && version !== 149 && version !== 150 && version !== 151 && version !== 152 && version !== 153 && version !== 154 && version !== 155 && version !== 156 && version !== 157 && version !== 158 && version !== 159 && version !== 160 && version !== 161 && version !== 162 && version !== 163 && version !== 164 && version !== 165 && version !== 166) {
    // 在任何 DDL/default 写入之前检查；失败不修改旧库。
    await assertPublicReleaseSchema(db);
    const retiredTables = new Set(['raven_cat_self_wakes', 'capability_bindings', 'assistant_capability_bindings', 'memory_entries']);
    if (tables.some(table => retiredTables.has(table.name))) {
      throw new Error('数据库仍包含旧开发结构，请完全卸载后重新安装。');
    }
  }

  await db.execAsync('BEGIN IMMEDIATE;');
  try {
    if (!fresh && version < 117) await migrateMemoryTriggerGroups(db);
    if (!fresh && version < 118) await migrateSecondaryChatSummary(db);
    if (!fresh && version === 118) await migrateFixedChatContext(db);
    if (!fresh && version < 120) await migrateStickerOwnership(db);
    if (!fresh && version < 122) {
      await db.execAsync('ALTER TABLE ai_assistants ADD COLUMN show_token_usage INTEGER NOT NULL DEFAULT 1;');
    }
    if (!fresh && version < 125) {
      await db.execAsync('ALTER TABLE ai_assistants ADD COLUMN nickname TEXT;');
    }
    if (!fresh && version < 126) await migrateChatSummaryModels(db);
    // 工具包暴露只是临时选择，不兼容旧三轮状态；重建空表，其他业务资料保持不变。
    if (!fresh && version < 127) await db.execAsync('DROP TABLE IF EXISTS chat_tool_package_exposure;');
    for (const sql of Object.values(SCHEMAS)) await db.execAsync(sql);
    if (!fresh && version < 162) await migrateStickerEmbeddingIndexControl(db);
    if (!fresh && version < 163) await migrateStickerRecognitionPolicy(db);
    if (!fresh && version < 164) await migrateMemoryEmbeddingVectorSnapshot(db);
    if (!fresh && version < 154) await migrateChatBubbleSkinPresets(db, version);
    if (!fresh && version === 154) await migrateChatBubbleSkinOwnership(db);
    if (!fresh && version < 156) await db.execAsync(`UPDATE chat_bubble_presets
      SET config_json = json_set(config_json, '$.textColor', CASE role WHEN 'user' THEN '#FFFFFF' ELSE '#1C1C1E' END)
      WHERE json_extract(config_json, '$.textColor') IS NULL;`);
    if (!fresh && version < 148) await migrateChatTurnDisplayReadState(db);
    if (!fresh) await migrateChatTurnObservability(db);
    if (!fresh) await migrateChatTurnPublication(db);
    if (!fresh && version < 135) await migrateAssistantNicknameHistory(db, version);
    if (!fresh && version < 136) {
      await db.execAsync('ALTER TABLE raven_cat_ai_schedules ADD COLUMN system_calendar INTEGER NOT NULL DEFAULT 0 CHECK (system_calendar IN (0, 1));');
    }
    if (!fresh && version < 138) await migrateChatSummaryPrimaryLimit(db);
    if (!fresh && version < 139) {
      await db.execAsync('ALTER TABLE ai_assistants ADD COLUMN show_action_steps INTEGER NOT NULL DEFAULT 1;');
    }
    if (!fresh && version < 140) {
      await db.execAsync('ALTER TABLE ai_assistants ADD COLUMN streaming_reply INTEGER CHECK (streaming_reply IN (0, 1));');
    }
    if (!fresh && version < 141) await migrateGroupMembership(db);
    for (const sql of Object.values(INDEXES)) await db.execAsync(sql);
    if (!fresh && version < 142) await migrateChatSummaryWorkQueue(db);
    if (!fresh && version < 145) await migrateMomentAnalysisErrorMessage(db);
    if (!fresh && version < 149) await migrateAIScheduleContext(db);
    if (!fresh && version < 150) {
      const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(web_search_settings)');
      if (!columns.some(column => column.name === 'connection_mode')) {
        await db.execAsync("ALTER TABLE web_search_settings ADD COLUMN connection_mode TEXT NOT NULL DEFAULT 'direct' CHECK (connection_mode IN ('direct', 'system'));");
      }
    }
    if (!fresh && version < 152) {
      const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(memory_model_settings)');
      if (!columns.some(column => column.name === 'embedding_enabled')) {
        await db.execAsync('ALTER TABLE memory_model_settings ADD COLUMN embedding_enabled INTEGER NOT NULL DEFAULT 0 CHECK (embedding_enabled IN (0, 1));');
        // 已有安装按原实际选择保留启用状态，新安装默认关闭。
        await db.execAsync('UPDATE memory_model_settings SET embedding_enabled = CASE WHEN embedding_model_config_id IS NULL THEN 0 ELSE 1 END;');
      }
    }
    if (!fresh && version < 157) await migrateModelServices(db);
    if (!fresh && version < 158) await detachDedicatedModelServices(db);
    if (!fresh && version < 159) await removeRetiredDedicatedServiceCopies(db);
    if (!fresh && version < 167) {
      const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(auxiliary_model_configs)');
      if (columns.some(column => column.name === 'enabled')) {
        // 只退役旧启停字段；其他资产字段与服务引用保持不变。
        await db.execAsync(`DROP INDEX IF EXISTS idx_auxiliary_model_configs_enabled;
          ALTER TABLE auxiliary_model_configs DROP COLUMN enabled;`);
      }
    }
    if (!fresh && version < 160) {
      // 旧版本可能因模型切换排入整库任务；升级只保留数据，不继续执行这份隐含授权。
      await db.execAsync(`UPDATE memory_item_embeddings SET
        status = CASE WHEN status IN ('pending','stale','retry_wait') THEN 'not_requested' ELSE status END,
        claim_id = NULL, claim_expires_at = NULL;
        UPDATE sticker_embedding_index_control SET
          published_model_id = (SELECT embedding_model_config_id FROM sticker_system_config WHERE id = 'global'),
          published_model_updated_at = (SELECT m.updated_at FROM auxiliary_model_configs m
            JOIN sticker_system_config c ON c.embedding_model_config_id = m.id WHERE c.id = 'global')
        WHERE id = 1 AND EXISTS (SELECT 1 FROM stickers WHERE owner_assistant_id IS NULL AND annotation_status = 'ready')
          AND EXISTS (SELECT 1 FROM auxiliary_model_configs m JOIN sticker_system_config c ON c.embedding_model_config_id = m.id
            WHERE c.id = 'global' AND m.capability_kind = 'embedding' AND NOT EXISTS (
              SELECT 1 FROM stickers s LEFT JOIN sticker_embeddings e ON e.sticker_id = s.id
                AND e.model_config_id = m.id AND e.model_config_updated_at = m.updated_at AND e.semantic_revision = s.semantic_revision
              WHERE s.owner_assistant_id IS NULL AND s.annotation_status = 'ready' AND e.sticker_id IS NULL));`);
    }
    if (!fresh) await migrateApplicationSettingsTools(db);
    if (!fresh && version !== 116 && version !== 117 && version !== 118 && version !== 119 && version !== 120 && version !== 121 && version !== 122 && version !== 123 && version !== 124 && version !== 125 && version !== 126 && version !== 127 && version !== 128 && version !== 129 && version !== 130 && version !== 131 && version !== 132 && version !== 133 && version !== 134 && version !== 135 && version !== 136 && version !== 137 && version !== 138 && version !== 139 && version !== 140 && version !== 141 && version !== 142 && version !== 143 && version !== 144 && version !== 145 && version !== 146 && version !== 147 && version !== 148 && version !== 149 && version !== 150 && version !== 151 && version !== 152 && version !== 153 && version !== 154 && version !== 155 && version !== 156 && version !== 157 && version !== 158 && version !== 159 && version !== 160 && version !== 161 && version !== 162 && version !== 163 && version !== 164 && version !== 165 && version !== 166) {
      // 纳入公开版115的定向修复：只清理无有效主体的 MCP 授权，正常授权原样保留。
      await db.execAsync(`
        DELETE FROM mcp_server_assistants
        WHERE NOT EXISTS (SELECT 1 FROM mcp_servers WHERE id = server_id)
           OR NOT EXISTS (SELECT 1 FROM ai_assistants WHERE id = assistant_id);
        DELETE FROM mcp_tool_grants
        WHERE NOT EXISTS (SELECT 1 FROM mcp_servers WHERE id = server_id);
      `);
    }
    await db.execAsync(DEFAULT_RECORDS_SQL);
    await db.execAsync(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION};`);
    await db.execAsync('COMMIT;');
  } catch (error) {
    await db.execAsync('ROLLBACK;');
    throw error;
  }
}
