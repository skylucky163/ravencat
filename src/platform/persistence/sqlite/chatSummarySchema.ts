/** 摘要是用户记录，只有 conversation 删除级联；消息删除与可见边界不影响它。 */
import type { DatabaseWriteExecutor } from '../runtime';
import { addColumnIfMissing } from './schemaColumnGuard';
export const CHAT_SUMMARY_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_summary_request_settings (
  conversation_id TEXT PRIMARY KEY REFERENCES chat_conversations(id) ON DELETE CASCADE,
  timeout_seconds INTEGER NOT NULL DEFAULT 300,
  max_output_tokens INTEGER,
  model_config_id TEXT,
  group_trigger_count INTEGER NOT NULL DEFAULT 40,
  primary_limit INTEGER
);
CREATE TABLE IF NOT EXISTS chat_summary_tasks (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK(level IN ('primary','secondary')),
  status TEXT NOT NULL CHECK(status IN ('running','waiting','failed','completed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  automatic_failures INTEGER NOT NULL DEFAULT 0,
  manual_retry INTEGER NOT NULL DEFAULT 0,
  last_manual INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  error_json TEXT,
  calls_json TEXT NOT NULL DEFAULT '[]',
  segment_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_summary_pending_task ON chat_summary_tasks(conversation_id,level)
  WHERE status <> 'completed';
CREATE TABLE IF NOT EXISTS chat_timeline_run_anchors (
  session_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  turn_run_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(session_id, turn_run_id)
);
CREATE TABLE IF NOT EXISTS chat_summary_state (
  conversation_id TEXT PRIMARY KEY REFERENCES chat_conversations(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 0,
  processed_cursor TEXT,
  claim_id TEXT,
  claim_to_cursor TEXT,
  claim_expires_at TEXT
);
CREATE TABLE IF NOT EXISTS chat_summary_segments (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  content TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'primary' CHECK(level IN ('primary', 'secondary')),
  compaction_id TEXT,
  context_sequence INTEGER,
  from_cursor TEXT,
  to_cursor TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  batch_size INTEGER,
  source_start_at TEXT,
  source_end_at TEXT,
  time_zone TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(conversation_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_chat_summary_conversation_order ON chat_summary_segments(conversation_id, sequence);
CREATE TABLE IF NOT EXISTS chat_summary_settings (
  conversation_id TEXT PRIMARY KEY REFERENCES chat_conversations(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  inject_enabled INTEGER NOT NULL DEFAULT 1,
  fixed_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  secondary_enabled INTEGER NOT NULL DEFAULT 1,
  secondary_token_threshold INTEGER NOT NULL DEFAULT 8000
);
CREATE TABLE IF NOT EXISTS chat_summary_processed_calls (
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  PRIMARY KEY(conversation_id, call_id)
);
CREATE TABLE IF NOT EXISTS chat_summary_call_boundary (
  conversation_id TEXT PRIMARY KEY REFERENCES chat_conversations(id) ON DELETE CASCADE,
  cleared_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_summary_work_queue (
  conversation_id TEXT PRIMARY KEY REFERENCES chat_conversations(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
  checked_revision INTEGER NOT NULL DEFAULT 0
);
`;

// 入队和来源事实同事务提交；版本水位保留检查期间到来的新变化，后台与进程退出不会丢工作。
function enqueueSummaryWork(where: string): string {
  return `INSERT INTO chat_summary_work_queue (conversation_id)
    SELECT id FROM chat_conversations WHERE ${where}
    ON CONFLICT(conversation_id) DO UPDATE SET revision = revision + 1;`;
}

/** 这里只记录需要重新检查的身份，不扫描原文、不建立生成任务或消耗重试预算。 */
export const CHAT_SUMMARY_WORK_QUEUE_TRIGGERS = `
CREATE INDEX IF NOT EXISTS idx_chat_summary_work_pending ON chat_summary_work_queue(conversation_id)
  WHERE revision > checked_revision;
CREATE TRIGGER IF NOT EXISTS chat_summary_queue_message_insert AFTER INSERT ON messages
  WHEN NEW.status = 'sent' BEGIN ${enqueueSummaryWork('id = NEW.session_id')} END;
CREATE TRIGGER IF NOT EXISTS chat_summary_queue_message_update
  AFTER UPDATE OF text,status,delivery_status,metadata_json,sender_type,logical_message_id,turn_run_id,turn_item_index ON messages
  WHEN NEW.status = 'sent' AND (OLD.text IS NOT NEW.text OR OLD.status IS NOT NEW.status
    OR OLD.delivery_status IS NOT NEW.delivery_status OR OLD.metadata_json IS NOT NEW.metadata_json
    OR OLD.sender_type IS NOT NEW.sender_type OR OLD.logical_message_id IS NOT NEW.logical_message_id
    OR OLD.turn_run_id IS NOT NEW.turn_run_id OR OLD.turn_item_index IS NOT NEW.turn_item_index)
  BEGIN ${enqueueSummaryWork('id = NEW.session_id')} END;
CREATE TRIGGER IF NOT EXISTS chat_summary_queue_message_delete AFTER DELETE ON messages
  BEGIN ${enqueueSummaryWork('id = OLD.session_id')} END;
CREATE TRIGGER IF NOT EXISTS chat_summary_queue_turn_insert AFTER INSERT ON conversation_turn_state
  WHEN NEW.reply_cursor > 0 BEGIN ${enqueueSummaryWork('id = NEW.session_id')} END;
CREATE TRIGGER IF NOT EXISTS chat_summary_queue_turn_update AFTER UPDATE OF reply_cursor ON conversation_turn_state
  WHEN OLD.reply_cursor IS NOT NEW.reply_cursor BEGIN ${enqueueSummaryWork('id = NEW.session_id')} END;
CREATE TRIGGER IF NOT EXISTS chat_summary_queue_group_plan AFTER UPDATE OF status ON group_speech_plans
  WHEN OLD.status IS NOT NEW.status AND NEW.status IN ('completed','failed','terminated','superseded')
  BEGIN ${enqueueSummaryWork('id = NEW.group_id')} END;
CREATE TRIGGER IF NOT EXISTS chat_summary_queue_call_event AFTER INSERT ON call_events
  WHEN NEW.include_in_ai_context = 1 BEGIN ${enqueueSummaryWork('id = NEW.chat_session_id')} END;
CREATE TRIGGER IF NOT EXISTS chat_summary_queue_call_end AFTER UPDATE OF ended_at ON call_sessions
  WHEN OLD.ended_at IS NOT NEW.ended_at AND NEW.ended_at IS NOT NULL
  BEGIN ${enqueueSummaryWork('id = NEW.chat_session_id')} END;
CREATE TRIGGER IF NOT EXISTS chat_summary_queue_summary_change AFTER UPDATE OF revision ON chat_summary_state
  WHEN OLD.revision IS NOT NEW.revision BEGIN ${enqueueSummaryWork('id = NEW.conversation_id')} END;
CREATE TRIGGER IF NOT EXISTS chat_summary_queue_assistant_model
  AFTER UPDATE OF model,api_key,api_base_url,private_context_primary_limit ON ai_assistants
  WHEN OLD.model IS NOT NEW.model OR OLD.api_key IS NOT NEW.api_key OR OLD.api_base_url IS NOT NEW.api_base_url
    OR OLD.private_context_primary_limit IS NOT NEW.private_context_primary_limit
  BEGIN ${enqueueSummaryWork('id IN (SELECT id FROM sessions WHERE ai_assistant_id = NEW.id)')} END;
CREATE TRIGGER IF NOT EXISTS chat_summary_queue_group_model_insert AFTER INSERT ON group_chat_admin_configs
  BEGIN ${enqueueSummaryWork('id = NEW.group_id')} END;
CREATE TRIGGER IF NOT EXISTS chat_summary_queue_group_model_update
  AFTER UPDATE OF model,api_key,api_base_url ON group_chat_admin_configs
  WHEN OLD.model IS NOT NEW.model OR OLD.api_key IS NOT NEW.api_key OR OLD.api_base_url IS NOT NEW.api_base_url
  BEGIN ${enqueueSummaryWork('id = NEW.group_id')} END;
`;

/** 旧版本没有持久待检查记录，只在升级事务内发现一次既有来源；普通启动不再补扫。 */
export async function migrateChatSummaryWorkQueue(db: DatabaseWriteExecutor): Promise<void> {
  await db.execAsync(`INSERT OR IGNORE INTO chat_summary_work_queue (conversation_id)
    SELECT c.id FROM chat_conversations c WHERE
      EXISTS (SELECT 1 FROM messages m WHERE m.session_id = c.id)
      OR EXISTS (SELECT 1 FROM call_sessions s WHERE s.chat_session_id = c.id)
      OR EXISTS (SELECT 1 FROM chat_summary_segments s WHERE s.conversation_id = c.id)
      OR EXISTS (SELECT 1 FROM chat_summary_tasks t WHERE t.conversation_id = c.id AND t.status <> 'completed');`);
}
/** 配置引用不建资产外键，删除资产后仍保留选择及不可用状态。 */
export async function migrateChatSummaryModels(db: DatabaseWriteExecutor): Promise<void> {
  await db.execAsync(`CREATE TABLE IF NOT EXISTS chat_summary_request_settings (
    conversation_id TEXT PRIMARY KEY REFERENCES chat_conversations(id) ON DELETE CASCADE,
    timeout_seconds INTEGER NOT NULL DEFAULT 300, max_output_tokens INTEGER);`);
  await addColumnIfMissing(db, 'chat_summary_request_settings', 'model_config_id', 'TEXT');
  await addColumnIfMissing(db, 'chat_summary_request_settings', 'group_trigger_count', 'INTEGER NOT NULL DEFAULT 40');
}
/** 归纳标记是处理进度，不是外键：用户删除二级正文后，不能自动补回或重新注入其原摘要。 */
export async function migrateSecondaryChatSummary(db: DatabaseWriteExecutor): Promise<void> {
  await addColumnIfMissing(db, 'chat_summary_segments', 'level', "TEXT NOT NULL DEFAULT 'primary' CHECK(level IN ('primary', 'secondary'))");
  await addColumnIfMissing(db, 'chat_summary_segments', 'compaction_id', 'TEXT');
  await addColumnIfMissing(db, 'chat_summary_segments', 'context_sequence', 'INTEGER');
}
/** 单聊摘要条数默认跟随主视角上限；留空即跟随，手动填写后固定。 */
export async function migrateChatSummaryPrimaryLimit(db: DatabaseWriteExecutor): Promise<void> {
  await addColumnIfMissing(db, 'chat_summary_request_settings', 'primary_limit', 'INTEGER');
}
/** 旧总开关映射到生成与注入两个独立开关；起点删除仅清引用，不恢复生成。 */
export async function migrateFixedChatContext(db: DatabaseWriteExecutor): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>("PRAGMA table_info('chat_summary_settings')");
  const hadInjectEnabled = columns.some((column) => column.name === 'inject_enabled');
  await addColumnIfMissing(db, 'chat_summary_settings', 'inject_enabled', 'INTEGER NOT NULL DEFAULT 1');
  await addColumnIfMissing(db, 'chat_summary_settings', 'fixed_message_id', 'INTEGER REFERENCES messages(id) ON DELETE SET NULL');
  // 只在本次真的新增列时迁移旧开关，避免重复执行覆盖用户已保存的选择。
  if (!hadInjectEnabled) await db.execAsync('UPDATE chat_summary_settings SET inject_enabled = enabled;');
}
/** 消息插入时固化回合锚点，后续清除历史边界不影响摘要顺序。 */
export const CHAT_TIMELINE_RUN_ANCHOR_SCHEMA = `
CREATE TRIGGER IF NOT EXISTS capture_chat_timeline_run_anchor AFTER INSERT ON messages
  WHEN NEW.turn_run_id IS NOT NULL AND NEW.turn_item_index = 1
  BEGIN
    INSERT OR IGNORE INTO chat_timeline_run_anchors (session_id, turn_run_id, id, created_at)
      VALUES (NEW.session_id, NEW.turn_run_id, NEW.id, NEW.created_at);
  END;
`;

/** 等历史消息列补齐后再建立 anchor，兼容旧备份的真实 bootstrap 顺序。 */
export async function migrateChatSummary(db: DatabaseWriteExecutor): Promise<void> {
  await db.execAsync(CHAT_SUMMARY_SCHEMA);
  await db.execAsync(`
INSERT OR IGNORE INTO chat_timeline_run_anchors (session_id, turn_run_id, id, created_at)
  SELECT session_id, turn_run_id, id, created_at FROM messages WHERE turn_run_id IS NOT NULL AND turn_item_index = 1;
${CHAT_TIMELINE_RUN_ANCHOR_SCHEMA}
  `);
}

/** 摘要正文独立保存；退休来源关联，不复制孤立旧引用，处理进度与通话原文保持不变。 */
export async function retireChatSummaryCallAssociations(db: DatabaseWriteExecutor): Promise<void> {
  await db.execAsync('DROP TABLE IF EXISTS chat_summary_call_segments;');
}
