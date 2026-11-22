/** owner_ai_id 刻意不设级联外键，AI 删除后仍保留历史 wake identity。 */
export const RAVEN_CAT_SELF_WAKES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS raven_cat_self_wakes (
    wake_id TEXT PRIMARY KEY CHECK (length(trim(wake_id)) > 0),
    owner_ai_id TEXT NOT NULL CHECK (length(trim(owner_ai_id)) > 0),
    wake_at TEXT NOT NULL,
    note TEXT,
    status TEXT NOT NULL
      CHECK (status IN ('scheduled', 'claimed', 'consumed', 'superseded')),
    created_by_run_id TEXT,
    claimed_by_run_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    claimed_at TEXT,
    consumed_at TEXT,
    superseded_at TEXT,
    CHECK (
      (status = 'scheduled'
        AND claimed_by_run_id IS NULL AND claimed_at IS NULL
        AND consumed_at IS NULL AND superseded_at IS NULL)
      OR
      (status = 'claimed'
        AND claimed_by_run_id IS NOT NULL AND claimed_at IS NOT NULL
        AND consumed_at IS NULL AND superseded_at IS NULL)
      OR
      (status = 'consumed'
        AND claimed_by_run_id IS NOT NULL AND claimed_at IS NOT NULL
        AND consumed_at IS NOT NULL AND superseded_at IS NULL)
      OR
      (status = 'superseded'
        AND claimed_by_run_id IS NULL AND claimed_at IS NULL
        AND consumed_at IS NULL AND superseded_at IS NOT NULL)
    )
  );
`;

export const RAVEN_CAT_SELF_WAKES_SCHEDULED_OWNER_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_raven_cat_self_wakes_owner_scheduled
    ON raven_cat_self_wakes(owner_ai_id) WHERE status = 'scheduled';
`;

export const RAVEN_CAT_SELF_WAKES_CLAIMED_OWNER_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_raven_cat_self_wakes_owner_claimed
    ON raven_cat_self_wakes(owner_ai_id) WHERE status = 'claimed';
`;

/** 历史迁移保留的 terminal metadata 索引；产品时间轴已改用 claimed_at。 */
export const RAVEN_CAT_SELF_WAKES_CONSUMED_HISTORY_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_raven_cat_self_wakes_owner_consumed_terminal
    ON raven_cat_self_wakes(owner_ai_id, consumed_at DESC, wake_id DESC)
    WHERE status = 'consumed';
`;

/** 主动生活历史按机会实际发生时间排序；claimed_at 是 consumed 记录的 occurredAt。 */
export const RAVEN_CAT_SELF_WAKES_CONSUMED_OCCURRED_HISTORY_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_raven_cat_self_wakes_owner_consumed_occurred
    ON raven_cat_self_wakes(owner_ai_id, claimed_at DESC, wake_id DESC)
    WHERE status = 'consumed';
`;
