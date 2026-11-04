import { bindModelServiceInTransaction, readModelServiceConnection, getModelServiceConnection } from '@features/assistants';
import { removeConversationWallpaperInTransaction } from '@features/profile';
/** 通过 databaseCoordinator 实现群聊及群发言计划、任务的 SQLite 仓储适配器。 */
import { databaseCoordinator } from '@platform/persistence';
import {
  collectChatSessionMediaAssetCandidatesInTransaction,
  resolveMediaAssetReferenceUri,
} from '@features/media';
import type {
  AppendGroupSpeechTaskInput,
  CreateGroupChatRecordInput,
  GroupChat,
  GroupChatAdminConfig,
  GroupChatDetails,
  GroupChatMember,
  GroupSpeechPlan,
  GroupSpeechPlanRotation,
  GroupSpeechPlanStatus,
  GroupSpeechTask,
  GroupSpeechTaskStatus,
  TryClaimGroupSpeechPlanResult,
  UpdateGroupChatAdminConfigInput,
  UpdateGroupChatProfileInput,
} from '../domain/GroupChat';
import type {
  CommitGroupAvatarMediaAssetReferenceInput,
  GroupAvatarMediaAssetMigrationCandidate,
  GroupChatDeletionResult,
  GroupAvatarQueryResult,
  IGroupChatRepository,
} from '../domain/GroupChatRepository';
import type { CoordinatedDatabaseExecutor, DatabaseTransactionExecutor } from '@platform/persistence';

interface GroupChatRow {
  id: string;
  name: string;
  avatar: string | null;
  avatar_media_asset_id: string | null;
  last_message: string | null;
  last_time: string | null;
  is_pinned: number | null;
  pinned_at: string | null;
  created_at: string;
  updated_at: string;
}

interface GroupChatMemberRow {
  id: string;
  group_id: string;
  ai_assistant_id: string;
  agent_id: string;
  display_order: number | null;
  enabled: number | null;
  muted: number;
  name?: string | null;
  nickname?: string | null;
  avatar?: string | null;
  avatar_media_asset_id?: string | null;
  model?: string | null;
  created_at: string;
  updated_at: string;
}

interface GroupChatAdminConfigRow {
  service_config_id: string | null;
  group_id: string;
  name: string;
  model: string;
  api_key: string | null;
  api_base_url: string | null;
  system_prompt: string | null;
  temperature: number | null;
  top_p: number | null;
  max_tokens: number | null;
  context_message_count: number;
  created_at: string;
  updated_at: string;
}

interface GroupSpeechPlanRow {
  id: string;
  group_id: string;
  status: GroupSpeechPlanStatus;
  invoked_user_message_ids_json: string | null;
  last_included_message_id: number | null;
  supersedes_plan_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface GroupSpeechTaskRow {
  id: string;
  plan_id: string;
  group_id: string;
  ai_assistant_id: string;
  agent_id: string;
  sequence_order: number;
  source: GroupSpeechTask['source'];
  status: GroupSpeechTaskStatus;
  visible_reply_committed: number | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

function parseInvokedUserMessageIds(json: string | null): number[] {
  try {
    const parsed = JSON.parse(json || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((value) => Number.isInteger(value))
      : [];
  } catch {
    return [];
  }
}

export class GroupChatRepository implements IGroupChatRepository {
  async getAvatarForAssistant(groupId: string, assistantId: string, isHostAI: boolean): Promise<GroupAvatarQueryResult> {
    return databaseCoordinator.read({ name: 'chat.get-group-avatar-for-assistant', feature: 'chat', priority: 'interactive' }, async db => {
      const row = await db.getFirstAsync<{
        groupId: string; name: string; avatar: string | null; avatarMediaAssetId: string | null; isMember: number;
      }>(`SELECT g.id AS groupId, g.name, g.avatar, g.avatar_media_asset_id AS avatarMediaAssetId,
          EXISTS (SELECT 1 FROM group_chat_members m
            WHERE m.group_id = g.id AND m.ai_assistant_id = ? AND m.enabled = 1) AS isMember
        FROM group_chats g WHERE g.id = ?`, [assistantId, groupId]);
      if (!row) return { status: 'not_found' };
      if (!isHostAI && row.isMember !== 1) return { status: 'forbidden' };
      return { status: 'found', groupId: row.groupId, name: row.name,
        avatar: row.avatar, avatarMediaAssetId: row.avatarMediaAssetId };
    });
  }

  async isSpeechTaskRunCurrentInTransaction(transaction: DatabaseTransactionExecutor, taskId: string): Promise<boolean> {
    return await transaction.getFirstAsync(`SELECT t.id FROM group_speech_tasks t JOIN group_speech_plans p ON p.id = t.plan_id
      WHERE t.id = ? AND t.status = 'running' AND p.status = 'running'`, [taskId]) !== null;
  }
  async rebaseRestoredMediaInTransaction(transaction: DatabaseTransactionExecutor, rebase: (uri: string | null) => string | null): Promise<void> {
    const rows = await transaction.getAllAsync<{ id: string; avatar: string }>('SELECT id, avatar FROM group_chats WHERE avatar_media_asset_id IS NULL AND avatar IS NOT NULL');
    for (const row of rows) {
      const avatar = rebase(row.avatar);
      if (avatar !== row.avatar) await transaction.runAsync('UPDATE group_chats SET avatar = ? WHERE id = ?', [avatar, row.id]);
    }
  }
  async getAll(): Promise<GroupChat[]> {
    try {
      const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'chat.getAll', feature: 'chat', priority: 'interactive' });
      const rows = await database.getAllAsync<GroupChatRow>(
        `SELECT *
         FROM group_chats
         ORDER BY is_pinned DESC, updated_at DESC`
      );

      return Promise.all(rows.map((row) => this.mapGroupRowToEntity(row)));
    } catch (error) {
      console.error('[GroupChatRepository] Failed to get all:', error);
      throw error;
    }
  }

  async getById(groupId: string): Promise<GroupChatDetails | null> {
    try {
      const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'chat.getById', feature: 'chat', priority: 'interactive' });
      const groupRow = await database.getFirstAsync<GroupChatRow>(
        'SELECT * FROM group_chats WHERE id = ?',
        [groupId]
      );

      if (!groupRow) {
        return null;
      }

      const [members, adminConfig] = await Promise.all([
        this.getMembers(groupId),
        this.getAdminConfig(groupId),
      ]);

      if (!adminConfig) {
        return null;
      }

      return {
        group: await this.mapGroupRowToEntity(groupRow),
        members,
        adminConfig,
      };
    } catch (error) {
      console.error('[GroupChatRepository] Failed to get by id:', error);
      return null;
    }
  }

  async getMembers(groupId: string): Promise<GroupChatMember[]> {
    try {
      const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'chat.getMembers', feature: 'chat', priority: 'interactive' });
      const rows = await database.getAllAsync<GroupChatMemberRow>(
        `SELECT
           m.*,
           a.name,
           a.nickname,
           a.avatar,
           a.avatar_media_asset_id,
           a.model
         FROM group_chat_members m
         LEFT JOIN ai_assistants a ON a.id = m.ai_assistant_id
         WHERE m.group_id = ?
         ORDER BY m.display_order ASC, m.created_at ASC`,
        [groupId]
      );

      return Promise.all(rows.map((row) => this.mapMemberRowToEntity(row)));
    } catch (error) {
      console.error('[GroupChatRepository] Failed to get members:', error);
      return [];
    }
  }

  async getAdminConfig(groupId: string): Promise<GroupChatAdminConfig | null> {
    try {
      const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'chat.getAdminConfig', feature: 'chat', priority: 'interactive' });
      const row = await database.getFirstAsync<GroupChatAdminConfigRow>(
        'SELECT * FROM group_chat_admin_configs WHERE group_id = ?',
        [groupId]
      );

      return row ? this.mapAdminRowToEntity(row, database) : null;
    } catch (error) {
      console.error('[GroupChatRepository] Failed to get admin config:', error);
      return null;
    }
  }

  async create(input: CreateGroupChatRecordInput): Promise<GroupChatDetails> {
    const database = databaseCoordinator.openTaskExecutor({ name: 'chat.create', feature: 'chat', priority: 'interactive' });
    await database.withExclusiveTransactionAsync((transaction) => this.createInTransaction(transaction, input));
    const details = await this.getById(input.group.id);
    if (!details) {
      throw new Error(`Failed to retrieve created group chat ${input.group.id}`);
    }

    return details;
  }

  async createInTransaction(transaction: DatabaseTransactionExecutor, input: CreateGroupChatRecordInput): Promise<void> {
    const now = new Date().toISOString();

    // 同一个事务里先写入会话身份行，再写入详情行，保证群聊身份与详情一致。
    await transaction.runAsync(
      `INSERT INTO chat_conversations (id, kind)
       VALUES (?, 'group')`,
      [input.group.id]
    );

    await transaction.runAsync(
      `INSERT INTO group_chats
       (id, name, avatar, avatar_media_asset_id, last_message, last_time, is_pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.group.id,
        input.group.name,
        input.group.avatarMediaAssetId ? null : input.group.avatar || null,
        input.group.avatarMediaAssetId || null,
        null,
        now,
        0,
        now,
        now,
      ]
    );

    await transaction.runAsync(
      `INSERT INTO group_chat_admin_configs
       (group_id, name, model, api_key, api_base_url, system_prompt, temperature, top_p,
        max_tokens, context_message_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.group.id,
        input.adminConfig.name,
        input.adminConfig.model,
        input.adminConfig.apiKey || null,
        input.adminConfig.apiBaseUrl || null,
        input.adminConfig.systemPrompt || null,
        input.adminConfig.temperature ?? null,
        input.adminConfig.topP ?? null,
        input.adminConfig.maxTokens === undefined ? 2000 : input.adminConfig.maxTokens,
        input.adminConfig.contextMessageCount ?? 20,
        now,
        now,
      ]
    );

    const serviceId = await bindModelServiceInTransaction(transaction, getModelServiceConnection(input.adminConfig.apiBaseUrl ?? '', input.adminConfig.apiKey), input.adminConfig.serviceConfigId);
    if (serviceId) await transaction.runAsync('UPDATE group_chat_admin_configs SET service_config_id = ?, api_base_url = NULL, api_key = NULL WHERE group_id = ?', [serviceId, input.group.id]);

    for (const member of input.members) {
      await transaction.runAsync(
        `INSERT INTO group_chat_members
         (id, group_id, ai_assistant_id, agent_id, display_order, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `${input.group.id}_${member.aiAssistantId}`,
          input.group.id,
          member.aiAssistantId,
          member.agentId,
          member.displayOrder,
          member.enabled === false ? 0 : 1,
          now,
          now,
        ]
      );
    }
  }

  async updateAdminConfig(
    groupId: string,
    input: UpdateGroupChatAdminConfigInput
  ): Promise<GroupChatAdminConfig | null> {
    const columns: Record<keyof UpdateGroupChatAdminConfigInput, string> = {
      serviceConfigId: 'service_config_id', model: 'model', apiKey: 'api_key', apiBaseUrl: 'api_base_url', systemPrompt: 'system_prompt',
      temperature: 'temperature', topP: 'top_p', maxTokens: 'max_tokens', contextMessageCount: 'context_message_count',
    };
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    for (const key of Object.keys(input) as (keyof UpdateGroupChatAdminConfigInput)[]) {
      const value = input[key];
      if (value === undefined || key === 'apiBaseUrl' || key === 'apiKey' || key === 'serviceConfigId') continue;
      fields.push(`${columns[key]} = ?`);
      values.push(value);
    }
    if (fields.length === 0 && input.apiBaseUrl === undefined && input.apiKey === undefined && input.serviceConfigId === undefined) throw new Error('管理员配置更新必须包含修改字段');
    fields.push('updated_at = ?');
    values.push(new Date().toISOString(), groupId);
    const database = databaseCoordinator.openTaskExecutor({ name: 'chat.updateAdminConfig', feature: 'chat', priority: 'interactive' });
    // 增量写入与确认共享事务，不把等待期间读取的旧配置重新写回。
    return database.withExclusiveTransactionAsync(async (transaction) => {
      if (input.apiBaseUrl !== undefined || input.apiKey !== undefined || input.serviceConfigId !== undefined) {
        const current = await transaction.getFirstAsync<GroupChatAdminConfigRow>('SELECT * FROM group_chat_admin_configs WHERE group_id = ?', [groupId]);
        if (!current) return null;
        const previous = current.service_config_id ? await readModelServiceConnection(transaction, current.service_config_id) : null;
        const baseUrl = input.apiBaseUrl !== undefined ? input.apiBaseUrl ?? '' : previous ? previous.baseUrl : current.api_base_url ?? '';
        const apiKey = input.apiKey !== undefined ? input.apiKey : previous ? previous.apiKey : current.api_key;
        const serviceId = await bindModelServiceInTransaction(transaction, getModelServiceConnection(baseUrl, apiKey), input.serviceConfigId);
        await transaction.runAsync('UPDATE group_chat_admin_configs SET service_config_id = ?, api_base_url = ?, api_key = ? WHERE group_id = ?', [serviceId, serviceId ? null : baseUrl, serviceId ? null : apiKey, groupId]);
      }
      const result = await transaction.runAsync(`UPDATE group_chat_admin_configs SET ${fields.join(', ')} WHERE group_id = ?`, values);
      if (result.changes === 0) return null;
      const row = await transaction.getFirstAsync<GroupChatAdminConfigRow>('SELECT * FROM group_chat_admin_configs WHERE group_id = ?', [groupId]);
      if (!row) throw new Error(`已更新的管理员配置不存在：${groupId}`);
      return this.mapAdminRowToEntity(row, transaction);
    });
  }

  async updateProfile(
    groupId: string,
    input: UpdateGroupChatProfileInput
  ): Promise<GroupChat | null> {
    const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'chat.updateGroupProfile', feature: 'chat', priority: 'interactive' });
    const fields: string[] = [];
    const values: (string | null)[] = [];

    if (input.name !== undefined) {
      fields.push('name = ?');
      values.push(input.name);
    }
    if (input.avatar !== undefined) {
      if (input.avatarMediaAssetId) {
        fields.push('avatar = NULL', 'avatar_media_asset_id = ?');
        values.push(input.avatarMediaAssetId);
      } else {
        fields.push('avatar = ?', 'avatar_media_asset_id = NULL');
        values.push(input.avatar);
      }
    } else if (input.avatarMediaAssetId !== undefined) {
      fields.push('avatar = NULL', 'avatar_media_asset_id = ?');
      values.push(input.avatarMediaAssetId);
    }

    const now = new Date().toISOString();
    fields.push('updated_at = ?');
    values.push(now, groupId);

    const row = await database.withExclusiveTransactionAsync(async (transaction) => {
      const result = await transaction.runAsync(
        `UPDATE group_chats
         SET ${fields.join(', ')}
         WHERE id = ?`,
        values
      );
      if (result.changes === 0) {
        return null;
      }

      const row = await transaction.getFirstAsync<GroupChatRow>(
        'SELECT * FROM group_chats WHERE id = ?',
        [groupId]
      );
      if (!row) {
        throw new Error(`更新后的群聊不存在：${groupId}`);
      }
      return row;
    });
    return row ? this.mapGroupRowToEntity(row) : null;
  }

  async setPinned(groupId: string, pinned: boolean): Promise<GroupChat | null> {
    const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'chat.setGroupPinned', feature: 'chat', priority: 'interactive' });
    // 置顶不是消息活动：不触碰 last_message / last_time / updated_at，
    // 只写 is_pinned 与「最近置顶时刻」。
    // 取消置顶必须把 pinned_at 一起清空，否则「刚刚置顶过」会继续影响排序。
    const pinnedAt = pinned ? new Date().toISOString() : null;
    const result = await database.runAsync(
      `UPDATE group_chats SET is_pinned = ?, pinned_at = ? WHERE id = ?`,
      [pinned ? 1 : 0, pinnedAt, groupId]
    );
    if (result.changes === 0) {
      return null;
    }

    const row = await database.getFirstAsync<GroupChatRow>(
      'SELECT * FROM group_chats WHERE id = ?',
      [groupId]
    );
    return row ? this.mapGroupRowToEntity(row) : null;
  }


  async listAvatarMediaAssetMigrationCandidates(): Promise<GroupAvatarMediaAssetMigrationCandidate[]> {
    const database = databaseCoordinator.openTaskExecutor({
      name: 'chat.list-group-avatar-media-asset-candidates',
      feature: 'chat',
      priority: 'maintenance',
    });
    const rows = await database.getAllAsync<{
      id: string;
      avatar: string;
      avatar_media_asset_id: string | null;
    }>(
      `SELECT id, avatar, avatar_media_asset_id
       FROM group_chats
       WHERE avatar IS NOT NULL
         AND TRIM(avatar) <> ''
         AND avatar_media_asset_id IS NULL
       ORDER BY id ASC`,
    );
    return rows.map((row) => ({
      id: row.id,
      avatar: row.avatar,
      avatarMediaAssetId: row.avatar_media_asset_id || null,
    }));
  }

  async getAvatarMediaAssetMigrationCandidate(
    ownerId: string,
  ): Promise<GroupAvatarMediaAssetMigrationCandidate | null> {
    const database = databaseCoordinator.openTaskExecutor({
      name: 'chat.get-group-avatar-media-asset-candidate',
      feature: 'chat',
      priority: 'maintenance',
    });
    const row = await database.getFirstAsync<{
      id: string;
      avatar: string;
      avatar_media_asset_id: string | null;
    }>(
      `SELECT id, avatar, avatar_media_asset_id
       FROM group_chats
       WHERE id = ?
         AND avatar IS NOT NULL
         AND TRIM(avatar) <> ''`,
      [ownerId],
    );
    return row
      ? {
          id: row.id,
          avatar: row.avatar,
          avatarMediaAssetId: row.avatar_media_asset_id || null,
        }
      : null;
  }

  async commitAvatarMediaAssetReferenceInTransaction(
    transaction: DatabaseTransactionExecutor,
    input: CommitGroupAvatarMediaAssetReferenceInput,
  ): Promise<void> {
    if (!input.mediaAssetId.trim()) {
      throw new Error('群头像 MediaAsset 引用不能为空');
    }
    const result = await transaction.runAsync(
      `UPDATE group_chats
       SET avatar = NULL,
           avatar_media_asset_id = ?,
           updated_at = ?
       WHERE id = ?
         AND avatar IS ?
         AND (
           (avatar_media_asset_id IS NULL AND ? IS NULL)
           OR avatar_media_asset_id = ?
         )`,
      [
        input.mediaAssetId,
        new Date().toISOString(),
        input.ownerId,
        input.expectedAvatar,
        input.expectedAvatarMediaAssetId,
        input.expectedAvatarMediaAssetId,
      ],
    );
    if (result.changes !== 1) {
      throw new Error(
        `群头像 MediaAsset CAS 必须恰好影响一行，实际影响 ${result.changes} 行：${input.ownerId}`,
      );
    }
  }

  async updatePreviewForCommittedMessage(
    groupId: string,
    messageId: number,
    lastMessage: string,
    lastTime: string,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'chat.updatePreviewForCommittedMessage', feature: 'chat', priority: 'interactive' });
    // CAS：晚到的旧消息 preview（如被换代 plan 的 AI 回复）不得覆盖更新的
    // 消息事实；last_message_id 为空的历史行允许任一真实消息写入。
    // EXISTS 守卫：消息可能已被用户删除，晚到 preview 不得把已删除消息
    // 复活成会话列表预览。
    const result = await database.runAsync(
      `UPDATE group_chats
       SET last_message = ?, last_time = ?, last_message_id = ?, updated_at = ?
       WHERE id = ? AND (last_message_id IS NULL OR last_message_id <= ?)
         AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`,
      [lastMessage, lastTime, messageId, now, groupId, messageId, messageId]
    );
    return (result.changes || 0) > 0;
  }

  async updateEditedMessagePreviewInTransaction(
    transaction: DatabaseTransactionExecutor,
    groupId: string,
    messageId: number,
    previewText: string,
  ): Promise<void> {
    await transaction.runAsync(
      `UPDATE group_chats SET last_message = ?, updated_at = ?
       WHERE id = ? AND last_message_id = ?`,
      [previewText, new Date().toISOString(), groupId, messageId],
    );
  }

  async updatePreviewInTransaction(
    transaction: DatabaseTransactionExecutor,
    groupId: string,
    messageId: number | null,
    lastMessage: string,
    lastTime: string | null,
  ): Promise<void> {
    const now = new Date().toISOString();
    await transaction.runAsync(
      `UPDATE group_chats
       SET last_message = ?, last_time = ?, last_message_id = ?, updated_at = ?
       WHERE id = ?`,
      [lastMessage, lastTime, messageId, now, groupId]
    );
  }

  async getLatestSpeechPlan(
    groupId: string,
    status?: GroupSpeechPlanStatus
  ): Promise<GroupSpeechPlan | null> {
    try {
      const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'chat.getLatestSpeechPlan', feature: 'chat', priority: 'interactive' });
      const hasStatus = Boolean(status);
      const row = await database.getFirstAsync<GroupSpeechPlanRow>(
        `SELECT *
         FROM group_speech_plans
         WHERE group_id = ?
         ${hasStatus ? 'AND status = ?' : ''}
         ORDER BY created_at DESC
         LIMIT 1`,
        hasStatus ? [groupId, status as GroupSpeechPlanStatus] : [groupId]
      );

      return row ? this.mapSpeechPlanRowToEntity(row) : null;
    } catch (error) {
      console.error('[GroupChatRepository] Failed to get latest speech plan:', error);
      return null;
    }
  }

  async getRunningSpeechPlan(groupId: string): Promise<GroupSpeechPlan | null> {
    try {
      const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'chat.getRunningSpeechPlan', feature: 'chat', priority: 'interactive' });
      const row = await database.getFirstAsync<GroupSpeechPlanRow>(
        `SELECT *
         FROM group_speech_plans
         WHERE group_id = ? AND status IN ('pending', 'preparing', 'running')
         ORDER BY created_at DESC
         LIMIT 1`,
        [groupId]
      );

      return row ? this.mapSpeechPlanRowToEntity(row) : null;
    } catch (error) {
      console.error('[GroupChatRepository] Failed to get running speech plan:', error);
      return null;
    }
  }

  async tryClaimGroupSpeechPlan(groupId: string): Promise<TryClaimGroupSpeechPlanResult> {
    const now = new Date().toISOString();
    const planId = `group_plan_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    return databaseCoordinator.transaction(
      {
        name: 'chat.tryClaimGroupSpeechPlan',
        feature: 'chat',
        priority: 'interactive',
      },
      async (transaction: DatabaseTransactionExecutor) => {
        const previousPlan = await transaction.getFirstAsync<Pick<GroupSpeechPlanRow, 'last_included_message_id'>>(
          `SELECT last_included_message_id
           FROM group_speech_plans
           WHERE group_id = ? AND status = 'completed' AND last_included_message_id IS NOT NULL
           ORDER BY created_at DESC, id DESC
           LIMIT 1`,
          [groupId],
        );
        const inserted = await transaction.runAsync(
          `INSERT INTO group_speech_plans
           (id, group_id, status, invoked_user_message_ids_json, last_included_message_id,
            started_at, completed_at, error_message, created_at, updated_at)
           VALUES (?, ?, 'pending', '[]', NULL, ?, NULL, NULL, ?, ?)
           ON CONFLICT(group_id) WHERE status IN ('pending', 'preparing', 'running') DO NOTHING`,
          [
            planId,
            groupId,
            now,
            now,
            now,
          ],
        );

        if ((inserted.changes || 0) > 0) {
          const created = await transaction.getFirstAsync<GroupSpeechPlanRow>(
            'SELECT * FROM group_speech_plans WHERE id = ?',
            [planId],
          );
          if (!created) {
            throw new Error(`Failed to retrieve claimed group speech plan ${planId}`);
          }

          return {
            claimed: true,
            plan: this.mapSpeechPlanRowToEntity(created),
            previousInputUpperBoundMessageId: previousPlan?.last_included_message_id ?? 0,
          };
        }

        const active = await transaction.getFirstAsync<GroupSpeechPlanRow>(
          `SELECT *
           FROM group_speech_plans
           WHERE group_id = ? AND status IN ('pending', 'preparing', 'running')
           ORDER BY created_at DESC, id DESC
           LIMIT 1`,
          [groupId],
        );
        if (!active) {
          throw new Error(`Failed to retrieve active group speech plan for ${groupId}`);
        }

        return {
          claimed: false,
          plan: this.mapSpeechPlanRowToEntity(active),
        };
      },
    );
  }

  async beginSpeechPlanPreparation(planId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'chat.beginSpeechPlanPreparation', feature: 'chat', priority: 'interactive' });
    const result = await database.runAsync(
      `UPDATE group_speech_plans
       SET status = 'preparing', updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      [now, planId],
    );
    return (result.changes || 0) > 0;
  }

  async updateSpeechPlanInput(
    planId: string,
    invokedUserMessageIds: number[],
    inputUpperBoundMessageId: number | null,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'chat.updateSpeechPlanInput', feature: 'chat', priority: 'interactive' });
    const result = await database.runAsync(
      `UPDATE group_speech_plans
       SET invoked_user_message_ids_json = ?,
           last_included_message_id = ?,
           updated_at = ?
       WHERE id = ? AND status = 'preparing'`,
      [JSON.stringify(invokedUserMessageIds), inputUpperBoundMessageId, now, planId],
    );
    return (result.changes || 0) > 0;
  }

  async rotateSpeechPlanForUserMessageInTransaction(
    transaction: DatabaseTransactionExecutor,
    params: { groupId: string; userMessageId: number },
  ): Promise<GroupSpeechPlanRotation> {
    const now = new Date().toISOString();
    const active = await transaction.getFirstAsync<GroupSpeechPlanRow>(
      `SELECT *
       FROM group_speech_plans
       WHERE group_id = ? AND status IN ('pending', 'preparing', 'running')
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [params.groupId],
    );
    if (!active) {
      return { kind: 'no_active_plan' };
    }

    if (active.status === 'pending' && active.supersedes_plan_id) {
      // 输入窗口内的后续消息：只扩展同一个 successor 的水位，不重复创建。
      const invoked = parseInvokedUserMessageIds(active.invoked_user_message_ids_json);
      invoked.push(params.userMessageId);
      await transaction.runAsync(
        `UPDATE group_speech_plans
         SET invoked_user_message_ids_json = ?, updated_at = ?
         WHERE id = ?`,
        [JSON.stringify(invoked), now, active.id],
      );
      return { kind: 'successor_window_extended', planId: active.id };
    }

    // 窗口起点：旧 plan 已固定的输入上界；fresh claim 的瞬时 pending 尚未固定
    // 上界，回退到最近 completed plan 的水位，与 tryClaim 的语义一致。
    let windowStartMessageId = active.last_included_message_id;
    if (windowStartMessageId === null) {
      const previous = await transaction.getFirstAsync<Pick<GroupSpeechPlanRow, 'last_included_message_id'>>(
        `SELECT last_included_message_id
         FROM group_speech_plans
         WHERE group_id = ? AND status = 'completed' AND last_included_message_id IS NOT NULL
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [params.groupId],
      );
      windowStartMessageId = previous?.last_included_message_id ?? 0;
    }

    const oldTasks = await transaction.getAllAsync<GroupSpeechTaskRow>(
      `SELECT *
       FROM group_speech_tasks
       WHERE plan_id = ?
       ORDER BY sequence_order ASC, created_at ASC, id ASC`,
      [active.id],
    );

    const supersededPlan = await transaction.runAsync(
      `UPDATE group_speech_plans
       SET status = 'superseded', completed_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'preparing', 'running')`,
      [now, now, active.id],
    );
    if ((supersededPlan.changes || 0) !== 1) {
      throw new Error(`群发言 plan 换代：${active.id} 期望处于 active，实际影响 ${supersededPlan.changes} 行`);
    }

    // 旧 queued/running 任务失去提交资格；running 任务的可见回复是否已提交
    // 由 visible_reply_committed 事先记录，本事务只消费该事实。
    await transaction.runAsync(
      `UPDATE group_speech_tasks
       SET status = 'superseded', completed_at = ?, updated_at = ?
       WHERE plan_id = ? AND status IN ('queued', 'running')`,
      [now, now, active.id],
    );

    // 公平继承：completed 不继承；queued 保持相对顺序；未提交可见回复的
    // running 移到继承队列末尾；同一 AI 最多保留一个待发言机会。
    const seenAssistantIds = new Set<string>();
    const inherited: GroupSpeechTaskRow[] = [];
    for (const task of oldTasks) {
      if (task.status !== 'queued') {
        continue;
      }
      if (seenAssistantIds.has(task.ai_assistant_id)) {
        continue;
      }
      seenAssistantIds.add(task.ai_assistant_id);
      inherited.push(task);
    }
    for (const task of oldTasks) {
      if (task.status !== 'running' || task.visible_reply_committed === 1) {
        continue;
      }
      if (seenAssistantIds.has(task.ai_assistant_id)) {
        continue;
      }
      seenAssistantIds.add(task.ai_assistant_id);
      inherited.push(task);
    }

    const successorPlanId = `group_plan_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    await transaction.runAsync(
      `INSERT INTO group_speech_plans
       (id, group_id, status, invoked_user_message_ids_json, last_included_message_id,
        supersedes_plan_id, started_at, completed_at, error_message, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      [
        successorPlanId,
        params.groupId,
        JSON.stringify([params.userMessageId]),
        windowStartMessageId,
        active.id,
        now,
        now,
      ],
    );

    for (const [index, task] of inherited.entries()) {
      await transaction.runAsync(
        `INSERT INTO group_speech_tasks
         (id, plan_id, group_id, ai_assistant_id, agent_id, sequence_order, source,
          status, started_at, completed_at, error_message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'inherited_after_user_interrupt', 'queued', NULL, NULL, NULL, ?, ?)`,
        [
          `group_task_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
          successorPlanId,
          params.groupId,
          task.ai_assistant_id,
          task.agent_id,
          index,
          now,
          now,
        ],
      );
    }

    return {
      kind: 'superseded',
      previousPlanId: active.id,
      successorPlanId,
      inheritedTaskCount: inherited.length,
    };
  }

  async terminateActiveSpeechPlan(groupId: string): Promise<string | null> {
    const now = new Date().toISOString();
    return databaseCoordinator.transaction(
      {
        name: 'chat.terminateActiveSpeechPlan',
        feature: 'chat',
        priority: 'interactive',
      },
      async (transaction: DatabaseTransactionExecutor) => {
        const active = await transaction.getFirstAsync<Pick<GroupSpeechPlanRow, 'id'>>(
          `SELECT id
           FROM group_speech_plans
           WHERE group_id = ? AND status IN ('pending', 'preparing', 'running')
           ORDER BY created_at DESC, id DESC
           LIMIT 1`,
          [groupId],
        );
        if (!active) {
          return null;
        }

        const terminated = await transaction.runAsync(
          `UPDATE group_speech_plans
           SET status = 'terminated', completed_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'preparing', 'running')`,
          [now, now, active.id],
        );
        if ((terminated.changes || 0) !== 1) {
          throw new Error(`群发言 plan 强制终止：${active.id} 期望处于 active，实际影响 ${terminated.changes} 行`);
        }

        // 终止即撤销全部未到终态任务的提交资格；与换代不同，这里不读取
        // visible_reply_committed 计算继承——终止不产生任何 successor。
        await transaction.runAsync(
          `UPDATE group_speech_tasks
           SET status = 'terminated', completed_at = ?, updated_at = ?
           WHERE plan_id = ? AND status IN ('queued', 'running')`,
          [now, now, active.id],
        );

        return active.id;
      },
    );
  }

  async interruptSpeechPlansWithoutOwner(activeGroupIds: readonly string[]): Promise<string[]> {
    const now = new Date().toISOString();
    const errorMessage = '应用进程中断，本轮召唤已停止';
    return databaseCoordinator.transaction(
      { name: 'chat.interrupt-orphan-group-plans', feature: 'chat', priority: 'runtime' },
      async (transaction) => {
        const plans = await transaction.getAllAsync<{ id: string; group_id: string }>(
          `SELECT id, group_id FROM group_speech_plans
           WHERE status IN ('pending', 'preparing', 'running')
             AND group_id NOT IN (SELECT value FROM json_each(?))`,
          [JSON.stringify(activeGroupIds)],
        );
        for (const plan of plans) {
          await transaction.runAsync(
            `UPDATE group_speech_plans SET status = 'failed', completed_at = ?, updated_at = ?, error_message = ? WHERE id = ?`,
            [now, now, errorMessage, plan.id],
          );
          await transaction.runAsync(
            `UPDATE group_speech_tasks SET status = 'failed', completed_at = ?, updated_at = ?, error_message = ?
             WHERE plan_id = ? AND status IN ('queued', 'running')`,
            [now, now, errorMessage, plan.id],
          );
        }
        return plans.map((plan) => plan.group_id);
      },
    );
  }

  async listSpeechPlanTasks(planId: string): Promise<GroupSpeechTask[]> {
    const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'chat.listSpeechPlanTasks', feature: 'chat', priority: 'interactive' });
    const rows = await database.getAllAsync<GroupSpeechTaskRow>(
      `SELECT *
       FROM group_speech_tasks
       WHERE plan_id = ?
       ORDER BY sequence_order ASC, created_at ASC, id ASC`,
      [planId],
    );
    return rows.map(this.mapSpeechTaskRowToEntity);
  }

  async activateSpeechPlanWithTasks(
    planId: string,
    params: {
      tasks: AppendGroupSpeechTaskInput[];
      mentionAssistantIds: string[];
    },
  ): Promise<boolean> {
    const now = new Date().toISOString();
    return databaseCoordinator.transaction(
      {
        name: 'chat.activateSpeechPlanWithTasks',
        feature: 'chat',
        priority: 'interactive',
      },
      async (transaction: DatabaseTransactionExecutor) => {
        const plan = await transaction.getFirstAsync<Pick<GroupSpeechPlanRow, 'status'>>(
          'SELECT status FROM group_speech_plans WHERE id = ?',
          [planId],
        );
        if (!plan || plan.status !== 'preparing') {
          return false;
        }

        if (params.mentionAssistantIds.length > 0) {
          // 用户明确 @ 优先：继承队列中同一 AI 的待发言机会由 mention 任务取代。
          const placeholders = params.mentionAssistantIds.map(() => '?').join(', ');
          await transaction.runAsync(
            `DELETE FROM group_speech_tasks
             WHERE plan_id = ? AND status = 'queued'
               AND ai_assistant_id IN (${placeholders})`,
            [planId, ...params.mentionAssistantIds],
          );
        }

        if (params.tasks.length > 0) {
          await transaction.runAsync(
            `UPDATE group_speech_tasks
             SET sequence_order = sequence_order + ?, updated_at = ?
             WHERE plan_id = ? AND status = 'queued'`,
            [params.tasks.length, now, planId],
          );
          for (const [index, input] of params.tasks.entries()) {
            await transaction.runAsync(
              `INSERT INTO group_speech_tasks
               (id, plan_id, group_id, ai_assistant_id, agent_id, sequence_order, source,
                status, started_at, completed_at, error_message, created_at, updated_at)
               SELECT ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, ?, ?
               WHERE EXISTS (SELECT 1 FROM group_chat_members m WHERE m.group_id = ? AND m.ai_assistant_id = ?
                 AND m.enabled = 1 AND m.muted = 0 AND (m.joined_during_plan_id IS NULL OR m.joined_during_plan_id <> ?))`,
              [
                input.id,
                planId,
                input.groupId,
                input.aiAssistantId,
                input.agentId,
                index,
                input.source,
                now,
                now,
                input.groupId,
                input.aiAssistantId,
                planId,
              ],
            );
          }
        }

        const activated = await transaction.runAsync(
          `UPDATE group_speech_plans
           SET status = 'running', started_at = ?, updated_at = ?
           WHERE id = ? AND status = 'preparing'`,
          [now, now, planId],
        );
        if ((activated.changes || 0) !== 1) {
          throw new Error(`群发言 plan 激活：${planId} 期望处于 preparing，实际影响 ${activated.changes} 行`);
        }
        return true;
      },
    );
  }

  async claimNextQueuedSpeechTask(planId: string): Promise<GroupSpeechTask | null> {
    const now = new Date().toISOString();
    return databaseCoordinator.transaction(
      {
        name: 'chat.claimNextQueuedSpeechTask',
        feature: 'chat',
        priority: 'interactive',
      },
      async (transaction: DatabaseTransactionExecutor) => {
        // plan 进入终态后其剩余 queued 任务一律不得再被 claim；supersede/强制终止
        // 与执行器共享这一持久裁决，而不是各自读取再判断。
        const plan = await transaction.getFirstAsync<Pick<GroupSpeechPlanRow, 'status'>>(
          'SELECT status FROM group_speech_plans WHERE id = ?',
          [planId],
        );
        if (!plan || (plan.status !== 'pending' && plan.status !== 'running')) {
          return null;
        }

        // 继承任务和规划期间的成员变化在领取边界收口，重新加入也不能复活旧机会。
        await transaction.runAsync(`UPDATE group_speech_tasks SET status = 'skipped', completed_at = ?, updated_at = ?, error_message = '成员当前不可发言'
          WHERE plan_id = ? AND status = 'queued' AND NOT EXISTS (SELECT 1 FROM group_chat_members m
            WHERE m.group_id = group_speech_tasks.group_id AND m.ai_assistant_id = group_speech_tasks.ai_assistant_id
            AND m.enabled = 1 AND m.muted = 0 AND (m.joined_during_plan_id IS NULL OR m.joined_during_plan_id <> ?))`, [now, now, planId, planId]);

        const next = await transaction.getFirstAsync<GroupSpeechTaskRow>(
          `SELECT *
           FROM group_speech_tasks
           WHERE plan_id = ? AND status = 'queued'
           ORDER BY sequence_order ASC, created_at ASC, id ASC
           LIMIT 1`,
          [planId],
        );
        if (!next) {
          return null;
        }

        const claimed = await transaction.runAsync(
          `UPDATE group_speech_tasks
           SET status = 'running', started_at = ?, updated_at = ?
           WHERE id = ? AND status = 'queued'`,
          [now, now, next.id],
        );
        if ((claimed.changes || 0) === 0) {
          return null;
        }

        return this.mapSpeechTaskRowToEntity({
          ...next,
          status: 'running',
          started_at: now,
          updated_at: now,
        });
      },
    );
  }

  async materializeAIMentionSpeechTasksInTransaction(
    transaction: DatabaseTransactionExecutor,
    planId: string,
    sourceTask: Pick<GroupSpeechTask, 'id' | 'aiAssistantId' | 'sequenceOrder'>,
    inputs: AppendGroupSpeechTaskInput[],
  ): Promise<GroupSpeechTask[]> {
    if (inputs.length === 0) {
      return [];
    }

    const now = new Date().toISOString();
    const tail = await transaction.getFirstAsync<{ max_order: number | null }>(
      'SELECT MAX(sequence_order) AS max_order FROM group_speech_tasks WHERE plan_id = ?',
      [planId],
    );
    const baseOrder = (tail?.max_order ?? -1) + 1;
    const created: GroupSpeechTask[] = [];
    let nextOrder = baseOrder;
    for (const input of inputs) {
      // parser 已经会过滤 self mention，但 scheduling owner 仍必须独立守住
      // 这个不变量，避免任何绕过 parser 的调用让 AI 自己再次排队。
      if (input.aiAssistantId === sourceTask.aiAssistantId) {
        continue;
      }

      const eligibleMember = await transaction.getFirstAsync<{ id: string }>(`SELECT id FROM group_chat_members
        WHERE group_id = ? AND ai_assistant_id = ? AND enabled = 1 AND muted = 0
        AND (joined_during_plan_id IS NULL OR joined_during_plan_id <> ?)`, [input.groupId, input.aiAssistantId, planId]);
      if (!eligibleMember) continue;

      // 只有来源任务之后仍排在 queued 中的目标任务，才是能覆盖本次 mention
      // 的 future turn。running、终态和来源之前的任务都不提供覆盖。
      const futureCoverage = await transaction.getFirstAsync<{ id: string }>(
        `SELECT id
         FROM group_speech_tasks
         WHERE plan_id = ?
           AND ai_assistant_id = ?
           AND status = 'queued'
           AND sequence_order > ?
         LIMIT 1`,
        [planId, input.aiAssistantId, sourceTask.sequenceOrder],
      );
      if (futureCoverage) {
        continue;
      }

      await transaction.runAsync(
        `INSERT INTO group_speech_tasks
         (id, plan_id, group_id, ai_assistant_id, agent_id, sequence_order, source,
          status, started_at, completed_at, error_message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, ?, ?)`,
        [
          input.id,
          planId,
          input.groupId,
          input.aiAssistantId,
          input.agentId,
          nextOrder,
          input.source,
          now,
          now,
        ],
      );
      created.push({
        id: input.id,
        planId,
        groupId: input.groupId,
        aiAssistantId: input.aiAssistantId,
        agentId: input.agentId,
        sequenceOrder: nextOrder,
        source: input.source,
        status: 'queued',
        visibleReplyCommitted: false,
        startedAt: null,
        completedAt: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      });
      nextOrder += 1;
    }
    return created;
  }

  async isSpeechTaskCommitEligible(planId: string, taskId: string): Promise<boolean> {
    const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'chat.isSpeechTaskCommitEligible', feature: 'chat', priority: 'interactive' });
    const row = await database.getFirstAsync<{ eligible: number }>(
      `SELECT COUNT(*) AS eligible
       FROM group_speech_tasks t
       JOIN group_speech_plans p ON p.id = t.plan_id
       WHERE t.id = ?
         AND t.plan_id = ?
         AND t.status = 'running'
         AND p.status IN ('pending', 'preparing', 'running')`,
      [taskId, planId],
    );
    return (row?.eligible ?? 0) > 0;
  }

  async isSpeechTaskCommitEligibleInTransaction(
    transaction: DatabaseTransactionExecutor,
    planId: string,
    taskId: string,
  ): Promise<boolean> {
    const row = await transaction.getFirstAsync<{ eligible: number }>(
      `SELECT COUNT(*) AS eligible
       FROM group_speech_tasks t
       JOIN group_speech_plans p ON p.id = t.plan_id
       WHERE t.id = ?
         AND t.plan_id = ?
         AND t.status = 'running'
         AND p.status IN ('pending', 'preparing', 'running')`,
      [taskId, planId],
    );
    return (row?.eligible ?? 0) > 0;
  }

  async isSpeechPlanActiveInTransaction(
    transaction: DatabaseTransactionExecutor,
    planId: string,
  ): Promise<boolean> {
    const row = await transaction.getFirstAsync<{ eligible: number }>(
      `SELECT COUNT(*) AS eligible
       FROM group_speech_plans
       WHERE id = ? AND status IN ('pending', 'preparing', 'running')`,
      [planId],
    );
    return (row?.eligible ?? 0) > 0;
  }

  async markSpeechTaskReplyCommittedInTransaction(
    transaction: DatabaseTransactionExecutor,
    taskId: string,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await transaction.runAsync(
      `UPDATE group_speech_tasks
       SET visible_reply_committed = 1, updated_at = ?
       WHERE id = ? AND status = 'running'`,
      [now, taskId],
    );
    return (result.changes || 0) > 0;
  }

  async updateSpeechPlanStatus(
    planId: string,
    status: GroupSpeechPlanStatus,
    options: {
      completedAt?: string | null;
      errorMessage?: string | null;
      expectedStatus?: GroupSpeechPlanStatus[];
    } = {}
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'chat.updateSpeechPlanStatus', feature: 'chat', priority: 'interactive' });
    const expected = options.expectedStatus ?? [];
    const guard = expected.length > 0
      ? ` AND status IN (${expected.map(() => '?').join(', ')})`
      : '';
    const result = await database.runAsync(
      `UPDATE group_speech_plans
       SET status = ?,
           completed_at = ?,
           error_message = ?,
           updated_at = ?
       WHERE id = ?${guard}`,
      [
        status,
        options.completedAt === undefined
          ? (status === 'completed' || status === 'failed' || status === 'superseded' || status === 'terminated' ? now : null)
          : options.completedAt,
        options.errorMessage || null,
        now,
        planId,
        ...expected,
      ]
    );
    return (result.changes || 0) > 0;
  }

  async updateSpeechTaskStatus(
    taskId: string,
    status: GroupSpeechTaskStatus,
    options: {
      startedAt?: string | null;
      completedAt?: string | null;
      errorMessage?: string | null;
      expectedStatus?: GroupSpeechTaskStatus;
    } = {}
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await (databaseCoordinator.openTaskExecutor({ name: 'chat.updateSpeechTaskStatus', feature: 'chat', priority: 'interactive' })).runAsync(
      `UPDATE group_speech_tasks
       SET status = ?,
           started_at = COALESCE(?, started_at),
           completed_at = ?,
           error_message = ?,
           updated_at = ?
       WHERE id = ?${options.expectedStatus ? ' AND status = ?' : ''}`,
      [
        status,
        options.startedAt === undefined ? null : options.startedAt,
        options.completedAt === undefined
          ? (status === 'completed' || status === 'partial' || status === 'failed' || status === 'skipped' || status === 'superseded' || status === 'terminated' ? now : null)
          : options.completedAt,
        options.errorMessage || null,
        now,
        taskId,
        ...(options.expectedStatus ? [options.expectedStatus] : []),
      ]
    );
    return (result.changes || 0) > 0;
  }

  /**
   * 删除群聊。
   *
   * 引用候选收集与删除事实必须在同一个 exclusive transaction 内完成：
   *
   *   - 先在同一事务里读出群头像引用与群消息里的媒体引用候选；
   *   - 再删除 group_chats 与 chat_conversations（identity 删除级联清理 messages）；
   *   - 返回候选给调用方在 commit 之后做 targeted release。
   *
   * 事务外先收集会让窗口期内新提交的群消息引用漏出候选集：那些消息随 identity 一起消失，
   * 但它们引用的资产永远不会进入 release 候选，形成长期 orphan。
   */
  async delete(groupId: string): Promise<GroupChatDeletionResult> {
    const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'chat.delete', feature: 'chat', priority: 'interactive' });
    let deletedGroupCount = 0;
    const mediaAssetCandidates = new Set<string>();

    await database.withExclusiveTransactionAsync(async (transaction) => {
      // 候选必须早于任何删除语句，且在同一个事务内：此时能看到的事实就是本次删除将带走的事实。
      const existing = await transaction.getFirstAsync<{ avatar_media_asset_id: string | null }>(
        'SELECT avatar_media_asset_id FROM group_chats WHERE id = ? LIMIT 1',
        [groupId],
      );
      if (existing) {
        const background = await removeConversationWallpaperInTransaction(transaction, `group:${groupId}`);
        if (background) mediaAssetCandidates.add(background);
        if (existing.avatar_media_asset_id) {
          mediaAssetCandidates.add(existing.avatar_media_asset_id);
        }
        for (const assetId of await collectChatSessionMediaAssetCandidatesInTransaction(
          transaction,
          [groupId],
        )) {
          mediaAssetCandidates.add(assetId);
        }
      }

      // 清理群聊附属记录；group_chats 删除后由外键级联兜底成员/配置/发言计划。
      await transaction.runAsync('DELETE FROM session_vision_helpers WHERE session_id = ?', [groupId]);
      await transaction.runAsync('DELETE FROM group_speech_tasks WHERE group_id = ?', [groupId]);
      await transaction.runAsync('DELETE FROM group_speech_plans WHERE group_id = ?', [groupId]);
      await transaction.runAsync('DELETE FROM group_chat_members WHERE group_id = ?', [groupId]);
      await transaction.runAsync('DELETE FROM group_chat_admin_configs WHERE group_id = ?', [groupId]);

      const result = await transaction.runAsync('DELETE FROM group_chats WHERE id = ?', [groupId]);
      deletedGroupCount = result.changes || 0;
      // 只有确实删除了 group_chats 才清理 group identity；
      // identity 删除后 messages 由外键级联清理，不再手工删除消息。
      if (deletedGroupCount > 0) {
        await transaction.runAsync(
          `DELETE FROM chat_conversations WHERE id = ? AND kind = 'group'`,
          [groupId]
        );
      }
    });

    return { deleted: deletedGroupCount > 0, mediaAssetCandidates: [...mediaAssetCandidates] };
  }

  private async mapGroupRowToEntity(row: GroupChatRow): Promise<GroupChat> {
    const group: GroupChat = {
      id: row.id,
      name: row.name,
      avatar: row.avatar,
      avatarMediaAssetId: row.avatar_media_asset_id || null,
      lastMessage: row.last_message,
      lastTime: row.last_time,
      isPinned: row.is_pinned === 1,
      pinnedAt: row.pinned_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    try {
      return {
        ...group,
        avatar: await resolveMediaAssetReferenceUri({
          mediaAssetId: group.avatarMediaAssetId,
          legacyUri: group.avatar,
        }),
      };
    } catch (error) {
      console.warn(`[群聊仓储] 当前群头像资产解析失败：${group.id}`, error);
      return { ...group, avatar: null };
    }
  }

  private async mapMemberRowToEntity(row: GroupChatMemberRow): Promise<GroupChatMember> {
    const member: GroupChatMember = {
      id: row.id,
      groupId: row.group_id,
      aiAssistantId: row.ai_assistant_id,
      agentId: row.agent_id,
      displayOrder: row.display_order || 0,
      enabled: row.enabled !== 0,
      muted: row.muted === 1,
      name: row.name || undefined,
      nickname: row.nickname,
      avatar: row.avatar || null,
      avatarMediaAssetId: row.avatar_media_asset_id || null,
      model: row.model || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    try {
      return {
        ...member,
        avatar: await resolveMediaAssetReferenceUri({
          mediaAssetId: member.avatarMediaAssetId,
          legacyUri: member.avatar ?? null,
        }),
      };
    } catch (error) {
      console.warn(`[群聊仓储] 当前群成员头像资产解析失败：${member.aiAssistantId}`, error);
      return { ...member, avatar: null };
    }
  }

  private async mapAdminRowToEntity(row: GroupChatAdminConfigRow, db: import('@platform/persistence').DatabaseReadExecutor): Promise<GroupChatAdminConfig> {
    const service = row.service_config_id ? await readModelServiceConnection(db, row.service_config_id) : null;
    return {
      groupId: row.group_id,
      name: row.name,
      model: row.model,
      serviceConfigId: row.service_config_id,
      apiKey: service ? service.apiKey : row.api_key,
      apiBaseUrl: service ? service.baseUrl : row.api_base_url,
      systemPrompt: row.system_prompt,
      temperature: row.temperature,
      topP: row.top_p,
      maxTokens: row.max_tokens,
      contextMessageCount: row.context_message_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapSpeechPlanRowToEntity(row: GroupSpeechPlanRow): GroupSpeechPlan {
    return {
      id: row.id,
      groupId: row.group_id,
      status: row.status,
      invokedUserMessageIds: parseInvokedUserMessageIds(row.invoked_user_message_ids_json),
      inputUpperBoundMessageId: row.last_included_message_id,
      supersedesPlanId: row.supersedes_plan_id ?? null,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapSpeechTaskRowToEntity(row: GroupSpeechTaskRow): GroupSpeechTask {
    return {
      id: row.id,
      planId: row.plan_id,
      groupId: row.group_id,
      aiAssistantId: row.ai_assistant_id,
      agentId: row.agent_id,
      sequenceOrder: row.sequence_order,
      source: row.source,
      status: row.status,
      visibleReplyCommitted: row.visible_reply_committed === 1,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export const groupChatRepository = new GroupChatRepository();
