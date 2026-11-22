/** 群成员变更与发言资格撤销在同一事务内裁决，退出快照不再读取原群的新事实。 */
import { randomUUID } from 'expo-crypto';
import { databaseCoordinator, type DatabaseReadExecutor, type DatabaseTransactionExecutor } from '@platform/persistence';
import { GroupMembershipError, type GroupActor, type GroupHistory, type GroupMemberAction,
  type GroupMembershipRepository } from '../domain/GroupMembership';

interface HistoryRow {
  id: string; ai_assistant_id: string; group_id: string; group_name: string; exited_at: string;
  reason: GroupHistory['reason']; inject_enabled: number; context_json: string;
}
function history(row: HistoryRow): GroupHistory {
  return { id: row.id, assistantId: row.ai_assistant_id, groupId: row.group_id, groupName: row.group_name,
    exitedAt: row.exited_at, reason: row.reason, injectEnabled: row.inject_enabled === 1,
    context: JSON.parse(row.context_json) };
}
const executor = () => databaseCoordinator.openTaskExecutor({ name: 'chat.group-membership', feature: 'chat', priority: 'interactive' });

async function requireActor(tx: DatabaseTransactionExecutor, actor: GroupActor, groupId: string, access: 'any' | 'member' | 'host') {
  const group = await tx.getFirstAsync<{ name: string }>('SELECT name FROM group_chats WHERE id = ?', [groupId]);
  if (!group) throw new GroupMembershipError('群聊不存在');
  if (actor.kind === 'user') return { groupName: group.name, actorName: '用户' };
  const member = await tx.getFirstAsync<{ name: string; is_host_ai: number; joined: number }>(`SELECT a.name, a.is_host_ai,
    EXISTS (SELECT 1 FROM group_chat_members m WHERE m.group_id = ? AND m.ai_assistant_id = a.id AND m.enabled = 1) AS joined
    FROM ai_assistants a WHERE a.id = ? AND a.deleted_at IS NULL`, [groupId, actor.assistantId]);
  if (!member) throw new GroupMembershipError('操作群聊的 AI 已不存在');
  if (access !== 'any' && (member.joined !== 1 || (access === 'host' && member.is_host_ai !== 1))) {
    throw new GroupMembershipError(access === 'host'
      ? '只有仍在该群的主理 AI 可以管理成员' : '只能操作自己仍参加的群聊');
  }
  return { groupName: group.name, actorName: member.name };
}

export class SQLiteGroupMembershipRepository implements GroupMembershipRepository {
  async searchByName(keyword: string) {
    // 搜索只公开群的真实名称与 ID，不借用包含成员、消息或管理员连接的详情查询。
    return executor().getAllAsync<{ groupId: string; name: string }>(`SELECT id AS groupId, name FROM group_chats
      WHERE INSTR(LOWER(name), LOWER(?)) > 0 ORDER BY name COLLATE NOCASE, id`, [keyword]);
  }
  async changeInTransaction(tx: DatabaseTransactionExecutor, actor: GroupActor, groupId: string,
    action: GroupMemberAction, assistantIds: string[], now: string) {
    const access = action === 'add' || action === 'join' ? 'any' : action === 'leave' ? 'member' : 'host';
    const { groupName, actorName } = await requireActor(tx, actor, groupId, access);
    if ((action === 'leave' || action === 'join')
      && (actor.kind !== 'assistant' || assistantIds.length !== 1 || assistantIds[0] !== actor.assistantId)) {
      throw new GroupMembershipError('加入或退出群聊只能操作自己');
    }
    const activePlan = await tx.getFirstAsync<{ id: string }>(`SELECT id FROM group_speech_plans
      WHERE group_id = ? AND status IN ('pending', 'preparing', 'running')`, [groupId]);
    const names: string[] = [];
    const unchangedNames: string[] = [];
    const exitedAssistantIds: string[] = [];
    const revokedTaskIds: string[] = [];
    for (const assistantId of assistantIds) {
      const target = await tx.getFirstAsync<{ name: string; agent_id: string; is_blocked: number }>(
        `SELECT a.name, a.agent_id, EXISTS (SELECT 1 FROM ai_blacklist b
          WHERE b.ai_id = a.id AND b.blocked_until > ?) AS is_blocked FROM ai_assistants a WHERE a.id = ? AND a.deleted_at IS NULL`, [now, assistantId]);
      if (!target) throw new GroupMembershipError('所选 AI 已不存在');
      const member = await tx.getFirstAsync<{ enabled: number; muted: number }>(
        'SELECT enabled, muted FROM group_chat_members WHERE group_id = ? AND ai_assistant_id = ?', [groupId, assistantId]);
      if (action === 'join' && member?.enabled === 1) {
        return { changed: false, groupName, notice: '你已在该群聊', exitedAssistantIds, revokedTaskIds };
      }
      if (action === 'add' || action === 'join') {
        if (member?.enabled === 1) throw new GroupMembershipError(`${target.name} 已在群聊中`);
        if (target.is_blocked === 1) throw new GroupMembershipError(`${target.name} 当前不可加入群聊`);
        await tx.runAsync(`INSERT INTO group_chat_members
          (id, group_id, ai_assistant_id, agent_id, display_order, enabled, muted, joined_during_plan_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(display_order), -1) + 1 FROM group_chat_members WHERE group_id = ?), 1, 0, ?, ?, ?)
          ON CONFLICT(group_id, ai_assistant_id) DO UPDATE SET enabled = 1, muted = 0,
          joined_during_plan_id = excluded.joined_during_plan_id, updated_at = excluded.updated_at`,
        [randomUUID(), groupId, assistantId, target.agent_id, groupId, activePlan?.id ?? null, now, now]);
      } else {
        if (member?.enabled !== 1) throw new GroupMembershipError(`${target.name} 已不在群聊中`);
        if (action === 'remove' || action === 'leave') {
          await tx.runAsync('UPDATE group_chat_members SET enabled = 0, muted = 0, updated_at = ? WHERE group_id = ? AND ai_assistant_id = ?', [now, groupId, assistantId]);
          exitedAssistantIds.push(assistantId);
        } else {
          const muted = action === 'mute' ? 1 : 0;
          if (member.muted === muted) {
            unchangedNames.push(target.name);
            continue;
          }
          await tx.runAsync('UPDATE group_chat_members SET muted = ?, updated_at = ? WHERE group_id = ? AND ai_assistant_id = ?', [muted, now, groupId, assistantId]);
        }
        if (action !== 'unmute') {
          const tasks = await tx.getAllAsync<{ id: string }>(`SELECT id FROM group_speech_tasks WHERE group_id = ?
            AND ai_assistant_id = ? AND status IN ('queued', 'running')`, [groupId, assistantId]);
          revokedTaskIds.push(...tasks.map(task => task.id));
          await tx.runAsync(`UPDATE group_speech_tasks SET status = 'skipped', completed_at = ?, updated_at = ?, error_message = ?
            WHERE group_id = ? AND ai_assistant_id = ? AND status IN ('queued', 'running')`,
          [now, now, action === 'mute' ? '成员已被禁言' : '成员已退出群聊', groupId, assistantId]);
        }
      }
      names.push(target.name);
    }
    if (names.length === 0) {
      return { changed: false, groupName, notice: `${unchangedNames.join('、')} ${action === 'mute' ? '已被禁言' : '未被禁言'}`,
        exitedAssistantIds, revokedTaskIds };
    }
    const targets = names.join('、');
    const notice = action === 'join' ? `${targets} 加入了群聊`
      : action === 'leave' ? `${targets} 退出了群聊` : action === 'add' ? `${actorName} 邀请 ${targets} 加入了群聊`
      : action === 'remove' ? `${actorName} 将 ${targets} 移出了群聊`
      : action === 'mute' ? `${actorName} 禁言了 ${targets}` : `${actorName} 解除了 ${targets} 的禁言`;
    return { changed: true, groupName, notice, exitedAssistantIds, revokedTaskIds };
  }
  async renameInTransaction(tx: DatabaseTransactionExecutor, actor: GroupActor, groupId: string, name: string) {
    const { actorName, groupName } = await requireActor(tx, actor, groupId, 'member');
    await tx.runAsync('UPDATE group_chats SET name = ?, updated_at = ? WHERE id = ?', [name, new Date().toISOString(), groupId]);
    return `${actorName} 将群名从「${groupName}」修改为「${name}」`;
  }
  async saveHistoryInTransaction(tx: DatabaseTransactionExecutor, value: GroupHistory) {
    await tx.runAsync(`INSERT INTO group_chat_history (id, ai_assistant_id, group_id, group_name, exited_at, reason, inject_enabled, context_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ai_assistant_id, group_id) DO UPDATE SET id = excluded.id,
      group_name = excluded.group_name, exited_at = excluded.exited_at, reason = excluded.reason,
      inject_enabled = excluded.inject_enabled, context_json = excluded.context_json`,
    [value.id, value.assistantId, value.groupId, value.groupName, value.exitedAt, value.reason, value.injectEnabled ? 1 : 0, JSON.stringify(value.context)]);
  }
  async listHistory(assistantId: string) {
    return (await executor().getAllAsync<HistoryRow>(`SELECT h.* FROM group_chat_history h WHERE h.ai_assistant_id = ?
      AND NOT EXISTS (SELECT 1 FROM group_chat_members m WHERE m.group_id = h.group_id AND m.ai_assistant_id = h.ai_assistant_id AND m.enabled = 1)
      ORDER BY h.exited_at DESC, h.id`, [assistantId])).map(history);
  }
  async getHistory(assistantId: string, historyId: string) {
    const row = await executor().getFirstAsync<HistoryRow>('SELECT * FROM group_chat_history WHERE ai_assistant_id = ? AND id = ?', [assistantId, historyId]);
    if (!row) throw new GroupMembershipError('这份历史群聊记录已不存在或已被新的退出记录替换');
    return history(row);
  }
  async getExitedHistory(assistantId: string, groupId: string, reader: DatabaseReadExecutor = executor()) {
    const member = await reader.getFirstAsync<{ enabled: number }>(
      'SELECT enabled FROM group_chat_members WHERE group_id = ? AND ai_assistant_id = ?', [groupId, assistantId]);
    if (member?.enabled === 1) throw new GroupMembershipError('无法在未退出的群使用此工具');
    const row = await reader.getFirstAsync<HistoryRow>(
      'SELECT * FROM group_chat_history WHERE ai_assistant_id = ? AND group_id = ?', [assistantId, groupId]);
    if (!row) throw new GroupMembershipError('没有这份已退出群聊的历史信息');
    return history(row);
  }
  async setHistoryInjection(assistantId: string, historyId: string, enabled: boolean) {
    const result = await executor().runAsync('UPDATE group_chat_history SET inject_enabled = ? WHERE ai_assistant_id = ? AND id = ?', [enabled ? 1 : 0, assistantId, historyId]);
    if (result.changes !== 1) throw new GroupMembershipError('这份历史群聊记录已不存在');
  }
}
export const groupMembershipRepository = new SQLiteGroupMembershipRepository();
