import { bindModelService, readModelService } from './SQLiteModelServiceRepository';
import { getModelServiceConnection } from '../domain/ModelService';
import { removeConversationWallpaperInTransaction } from '@features/profile';
/** AI 助手仓储的 SQLite 实现。 */
import {
  databaseCoordinator,
  type CoordinatedDatabaseExecutor,
  type DatabaseTransactionExecutor,
} from '@platform/persistence';
import {
  collectChatSessionMediaAssetCandidatesInTransaction,
  collectAssistantMediaAssetCandidatesInTransaction,
  resolveMediaAssetReferenceUri,
} from '@features/media';
import { createAIProfile, type AIProfile } from '../domain/AIProfile';
import { initializeAssistantAuxiliaryModelsInTransaction } from './SQLiteAuxiliaryModelDefaults';
import { auxiliaryModelRepository } from './SQLiteAuxiliaryModelRepository';
import type {
  AIAssistantDeletionResult,
  AIAssistantSettingsUpdate,
  AIModelSettingsUpdate,
  AIAssistantSummary,
  AIAvatarMediaAssetReference,
  AIAvatarMediaAssetMigrationCandidate,
  CommitAIAvatarMediaAssetReferenceInput,
  ReplaceAIAvatarMediaAssetReferenceInput,
  IAIAssistantRepository,
  AssistantNicknameContext,
  AssistantSettingsUpdateResult,
} from '../domain/AssistantRepository';
import {
  createHostAIAppointmentCooldown,
  HOST_AI_RELATIONSHIP_STATE_ID,
} from '../domain/HostRepository';

/**
 * AIAssistantRepository
 * 
 * AI助手的 SQLite 实现
 */
export class AIAssistantRepository implements IAIAssistantRepository {
  /** 一次性复制四项设置，同事务完成；不修改角色资料，也不建立继承关系。 */
  async applyContextLimits(assistantIds: readonly string[], settings: import('../domain/AssistantRepository').AssistantContextLimits): Promise<void> {
    const database = databaseCoordinator.openTaskExecutor({ name: 'assistants.applyContextLimits', feature: 'assistants', priority: 'interactive' });
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const now = new Date().toISOString();
      for (const id of assistantIds) {
        const result = await transaction.runAsync(`UPDATE ai_assistants SET private_context_primary_limit = ?, private_context_secondary_limit = ?,
          group_context_primary_limit = ?, group_context_secondary_limit = ?, updated_at = ? WHERE id = ?`,
        [settings.privateContextPrimaryLimit, settings.privateContextSecondaryLimit, settings.groupContextPrimaryLimit, settings.groupContextSecondaryLimit, now, id]);
        if (result.changes !== 1) throw new Error('所选AI已删除，请刷新列表后重新应用');
      }
    });
  }
  async rebaseRestoredMediaInTransaction(transaction: DatabaseTransactionExecutor, rebase: (uri: string | null) => string | null): Promise<void> {
    const rows = await transaction.getAllAsync<{ id: string; avatar: string }>('SELECT id, avatar FROM ai_assistants WHERE avatar_media_asset_id IS NULL AND avatar IS NOT NULL');
    for (const row of rows) {
      const avatar = rebase(row.avatar);
      if (avatar !== row.avatar) await transaction.runAsync('UPDATE ai_assistants SET avatar = ? WHERE id = ?', [avatar, row.id]);
    }
  }
  private buildActiveBlockJoin(now: string): string {
    return `
      LEFT JOIN ai_blacklist b ON b.ai_id = a.id
        AND b.blocked_until > '${now}'
        AND b.created_at = (
          SELECT MAX(b2.created_at)
          FROM ai_blacklist b2
          WHERE b2.ai_id = a.id AND b2.blocked_until > '${now}'
        )
    `;
  }

  private async readModelConnection(db: import('@platform/persistence').DatabaseReadExecutor, row: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!row.service_config_id) return row;
    const service = await readModelService(db, row.service_config_id as string);
    return { ...row, api_key: service.apiKey, api_base_url: service.baseUrl };
  }

  private async mapRowToAIProfile(row: Record<string, unknown>): Promise<AIProfile> {
    const profile = createAIProfile({
      id: row.id as string,
      agentId: row.agent_id as string,
      name: row.name as string,
      nickname: row.nickname as string | null,
      avatar: row.avatar as string | null,
      avatarMediaAssetId: row.avatar_media_asset_id as string | null,
      profileCoverMediaAssetId: row.profile_cover_media_asset_id as string | null,
      model: row.model as string,
      serviceConfigId: row.service_config_id as string | null,
      apiKey: row.api_key as string | null,
      apiBaseUrl: row.api_base_url as string | null,
      systemPrompt: row.system_prompt as string | null,
      temperature: row.temperature as number | null,
      topP: row.top_p as number | null,
      maxTokens: row.max_tokens as number | null,
      privateContextPrimaryLimit: row.private_context_primary_limit as number,
      privateContextSecondaryLimit: row.private_context_secondary_limit as number,
      groupContextPrimaryLimit: row.group_context_primary_limit as number,
      groupContextSecondaryLimit: row.group_context_secondary_limit as number,
      enableTools: row.enable_tools === 1,
      disableThinking: row.disable_thinking === 1,
      streamingReply: row.streaming_reply === null ? null : row.streaming_reply === 1,
      showTokenUsage: row.show_token_usage === 1,
      showActionSteps: row.show_action_steps === 1,
      // 2.x 读取旧列仅用于覆盖未完成迁移的数据库；3.0 删除旧列和该回退。
      allowMultipleBubbles: row.allow_multiple_bubbles === undefined || row.allow_multiple_bubbles === null
        ? row.enable_short_text_protocol !== 0
        : row.allow_multiple_bubbles !== 0,
      supportsVision: row.supports_vision === 1,
      isLedgerAI: row.is_ledger_ai === 1,
      isHostAI: row.is_host_ai === 1,
      hostCooldownStart: row.host_cooldown_start as string | null,
      hostCooldownEnd: row.host_cooldown_end as string | null,
      hostRevokeCooldownStart: row.host_revoke_cooldown_start as string | null,
      hostRevokeCooldownEnd: row.host_revoke_cooldown_end as string | null,
      canonicalConversationId: row.canonical_conversation_id as string | null,
      isPinned: row.session_is_pinned === 1,
      pinnedAt: (row.session_pinned_at as string | null) || null,
      lastMessage: (row.session_last_message as string) || '',
      lastTime: (row.session_last_time as string) || '',
      isBlocked: !!row.blocked_until,
      blockedUntil: (row.blocked_until as string | null) || null,
      blockReason: (row.block_reason as string | null) || null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    });
    return this.resolveAvatar(profile);
  }

  private async mapRowToAIAssistantSummary(
    row: Record<string, unknown>,
  ): Promise<AIAssistantSummary> {
    const summary: AIAssistantSummary = {
      id: row.id as string,
      agentId: row.agent_id as string,
      name: row.name as string,
      nickname: row.nickname as string | null,
      avatar: row.avatar as string | null,
      avatarMediaAssetId: row.avatar_media_asset_id as string | null,
      model: row.model as string,
      isHostAI: row.is_host_ai === 1,
      canonicalConversationId: row.canonical_conversation_id as string | null,
      isBlocked: row.is_blocked === 1,
    };
    try {
      return {
        ...summary,
        avatar: await resolveMediaAssetReferenceUri({
          mediaAssetId: summary.avatarMediaAssetId,
          legacyUri: summary.avatar,
        }),
      };
    } catch (error) {
      console.warn(`[助手仓储] 当前 AI 头像资产解析失败：${summary.id}`, error);
      return { ...summary, avatar: null };
    }
  }

  private async resolveAvatar(profile: AIProfile): Promise<AIProfile> {
    try {
      return {
        ...profile,
        avatar: await resolveMediaAssetReferenceUri({
          mediaAssetId: profile.avatarMediaAssetId,
          legacyUri: profile.avatar,
        }),
      };
    } catch (error) {
      console.warn(`[助手仓储] 当前 AI 头像资产解析失败：${profile.id}`, error);
      return { ...profile, avatar: null };
    }
  }

  /**
   * canonical conversation projection。
   *
   * 所有返回**完整 AIProfile** 的查询入口必须共用这一份投影：漏掉任何一列都会让
   * 同一个 AI 在不同入口读到不同的 isPinned / lastTime / canonicalConversationId
   * （domain projection 漂移）。轻量 summary DTO 不适用（它们不需要预览事实）。
   */
  private buildCanonicalConversationProjection(): string {
    return `s.last_message AS session_last_message,
            s.last_time AS session_last_time,
            s.is_pinned AS session_is_pinned,
            s.pinned_at AS session_pinned_at,
            s.id AS canonical_conversation_id,
            (SELECT media_asset_id FROM assistant_profile_covers WHERE assistant_id = a.id)
              AS profile_cover_media_asset_id`;
  }

  /** sessions 与 AI 是 1:1（UNIQUE(ai_assistant_id)），LEFT JOIN 不会放大行数。 */
  private buildCanonicalConversationJoin(): string {
    return 'LEFT JOIN sessions s ON s.ai_assistant_id = a.id';
  }

  /**
   * 获取所有AI助手列表
   */
  async listServiceAssistantIds(serviceConfigId: string): Promise<string[]> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'assistants.serviceUsers', feature: 'assistants', priority: 'interactive' });
    return (await db.getAllAsync<{ id: string }>('SELECT id FROM ai_assistants WHERE service_config_id = ?', [serviceConfigId])).map(row => row.id);
  }

  async getAll(): Promise<AIProfile[]> {
    try {
      const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'assistants.getAll', feature: 'assistants', priority: 'runtime' });
      const now = new Date().toISOString();
      const rows = await database.getAllAsync<Record<string, unknown>>(`
        SELECT 
          a.*,
          b.blocked_until,
          b.reason as block_reason,
          ${this.buildCanonicalConversationProjection()}
        FROM ai_assistants a
        ${this.buildActiveBlockJoin(now)}
        ${this.buildCanonicalConversationJoin()}
        ORDER BY a.created_at ASC
      `);

      return Promise.all(rows.map(async row => this.mapRowToAIProfile(await this.readModelConnection(database, row))));
    } catch (error) {
      console.error('[AIAssistantRepository] Failed to get all:', error);
      throw error;
    }
  }

  /** 身份遍历不读取模型配置，也不触发头像 backing 的解析。 */
  async listIds(): Promise<string[]> {
    const database = databaseCoordinator.openTaskExecutor({
      name: 'assistants.listIds', feature: 'assistants', priority: 'runtime',
    });
    const rows = await database.getAllAsync<{ id: string }>('SELECT id FROM ai_assistants ORDER BY created_at ASC');
    return rows.map((row) => row.id);
  }

  async listSummaries(): Promise<AIAssistantSummary[]> {
    const database = databaseCoordinator.openTaskExecutor({
      name: 'assistants.listSummaries',
      feature: 'assistants',
      priority: 'surface',
    });
    const rows = await database.getAllAsync<Record<string, unknown>>(
      `SELECT a.id, a.agent_id, a.name, a.nickname, a.avatar, a.avatar_media_asset_id, a.model,
              a.is_host_ai,
              (SELECT id FROM sessions WHERE ai_assistant_id = a.id LIMIT 1)
                AS canonical_conversation_id,
              EXISTS (
                SELECT 1 FROM ai_blacklist b
                WHERE b.ai_id = a.id AND b.blocked_until > ?
              ) AS is_blocked
       FROM ai_assistants a
       ORDER BY a.created_at ASC`,
      [new Date().toISOString()]
    );
    return Promise.all(rows.map((row) => this.mapRowToAIAssistantSummary(row)));
  }

  /**
   * 根据ID获取AI助手
   */
  async getById(assistantId: string): Promise<AIProfile | null> {
    try {
      const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'assistants.getById', feature: 'assistants', priority: 'runtime' });
      const now = new Date().toISOString();
      const row = await database.getFirstAsync<Record<string, unknown>>(
        `SELECT a.*, b.blocked_until, b.reason as block_reason,
                ${this.buildCanonicalConversationProjection()}
         FROM ai_assistants a
         ${this.buildActiveBlockJoin(now)}
         ${this.buildCanonicalConversationJoin()}
         WHERE a.id = ?`,
        [assistantId]
      );

      if (!row) return null;
      return await this.mapRowToAIProfile(await this.readModelConnection(database, row));
    } catch (error) {
      console.error('[AIAssistantRepository] Failed to get by id:', error);
      return null;
    }
  }

  /**
   * 获取记账AI助手
   */
  async getLedgerAI(): Promise<AIProfile | null> {
    try {
      const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'assistants.getLedgerAI', feature: 'assistants', priority: 'runtime' });
      const now = new Date().toISOString();
      const row = await database.getFirstAsync<Record<string, unknown>>(
        `SELECT a.*, b.blocked_until, b.reason as block_reason,
                ${this.buildCanonicalConversationProjection()}
         FROM ai_assistants a
         ${this.buildActiveBlockJoin(now)}
         ${this.buildCanonicalConversationJoin()}
         WHERE a.is_ledger_ai = 1
         LIMIT 1`
      );

      if (!row) return null;
      return await this.mapRowToAIProfile(await this.readModelConnection(database, { ...row, is_ledger_ai: 1 }));
    } catch (error) {
      console.error('[AIAssistantRepository] Failed to get ledger AI:', error);
      return null;
    }
  }

  /**
   * 获取主理AI
   */
  async getHostAI(): Promise<AIProfile | null> {
    try {
      const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'assistants.getHostAI', feature: 'assistants', priority: 'runtime' });
      const now = new Date().toISOString();
      const row = await database.getFirstAsync<Record<string, unknown>>(
        `SELECT a.*, b.blocked_until, b.reason as block_reason,
                ${this.buildCanonicalConversationProjection()}
         FROM ai_assistants a
         ${this.buildActiveBlockJoin(now)}
         ${this.buildCanonicalConversationJoin()}
         WHERE a.is_host_ai = 1
         LIMIT 1`
      );

      if (!row) return null;
      return await this.mapRowToAIProfile(await this.readModelConnection(database, { ...row, is_host_ai: 1 }));
    } catch (error) {
      console.error('[AIAssistantRepository] Failed to get host AI:', error);
      return null;
    }
  }

  async getHostSummary(): Promise<AIAssistantSummary | null> {
    const database = databaseCoordinator.openTaskExecutor({
      name: 'assistants.getHostSummary',
      feature: 'assistants',
      priority: 'surface',
    });
    const row = await database.getFirstAsync<Record<string, unknown>>(
      `SELECT a.id, a.agent_id, a.name, a.nickname, a.avatar, a.avatar_media_asset_id, a.model,
              a.is_host_ai,
              (SELECT id FROM sessions WHERE ai_assistant_id = a.id LIMIT 1)
                AS canonical_conversation_id,
              EXISTS (
                SELECT 1 FROM ai_blacklist b
                WHERE b.ai_id = a.id AND b.blocked_until > ?
              ) AS is_blocked
       FROM ai_assistants a
       WHERE a.is_host_ai = 1
       LIMIT 1`,
      [new Date().toISOString()]
    );
    return row ? await this.mapRowToAIAssistantSummary(row) : null;
  }

  /**
   * 插入AI助手
   */
  async insert(ai: AIProfile): Promise<AIProfile> {
    const now = new Date().toISOString();

    const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'assistants.insert', feature: 'assistants', priority: 'runtime' });
    const connection = await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync(
        `INSERT INTO ai_assistants
         (id, agent_id, name, nickname, avatar, avatar_media_asset_id, model, api_key, api_base_url, system_prompt, temperature, top_p, max_tokens, private_context_primary_limit, private_context_secondary_limit, group_context_primary_limit, group_context_secondary_limit, enable_tools, disable_thinking, enable_short_text_protocol, allow_multiple_bubbles, streaming_reply, show_token_usage, show_action_steps, supports_vision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,      [
          ai.id,
          ai.agentId,
          ai.name,
          ai.nickname,
          ai.avatarMediaAssetId ? null : ai.avatar || null,
          ai.avatarMediaAssetId || null,
          ai.model,
          ai.apiKey || null,
          ai.apiBaseUrl || null,
          ai.systemPrompt || null,
          ai.temperature,
          ai.topP,
          ai.maxTokens === undefined ? 2000 : ai.maxTokens,
          ai.privateContextPrimaryLimit,
          ai.privateContextSecondaryLimit,
          ai.groupContextPrimaryLimit,
          ai.groupContextSecondaryLimit,
          ai.enableTools ? 1 : 0,
          ai.disableThinking ? 1 : 0,
          // 2.x 双写旧列供降级安装读取；3.0 删除旧列和这一次写入。
          ai.allowMultipleBubbles === false ? 0 : 1,
          // 2.x 双写旧列供降级安装读取；3.0 删除旧列和这一次写入。
          ai.allowMultipleBubbles === false ? 0 : 1,
          ai.streamingReply === null ? null : ai.streamingReply ? 1 : 0,
          ai.showTokenUsage ? 1 : 0,
          ai.showActionSteps ? 1 : 0,
          ai.supportsVision ? 1 : 0,
          now,
          now
        ]
      );

      const serviceId = await bindModelService(transaction, getModelServiceConnection(ai.apiBaseUrl ?? '', ai.apiKey), ai.serviceConfigId);
      if (serviceId) await transaction.runAsync('UPDATE ai_assistants SET service_config_id = ?, api_base_url = NULL, api_key = NULL WHERE id = ?', [serviceId, ai.id]);
      await initializeAssistantAuxiliaryModelsInTransaction(transaction, ai.id,
        (id) => auxiliaryModelRepository.getModelConfigByIdInTransaction(transaction, id));
      const service = serviceId ? await readModelService(transaction, serviceId) : null;
      return { serviceConfigId: serviceId, apiBaseUrl: service ? service.baseUrl : ai.apiBaseUrl, apiKey: service ? service.apiKey : ai.apiKey };
    });

    return this.resolveAvatar(createAIProfile({
      ...ai,
      ...connection,
      avatar: ai.avatarMediaAssetId ? null : ai.avatar,
      avatarMediaAssetId: ai.avatarMediaAssetId || null,
      createdAt: now,
      updatedAt: now,
    }));
  }

  /**
   * 模型页只更新自己拥有的配置字段，不能写回其他入口的旧实体快照。
   */
  async updateModelSettings(assistantId: string, settings: AIModelSettingsUpdate): Promise<AIProfile> {
    const columns: Record<keyof AIModelSettingsUpdate, string> = {
      model: 'model', apiKey: 'api_key', apiBaseUrl: 'api_base_url', serviceConfigId: 'service_config_id',
      temperature: 'temperature', topP: 'top_p', maxTokens: 'max_tokens',
      enableTools: 'enable_tools', disableThinking: 'disable_thinking',
    };
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    for (const key of Object.keys(columns) as (keyof AIModelSettingsUpdate)[]) {
      const value = settings[key];
      if (value !== undefined && key !== 'apiBaseUrl' && key !== 'apiKey' && key !== 'serviceConfigId') {
        fields.push(`${columns[key]} = ?`);
        values.push(typeof value === 'boolean' ? Number(value) : value);
      }
    }
    const now = new Date().toISOString();
    fields.push('updated_at = ?');
    values.push(now, assistantId);
    const database = databaseCoordinator.openTaskExecutor({ name: 'assistants.updateModelSettings', feature: 'assistants', priority: 'runtime' });
    // 更新与 canonical 投影读取共享事务；提交后再解析头像和通知消费者。
    const row = await database.withExclusiveTransactionAsync(async (transaction) => {
      if (settings.apiBaseUrl !== undefined || settings.apiKey !== undefined || settings.serviceConfigId !== undefined) {
        const current = await transaction.getFirstAsync<{ service_config_id: string | null; api_base_url: string | null; api_key: string | null }>('SELECT service_config_id, api_base_url, api_key FROM ai_assistants WHERE id = ?', [assistantId]);
        if (!current) throw new Error(`AI 助手不存在：${assistantId}`);
        const previous = current.service_config_id ? await readModelService(transaction, current.service_config_id) : null;
        const baseUrl = settings.apiBaseUrl !== undefined ? settings.apiBaseUrl ?? '' : previous ? previous.baseUrl : current.api_base_url ?? '';
        const apiKey = settings.apiKey !== undefined ? settings.apiKey : previous ? previous.apiKey : current.api_key;
        const serviceId = await bindModelService(transaction, getModelServiceConnection(baseUrl, apiKey), settings.serviceConfigId);
        await transaction.runAsync('UPDATE ai_assistants SET service_config_id = ?, api_base_url = ?, api_key = ? WHERE id = ?', [serviceId, serviceId ? null : baseUrl, serviceId ? null : apiKey, assistantId]);
      }
      await transaction.runAsync(`UPDATE ai_assistants SET ${fields.join(', ')} WHERE id = ?`, values);
      const persisted = await transaction.getFirstAsync<Record<string, unknown>>(
        `SELECT a.*, b.blocked_until, b.reason as block_reason,
                ${this.buildCanonicalConversationProjection()}
         FROM ai_assistants a
         ${this.buildActiveBlockJoin(now)}
         ${this.buildCanonicalConversationJoin()}
         WHERE a.id = ?`, [assistantId],
      );
      if (!persisted) throw new Error(`AI 助手不存在：${assistantId}`);
      return this.readModelConnection(transaction, persisted);
    });
    return this.mapRowToAIProfile(row);
  }

  /** 设置提交返回昵称变更事实，跨 Feature 的历史写入由应用事务组合。 */
  async updateSettingsInTransaction(
    transaction: DatabaseTransactionExecutor,
    assistantId: string,
    settings: AIAssistantSettingsUpdate,
  ): Promise<AssistantSettingsUpdateResult> {
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (settings.name !== undefined) {
      fields.push('name = ?');
      values.push(settings.name);
    }
    if (settings.avatarMediaAssetId !== undefined) {
      fields.push('avatar = ?', 'avatar_media_asset_id = ?');
      if (settings.avatarMediaAssetId) {
        values.push(null, settings.avatarMediaAssetId);
      } else {
        values.push(settings.avatar ?? null, null);
      }
    } else if (settings.avatar !== undefined) {
      // 显式提交 legacy avatar 时清空旧 asset 投影；不带 avatar 的其他设置
      // 更新不会触碰 canonical 引用。
      fields.push('avatar = ?', 'avatar_media_asset_id = NULL');
      values.push(settings.avatar);
    }
    if (settings.systemPrompt !== undefined) {
      fields.push('system_prompt = ?');
      values.push(settings.systemPrompt);
    }
    if (settings.allowMultipleBubbles !== undefined) {
      // 2.x 双写旧列供降级安装读取；3.0 只更新 allow_multiple_bubbles。
      fields.push('allow_multiple_bubbles = ?', 'enable_short_text_protocol = ?');
      values.push(settings.allowMultipleBubbles ? 1 : 0, settings.allowMultipleBubbles ? 1 : 0);
    }
    if (settings.streamingReply !== undefined) {
      fields.push('streaming_reply = ?');
      values.push(settings.streamingReply === null ? null : settings.streamingReply ? 1 : 0);
    }
    if (settings.showTokenUsage !== undefined) {
      fields.push('show_token_usage = ?');
      values.push(settings.showTokenUsage ? 1 : 0);
    }
    if (settings.showActionSteps !== undefined) {
      fields.push('show_action_steps = ?');
      values.push(settings.showActionSteps ? 1 : 0);
    }
    const contextColumns = {
      privateContextPrimaryLimit: 'private_context_primary_limit',
      privateContextSecondaryLimit: 'private_context_secondary_limit',
      groupContextPrimaryLimit: 'group_context_primary_limit',
      groupContextSecondaryLimit: 'group_context_secondary_limit',
    } as const;
    for (const key of Object.keys(contextColumns) as (keyof typeof contextColumns)[]) {
      if (settings[key] !== undefined) {
        fields.push(`${contextColumns[key]} = ?`);
        values.push(settings[key]);
      }
    }

    let nicknameChange: AssistantSettingsUpdateResult['nicknameChange'] = null;
    if (settings.nickname !== undefined) {
      const previous = await transaction.getFirstAsync<{ nickname: string | null }>(
        'SELECT nickname FROM ai_assistants WHERE id = ?', [assistantId],
      );
      if (!previous) return { updated: false, nicknameChange: null };
      if (previous.nickname !== settings.nickname) {
        fields.push('nickname = ?');
        values.push(settings.nickname);
        nicknameChange = { changeId: `${now}:${Math.random().toString(36).slice(2)}`,
          assistantId, previousNickname: previous.nickname, nickname: settings.nickname, occurredAt: now };
      }
    }
    fields.push('updated_at = ?');
    values.push(now, assistantId);
    const result = await transaction.runAsync(
      `UPDATE ai_assistants SET ${fields.join(', ')} WHERE id = ?`, values,
    );
    return { updated: result.changes > 0, nicknameChange };
  }

  async getNicknameContext(assistantId: string): Promise<AssistantNicknameContext | null> {
    const database = databaseCoordinator.openTaskExecutor({ name: 'assistants.nicknameContext', feature: 'assistants', priority: 'runtime' });
    return database.getFirstAsync<{ nickname: string | null }>(
      'SELECT nickname FROM ai_assistants WHERE id = ?', [assistantId],
    );
  }

  /**
   * 删除 AI 助手。
   *
   * 级联范围（sessions.id 就是 direct conversation id，也就是 messages.session_id）与
   * 引用候选收集必须在同一个 exclusive transaction 内完成：
   *
   *   - 先在同一事务里读出本次删除将带走的 session id 与它们的消息媒体引用候选；
   *   - 再删除 AI / blacklist / chat_conversations（identity 删除级联清理 messages）；
   *   - 返回候选给调用方在 commit 之后做 targeted release。
   *
   * 事务外先收集会让窗口期内新提交的消息引用漏出候选集：那些消息随 identity 一起消失，
   * 但它们引用的资产永远不会进入 release 候选，形成长期 orphan。
   */
  async delete(id: string): Promise<AIAssistantDeletionResult> {
    const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'assistants.delete', feature: 'assistants', priority: 'runtime' });
    let deleted = false;
    const mediaAssetCandidates = new Set<string>();

    await database.withExclusiveTransactionAsync(async (txn) => {
      const assistant = await txn.getFirstAsync<{
        is_host_ai: number;
      }>(
        'SELECT is_host_ai FROM ai_assistants WHERE id = ? LIMIT 1',
        [id]
      );
      if (!assistant) return;

      // AI 删除后由外键级联删除 sessions 详情行，identity 删除会级联清理这些会话的 messages。
      const sessionRows = await txn.getAllAsync<{ id: string }>(
        'SELECT id FROM sessions WHERE ai_assistant_id = ?',
        [id]
      );
      const directSessionIds = sessionRows.map((row) => row.id);
      for (const sessionId of directSessionIds) {
        const background = await removeConversationWallpaperInTransaction(txn, `single:${sessionId}`);
        if (background) mediaAssetCandidates.add(background);
      }

      // 候选必须早于任何删除语句，且在同一个事务内：此时能看到的事实就是本次删除将带走的事实。
      for (const assetId of await collectAssistantMediaAssetCandidatesInTransaction(txn, id)) {
        mediaAssetCandidates.add(assetId);
      }
      for (const assetId of await collectChatSessionMediaAssetCandidatesInTransaction(
        txn,
        directSessionIds,
      )) {
        mediaAssetCandidates.add(assetId);
      }

      if (assistant.is_host_ai === 1) {
        const cooldown = createHostAIAppointmentCooldown(new Date());
        await txn.runAsync(
          `INSERT INTO host_ai_relationship_state (
             id, last_revoked_ai_id, appointment_cooldown_start,
             appointment_cooldown_end, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             last_revoked_ai_id = excluded.last_revoked_ai_id,
             appointment_cooldown_start = excluded.appointment_cooldown_start,
             appointment_cooldown_end = excluded.appointment_cooldown_end,
             updated_at = excluded.updated_at`,
          [
            HOST_AI_RELATIONSHIP_STATE_ID,
            id,
            cooldown.startAt,
            cooldown.endAt,
            cooldown.startAt,
            cooldown.startAt,
          ]
        );
      }
      await txn.runAsync('DELETE FROM ai_blacklist WHERE blocked_by = ?', [id]);
      await txn.runAsync('DELETE FROM ai_assistants WHERE id = ?', [id]);

      if (directSessionIds.length > 0) {
        const placeholders = directSessionIds.map(() => '?').join(',');
        await txn.runAsync(
          `DELETE FROM chat_conversations WHERE kind = 'direct' AND id IN (${placeholders})`,
          directSessionIds
        );
      }

      deleted = true;
    });

    return { deleted, mediaAssetCandidates: [...mediaAssetCandidates] };
  }

  async listAvatarMediaAssetMigrationCandidates(): Promise<AIAvatarMediaAssetMigrationCandidate[]> {
    const database = databaseCoordinator.openTaskExecutor({
      name: 'assistants.list-avatar-media-asset-candidates',
      feature: 'assistants',
      priority: 'maintenance',
    });
    const rows = await database.getAllAsync<{
      id: string;
      avatar: string;
      avatar_media_asset_id: string | null;
    }>(
      `SELECT id, avatar, avatar_media_asset_id
       FROM ai_assistants
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

  async getAvatarMediaAssetReference(
    ownerId: string,
  ): Promise<AIAvatarMediaAssetReference | null> {
    const database = databaseCoordinator.openTaskExecutor({
      name: 'assistants.get-avatar-media-asset-reference',
      feature: 'assistants',
      priority: 'runtime',
    });
    const row = await database.getFirstAsync<{
      avatar: string | null;
      avatar_media_asset_id: string | null;
    }>(
      'SELECT avatar, avatar_media_asset_id FROM ai_assistants WHERE id = ? LIMIT 1',
      [ownerId],
    );
    return row
      ? { avatar: row.avatar, avatarMediaAssetId: row.avatar_media_asset_id }
      : null;
  }

  async commitAvatarMediaAssetReferenceInTransaction(
    transaction: DatabaseTransactionExecutor,
    input: CommitAIAvatarMediaAssetReferenceInput,
  ): Promise<void> {
    if (!input.mediaAssetId.trim()) {
      throw new Error('AI 头像 MediaAsset 引用不能为空');
    }
    const changed = await this.tryCommitAvatarMediaAssetReferenceInTransaction(transaction, input);
    if (!changed) throw new Error(`AI 头像 MediaAsset CAS 未影响一行：${input.ownerId}`);
  }

  async canManageApplicationSettingsInTransaction(transaction: DatabaseTransactionExecutor, actorId: string, targetId: string | null): Promise<boolean> {
    const actor = await transaction.getFirstAsync<{ is_host_ai: number }>('SELECT is_host_ai FROM ai_assistants WHERE id = ?', [actorId]);
    return actor !== null && (actorId === targetId || actor.is_host_ai === 1);
  }

  async getProfileCoverReference(assistantId: string): Promise<{ mediaAssetId: string | null } | null> {
    const database = databaseCoordinator.openTaskExecutor({ name: 'assistants.get-profile-cover', feature: 'assistants', priority: 'interactive' });
    return database.getFirstAsync<{ mediaAssetId: string | null }>(
      `SELECT (SELECT media_asset_id FROM assistant_profile_covers WHERE assistant_id = a.id) AS mediaAssetId
       FROM ai_assistants a WHERE a.id = ?`, [assistantId]);
  }

  /** 目标身份由可信调用方固定，事务内 CAS 同时保护首次设置、并发修改和角色删除。 */
  async tryCommitProfileCoverInTransaction(transaction: DatabaseTransactionExecutor, assistantId: string, expectedMediaAssetId: string | null, mediaAssetId: string): Promise<boolean> {
    const result = await transaction.runAsync(
      `INSERT INTO assistant_profile_covers (assistant_id, media_asset_id)
       SELECT id, ? FROM ai_assistants a WHERE id = ?
         AND (SELECT media_asset_id FROM assistant_profile_covers WHERE assistant_id = a.id) IS ?
       ON CONFLICT(assistant_id) DO UPDATE SET media_asset_id = excluded.media_asset_id`,
      [mediaAssetId, assistantId, expectedMediaAssetId]);
    if (result.changes !== 1) return false;
    await transaction.runAsync('UPDATE ai_assistants SET updated_at = ? WHERE id = ?', [new Date().toISOString(), assistantId]);
    return true;
  }

  async changeNameInTransaction(transaction: DatabaseTransactionExecutor, assistantId: string, expectedName: string, name: string): Promise<boolean> {
    const result = await transaction.runAsync('UPDATE ai_assistants SET name = ?, updated_at = ? WHERE id = ? AND name = ?',
      [name, new Date().toISOString(), assistantId, expectedName]);
    return result.changes === 1;
  }

  async tryCommitAvatarMediaAssetReferenceInTransaction(transaction: DatabaseTransactionExecutor, input: ReplaceAIAvatarMediaAssetReferenceInput): Promise<boolean> {
    const result = await transaction.runAsync(
      `UPDATE ai_assistants
       SET avatar = NULL,
           avatar_media_asset_id = ?,
           updated_at = ?
       WHERE id = ?
         AND ((avatar IS NULL AND ? IS NULL) OR avatar = ?)
         AND (
           (avatar_media_asset_id IS NULL AND ? IS NULL)
           OR avatar_media_asset_id = ?
         )`,
      [
        input.mediaAssetId,
        new Date().toISOString(),
        input.ownerId,
        input.expectedAvatar,
        input.expectedAvatar,
        input.expectedAvatarMediaAssetId,
        input.expectedAvatarMediaAssetId,
      ],
    );
    return result.changes === 1;
  }

  /**
   * 设置记账AI助手
   */
  async setLedgerAI(aiId: string): Promise<boolean> {
    const now = new Date().toISOString();

    const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'assistants.setLedgerAI', feature: 'assistants', priority: 'runtime' });
    
    // 先清除所有AI的记账AI标记
    await database.runAsync(
      'UPDATE ai_assistants SET is_ledger_ai = 0, updated_at = ?',
      [now]
    );

    // 如果指定了AI，则设置该AI为记账AI
    if (aiId) {
      await database.runAsync(
        'UPDATE ai_assistants SET is_ledger_ai = 1, updated_at = ? WHERE id = ?',
        [now, aiId]
      );
    }

    return true;
  }
}

// 单例实例
export const aiAssistantRepository = new AIAssistantRepository();
