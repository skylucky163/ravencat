import { MODEL_SERVICE_SCHEMA } from './modelServiceSchema';
/** 集中定义 SQLite 建表与索引语句。 */
import { CALL_HISTORY_SCHEMA } from './callHistorySchema';

import {
  RAVEN_CAT_AI_SCHEDULES_OWNER_STATUS_TIME_INDEX,
  RAVEN_CAT_AI_SCHEDULES_OWNER_TIME_INDEX,
  RAVEN_CAT_AI_SCHEDULES_CONSUMED_HISTORY_INDEX,
  RAVEN_CAT_AI_SCHEDULES_CONSUMED_OCCURRED_HISTORY_INDEX,
  RAVEN_CAT_AI_SCHEDULES_SCHEMA,
  RAVEN_CAT_AI_SCHEDULE_CONTEXT_SCHEMA,
  RAVEN_CAT_COMPANION_STATE_SCHEMA,
} from './ravenCatCompanionSchema';
import {
  RAVEN_CAT_SOFT_APP_LOCKS_AI_ACTIVE_TARGET_INDEX,
  RAVEN_CAT_SOFT_APP_LOCKS_SCHEMA,
  RAVEN_CAT_SOFT_APP_LOCKS_STATUS_INDEX,
} from './ravenCatDeviceControlSchema';
import { RAVEN_CAT_FLOATING_INTERACTION_SETTINGS_SCHEMA } from './ravenCatFloatingInteractionSchema';
import { HOST_AI_RELATIONSHIP_STATE_SCHEMA } from './hostAIRelationshipSchema';
import {
  MEDIA_ASSET_CONTENT_HASH_INDEX,
  MEDIA_ASSET_SCHEMA,
} from './mediaAssetSchema';
import { PROMPTING_SCHEMA } from './promptingSchema';
import { PROTOCOL_SCHEMA } from './protocolSchema';
import { MEMORY_V3_SCHEMA } from './memoryV3Schema';
import { MODEL_SELECTION_SCHEMA } from './modelSelectionSchema';
import { TRANSLATION_SELECTION_SCHEMA } from './translationModelSchema';
import { AUXILIARY_MODEL_DEFAULTS_SCHEMA } from './auxiliaryModelDefaultsSchema';
import { CHAT_SUMMARY_SCHEMA, CHAT_TIMELINE_RUN_ANCHOR_SCHEMA, CHAT_SUMMARY_WORK_QUEUE_TRIGGERS } from './chatSummarySchema';
import { CHAT_TOOL_PACKAGE_EXPOSURE_SCHEMA } from './chatToolPackageSchema';
import { CHAT_TURN_PRESENTATIONS_SCHEMA } from './chatTurnPresentationSchema';
import { GROUP_HISTORY_SCHEMA } from './groupMembershipSchema';
import {
  TOGETHER_LISTENING_ACTIVITIES_SCHEMA,
  TOGETHER_LISTENING_CHAT_CREATED_INDEX,
  TOGETHER_LISTENING_HOST_CREATED_INDEX,
  TOGETHER_LISTENING_SINGLE_CURRENT_INDEX,
} from './togetherListeningSchema';
import {
  STICKER_SYSTEM_CONFIG_SCHEMA,
  STICKER_EMBEDDING_FAILURES_SCHEMA,
  AI_STICKER_TASKS_SCHEMA,
  STICKER_OWNERSHIP_INDEXES,
  STICKER_EMBEDDINGS_SCHEMA,
  STICKER_EMBEDDINGS_MODEL_INDEX,
  STICKER_GROUPS_ORDER_INDEX,
  STICKER_GROUPS_SCHEMA,
  STICKERS_ANNOTATION_INDEX,
  STICKERS_FAVORITE_RECENT_INDEX,
  STICKERS_GROUP_ORDER_INDEX,
  STICKERS_SCHEMA,
} from './stickerSchema';
import { AI_DOWNLOADED_IMAGES_SCHEMA } from './aiImageSchema';
import { CHAT_FAVORITES_SCHEMA, CHAT_FAVORITES_INDEXES } from './chatFavoriteSchema';
import {
  MOMENTS_SCHEMA,
  MOMENT_AUDIENCE_AI_SCHEMA,
  MOMENT_AUDIENCE_AI_VIEWER_INDEX,
  MOMENT_COMMENTS_MOMENT_CREATED_INDEX,
  MOMENT_COMMENTS_PARENT_INDEX,
  MOMENT_COMMENTS_SCHEMA,
  MOMENT_LIKES_SCHEMA,
  MOMENT_MEDIA_INDEXES,
  MOMENT_MEDIA_SCHEMA,
  MOMENT_SETTINGS_SCHEMA,
  MOMENT_SOCIAL_INBOX_DELIVERIES_SCHEMA,
  MOMENT_SOCIAL_INBOX_INDEXES,
  MOMENTS_CREATED_AT_INDEX,
  MOMENTS_CREATED_ID_INDEX,
} from './momentsSchema';

import { CALL_BACKGROUND_SELECTION_SCHEMA } from './callBackgroundSchema';
import { CALL_RINGTONE_SELECTION_SCHEMA } from './callRingtoneSchema';
import { WALLPAPER_SELECTION_SCHEMA } from './wallpaperSelectionSchema';

import { AGENT_RUNS_SCHEMA, AGENT_STEPS_SCHEMA, AGENT_TOOL_RECEIPTS_SCHEMA } from './agentRuntimeSchema';
import { CHAT_REGENERATION_REQUESTS_SCHEMA } from './chatRegenerationSchema';
import { CHAT_REPLY_VERSIONS_SCHEMA } from './chatReplyVersionSchema';
import { MCP_SERVERS_SCHEMA, MCP_TOOL_GRANTS_SCHEMA, MCP_SERVER_ASSISTANTS_SCHEMA, MCP_TOOL_GRANTS_INDEXES } from './mcpSchema';
import { WEB_SEARCH_SCHEMA } from './webSearchSchema';
import { CHAT_BUBBLE_SKINS_SCHEMA } from './chatBubbleSkinSchema';

export const SCHEMAS: Record<string, string> = {
  modelServices: MODEL_SERVICE_SCHEMA,
  chatBubbleSkins: CHAT_BUBBLE_SKINS_SCHEMA,
  webSearch: WEB_SEARCH_SCHEMA,
  chatFavorites: CHAT_FAVORITES_SCHEMA,
  callBackgroundSelection: CALL_BACKGROUND_SELECTION_SCHEMA,
  callRingtoneSelection: CALL_RINGTONE_SELECTION_SCHEMA,
  wallpaperSelections: WALLPAPER_SELECTION_SCHEMA,
  // 1. ai_assistants 表 - AI助手列表
  aiAssistants: `
    CREATE TABLE IF NOT EXISTS ai_assistants (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      nickname TEXT,
      avatar TEXT,
      avatar_media_asset_id TEXT,
      model TEXT NOT NULL,
      api_key TEXT,
      service_config_id TEXT REFERENCES model_service_configs(id),
      api_base_url TEXT,
      system_prompt TEXT,
      temperature REAL DEFAULT 0.7,
      top_p REAL DEFAULT 1.0,
      max_tokens INTEGER DEFAULT 2000,
      enable_tools INTEGER DEFAULT 0,
      disable_thinking INTEGER NOT NULL DEFAULT 0,
      enable_external_tool_search INTEGER DEFAULT 0,
      enable_external_tool_translate INTEGER DEFAULT 0,
      enable_external_tool_weather INTEGER DEFAULT 0,
      enable_external_tool_map INTEGER DEFAULT 0,
      enable_short_text_protocol INTEGER DEFAULT 1,
      allow_multiple_bubbles INTEGER DEFAULT 1,
      streaming_reply INTEGER CHECK (streaming_reply IN (0, 1)),
      show_token_usage INTEGER NOT NULL DEFAULT 1,
      show_action_steps INTEGER NOT NULL DEFAULT 1,
      supports_vision INTEGER DEFAULT 0,
      -- 已发布版保留的物理列；当前运行时使用角色视觉模型选择。
      image_processing_mode TEXT NOT NULL DEFAULT 'direct',
      vision_helper_ai_id TEXT,
      allow_helper_auto_join INTEGER DEFAULT 1,
      is_default INTEGER DEFAULT 0,
      is_ledger_ai INTEGER DEFAULT 0,
      last_active_session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_host_ai INTEGER DEFAULT 0,
      host_cooldown_start TEXT,
      host_cooldown_end TEXT,
      host_revoke_cooldown_start TEXT,
      host_revoke_cooldown_end TEXT,
      private_context_primary_limit INTEGER NOT NULL DEFAULT 30,
      private_context_secondary_limit INTEGER NOT NULL DEFAULT 10,
      group_context_primary_limit INTEGER NOT NULL DEFAULT 40,
      group_context_secondary_limit INTEGER NOT NULL DEFAULT 5,
      FOREIGN KEY (last_active_session_id) REFERENCES sessions(id) ON DELETE SET NULL,
      FOREIGN KEY (vision_helper_ai_id) REFERENCES ai_assistants(id) ON DELETE SET NULL
    );
  `,

  assistantProfileCovers: `
    CREATE TABLE IF NOT EXISTS assistant_profile_covers (
      assistant_id TEXT PRIMARY KEY REFERENCES ai_assistants(id) ON DELETE CASCADE,
      media_asset_id TEXT NOT NULL REFERENCES media_assets(id)
    );
  `,
  hostAIRelationshipState: HOST_AI_RELATIONSHIP_STATE_SCHEMA,

  auxiliaryModelConfigs: `
    CREATE TABLE IF NOT EXISTS auxiliary_model_configs (
      id TEXT PRIMARY KEY,
      capability_kind TEXT NOT NULL,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT,
      service_config_id TEXT REFERENCES model_service_configs(id),
      model TEXT NOT NULL,
      temperature REAL,
      top_p REAL,
      max_tokens INTEGER,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,

  modelSelections: MODEL_SELECTION_SCHEMA,

  translationSelection: TRANSLATION_SELECTION_SCHEMA,
  auxiliaryModelInitialDefaults: AUXILIARY_MODEL_DEFAULTS_SCHEMA,

  // 2.0 chat_conversations 表 - 会话统一身份（私聊 direct / 群聊 group 共用）
  // 只回答“这个 conversation ID 是否存在、是 direct 还是 group”，详情与 preview 仍属于 sessions / group_chats。
  chatConversations: `
    CREATE TABLE IF NOT EXISTS chat_conversations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('direct', 'group'))
    );
  `,

  chatTextDrafts: `
    CREATE TABLE IF NOT EXISTS chat_text_drafts (
      conversation_id TEXT PRIMARY KEY REFERENCES chat_conversations(id) ON DELETE CASCADE,
      text TEXT NOT NULL
    );
  `,

  // 2. sessions 表 - 会话列表
  sessions: `
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      ai_assistant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      last_message TEXT,
      last_time TEXT,
      is_active INTEGER DEFAULT 1,
      is_pinned INTEGER DEFAULT 0,
      pinned_at TEXT,
      visible_after_message_id INTEGER,
      visible_after_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_archived INTEGER DEFAULT 0,
      archive_reason TEXT,
      tags TEXT,
      UNIQUE (ai_assistant_id),
      FOREIGN KEY (ai_assistant_id) REFERENCES ai_assistants(id) ON DELETE CASCADE
    );
  `,

  groupChats: `
    CREATE TABLE IF NOT EXISTS group_chats (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT,
      avatar_media_asset_id TEXT,
      last_message TEXT,
      last_time TEXT,
      last_message_id INTEGER,
      is_pinned INTEGER DEFAULT 0,
      pinned_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,

  groupChatMembers: `
    CREATE TABLE IF NOT EXISTS group_chat_members (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      ai_assistant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      display_order INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
      joined_during_plan_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(group_id, ai_assistant_id),
      FOREIGN KEY (group_id) REFERENCES group_chats(id) ON DELETE CASCADE,
      FOREIGN KEY (ai_assistant_id) REFERENCES ai_assistants(id) ON DELETE CASCADE
    );
  `,

  groupChatAdminConfigs: `
    CREATE TABLE IF NOT EXISTS group_chat_admin_configs (
      group_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      model TEXT NOT NULL,
      api_key TEXT,
      service_config_id TEXT REFERENCES model_service_configs(id),
      api_base_url TEXT,
      system_prompt TEXT,
      temperature REAL DEFAULT 0.7,
      top_p REAL DEFAULT 1.0,
      max_tokens INTEGER,
      context_message_count INTEGER NOT NULL DEFAULT 20
        CHECK (context_message_count BETWEEN 0 AND 100),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (group_id) REFERENCES group_chats(id) ON DELETE CASCADE
    );
  `,

  groupSpeechPlans: `
    CREATE TABLE IF NOT EXISTS group_speech_plans (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      status TEXT NOT NULL,
      invoked_user_message_ids_json TEXT,
      last_included_message_id INTEGER,
      supersedes_plan_id TEXT,
      started_at TEXT,
      completed_at TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (group_id) REFERENCES group_chats(id) ON DELETE CASCADE
    );
  `,

  groupSpeechTasks: `
    CREATE TABLE IF NOT EXISTS group_speech_tasks (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      ai_assistant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      sequence_order INTEGER NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      visible_reply_committed INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES group_speech_plans(id) ON DELETE CASCADE,
      FOREIGN KEY (group_id) REFERENCES group_chats(id) ON DELETE CASCADE,
      FOREIGN KEY (ai_assistant_id) REFERENCES ai_assistants(id) ON DELETE CASCADE
    );
  `,

  // 3. messages 表 - 消息记录
  messages: `
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent_id TEXT,
      client_message_id TEXT,
      text TEXT NOT NULL,
      is_me INTEGER NOT NULL,
      sender_type TEXT,
      api_message_id TEXT,
      time TEXT,
      created_at TEXT NOT NULL,
      show_time_separator_before INTEGER DEFAULT 0,
      updated_at TEXT,
      reply_to_id INTEGER,
      reply_to_text TEXT,
      logical_message_id TEXT,
      segment_index INTEGER DEFAULT 0,
      segment_total INTEGER DEFAULT 1,
      delivery_status TEXT DEFAULT 'delivered',
      status TEXT DEFAULT 'sent',
      tokens_used INTEGER DEFAULT 0,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      metadata_json TEXT,
      is_read INTEGER DEFAULT 0,
      voice_played_at TEXT,
      turn_run_id TEXT,
      turn_item_index INTEGER,
      FOREIGN KEY (session_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
    );
  `,

  // 3.1 conversation_turn_runs / conversation_turn_state - Phase 5A 会话回合协调
  // 外键目标是 chat_conversations(id)，删除会话级联清理回合事实（方案 16.1）。
  conversationTurnRuns: `
    CREATE TABLE IF NOT EXISTS conversation_turn_runs (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      reply_cursor_at_claim INTEGER NOT NULL,
      input_high_watermark INTEGER NOT NULL,
      revision_at_claim INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN
        ('active','committed','superseded','cancelled','failed')),
      terminal_reason TEXT NULL,
      created_at TEXT NOT NULL,
      terminal_at TEXT NULL,
      regeneration_source_run_id TEXT NULL,
      input_cursor_at_claim INTEGER NULL
    );
  `,

  conversationTurnState: `
    CREATE TABLE IF NOT EXISTS conversation_turn_state (
      session_id TEXT PRIMARY KEY REFERENCES chat_conversations(id) ON DELETE CASCADE,
      reply_cursor INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      active_run_id TEXT NULL REFERENCES conversation_turn_runs(run_id),
      active_run_kind TEXT NULL,
      host_request_revision INTEGER NOT NULL DEFAULT 0,
      host_request_input_id INTEGER,
      host_request_status TEXT,
      host_request_at TEXT,
      updated_at TEXT NOT NULL
    );
  `,

  chatToolPackageExposure: CHAT_TOOL_PACKAGE_EXPOSURE_SCHEMA,
  chatTurnPresentations: CHAT_TURN_PRESENTATIONS_SCHEMA,
  groupChatHistory: GROUP_HISTORY_SCHEMA,
  chatRegenerationRequests: CHAT_REGENERATION_REQUESTS_SCHEMA,
  chatReplyVersions: CHAT_REPLY_VERSIONS_SCHEMA,

  callSessions: `
    CREATE TABLE IF NOT EXISTS call_sessions (
      id TEXT PRIMARY KEY,
      chat_session_id TEXT NOT NULL,
      ai_assistant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      state TEXT NOT NULL,
      requested_mode TEXT NOT NULL,
      active_mode TEXT NOT NULL,
      source TEXT NOT NULL,
      source_tool_call_id TEXT,
      opening_line TEXT,
      reason TEXT,
      ai_rejection_reason TEXT,
      started_at TEXT,
      accepted_at TEXT,
      ended_at TEXT,
      end_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (chat_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (ai_assistant_id) REFERENCES ai_assistants(id) ON DELETE CASCADE
    );
  `,

  callHistory: CALL_HISTORY_SCHEMA,

  callParticipants: `
    CREATE TABLE IF NOT EXISTS call_participants (
      id TEXT PRIMARY KEY,
      call_id TEXT NOT NULL,
      role TEXT NOT NULL,
      ai_assistant_id TEXT,
      agent_id TEXT,
      display_name TEXT NOT NULL,
      joined_at TEXT,
      left_at TEXT,
      FOREIGN KEY (call_id) REFERENCES call_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (ai_assistant_id) REFERENCES ai_assistants(id) ON DELETE SET NULL
    );
  `,

  callEvents: `
    CREATE TABLE IF NOT EXISTS call_events (
      id TEXT PRIMARY KEY,
      call_id TEXT NOT NULL,
      chat_session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      text TEXT,
      attachment_id TEXT,
      visible_in_chat INTEGER DEFAULT 0,
      include_in_ai_context INTEGER DEFAULT 1,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (call_id) REFERENCES call_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (chat_session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `,

  callAttachments: `
    CREATE TABLE IF NOT EXISTS call_attachments (
      id TEXT PRIMARY KEY,
      call_id TEXT NOT NULL,
      event_id TEXT,
      kind TEXT NOT NULL,
      local_uri TEXT,
      mime_type TEXT,
      width INTEGER,
      height INTEGER,
      size_bytes INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (call_id) REFERENCES call_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (event_id) REFERENCES call_events(id) ON DELETE SET NULL
    );
  `,

  // 4. 协议空间：用户与 AI 共同维护的固定注入信息。
  protocols: PROTOCOL_SCHEMA,

  // 5. moments 表 - 朋友圈动态（V2 稳定作者身份 + AI audience）
  moments: MOMENTS_SCHEMA,

  // 6. moment_comments 表 - 朋友圈评论与回复（V2 稳定作者身份）
  momentComments: MOMENT_COMMENTS_SCHEMA,

  // 7. moment_likes 表 - 朋友圈点赞事实
  momentLikes: MOMENT_LIKES_SCHEMA,

  // 7.1 moment_audience_ai 表 - selected audience 的 AI viewer 关系真值
  momentAudienceAi: MOMENT_AUDIENCE_AI_SCHEMA,

  // 7.2 Moments Social Inbox 投递；fresh schema 为空，不回填历史事实
  momentSocialInboxDeliveries: MOMENT_SOCIAL_INBOX_DELIVERIES_SCHEMA,

  // 7.3 Moment 正文图片引用与图片语义快照
  momentMedia: MOMENT_MEDIA_SCHEMA,

  // 7.4 Moments 自有图片理解模型绑定
  momentSettings: MOMENT_SETTINGS_SCHEMA,

  // 8. app_icons 表 - 应用图标配置（历史兼容）
  appIcons: `
    CREATE TABLE IF NOT EXISTS app_icons (
      app_id TEXT PRIMARY KEY,
      custom_name TEXT,
      icon_type TEXT,
      icon_value TEXT,
      updated_at TEXT NOT NULL
    );
  `,

  // 8.1 user_profile 表 - 当前用户资料
  userProfile: `
    CREATE TABLE IF NOT EXISTS user_profile (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      gender TEXT NOT NULL DEFAULT '',
      age INTEGER CHECK (age IS NULL OR (typeof(age) = 'integer' AND age >= 0)),
      identity TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT '',
      other TEXT NOT NULL DEFAULT '',
      signature TEXT NOT NULL DEFAULT '',
      avatar TEXT,
      avatar_media_asset_id TEXT,
      moments_cover TEXT,
      moments_cover_media_asset_id TEXT,
      moments_cover_revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `,

  // 8.1.1 memory_pools 表 - 同一用户 × 同一 AI 的 pair 级共享记忆域
  memoryPools: `
    CREATE TABLE IF NOT EXISTS memory_pools (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT 'pair_shared',
      user_profile_id TEXT NOT NULL,
      ai_assistant_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_profile_id, ai_assistant_id),
      FOREIGN KEY (user_profile_id) REFERENCES user_profile(id) ON DELETE CASCADE,
      FOREIGN KEY (ai_assistant_id) REFERENCES ai_assistants(id) ON DELETE CASCADE
    );
  `,

  // 记忆正文、向量与聊天摘要使用当前业务表。
  memoryV3: MEMORY_V3_SCHEMA,
  chatSummary: CHAT_SUMMARY_SCHEMA,

  // 8.2 desktop_personalization 表 - 背景个性化（历史兼容）
  desktopPersonalization: `
    CREATE TABLE IF NOT EXISTS desktop_personalization (
      id TEXT PRIMARY KEY,
      wallpaper_type TEXT,
      wallpaper_value TEXT,
      updated_at TEXT NOT NULL
    );
  `,

  // 9. ledger_records 表 - 羽库账本记录
  ledgerRecords: `
    CREATE TABLE IF NOT EXISTS ledger_records (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      detail TEXT,
      amount REAL NOT NULL,
      record_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,

  // 10. ledger_quick_actions 表 - 快捷记账配置
  ledgerQuickActions: `
    CREATE TABLE IF NOT EXISTS ledger_quick_actions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      detail TEXT,
      amount REAL NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,

  // 12. ai_blacklist 表 - 主理AI拉黑记录
  // - ai_id: 被拉黑目标的系统 ai id
  // - blocked_by: 执行动作的 host AI 的系统 ai id（历史字段名，非 agentId）
  aiBlacklist: `
    CREATE TABLE IF NOT EXISTS ai_blacklist (
      id TEXT PRIMARY KEY,
      ai_id TEXT NOT NULL,
      blocked_by TEXT NOT NULL,
      blocked_until TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (ai_id) REFERENCES ai_assistants(id) ON DELETE CASCADE
    );
  `,

  // Legacy memory tables removed: amber_diaries, amber_diary_segments, amber_profiles, amber_must_remember, session_sticky_notes

  // 18. session_vision_helpers 表 - 视觉外援协作 episode 状态
  sessionVisionHelpers: `
    CREATE TABLE IF NOT EXISTS session_vision_helpers (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      episode_id TEXT NOT NULL,
      primary_ai_id TEXT NOT NULL,
      helper_ai_id TEXT,
      status TEXT NOT NULL,
      turn_count INTEGER DEFAULT 0,
      anchor_image_message_id INTEGER,
      joined_at_message_id INTEGER,
      last_helper_message_id INTEGER,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (primary_ai_id) REFERENCES ai_assistants(id) ON DELETE CASCADE,
      FOREIGN KEY (helper_ai_id) REFERENCES ai_assistants(id) ON DELETE SET NULL
    );
  `,

  ravenCatContactSettings: `
    CREATE TABLE IF NOT EXISTS raven_cat_contact_settings (
      id TEXT PRIMARY KEY,
      quiet_hours_enabled INTEGER NOT NULL DEFAULT 1
        CHECK (quiet_hours_enabled IN (0, 1)),
      quiet_hours_start_minutes INTEGER NOT NULL DEFAULT 1380
        CHECK (quiet_hours_start_minutes BETWEEN 0 AND 1439),
      quiet_hours_end_minutes INTEGER NOT NULL DEFAULT 480
        CHECK (quiet_hours_end_minutes BETWEEN 0 AND 1439),
      user_screen_capture_blacklist_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,

  ravenCatCompanionState: RAVEN_CAT_COMPANION_STATE_SCHEMA,

  ravenCatAISchedules: RAVEN_CAT_AI_SCHEDULES_SCHEMA,
  ravenCatAIScheduleContext: RAVEN_CAT_AI_SCHEDULE_CONTEXT_SCHEMA,

  ravenCatFloatingInteractionSettings: RAVEN_CAT_FLOATING_INTERACTION_SETTINGS_SCHEMA,

  mediaAssets: MEDIA_ASSET_SCHEMA,
  stickerGroups: STICKER_GROUPS_SCHEMA,
  stickers: STICKERS_SCHEMA,
  prompting: PROMPTING_SCHEMA,
  ravenCatSoftAppLocks: RAVEN_CAT_SOFT_APP_LOCKS_SCHEMA,
  togetherListeningActivities: TOGETHER_LISTENING_ACTIVITIES_SCHEMA,
  // 已发布版所需的当前表；升级历史不参与新建库。
  agentRuns: AGENT_RUNS_SCHEMA,
  agentSteps: AGENT_STEPS_SCHEMA,
  agentToolReceipts: AGENT_TOOL_RECEIPTS_SCHEMA,
  mcpServers: MCP_SERVERS_SCHEMA,
  mcpToolGrants: MCP_TOOL_GRANTS_SCHEMA,
  mcpServerAssistants: MCP_SERVER_ASSISTANTS_SCHEMA,
  stickerEmbeddings: STICKER_EMBEDDINGS_SCHEMA,
  stickerEmbeddingFailures: STICKER_EMBEDDING_FAILURES_SCHEMA,
  stickerSystemConfig: STICKER_SYSTEM_CONFIG_SCHEMA,
  aiStickerTasks: AI_STICKER_TASKS_SCHEMA,
  aiDownloadedImages: AI_DOWNLOADED_IMAGES_SCHEMA,
  chatTimelineRunAnchor: CHAT_TIMELINE_RUN_ANCHOR_SCHEMA,
};

export const INDEXES: Record<string, string> = {
  chatSummaryWorkQueue: CHAT_SUMMARY_WORK_QUEUE_TRIGGERS,
  chatFavorites: CHAT_FAVORITES_INDEXES,
  idxStickerOwnership: STICKER_OWNERSHIP_INDEXES,
  idxStickerEmbeddingsModel: STICKER_EMBEDDINGS_MODEL_INDEX,
  idx_sessions_canonical_ai: `CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_canonical_ai
          ON sessions(ai_assistant_id);`,
  idxMcpToolGrantsServer: MCP_TOOL_GRANTS_INDEXES[0],
  idx_ai_assistants_single_host: `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_assistants_single_host
     ON ai_assistants(is_host_ai) WHERE is_host_ai = 1;`,
  idx_agent_steps_run: `CREATE INDEX IF NOT EXISTS idx_agent_steps_run
        ON agent_steps(run_id, step_index);`,
  idx_agent_runs_status_updated: `CREATE INDEX IF NOT EXISTS idx_agent_runs_status_updated
        ON agent_runs(status, updated_at DESC);`,
  idx_agent_runs_assistant_updated: `CREATE INDEX IF NOT EXISTS idx_agent_runs_assistant_updated
        ON agent_runs(assistant_id, updated_at DESC);`,
  idx_agent_receipts_run_updated: `CREATE INDEX IF NOT EXISTS idx_agent_receipts_run_updated
        ON agent_tool_receipts(run_id, updated_at DESC);`,
  idx_agent_receipts_executing: `CREATE INDEX IF NOT EXISTS idx_agent_receipts_executing
        ON agent_tool_receipts(status, idempotency, updated_at ASC);`,
  idxRavenCatAISchedulesOwnerStatusTime: RAVEN_CAT_AI_SCHEDULES_OWNER_STATUS_TIME_INDEX,
  idxRavenCatAISchedulesOwnerTime: RAVEN_CAT_AI_SCHEDULES_OWNER_TIME_INDEX,
  idxRavenCatAISchedulesConsumedHistory: RAVEN_CAT_AI_SCHEDULES_CONSUMED_HISTORY_INDEX,
  idxRavenCatAISchedulesConsumedOccurredHistory:
    RAVEN_CAT_AI_SCHEDULES_CONSUMED_OCCURRED_HISTORY_INDEX,
  idxMediaAssetsContentHash: MEDIA_ASSET_CONTENT_HASH_INDEX,
  idxStickerGroupsOrder: STICKER_GROUPS_ORDER_INDEX,
  idxStickersGroupOrder: STICKERS_GROUP_ORDER_INDEX,
  idxStickersFavoriteRecent: STICKERS_FAVORITE_RECENT_INDEX,
  idxStickersAnnotation: STICKERS_ANNOTATION_INDEX,
  idxRavenCatSoftAppLocksStatus: RAVEN_CAT_SOFT_APP_LOCKS_STATUS_INDEX,
  idxRavenCatSoftAppLocksAiActiveTarget: RAVEN_CAT_SOFT_APP_LOCKS_AI_ACTIVE_TARGET_INDEX,
  idxTogetherListeningSingleCurrent: TOGETHER_LISTENING_SINGLE_CURRENT_INDEX,
  idxTogetherListeningChatCreated: TOGETHER_LISTENING_CHAT_CREATED_INDEX,
  idxTogetherListeningHostCreated: TOGETHER_LISTENING_HOST_CREATED_INDEX,

  // Sessions 相关索引
  idxSessionsAiId: `CREATE INDEX IF NOT EXISTS idx_sessions_ai_id ON sessions(ai_assistant_id);`,
  idxSessionsActive: `CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(is_active);`,
  idxSessionsPinned: `CREATE INDEX IF NOT EXISTS idx_sessions_pinned ON sessions(ai_assistant_id, is_pinned, updated_at);`,

  // Group chat 相关索引
  idxGroupChatsUpdatedAt: `CREATE INDEX IF NOT EXISTS idx_group_chats_updated_at ON group_chats(updated_at DESC);`,
  idxGroupChatsPinned: `CREATE INDEX IF NOT EXISTS idx_group_chats_pinned ON group_chats(is_pinned, updated_at DESC);`,
  idxGroupChatMembersGroupId: `CREATE INDEX IF NOT EXISTS idx_group_chat_members_group_id ON group_chat_members(group_id, display_order);`,
  idxGroupChatMembersAiId: `CREATE INDEX IF NOT EXISTS idx_group_chat_members_ai_id ON group_chat_members(ai_assistant_id);`,
  idxGroupSpeechPlansGroupStatus: `CREATE INDEX IF NOT EXISTS idx_group_speech_plans_group_status ON group_speech_plans(group_id, status, created_at DESC);`,
  idxGroupSpeechPlansSingleActive: `CREATE UNIQUE INDEX IF NOT EXISTS idx_group_speech_plans_single_active ON group_speech_plans(group_id) WHERE status IN ('pending', 'preparing', 'running');`,
  idxGroupSpeechTasksPlanOrder: `CREATE INDEX IF NOT EXISTS idx_group_speech_tasks_plan_order ON group_speech_tasks(plan_id, sequence_order);`,
  idxGroupSpeechTasksGroupStatus: `CREATE INDEX IF NOT EXISTS idx_group_speech_tasks_group_status ON group_speech_tasks(group_id, status);`,

  // Messages 相关索引
  idxMessagesSessionId: `CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);`,
  idxMessagesCreatedAt: `CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);`,
  idxMessagesAgentId: `CREATE INDEX IF NOT EXISTS idx_messages_agent_id ON messages(agent_id);`,
  // 分页性能优化索引（cursor-based pagination）
  idxMessagesSessionIdId: `CREATE INDEX IF NOT EXISTS idx_messages_session_id_id ON messages(session_id, id DESC);`,
  idxMessagesSessionClientMessage: `CREATE INDEX IF NOT EXISTS idx_messages_session_client_message ON messages(session_id, client_message_id);`,
  idxMessagesSessionLogicalMessage: `CREATE INDEX IF NOT EXISTS idx_messages_session_logical_message ON messages(session_id, logical_message_id);`,
  idxMessagesUnreadLookup: `CREATE INDEX IF NOT EXISTS idx_messages_unread_lookup ON messages(session_id, sender_type, is_me, is_read);`,
  idxMessagesLogicalSegment: `CREATE INDEX IF NOT EXISTS idx_messages_logical_segment ON messages(logical_message_id, segment_index);`,
  // 同一 run 的重复提交或条目重放由部分唯一索引给出 constraint 证据（方案 16.6）
  idxMessagesTurnItem: `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_turn_item ON messages(turn_run_id, turn_item_index) WHERE turn_run_id IS NOT NULL;`,

  // Conversation turn 协调索引：恢复扫描、会话历史、每会话最多一个 active run
  idxTurnRunsRecovery: `CREATE INDEX IF NOT EXISTS idx_turn_runs_recovery ON conversation_turn_runs(session_id, status, input_high_watermark);`,
  idxTurnRunsSessionHistory: `CREATE INDEX IF NOT EXISTS idx_turn_runs_session_history ON conversation_turn_runs(session_id, created_at);`,
  idxTurnRunsSingleActive: `CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_runs_single_active ON conversation_turn_runs(session_id) WHERE status = 'active';`,

  // Call 相关索引
  idxCallSessionsChatSession: `CREATE INDEX IF NOT EXISTS idx_call_sessions_chat_session ON call_sessions(chat_session_id, created_at DESC);`,
  idxCallSessionsStateUpdated: `CREATE INDEX IF NOT EXISTS idx_call_sessions_state_updated ON call_sessions(state, updated_at DESC);`,
  idxCallSessionsAiCreated: `CREATE INDEX IF NOT EXISTS idx_call_sessions_ai_created ON call_sessions(ai_assistant_id, created_at DESC);`,
  idxCallSessionsAgentCreated: `CREATE INDEX IF NOT EXISTS idx_call_sessions_agent_created ON call_sessions(agent_id, created_at DESC);`,
  idxCallEventsCallCreated: `CREATE INDEX IF NOT EXISTS idx_call_events_call_created ON call_events(call_id, created_at ASC);`,
  idxCallEventsChatContext: `CREATE INDEX IF NOT EXISTS idx_call_events_chat_context ON call_events(chat_session_id, include_in_ai_context, created_at DESC);`,
  idxCallAttachmentsCallCreated: `CREATE INDEX IF NOT EXISTS idx_call_attachments_call_created ON call_attachments(call_id, created_at DESC);`,

  // Protocols 相关索引
  idxProtocolsAiId: `CREATE INDEX IF NOT EXISTS idx_protocols_ai_id ON protocols(ai_assistant_id);`,
  idxAuxiliaryModelConfigsUpdatedAt: `CREATE INDEX IF NOT EXISTS idx_auxiliary_model_configs_updated_at ON auxiliary_model_configs(updated_at DESC);`,
  idxAuxiliaryModelConfigsCapabilityKind: `CREATE INDEX IF NOT EXISTS idx_auxiliary_model_configs_capability_kind ON auxiliary_model_configs(capability_kind, updated_at DESC);`,

  // 朋友圈相关索引
  // 点赞唯一性已由 moment_likes 的自然主键 (moment_id, actor_type, actor_id) 保证，
  // 评论不再按 user_name/content 去重（评论事实由作者稳定身份拥有）。
  idxMomentsCreatedAt: MOMENTS_CREATED_AT_INDEX,
  idxMomentsCreatedId: MOMENTS_CREATED_ID_INDEX,
  idxMomentAudienceAiViewer: MOMENT_AUDIENCE_AI_VIEWER_INDEX,
  idxCommentsMomentCreated: MOMENT_COMMENTS_MOMENT_CREATED_INDEX,
  idxCommentsParentId: MOMENT_COMMENTS_PARENT_INDEX,
  idxMomentSocialInboxRecipientUnreadSeq: MOMENT_SOCIAL_INBOX_INDEXES[0],
  idxMomentSocialInboxRecipientMomentUnreadSeq: MOMENT_SOCIAL_INBOX_INDEXES[1],
  idxMomentSocialInboxSourceComment: MOMENT_SOCIAL_INBOX_INDEXES[2],
  idxMomentSocialInboxTargetComment: MOMENT_SOCIAL_INBOX_INDEXES[3],
  idxMomentSocialInboxUnreadLikeRevoke: MOMENT_SOCIAL_INBOX_INDEXES[4],
  idxMomentMediaMomentSort: MOMENT_MEDIA_INDEXES[0],
  idxMomentMediaAsset: MOMENT_MEDIA_INDEXES[1],

  // 应用图标配置索引（历史兼容）
  idxAppIconsUpdatedAt: `CREATE INDEX IF NOT EXISTS idx_app_icons_updated_at ON app_icons(updated_at);`,
  idxUserProfileUpdatedAt: `CREATE INDEX IF NOT EXISTS idx_user_profile_updated_at ON user_profile(updated_at);`,
  idxMemoryPoolsPair: `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_pools_pair ON memory_pools(user_profile_id, ai_assistant_id);`,
  idxMemoryPoolsAiId: `CREATE INDEX IF NOT EXISTS idx_memory_pools_ai_id ON memory_pools(ai_assistant_id);`,
  idxDesktopPersonalizationUpdatedAt: `CREATE INDEX IF NOT EXISTS idx_desktop_personalization_updated_at ON desktop_personalization(updated_at);`,

  // 账本记录索引
  idxLedgerDate: `CREATE INDEX IF NOT EXISTS idx_ledger_date ON ledger_records(record_date);`,
  idxLedgerType: `CREATE INDEX IF NOT EXISTS idx_ledger_type ON ledger_records(type);`,
  idxLedgerCategory: `CREATE INDEX IF NOT EXISTS idx_ledger_category ON ledger_records(category);`,
  idxLedgerDetail: `CREATE INDEX IF NOT EXISTS idx_ledger_detail ON ledger_records(detail);`,

  // 主理AI拉黑索引
  idxAIBlacklistAiId: `CREATE INDEX IF NOT EXISTS idx_ai_blacklist_ai_id ON ai_blacklist(ai_id);`,
  idxAIBlacklistBlockedBy: `CREATE INDEX IF NOT EXISTS idx_ai_blacklist_blocked_by ON ai_blacklist(blocked_by);`,

  // Legacy memory indexes removed

  // 视觉外援协作索引
  idxSessionVisionHelpersSessionId: `CREATE INDEX IF NOT EXISTS idx_session_vision_helpers_session_id ON session_vision_helpers(session_id, updated_at DESC);`,
  idxSessionVisionHelpersEpisodeId: `CREATE UNIQUE INDEX IF NOT EXISTS idx_session_vision_helpers_episode_id ON session_vision_helpers(episode_id);`,
  idxSessionVisionHelpersActive: `CREATE INDEX IF NOT EXISTS idx_session_vision_helpers_active ON session_vision_helpers(session_id, status);`,
};
