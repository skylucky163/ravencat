/** 提供主动伴随与唯一 AI 日程使用的 SQLite 建表语句。 */
import { addColumnIfMissing } from './schemaColumnGuard';

export const RAVEN_CAT_COMPANION_STATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS raven_cat_companion_state (
    id TEXT PRIMARY KEY,
    desired_enabled INTEGER NOT NULL DEFAULT 0 CHECK (desired_enabled IN (0, 1)),
    activation_status TEXT NOT NULL DEFAULT 'disabled'
      CHECK (activation_status IN ('disabled', 'enabling', 'enabled', 'paused_error', 'disabling')),
    schedule_revision INTEGER NOT NULL DEFAULT 0 CHECK (schedule_revision >= 0),
    host_ai_id TEXT,
    last_failure_code TEXT,
    last_failure_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (host_ai_id) REFERENCES ai_assistants(id) ON DELETE SET NULL
  );
`;

/** 日程 owner 不设外键，以保留创建者与完整历史。 */
function buildRavenCatAISchedulesSchema(
  tableName: 'raven_cat_ai_schedules' | 'raven_cat_ai_schedules_new',
  ifNotExists: boolean,
): string {
  return `
  CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} (
    schedule_id TEXT PRIMARY KEY CHECK (length(trim(schedule_id)) > 0),
    owner_ai_id TEXT NOT NULL CHECK (length(trim(owner_ai_id)) > 0),
    remind_at TEXT NOT NULL,
    summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 160),
    details TEXT NOT NULL CHECK (length(trim(details)) BETWEEN 1 AND 4000),
    system_calendar INTEGER NOT NULL DEFAULT 0 CHECK (system_calendar IN (0, 1)),
    ${ifNotExists ? AI_SCHEDULE_TIMING_COLUMNS.join(',\n    ') + ',' : ''}
    source_conversation_id TEXT,
    source_message_ids_json TEXT,
    source_excerpt TEXT CHECK (source_excerpt IS NULL OR length(source_excerpt) BETWEEN 1 AND 2000),
    status TEXT NOT NULL
      CHECK (status IN ('scheduled', 'claimed', 'consumed', 'cancelled')),
    claimed_by_run_id TEXT,
    claimed_at TEXT,
    consumed_at TEXT,
    completion_disposition TEXT
      CHECK (completion_disposition IS NULL
        OR completion_disposition IN ('agent_terminal', 'interrupted')),
    cancelled_at TEXT,
    cancelled_reason TEXT CHECK (cancelled_reason IS NULL OR cancelled_reason IN ('owner_revoked', 'expired', 'merged_schedule', 'merged_chat')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (source_conversation_id IS NULL AND source_message_ids_json IS NULL AND source_excerpt IS NULL)
      OR
      (source_conversation_id IS NOT NULL AND source_message_ids_json IS NOT NULL AND source_excerpt IS NOT NULL)
    ),
    CHECK (
      (status = 'scheduled'
        AND claimed_by_run_id IS NULL AND claimed_at IS NULL
        AND consumed_at IS NULL AND completion_disposition IS NULL
        AND cancelled_at IS NULL AND cancelled_reason IS NULL)
      OR
      (status = 'claimed'
        AND claimed_by_run_id IS NOT NULL AND claimed_at IS NOT NULL
        AND consumed_at IS NULL AND completion_disposition IS NULL
        AND cancelled_at IS NULL AND cancelled_reason IS NULL)
      OR
      (status = 'consumed'
        AND claimed_by_run_id IS NOT NULL AND claimed_at IS NOT NULL
        AND consumed_at IS NOT NULL AND completion_disposition IS NOT NULL
        AND cancelled_at IS NULL AND cancelled_reason IS NULL)
      OR
      (status = 'cancelled'
        AND claimed_by_run_id IS NULL AND claimed_at IS NULL
        AND consumed_at IS NULL AND completion_disposition IS NULL
        AND cancelled_at IS NOT NULL)
    )
  );
`;
}

const AI_SCHEDULE_TIMING_COLUMNS = [
  'recurrence_json TEXT',
  'series_id TEXT',
  "trigger_kind TEXT NOT NULL DEFAULT 'scheduled' CHECK (trigger_kind IN ('scheduled','unanswered'))",
  'conversation_id TEXT',
  'reply_revision INTEGER',
  'next_follow_up_minutes INTEGER CHECK (next_follow_up_minutes IS NULL OR next_follow_up_minutes BETWEEN 2 AND 43200)',
];

/** 等待事实只保存回复代次和消息依据；实际唤醒仍是唯一日程表中的一行。 */
export const RAVEN_CAT_AI_SCHEDULE_WAIT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS raven_cat_ai_schedule_wait (
    conversation_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0,
    active_run_id TEXT
  );
  CREATE TABLE IF NOT EXISTS raven_cat_ai_schedule_unanswered (
    schedule_id TEXT PRIMARY KEY REFERENCES raven_cat_ai_schedules(schedule_id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL,
    first_visible_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_schedule_unanswered_conversation
    ON raven_cat_ai_schedule_unanswered(conversation_id, first_visible_at, schedule_id);
`;

export async function migrateAIScheduleTiming(db: RavenCatCompanionMigrationExecutor): Promise<void> {
  for (const column of AI_SCHEDULE_TIMING_COLUMNS) {
    const [name, ...definition] = column.split(' ');
    await addColumnIfMissing(db, 'raven_cat_ai_schedules', name, definition.join(' '));
  }
  await addColumnIfMissing(db, 'raven_cat_contact_settings', 'follow_up_enabled', 'INTEGER NOT NULL DEFAULT 0 CHECK (follow_up_enabled IN (0,1))');
  await addColumnIfMissing(db, 'raven_cat_contact_settings', 'follow_up_interval_minutes', 'INTEGER NOT NULL DEFAULT 10 CHECK (follow_up_interval_minutes BETWEEN 2 AND 43200)');
}

export const RAVEN_CAT_AI_SCHEDULES_SCHEMA = buildRavenCatAISchedulesSchema(
  'raven_cat_ai_schedules',
  true,
);

/** 每个日程只保存一份处理结果及提示词交接身份，没有重新执行入口。 */
export const RAVEN_CAT_AI_SCHEDULE_CONTEXT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS raven_cat_ai_schedule_context (
    schedule_id TEXT PRIMARY KEY REFERENCES raven_cat_ai_schedules(schedule_id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    target_schedule_id TEXT,
    presented_run_id TEXT,
    acknowledged_at TEXT,
    occurred_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_schedule_context_pending
    ON raven_cat_ai_schedule_context(acknowledged_at, target_schedule_id, occurred_at, schedule_id);
`;

/** 升级系统终结原因的约束，保留原始计划、领取及历史事实。 */
export async function migrateAIScheduleContext(db: RavenCatCompanionMigrationExecutor): Promise<void> {
  const columns = `schedule_id,owner_ai_id,remind_at,summary,details,system_calendar,
    source_conversation_id,source_message_ids_json,source_excerpt,status,claimed_by_run_id,claimed_at,
    consumed_at,completion_disposition,cancelled_at,cancelled_reason,created_at,updated_at`;
  await db.execAsync(`${RAVEN_CAT_AI_SCHEDULES_REBUILD_SCHEMA}
    INSERT INTO raven_cat_ai_schedules_new (${columns}) SELECT ${columns} FROM raven_cat_ai_schedules;
    DROP TABLE raven_cat_ai_schedules;
    ALTER TABLE raven_cat_ai_schedules_new RENAME TO raven_cat_ai_schedules;`);
  await db.execAsync(RAVEN_CAT_AI_SCHEDULE_CONTEXT_SCHEMA);
  await db.execAsync([
    RAVEN_CAT_AI_SCHEDULES_OWNER_STATUS_TIME_INDEX, RAVEN_CAT_AI_SCHEDULES_OWNER_TIME_INDEX,
    RAVEN_CAT_AI_SCHEDULES_CONSUMED_HISTORY_INDEX, RAVEN_CAT_AI_SCHEDULES_CONSUMED_OCCURRED_HISTORY_INDEX,
  ].join('\n'));
}

const RAVEN_CAT_AI_SCHEDULES_REBUILD_SCHEMA = buildRavenCatAISchedulesSchema(
  'raven_cat_ai_schedules_new',
  false,
);

/** 覆盖按状态读取 future/history 的稳定范围查询。 */
export const RAVEN_CAT_AI_SCHEDULES_OWNER_STATUS_TIME_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_raven_cat_ai_schedules_owner_status_time
    ON raven_cat_ai_schedules(owner_ai_id, status, remind_at, schedule_id);
`;

/** 覆盖 status=all 的稳定范围查询。 */
export const RAVEN_CAT_AI_SCHEDULES_OWNER_TIME_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_raven_cat_ai_schedules_owner_time
    ON raven_cat_ai_schedules(owner_ai_id, remind_at, schedule_id);
`;

/** 历史迁移保留的 terminal metadata 索引；产品时间轴已改用 claimed_at。 */
export const RAVEN_CAT_AI_SCHEDULES_CONSUMED_HISTORY_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_raven_cat_ai_schedules_owner_consumed_terminal
    ON raven_cat_ai_schedules(owner_ai_id, consumed_at DESC, schedule_id DESC)
    WHERE status = 'consumed';
`;

/** 主动生活历史按机会实际发生时间排序；claimed_at 是 consumed 记录的 occurredAt。 */
export const RAVEN_CAT_AI_SCHEDULES_CONSUMED_OCCURRED_HISTORY_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_raven_cat_ai_schedules_owner_consumed_occurred
    ON raven_cat_ai_schedules(owner_ai_id, claimed_at DESC, schedule_id DESC)
    WHERE status = 'consumed';
`;

interface RavenCatCompanionMigrationExecutor {
  execAsync(source: string): Promise<void>;
  getAllAsync<T>(source: string): Promise<T[]>;
}

/**
 * 把旧 AI Schedule 表收敛到与 fresh schema 完全相同的跨列状态约束。
 *
 * 旧版 Migration 83 只增加了 column CHECK，无法约束 status 与 disposition 的
 * 组合；这里通过 sqlite_master 识别该 drift，并在一个 transaction 内重建表、
 * backfill 历史 consumed disposition、恢复全部业务索引。
 */
export async function migrateRavenCatAISchedulesCompletionDisposition(
  db: RavenCatCompanionMigrationExecutor,
): Promise<void> {
  const tableRows = await db.getAllAsync<{ sql: string | null }>(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'raven_cat_ai_schedules'
  `);
  if (tableRows.length === 0) {
    throw new Error('AI Schedule Migration 83 要求 migration 78 已建立业务表');
  }

  const createSql = (tableRows[0].sql ?? '').toLowerCase();
  const dispositionNullChecks = createSql.match(
    /completion_disposition\s+is\s+null/g,
  )?.length ?? 0;
  const hasLatestStateCheck = dispositionNullChecks >= 4
    && /completion_disposition\s+is\s+not\s+null/.test(createSql);

  if (!hasLatestStateCheck) {
    const columns = await db.getAllAsync<{ name: string }>(
      `PRAGMA table_info('raven_cat_ai_schedules')`,
    );
    const hasCompletionDisposition = columns.some(
      (column) => column.name === 'completion_disposition',
    );
    const completionDispositionExpression = hasCompletionDisposition
      ? `CASE
           WHEN status = 'consumed'
             THEN COALESCE(completion_disposition, 'agent_terminal')
           ELSE NULL
         END`
      : `CASE WHEN status = 'consumed' THEN 'agent_terminal' ELSE NULL END`;

    await db.execAsync('BEGIN;');
    try {
      await db.execAsync(`DROP TABLE IF EXISTS raven_cat_ai_schedules_new;`);
      await db.execAsync(RAVEN_CAT_AI_SCHEDULES_REBUILD_SCHEMA);
      await db.execAsync(`
        INSERT INTO raven_cat_ai_schedules_new (
          schedule_id, owner_ai_id, remind_at, summary, details,
          source_conversation_id, source_message_ids_json, source_excerpt,
          status, claimed_by_run_id, claimed_at, consumed_at,
          completion_disposition, cancelled_at, cancelled_reason,
          created_at, updated_at
        )
        SELECT
          schedule_id, owner_ai_id, remind_at, summary, details,
          source_conversation_id, source_message_ids_json, source_excerpt,
          status, claimed_by_run_id, claimed_at, consumed_at,
          ${completionDispositionExpression}, cancelled_at, cancelled_reason,
          created_at, updated_at
        FROM raven_cat_ai_schedules;

        DROP TABLE raven_cat_ai_schedules;
        ALTER TABLE raven_cat_ai_schedules_new RENAME TO raven_cat_ai_schedules;
      `);
      await db.execAsync(RAVEN_CAT_AI_SCHEDULES_OWNER_STATUS_TIME_INDEX);
      await db.execAsync(RAVEN_CAT_AI_SCHEDULES_OWNER_TIME_INDEX);
      await db.execAsync(RAVEN_CAT_AI_SCHEDULES_CONSUMED_HISTORY_INDEX);
      await db.execAsync(RAVEN_CAT_AI_SCHEDULES_CONSUMED_OCCURRED_HISTORY_INDEX);
      await db.execAsync('COMMIT;');
    } catch (error) {
      await db.execAsync('ROLLBACK;');
      throw error;
    }
    return;
  }

  // latest fresh schema 不需重建；索引仍由当前 migration contract 幂等确保。
  await db.execAsync(RAVEN_CAT_AI_SCHEDULES_OWNER_STATUS_TIME_INDEX);
  await db.execAsync(RAVEN_CAT_AI_SCHEDULES_OWNER_TIME_INDEX);
  await db.execAsync(RAVEN_CAT_AI_SCHEDULES_CONSUMED_HISTORY_INDEX);
  await db.execAsync(RAVEN_CAT_AI_SCHEDULES_CONSUMED_OCCURRED_HISTORY_INDEX);
}

/**
 * 退役 CompanionState 的旧 wake 单值列。旧值没有稳定 identity，禁止迁入 Self Wake。
 */
export async function migrateRavenCatCompanionStateWakeColumns(
  db: RavenCatCompanionMigrationExecutor,
): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>(
    `PRAGMA table_info('raven_cat_companion_state')`,
  );
  const columnNames = new Set(columns.map((column) => column.name));
  const retiredColumns = [
    'desired_wake_at',
    'continuity_deadline',
    'effective_wake_at',
    'wake_intent_summary',
    'wake_adjustment_reason',
    'next_wake_at',
    'next_wake_source',
  ];
  if (!retiredColumns.some((column) => columnNames.has(column))) return;

  await db.execAsync('PRAGMA foreign_keys = OFF;');
  try {
    await db.execAsync(`
      BEGIN;
      CREATE TABLE raven_cat_companion_state_new (
        id TEXT PRIMARY KEY,
        desired_enabled INTEGER NOT NULL DEFAULT 0
          CHECK (desired_enabled IN (0, 1)),
        activation_status TEXT NOT NULL DEFAULT 'disabled'
          CHECK (activation_status IN ('disabled', 'enabling', 'enabled', 'paused_error', 'disabling')),
        schedule_revision INTEGER NOT NULL DEFAULT 0
          CHECK (schedule_revision >= 0),
        host_ai_id TEXT,
        last_failure_code TEXT,
        last_failure_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (host_ai_id) REFERENCES ai_assistants(id) ON DELETE SET NULL
      );

      INSERT INTO raven_cat_companion_state_new (
        id, desired_enabled, activation_status, schedule_revision,
        host_ai_id, last_failure_code, last_failure_at, created_at, updated_at
      )
      SELECT id, desired_enabled, activation_status, schedule_revision,
        host_ai_id, last_failure_code, last_failure_at, created_at, updated_at
      FROM raven_cat_companion_state;

      DROP TABLE raven_cat_companion_state;
      ALTER TABLE raven_cat_companion_state_new RENAME TO raven_cat_companion_state;
      COMMIT;
    `);
  } catch (error) {
    await db.execAsync('ROLLBACK;');
    throw error;
  } finally {
    await db.execAsync('PRAGMA foreign_keys = ON;');
  }
}

export const RAVEN_CAT_COMPANION_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_assistants_single_host
     ON ai_assistants(is_host_ai) WHERE is_host_ai = 1;`,
] as const;
