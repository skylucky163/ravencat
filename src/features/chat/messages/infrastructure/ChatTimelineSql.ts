/** 时间线、摘要和原文窗口共用 canonical 顺序，游标不依赖被删除消息行。 */
export interface TimelineOrderRow {
  timeline_order_created_at: string;
  timeline_order_anchor_id: number;
  timeline_order_item_index: number | null;
  id: number;
}

/**
 * SQLite 中的聊天时间线排序键与 ChatTimelineOrdering 的组合规则保持一致：
 * 同一 run 以 turn_item_index=1 的首项作为锚点，再按 turn_item_index 排列；
 * 不同 run 之间使用各自最早成员的 created_at + id，普通消息使用自身历史键。
 *
 * turn_item_index 为 NULL 的 run 行是独立提交项（业务卡片或尚未绑定最终顺序的
 * 图片／表情）：组内槽位取「created_at 不晚于自身的
 * 最后一个 canonical 成员」之后的半槽位（MAX + 0.5，无成员则为 0.5），同槽位
 * 按 id 排列；它不参与锚点候选。run 没有任何已提交成员时（失败/取消/非
 * canonical run），锚点回退为自身历史键，该行等同普通消息排序。
 *
 * T3 在一个事务中写入其余条目并绑定已提交媒体，锚点把完整 run 作为一个稳定区间；
 * Chat 持久保存最小锚点，使删除首项之后的处理游标仍稳定；不保存消息副本，
 * 也不改变消息的真实 created_at。
 */
export function timelineOrderExpressions(alias = 'm', anchorAlias = 'a'): {
  createdAt: string;
  anchorId: string;
  itemIndex: string;
} {
  return {
    createdAt: `CASE WHEN ${alias}.turn_run_id IS NULL
      THEN ${alias}.created_at
      ELSE COALESCE(${anchorAlias}.created_at, ${alias}.created_at)
    END`,
    anchorId: `CASE WHEN ${alias}.turn_run_id IS NULL
      THEN ${alias}.id
      ELSE COALESCE(${anchorAlias}.id, ${alias}.id)
    END`,
    itemIndex: `CASE
      WHEN ${alias}.turn_run_id IS NULL THEN 0
      WHEN ${alias}.turn_item_index IS NOT NULL THEN ${alias}.turn_item_index
      ELSE (
        SELECT COALESCE(MAX(x.turn_item_index), 0) + 0.5
        FROM messages x
        WHERE x.session_id = ${alias}.session_id
          AND x.turn_run_id = ${alias}.turn_run_id
          AND x.turn_item_index IS NOT NULL
          AND x.created_at <= ${alias}.created_at
      )
    END`,
  };
}

export function timelineOrderedMessagesCte(
  sourceWhere?: string,
  projection: 'full' | 'keys' = 'full',
): string {
  const expressions = timelineOrderExpressions('m', 'a');
  return `WITH ordered_messages AS (
    SELECT ${projection === 'keys' ? 'm.id' : 'm.*'},
      ${expressions.createdAt} AS timeline_order_created_at,
      ${expressions.anchorId} AS timeline_order_anchor_id,
      ${expressions.itemIndex} AS timeline_order_item_index
    FROM chat_visible_messages m
    LEFT JOIN chat_timeline_run_anchors a
      ON a.session_id = m.session_id
      AND a.turn_run_id = m.turn_run_id
    ${sourceWhere ? `WHERE ${sourceWhere}` : ''}
  )`;
}

export function timelineProjectionOrderBy(order: 'ASC' | 'DESC', alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  return [
    `${prefix}timeline_order_created_at ${order}`,
    `${prefix}timeline_order_anchor_id ${order}`,
    `${prefix}timeline_order_item_index ${order}`,
    `${prefix}id ${order}`,
  ].join(', ');
}

export function timelineCursorCondition(
  order: 'ASC' | 'DESC',
  cursor: TimelineOrderRow,
): { sql: string; params: (string | number | null)[] } {
  const comparator = order === 'ASC' ? '>' : '<';
  const columns = [
    'timeline_order_created_at',
    'timeline_order_anchor_id',
    'timeline_order_item_index',
    'id',
  ];
  const values: (string | number | null)[] = [
    cursor.timeline_order_created_at,
    cursor.timeline_order_anchor_id,
    cursor.timeline_order_item_index,
    cursor.id,
  ];
  const clauses: string[] = [];
  for (let index = 0; index < columns.length; index += 1) {
    const equalColumns = columns
      .slice(0, index)
      .map((column) => `${column} = ?`)
      .join(' AND ');
    clauses.push(
      `${equalColumns ? `${equalColumns} AND ` : ''}${columns[index]} ${comparator} ?`,
    );
  }
  // 每个分支都重复使用同一 cursor 值，参数顺序与条件逐项对应。
  const params: (string | number | null)[] = [];
  for (let index = 0; index < columns.length; index += 1) {
    for (let equalIndex = 0; equalIndex < index; equalIndex += 1) {
      params.push(values[equalIndex]);
    }
    params.push(values[index]);
  }
  return {
    sql: `(${clauses.join(' OR ')})`,
    params,
  };
}

/**
 * 原文全量聚合不受分页或旧版本可见边界影响；清除历史物理删除的消息不再参与。
 * 同一模型调用的前言与工具状态可能重复保存 usage，按调用身份取最大值；
 * 多分段只有末段保存 usage。语音／表情等独立条目可能承接内部终轮用量，保留其独立归属。
 * 发言条数只计已发送正文；工具失败或尚未结束不撤销模型已返回并保存的实际用量。
 */
export const CHAT_RECORD_STATISTICS_SQL = `
  WITH source AS (
    SELECT *, CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END AS metadata
    FROM messages
    WHERE session_id = ?
  ), identified AS (
    SELECT *,
      COALESCE('run:' || NULLIF(turn_run_id, ''),
               'run:' || NULLIF(json_extract(metadata, '$.replyRunId'), ''),
               'logical:' || NULLIF(logical_message_id, ''), 'message:' || id) AS reply_key,
      CASE WHEN sender_type = 'user' AND status = 'sent'
        AND COALESCE(delivery_status, 'delivered') <> 'cancelled'
        THEN 1 ELSE 0 END AS is_user_message,
      CASE WHEN sender_type = 'assistant' AND status = 'sent'
        AND COALESCE(delivery_status, 'delivered') <> 'cancelled'
        AND COALESCE(json_extract(metadata, '$.kind'), '') <> 'error'
        AND COALESCE(json_extract(metadata, '$.type'), '') NOT IN ('callStatus', 'toolStatus', 'togetherListening')
        THEN 1 ELSE 0 END AS is_assistant_message
    FROM source
  ), usage_rows AS (
    SELECT *, CASE
      WHEN (sender_type = 'assistant' AND COALESCE(json_extract(metadata, '$.kind'), '') NOT IN ('voice', 'sticker'))
        OR json_extract(metadata, '$.type') IN ('toolStatus', 'agentActivity')
      THEN COALESCE(COALESCE('run:' || NULLIF(turn_run_id, ''),
                            'run:' || NULLIF(json_extract(metadata, '$.replyRunId'), ''), 'legacy')
                      || ':api:' || NULLIF(api_message_id, ''),
                    reply_key || ':step:' || json_extract(metadata, '$.stepIndex'),
                    'logical:' || NULLIF(logical_message_id, ''), 'message:' || id)
      ELSE 'message:' || id END AS usage_key
    FROM identified
    WHERE tokens_used > 0 OR prompt_tokens > 0 OR completion_tokens > 0
  ), usages AS (
    SELECT usage_key,
      MAX(CASE WHEN tokens_used > 0 THEN tokens_used ELSE COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0) END) AS total,
      MAX(COALESCE(prompt_tokens, 0)) AS prompt,
      MAX(COALESCE(completion_tokens, 0)) AS completion
    FROM usage_rows GROUP BY usage_key
  ), replies AS (
    SELECT reply_key, MAX(is_assistant_message) AS has_message,
      MAX(CASE WHEN tokens_used > 0 OR prompt_tokens > 0 OR completion_tokens > 0 THEN 1 ELSE 0 END) AS has_usage
    FROM identified GROUP BY reply_key
  )
  SELECT
    COUNT(CASE WHEN is_user_message = 1 THEN 1 END) AS userMessageCount,
    (SELECT COUNT(*) FROM replies WHERE has_message = 1) AS assistantMessageCount,
    COALESCE(SUM(CASE WHEN is_user_message = 1 THEN length(text) ELSE 0 END), 0) AS userCharacterCount,
    COALESCE(SUM(CASE WHEN is_assistant_message = 1 THEN length(text) ELSE 0 END), 0) AS assistantCharacterCount,
    (SELECT COALESCE(SUM(total), 0) FROM usages) AS totalTokens,
    (SELECT COALESCE(SUM(prompt), 0) FROM usages) AS promptTokens,
    (SELECT COALESCE(SUM(completion), 0) FROM usages) AS completionTokens,
    (SELECT COUNT(*) FROM replies WHERE has_message = 1 AND has_usage = 0) AS assistantRepliesWithoutUsage
  FROM identified
`;
