import { sharedChatRecord, sharedMoment, chatSharingDependencies } from './helpers/chat-sharing-fixture.mjs';
/** AI 图片与收藏的行为测试：真实 SQLite 所有权、迁移、claim/fence 和工具视觉输入。 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { agentToolSchemaDependencies } from './helpers/agent-tool-schema-dependencies.mjs';
import { SCHEMAS, bootstrapSqlite, createSqliteExecutor, loadSqliteModule } from './helpers/sqlite-bootstrap-fixture.mjs';
import { createCoordinatedSqliteFixture, databaseErrors } from './helpers/coordinated-sqlite-fixture.mjs';
import { loadTypeScriptModule as load } from './helpers/load-typescript-module.mjs';

const domain = load('src/features/stickers/domain/Sticker.ts');
const chatSticker = load('src/features/chat/messages/domain/ChatSticker.ts');
const chatMetadata = load('src/features/chat/messages/domain/chatMessageMetadata.ts', { './ChatSticker': chatSticker,
  ...chatSharingDependencies });
const sharedRecord = sharedChatRecord;
const embeddingDomain = load('src/features/stickers/domain/StickerEmbedding.ts');
const abort = load('src/shared/runtime/abortSignal.ts');
const runState = load('src/platform/agentRuntime/AgentRunState.ts');
const slot = load('src/shared/runtime/RuntimeSlot.ts');
const runtime = load('src/features/stickers/application/StickerRuntime.ts', { '@shared/runtime/RuntimeSlot': slot });
const progressSignals = load('src/features/stickers/application/StickerProcessingSignal.ts', {
  './StickerAnnotationChangedSignal': load('src/features/stickers/application/StickerAnnotationChangedSignal.ts'),
});
const models = load('src/features/stickers/application/StickerSystemModels.ts', {
  './StickerRuntime': runtime,
  './StickerAnnotationPendingSignal': {}, './StickerEmbeddingPendingSignal': {},
  './StickerProcessingSignal': progressSignals,
  './StickerAnnotationChangedSignal': load('src/features/stickers/application/StickerAnnotationChangedSignal.ts'),
  '../domain/StickerSystemConfig': load('src/features/stickers/domain/StickerSystemConfig.ts'),
});
const { SQLiteStickerRepository } = load('src/features/stickers/infrastructure/SQLiteStickerRepository.ts', {
  '@shared/runtime/abortSignal': abort,
  '@platform/persistence': { ...databaseErrors, databaseCoordinator: { openTaskExecutor: () => ({}) } },
  '../domain/Sticker': domain,
});
const processingModule = load('src/features/stickers/infrastructure/SQLiteAIStickerProcessingRepository.ts', {
  '../domain/Sticker': domain,
  './SQLiteStickerRepository': load('src/features/stickers/infrastructure/SQLiteStickerRepository.ts', {
    '@shared/runtime/abortSignal': abort,
    '@platform/persistence': { ...databaseErrors, databaseCoordinator: { openTaskExecutor: () => ({}) } }, '../domain/Sticker': domain,
  }),
});
const { ConversationTurnRepository } = load('src/features/chat/reply/infrastructure/SQLiteConversationTurnRepository.ts', {
  './ChatReplyVersionSql': load('src/features/chat/reply/infrastructure/ChatReplyVersionSql.ts'),
  '@platform/persistence': {}, '../../messages/infrastructure/ChatMessageMutationSql': load('src/features/chat/reply/infrastructure/ChatTurnPresentationSql.ts'),
  '../../messages/infrastructure/SQLiteMessageRepository': {}, '../domain/ConversationTurn': {}, '../../messages/domain': {},
});
const turns = new ConversationTurnRepository();
const { GroupChatRepository } = load('src/features/chat/group/infrastructure/SQLiteGroupChatRepository.ts', {
  '@platform/persistence': {}, '@features/media': {}, '@features/profile': {}, '@features/assistants': {},
});
const groups = new GroupChatRepository();
const { assertImageToolRunCurrent } = load('src/host/composition/agent/assertImageToolRunCurrent.ts', {
  '@platform/agentRuntime': runState,
  '@shared/runtime/abortSignal': abort,
  '@features/chat': { isChatReplyRunCurrentInTransaction: (tx, id) => turns.isRunCurrentInTransaction(tx, id),
    isGroupSpeechTaskRunCurrentInTransaction: (tx, id) => groups.isSpeechTaskRunCurrentInTransaction(tx, id) },
});

function coordinated(db, reads = []) {
  const raw = createSqliteExecutor(db);
  return createCoordinatedSqliteFixture({ ...raw,
    getFirstAsync: (sql, ...args) => { reads.push(sql); return raw.getFirstAsync(sql, ...args); },
    getAllAsync: (sql, ...args) => { reads.push(sql); return raw.getAllAsync(sql, ...args); },
  }).executor;
}
const now = '2026-10-11T00:00:00.000Z';
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
await bootstrapSqlite(createSqliteExecutor(db));
const sqlReads = [];
const executor = coordinated(db, sqlReads);
for (const id of ['ai-one', 'ai-two']) db.prepare(`INSERT INTO ai_assistants (id,agent_id,name,model,created_at,updated_at)
  VALUES (?,?,?,'model',?,?)`).run(id, id, id, now, now);
const asset = { id: 'image-1', storageBackend: 'persistent-media', storageKey: 'catalog/media/image-1.png',
  hashAlgorithm: 'sha256', contentHash: 'a'.repeat(64), mimeType: 'image/png', byteSize: 10,
  width: 120, height: 120, durationMs: null, status: 'ready', createdAt: now, updatedAt: now };
db.prepare(`INSERT INTO media_assets (id,storage_backend,storage_key,hash_algorithm,content_hash,mime_type,byte_size,width,height,status,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(asset.id, asset.storageBackend, asset.storageKey, asset.hashAlgorithm, asset.contentHash, asset.mimeType,
  asset.byteSize, asset.width, asset.height, asset.status, now, now);
const repo = new SQLiteStickerRepository(executor);
const aiRepo = new processingModule.SQLiteAIStickerProcessingRepository(executor);
const noFence = async () => {};
const userSticker = { id: 'user-sticker', ownerAssistantId: null, mediaAssetId: asset.id, groupId: null, name: '用户猫猫',
  description: '摸摸猫', tags: ['安慰'], emotion: '温柔', sourceFileName: 'cat.png', mimeType: 'image/png', width: 120,
  height: 120, isAnimated: false, isFavorite: false, useCount: 0, lastUsedAt: null, annotationStatus: 'ready',
  annotationError: null, semanticRevision: 1, createdAt: now, updatedAt: now };
await executor.withExclusiveTransactionAsync(tx => repo.createStickerInTransaction(tx, userSticker));
await aiRepo.create('ai-one', asset, '自己的猫', null, 'one-sticker', now, noFence);
await aiRepo.create('ai-two', asset, '另一只猫', null, 'two-sticker', now, noFence);
assert.equal((await repo.listStickers()).length, 1, '用户列表不能看到 AI 收藏');
assert.equal(await repo.getStickerById('one-sticker'), null);
assert.equal(await repo.getStickerById('two-sticker', 'ai-one'), null);
assert.deepEqual((await repo.searchStickers({ assistantId: 'ai-one' })).map(s => s.id).sort(), ['one-sticker', 'user-sticker']);
assert.equal(await repo.deleteSticker('one-sticker'), false, '用户删除口不能删除 AI 收藏');
assert.equal(await repo.deleteSticker('two-sticker', 'ai-one'), false, '角色不能删除其他角色的收藏');
assert.equal((await aiRepo.create('ai-one', asset, '重复', null, 'ignored', now, noFence)).reused, true);
await repo.setAutomaticRecognitionEnabled(true, now);
assert.equal(await repo.claimNextAnnotation('user-worker', now), null, 'AI 识别失败项不能进用户自动队列');

let inspect = { mimeType: 'image/png', isAnimated: false, byteSize: 10, width: 120, height: 120 };
let recognitionCalls = 0, embeddingCalls = 0;
let embeddingFailure = true;
let recognize = async () => { recognitionCalls++; return { name: '小猫', description: '给你摸摸头', tags: ['安慰'], emotion: '温柔' }; };
let embed = async () => { embeddingCalls++; if (embeddingFailure) throw new Error('网络断开'); return [[1, 0]]; };
const model = { id: 'embedding', capabilityKind: 'embedding', enabled: true, baseUrl: 'https://example.invalid',
  apiKey: 'test', name: '向量模型', model: 'embed', updatedAt: now };
let generated = 0;
let modelConfigReads = 0;
runtime.configureStickersRuntime({ repository: repo, media: { resolveMediaAsset: async id => ({ asset: { ...asset, id }, localUri: 'file:///cat.png' }),
  releaseMediaAssetCandidates: async () => {} }, auxiliaryModels: { getModelConfigById: async () => { modelConfigReads++; return model; },
    listModelConfigsByRequirement: async () => [model] }, embeddings: { embedTexts: (...args) => embed(...args) },
  generateId: () => `new-${++generated}`, now: () => now,
  aiProcessing: { repository: aiRepo, executionId: 'process-1', recognize: (...args) => recognize(...args), assertCurrent: assertImageToolRunCurrent },
});
await repo.saveStickerSystemConfig({ recognitionModelConfigId: 'ocr', embeddingModelConfigId: 'embedding', updatedAt: now }, now);
const commands = load('src/features/stickers/application/AIStickerCommands.ts', {
  '@shared/runtime/abortSignal': abort, '@platform/device': { inspectLocalImage: async () => inspect },
  '../domain/StickerEmbedding': embeddingDomain, '../domain/Sticker': domain,
  './StickerRuntime': runtime, './StickerSystemModels': models,
});
const context = (assistantId = 'ai-one', source = 'manual') => ({ task: { assistantId, source }, runId: 'run-1', abortSignal: new AbortController().signal });
const actor = context();
await assert.rejects(commands.maintainAISticker({ sticker_id: 'user-sticker', action: 'edit', description: '错' }, actor), /只能维护自己的/);
await assert.rejects(commands.maintainAISticker({ sticker_id: 'two-sticker', action: 'delete' }, actor), domain.StickerNotFoundError);
await repo.deleteSticker('two-sticker', 'ai-two');
const receivedImage = { id: 'chat-attachment', type: 'image', source: 'gallery', fileName: 'chat-cat.png', mediaAssetId: asset.id };
const receivedMessage = { id: 101, sessionId: 'chat', senderType: 'user', isMe: true, status: 'sent', deliveryStatus: null,
  text: '收藏这张猫猫', createdAt: now, metadataJson: JSON.stringify({ kind: 'image', attachments: [receivedImage] }) };
const { AddOwnStickerTool, MaintainOwnStickerTool } = load('src/features/stickers/aiTools/AIStickerLibraryTools.ts', {
  '@features/media': { mediaImageFailure: () => null }, '../domain/Sticker': domain, '../application/AIStickerCommands': commands,
});
const collected = await AddOwnStickerTool.execute({ media_asset_id: chatMetadata.getMessageAttachments(receivedMessage)[0].mediaAssetId }, context('ai-two'));
assert.equal(collected.status, 'success', '聊天图片的媒体 ID 可以直接收藏，不需要 URL 或重新下载');
const added = collected.data;
assert.equal(added.recognition.status, 'succeeded');
assert.equal(added.embedding.status, 'failed');
assert.equal(recognitionCalls, 1);
assert.equal(embeddingCalls, 1, '新增表情只自动触发一次向量化');
const duplicate = await commands.addAISticker({ media_asset_id: asset.id }, context('ai-two'));
assert.equal(duplicate.reused, true);
assert.equal(embeddingCalls, 1, '重复收藏不能变成隐藏重试');
recognitionCalls = 0;
embeddingCalls = 0;
assert.equal((await commands.processAISticker('one-sticker', 'recognize', actor)).status, 'succeeded');
assert.equal((await commands.processAISticker('one-sticker', 'embed', actor)).status, 'failed');
assert.equal(embeddingCalls, 1, '失败不自动重试');
assert.equal((await commands.getStickerVectorState(await repo.getStickerById('one-sticker', 'ai-one'))).error, '网络断开');
assert.equal((await repo.searchStickers({ assistantId: 'ai-one', query: '摸摸', readyOnly: true })).length, 2, '缺向量仍能词面召回');
assert.equal((await repo.listReadyStickersNeedingEmbedding({ modelConfigId: model.id, modelConfigUpdatedAt: now, dimension: null }, 50)).some(s => s.ownerAssistantId), false);
embeddingFailure = false;
await commands.processAISticker('one-sticker', 'embed', actor);
assert.equal((await commands.getStickerVectorState(await repo.getStickerById('one-sticker', 'ai-one'))).status, 'ready');
await commands.maintainAISticker({ sticker_id: 'one-sticker', action: 'edit', description: '发现图中文字是晚安', tags: ['晚安'] }, actor);
assert.equal(embeddingCalls, 2, '改语义不隐式请求模型');
assert.equal((await commands.getStickerVectorState(await repo.getStickerById('one-sticker', 'ai-one'))).status, 'missing_or_stale');
await commands.processAISticker('one-sticker', 'embed', actor);
assert.equal(embeddingCalls, 3, '显式重新向量化一次');
const revision = (await repo.getStickerById('one-sticker', 'ai-one')).semanticRevision;
recognize = async () => { throw new Error('识图服务不可用'); };
await commands.processAISticker('one-sticker', 'recognize', actor);
assert.equal((await repo.getStickerById('one-sticker', 'ai-one')).annotationStatus, 'ready', '重新识别失败保留已有语义');
assert.equal((await repo.getStickerById('one-sticker', 'ai-one')).semanticRevision, revision);
inspect = { ...inspect, isAnimated: true };
await assert.rejects(commands.addAISticker({ media_asset_id: asset.id }, actor), /只能导入静态/);
inspect = { ...inspect, isAnimated: false };

// 取消立即撤销 claim；即使模型不响应 abort，迟到结果也不能保存。
let release, started;
const began = new Promise(resolve => { started = resolve; });
embed = async () => { embeddingCalls++; started(); return new Promise(resolve => { release = resolve; }); };
await commands.maintainAISticker({ sticker_id: 'one-sticker', action: 'edit', description: '又修正一次' }, actor);
const controller = new AbortController();
const processing = commands.processAISticker('one-sticker', 'embed', { ...actor, abortSignal: controller.signal });
await began;
controller.abort(new Error('用户发来新消息'));
await executor.getFirstAsync('SELECT 1');
assert.equal((await aiRepo.getTask('one-sticker')).status, 'cancelled');
release([[0, 1]]);
await assert.rejects(processing, /用户发来新消息/);
assert.equal((await commands.getStickerVectorState(await repo.getStickerById('one-sticker', 'ai-one'))).status, 'missing_or_stale');

// T1 已提交但 JS 取消尚未到达时，持久回合 fence 仍拒绝副作用。
db.exec(`INSERT INTO chat_conversations (id,kind) VALUES ('chat','direct');
  INSERT INTO conversation_turn_runs (run_id,session_id,kind,reply_cursor_at_claim,input_high_watermark,revision_at_claim,status,created_at)
  VALUES ('run-1','chat','user_reply',0,1,1,'active','${now}');
  INSERT INTO conversation_turn_state (session_id,revision,active_run_id,updated_at) VALUES ('chat',1,'run-1','${now}');`);
const chatActor = context('ai-one', 'chat');
assert.equal(await turns.isRunCurrentInTransaction(createSqliteExecutor(db), 'run-1'), true);
await turns.supersedeActiveRunInTransaction(createSqliteExecutor(db), 'chat', now);
await assert.rejects(commands.maintainAISticker({ sticker_id: 'one-sticker', action: 'delete' }, chatActor), error => error.cause.code === 'SUPERSEDED');
db.exec(`INSERT INTO chat_conversations VALUES ('image-group','group');
  INSERT INTO group_chats(id,name,created_at,updated_at) VALUES ('image-group','群','${now}','${now}');
  INSERT INTO group_speech_plans(id,group_id,status,created_at,updated_at) VALUES ('image-plan','image-group','running','${now}','${now}');
  INSERT INTO group_speech_tasks(id,plan_id,group_id,ai_assistant_id,agent_id,sequence_order,source,status,created_at,updated_at)
    VALUES ('image-task','image-plan','image-group','ai-one','ai-one',1,'admin','running','${now}','${now}');`);
const groupActor = { ...context('ai-one', 'chat'), runId: 'image-task', task: { assistantId: 'ai-one', source: 'chat', type: 'group_chat_reply' } };
await assertImageToolRunCurrent(createSqliteExecutor(db), groupActor);
db.prepare("UPDATE group_speech_plans SET status='terminated' WHERE id='image-plan'").run();
await assert.rejects(commands.maintainAISticker({ sticker_id: 'one-sticker', action: 'delete' }, groupActor), error => error.cause.code === 'SUPERSEDED');
assert.notEqual(await repo.getStickerById('one-sticker', 'ai-one'), null);
const claim = await aiRepo.claim('ai-one', 'one-sticker', 'embed', 'before-edit', 'process-1', now, noFence);
await repo.updateStickerMetadata('one-sticker', { description: '等待网络期间修改了语义' }, now, 'ai-one');
assert.equal(await aiRepo.finish(claim, { embedding: { stickerId: 'one-sticker', modelConfigId: model.id, modelConfigUpdatedAt: now,
  semanticRevision: claim.sticker.semanticRevision, dimension: 2, vector: [1,0], createdAt: now, updatedAt: now } }, now, noFence), false);
assert.equal((await aiRepo.getTask('one-sticker')).status, 'cancelled');

const activeClaim = await aiRepo.claim('ai-one', 'one-sticker', 'embed', 'active', 'process-1', now, noFence);
assert.equal(await aiRepo.claim('ai-one', 'one-sticker', 'embed', 'duplicate', 'process-1', now, noFence), null);
const recoveredClaim = await aiRepo.claim('ai-one', 'one-sticker', 'embed', 'explicit-recovery', 'process-2', now, noFence);
assert.notEqual(recoveredClaim, null, '新执行实例只在显式调用时接管遗留任务');
assert.equal(await aiRepo.finish(activeClaim, { error: '旧实例的迟到失败' }, now, noFence), false);
await aiRepo.cancel(recoveredClaim, now);

// 容量按收藏所有者计算；自己的库满了仍可复用已有收藏，不挤占用户库。
const insertAsset = db.prepare(`INSERT INTO media_assets
  (id,storage_backend,storage_key,hash_algorithm,content_hash,mime_type,byte_size,status,created_at,updated_at)
  VALUES (?,'persistent-media',?,'sha256',?,'image/png',1,'ready',?,?)`);
const insertOwned = db.prepare(`INSERT INTO stickers (id,media_asset_id,owner_assistant_id,name,mime_type,created_at,updated_at)
  VALUES (?,?,'ai-one','容量测试','image/png',?,?)`);
for (let i = 1; i <= 499; i++) {
  insertAsset.run(`capacity-${i}`, `catalog/media/capacity-${i}.png`, String(i).padStart(64, '0'), now, now);
  insertOwned.run(`capacity-sticker-${i}`, `capacity-${i}`, now, now);
}
insertAsset.run('spare', 'catalog/media/spare.png', 'f'.repeat(64), now, now);
await assert.rejects(aiRepo.create('ai-one', { ...asset, id: 'spare' }, '满库', null, 'overflow', now, noFence), domain.StickerLibraryFullError);
const inputSchema = load('src/shared/aiTools/AgentToolInputSchema.ts', agentToolSchemaDependencies);
const { AgentToolExecutor } = load('src/platform/agentRuntime/AgentToolExecutor.ts', {
  '@shared/aiTools': inputSchema, './AgentRunState': runState,
});
const collectionTools = [AddOwnStickerTool, MaintainOwnStickerTool];
const toolExecutor = new AgentToolExecutor({ get: name => {
  const tool = collectionTools.find(item => item.name === name);
  return { descriptor: { name, inputSchema: tool.definition.parameters }, execute: tool.execute };
} });
const invokeCollection = (tool, input, ctx = actor) => {
  const task = { ...ctx.task, allowedToolNames: collectionTools.map(item => item.name) };
  return toolExecutor.execute(toolExecutor.prepare({ id: 'collection-call', name: tool.name, arguments: JSON.stringify(input) }, task), { ...ctx, task });
};
const collectionLogs = [], oldConsoleError = console.error;
console.error = (...args) => collectionLogs.push(args);
try {
  const full = await invokeCollection(AddOwnStickerTool, { media_asset_id: 'spare' });
  assert.equal(full.status, 'error');
  assert.equal(full.modelContent, new domain.StickerLibraryFullError(500).message);
  assert.equal(collectionLogs.length, 0, '满库业务拒绝不触发开发版红色日志');
  assert.equal(await repo.getStickerByMediaAssetId('spare'), null);
  const getSticker = repo.getStickerById.bind(repo);
  repo.getStickerById = async (id, owner) => {
    const snapshot = await getSticker(id, owner);
    if (id === added.stickerId) await repo.deleteSticker(id, 'ai-two');
    return snapshot;
  };
  try {
    const stale = await invokeCollection(MaintainOwnStickerTool,
      { sticker_id: added.stickerId, action: 'edit', description: '不能修改已删除的收藏' }, context('ai-two'));
    assert.equal(stale.status, 'error');
    assert.equal(stale.modelContent, new domain.StickerNotFoundError(added.stickerId).message);
    assert.equal(collectionLogs.length, 0, '读取后删除的竞态也返回明确业务原因');
  } finally { repo.getStickerById = getSticker; }
  await assert.rejects(invokeCollection(MaintainOwnStickerTool, { sticker_id: 'one-sticker', action: 'delete' }, chatActor), error => error.code === 'SUPERSEDED');
  assert.equal(collectionLogs.length, 0, 'signal 尚未取消时持久 fence 仍终止旧 run');
  db.exec("CREATE TRIGGER reject_tool_sticker_update BEFORE UPDATE ON stickers BEGIN SELECT RAISE(ABORT,'sticker storage failure'); END;");
  try {
    const failed = await invokeCollection(MaintainOwnStickerTool, { sticker_id: 'one-sticker', action: 'edit', description: '不能保存' });
    assert.equal(failed.code, 'TOOL_EXECUTION_FAILED');
    assert.equal(collectionLogs.length, 1);
    assert.ok(collectionLogs[0][1].error instanceof databaseErrors.CoordinatedDatabaseError);
  } finally { db.exec('DROP TRIGGER reject_tool_sticker_update'); }
} finally { console.error = oldConsoleError; }
assert.equal((await aiRepo.create('ai-one', asset, '重复', null, 'reused-full', now, noFence)).reused, true);
await executor.withExclusiveTransactionAsync(tx => repo.createStickerInTransaction(tx, { ...userSticker, id: 'user-spare', mediaAssetId: 'spare' }));
assert.equal((await repo.listStickers()).length, 2, 'AI 满库不能占用用户配额');

// 浏览和选择时带素材 ID 与缺向量提醒；不把本地路径或文件内容交给模型。
let searchResults = [], pageStickers = [userSticker];
const stickerTools = load('src/features/stickers/aiTools/StickerAgentTools.ts', {
  '@shared/runtime/abortSignal': abort, '@features/media': { mediaImageFailure: () => null },
  '@shared/aiTools': load('src/shared/aiTools/ToolCompletionIntent.ts'),
  '../application/StickerRuntime': runtime, '../application/AIStickerCommands': commands,
  '../application/StickerQueries': { getStickerById: id => repo.getStickerById(id, 'ai-one'),
    listStickersInGroupForAI: async () => ({ stickers: pageStickers, nextCursor: null }) },
  '../application/StickerSearch': { searchStickersForAI: async () => searchResults },
  '../domain/StickerSearch': { encodeStickerGroupPageCursor: cursor => cursor },
  '../domain/Sticker': domain,
});
const groupPage = await stickerTools.listStickersInGroup({ group_id: 'group' }, actor);
assert.equal(groupPage.data.stickers[0].mediaAssetId, asset.id);
assert.equal(groupPage.data.stickers[0].vector.status, 'missing_or_stale');
assert.match(groupPage.modelContent, /词面|标签/);
assert.equal(Object.hasOwn(groupPage.data.stickers[0], 'uri'), false);
assert.equal(Object.hasOwn(groupPage.data.stickers[0], 'base64'), false);
const selected = await stickerTools.selectSticker({ sticker_id: userSticker.id, on_success: 'continue' }, actor);
assert.equal(JSON.parse(selected.modelContent).sticker.vector.status, 'missing_or_stale');

// 满页结果的读取成本不随张数增长，且有效、缺失、过期向量与失败原因仍各自归属正确。
await executor.withExclusiveTransactionAsync(async tx => {
  for (let i = 1; i <= 47; i++) await repo.createStickerInTransaction(tx,
    { ...userSticker, id: `batch-user-${i}`, mediaAssetId: `capacity-${i}` });
});
const ownSticker = await repo.getStickerById('one-sticker', 'ai-one');
const failedClaim = await aiRepo.claim('ai-one', ownSticker.id, 'embed', 'batch-failure', 'process-1', now, noFence);
await aiRepo.finish(failedClaim, { error: '向量服务不可用' }, now, noFence);
const spareSticker = await repo.getStickerById('user-spare');
db.prepare(`INSERT INTO sticker_embeddings
  (sticker_id,model_config_id,model_config_updated_at,semantic_revision,dimension,vector_json,created_at,updated_at)
  VALUES (?,?,?,?,2,'[1,0]',?,?)`).run(spareSticker.id, model.id, now, spareSticker.semanticRevision, now, now);
pageStickers = await repo.listStickers({ limit: 50 });
searchResults = [ownSticker, ...pageStickers];
assert.equal(searchResults.length, 50);
const embeddingsBeforeSearch = embeddingCalls;
sqlReads.length = 0;
modelConfigReads = 0;
const searched = await stickerTools.searchStickers({ limit: 50 }, actor);
assert.deepEqual(searched.data.stickers.map(s => s.stickerId), searchResults.map(s => s.id), '保留搜索顺序与发送 ID');
assert.equal(JSON.parse(searched.modelContent).stickers[0].mediaAssetId, ownSticker.mediaAssetId);
assert.equal(searched.data.stickers.find(s => s.stickerId === spareSticker.id).vector.status, 'ready');
assert.equal(searched.data.stickers.find(s => s.stickerId === userSticker.id).vector.status, 'missing_or_stale');
assert.equal(searched.data.stickers[0].vector.status, 'missing_or_stale', '旧语义向量不能被当成有效向量');
assert.equal(searched.data.stickers[0].vector.error, '向量服务不可用');
assert.equal(searched.data.stickers.find(s => s.stickerId === userSticker.id).vector.error, null);
assert.ok(sqlReads.length <= 3, `50 张结果的状态整理不能逐张查库，实际读取 ${sqlReads.length} 次`);
assert.equal(modelConfigReads, 1, '同批状态使用同一模型配置');
assert.equal(embeddingCalls, embeddingsBeforeSearch, '状态整理不能请求向量模型');
sqlReads.length = 0;
modelConfigReads = 0;
const batchPage = await stickerTools.listStickersInGroup({ group_id: 'group', limit: 50 }, actor);
assert.deepEqual(batchPage.data.stickers.map(s => s.stickerId), pageStickers.map(s => s.id));
assert.equal(batchPage.data.stickers.find(s => s.stickerId === spareSticker.id).vector.status, 'ready');
assert.ok(sqlReads.length <= 2, '用户分组列表不能逐张查库或读取 AI 私有处理状态');
assert.equal(modelConfigReads, 1);
await repo.saveStickerSystemConfig({ recognitionModelConfigId: 'ocr', embeddingModelConfigId: null, updatedAt: now }, now);
assert.ok((await commands.getStickerVectorStates(searchResults)).every(state => state.status === 'missing_or_stale'), '取消模型配置后不能沿用旧状态');
await repo.saveStickerSystemConfig({ recognitionModelConfigId: 'ocr', embeddingModelConfigId: model.id, updatedAt: now }, now);
searchResults = [];
sqlReads.length = 0;
modelConfigReads = 0;
assert.equal((await stickerTools.searchStickers({}, actor)).data.stickers.length, 0);
assert.equal(sqlReads.length, 0, '空结果无需读取向量或配置');
assert.equal(modelConfigReads, 0);
assert.deepEqual(await aiRepo.getTasks([]), new Map());

// 媒体生命周期枚举下载引用，删除角色才撤销下载记录；其他库的同图引用仍保留。
const { SQLiteMediaAssetRepository } = load('src/features/media/infrastructure/SQLiteMediaAssetRepository.ts');
const mediaRepo = new SQLiteMediaAssetRepository(executor);
db.prepare('INSERT INTO ai_downloaded_images VALUES (?,?,?,?,?,?)').run('download','ai-one',asset.id,'https://example.com/cat.png','cat.png',now);
assert.ok((await mediaRepo.auditDatabase()).references.some(r => r.kind === 'ai_download'));
assert.ok((await mediaRepo.listAssistantMediaAssetIds('ai-one', createSqliteExecutor(db))).includes(asset.id));
db.prepare("DELETE FROM ai_assistants WHERE id='ai-one'").run();
assert.equal(await repo.getStickerById('one-sticker', 'ai-one'), null);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_downloaded_images').get().n, 0);
assert.equal((await executor.withExclusiveTransactionAsync(tx => mediaRepo.releaseUnreferencedAssetsInTransaction(tx, [asset.id]))).length, 0);
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
db.close();

// 真正的 119 -> 当前迁移保留用户语义及向量，去掉原来全库唯一约束。
const legacy = new DatabaseSync(':memory:');
legacy.exec('PRAGMA foreign_keys=ON');
for (const [key, sql] of Object.entries(SCHEMAS)) {
  if (['stickers', 'aiStickerTasks', 'aiDownloadedImages'].includes(key)) continue;
  legacy.exec(sql);
}
// 119 的真实结构没有后来新增的设置列，不能把当前 schema 冒充旧库。
legacy.exec('ALTER TABLE ai_assistants DROP COLUMN show_token_usage; ALTER TABLE ai_assistants DROP COLUMN nickname; ALTER TABLE ai_assistants DROP COLUMN show_action_steps; ALTER TABLE ai_assistants DROP COLUMN streaming_reply;');
legacy.exec('ALTER TABLE chat_summary_request_settings DROP COLUMN model_config_id; ALTER TABLE chat_summary_request_settings DROP COLUMN group_trigger_count; ALTER TABLE chat_summary_request_settings DROP COLUMN primary_limit;');
legacy.exec('ALTER TABLE group_chat_members DROP COLUMN muted; ALTER TABLE group_chat_members DROP COLUMN joined_during_plan_id;');
for (const table of ['auxiliary_model_configs', 'ai_assistants', 'group_chat_admin_configs']) legacy.exec(`ALTER TABLE ${table} DROP COLUMN service_config_id;`);
const schema = loadSqliteModule('stickerSchema');
const oldStickers = schema.STICKERS_SCHEMA.replace('media_asset_id TEXT NOT NULL CHECK', 'media_asset_id TEXT NOT NULL UNIQUE CHECK')
  .replace('    owner_assistant_id TEXT,\n', '').replace(',\n    FOREIGN KEY (owner_assistant_id) REFERENCES ai_assistants(id) ON DELETE CASCADE', '');
legacy.exec(oldStickers);
legacy.exec(`INSERT INTO media_assets (id,storage_backend,storage_key,hash_algorithm,content_hash,mime_type,byte_size,status,created_at,updated_at)
  VALUES ('old','persistent-media','catalog/media/old.png','sha256','${'b'.repeat(64)}','image/png',1,'ready','${now}','${now}');
  INSERT INTO stickers (id,media_asset_id,name,description,tags_json,mime_type,annotation_status,semantic_revision,created_at,updated_at)
  VALUES ('old-sticker','old','旧名称','旧描述','["旧标签"]','image/png','ready',7,'${now}','${now}');
  INSERT INTO sticker_embeddings VALUES ('old-sticker','embedding','${now}',7,2,'[1,0]','${now}','${now}');
  ALTER TABLE raven_cat_ai_schedules DROP COLUMN system_calendar;
  PRAGMA user_version=119;`);
await bootstrapSqlite(createSqliteExecutor(legacy));
const old = legacy.prepare('SELECT * FROM stickers').get();
assert.equal(old.owner_assistant_id, null);
assert.equal(old.description, '旧描述');
assert.equal(old.semantic_revision, 7);
assert.equal(legacy.prepare('SELECT vector_json FROM sticker_embeddings').get().vector_json, '[1,0]');
assert.deepEqual(legacy.prepare('PRAGMA foreign_key_check').all(), []);
assert.throws(() => legacy.prepare(`INSERT INTO stickers (id,media_asset_id,name,mime_type,created_at,updated_at)
  VALUES ('duplicate','old','重复','image/png','${now}','${now}')`).run(), /UNIQUE/);
legacy.close();

// 私有下载查询复用真实表与 Repository：只查自己的记录，按媒体身份去重并分页。
const downloadsDb = new DatabaseSync(':memory:');
downloadsDb.exec('PRAGMA foreign_keys=ON');
await bootstrapSqlite(createSqliteExecutor(downloadsDb));
const downloadsExecutor = coordinated(downloadsDb);
const { SQLiteAIDownloadedImageRepository } = load('src/features/media/infrastructure/SQLiteAIDownloadedImageRepository.ts', {
  '@platform/persistence': { databaseCoordinator: { openTaskExecutor: () => downloadsExecutor } },
  '@platform/device': { createRandomUUID: () => `download-${++generated}` },
});
const downloads = new SQLiteAIDownloadedImageRepository();
for (const id of ['ai-one', 'ai-two']) downloadsDb.prepare(`INSERT INTO ai_assistants (id,agent_id,name,model,created_at,updated_at)
  VALUES (?,?,?,'model',?,?)`).run(id, id, id, now, now);
for (const [index, id] of [asset.id, 'snow-1', 'snow-2', 'snow-3', 'other-image'].entries()) downloadsDb.prepare(`INSERT INTO media_assets
  (id,storage_backend,storage_key,hash_algorithm,content_hash,mime_type,byte_size,status,created_at,updated_at)
  VALUES (?,'persistent-media',?,'sha256',?,'image/png',1,'ready',?,?)`).run(id, `catalog/${id}.png`, index.toString(16).padStart(64, '0'), now, now);
for (const [id, owner, mediaId, fileName, createdAt] of [
  ['snow-a', 'ai-one', 'snow-1', '雪山日出.png', now],
  ['snow-b', 'ai-one', 'snow-2', '雪山日落.png', now],
  ['snow-c', 'ai-one', 'snow-3', '雪山星空.PNG', now],
  ['snow-d', 'ai-one', 'snow-1', '雪山新名字.png', '2026-10-12T00:00:00.000Z'],
  ['other', 'ai-two', 'other-image', '雪山私藏.png', now],
  ['literal', 'ai-one', asset.id, '100%_Cat.png', now],
]) downloadsDb.prepare('INSERT INTO ai_downloaded_images VALUES (?,?,?,?,?,?)')
  .run(id, owner, mediaId, `https://example.com/${id}.png`, fileName, createdAt);
assert.equal((await downloads.query('ai-one', { mediaAssetId: 'snow-1' })).images[0].fileName, '雪山新名字.png');
assert.equal((await downloads.query('ai-one', { mediaAssetId: 'snow-1' })).images.length, 1);
assert.deepEqual(await downloads.query('ai-one', { mediaAssetId: 'other-image' }), { images: [], nextOffset: null });
const firstDownloads = await downloads.query('ai-one', { keyword: '雪山', limit: 2, offset: 0 });
assert.deepEqual(firstDownloads.images.map(image => image.mediaAssetId), ['snow-1', 'snow-3']);
assert.equal(firstDownloads.nextOffset, 2);
const lastDownloads = await downloads.query('ai-one', { keyword: '雪山', limit: 2, offset: firstDownloads.nextOffset });
assert.deepEqual(lastDownloads.images.map(image => image.mediaAssetId), ['snow-2']);
assert.equal(lastDownloads.nextOffset, null);
assert.equal((await downloads.query('ai-one', { keyword: '日出', limit: 20, offset: 0 })).images[0].mediaAssetId, 'snow-1', '旧下载时取的名字仍可找回同一媒体');
for (const keyword of ['cat', '%_', '100%']) {
  assert.deepEqual((await downloads.query('ai-one', { keyword, limit: 20, offset: 0 })).images.map(image => image.mediaAssetId), [asset.id]);
}
assert.deepEqual((await downloads.query('ai-one', { keyword: "' OR 1=1 --", limit: 20, offset: 0 })).images, []);

// 工具结果中的原生图片在完整工具批次之后送进模型，而辅助视觉只返回文字。
const imageRuntime = load('src/features/media/application/AIImageRuntime.ts', { '@shared/runtime/RuntimeSlot': slot });
let visionMode = 'direct_vision', missing = false, downloadedCommits = 0, tempDeletes = 0;
class MissingImage extends Error {}
const imageTools = load('src/features/media/application/AIImageTools.ts', {
  'expo-file-system': { File: class { delete() { tempDeletes++; } } },
  '@platform/device': { inspectLocalImage: async () => inspect },
  '@platform/web': { downloadWebImage: async () => ({ ok: true, data: { uri: 'file:///temp', fileName: 'cat.png', url: 'https://example.com/cat.png' } }) },
  '@shared/runtime/abortSignal': abort,
  './AIImageRuntime': imageRuntime,
  './MediaImageToolResult': { mediaImageFailure: error => error instanceof MissingImage ? { status: 'error', code: 'IMAGE_MISSING', modelContent: '找不到图片，请重新发送', retryable: false } : null },
  './MediaAssetRuntime': { resolveMediaAsset: async () => { if (missing) throw new MissingImage(); return { localUri: 'file:///cat.png' }; },
    createMediaAssetWithReference: async (_, commit) => {
      await downloadsExecutor.withExclusiveTransactionAsync(transaction => commit({ transaction, asset }));
      downloadedCommits++;
      return { asset };
    } },
  './MediaAssetBacking': { MEDIA_ASSET_STORAGE_BACKEND: { persistentMedia: 'persistent-media' } },
});
imageRuntime.configureAIImageRuntime({ downloads, assertCurrent: noFence,
  resolveAvatar: async () => ({ status: 'found', mediaAssetId: asset.id, label: '用户头像' }),
  view: async () => ({ route: visionMode, ocrSucceeded: visionMode === 'ocr' ? true : null,
    parts: visionMode === 'direct_vision' ? [{ type: 'text', text: '原图已提供' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }]
      : [{ type: 'text', text: '辅助视觉转述' }] }),
});
const viewed = await imageTools.ViewImageTool.execute({ target: 'user_avatar' }, actor);
assert.equal(viewed.modelImages[0].url, 'data:image/png;base64,AAA');
visionMode = 'ocr';
const ocr = await imageTools.ViewImageTool.execute({ target: 'self_avatar' }, actor);
assert.deepEqual(ocr.modelImages, []);
missing = true;
assert.equal((await imageTools.ViewImageTool.execute({ target: 'media', media_asset_id: 'missing' }, actor)).code, 'IMAGE_MISSING');
missing = false;
const downloadedImage = await imageTools.DownloadImageTool.execute({ url: 'https://example.com/cat.png' }, actor);
assert.equal(downloadedCommits, 1);
assert.equal(tempDeletes, 1, '持久资产提交后回收暂存文件');
const foundDownload = await imageTools.QueryDownloadedImagesTool.execute({ media_asset_id: downloadedImage.data.mediaAssetId }, actor);
assert.equal(foundDownload.data.images.length, 1);
assert.equal(foundDownload.data.images[0].mediaAssetId, JSON.parse(downloadedImage.modelContent).mediaAssetId);
const foundByName = await imageTools.QueryDownloadedImagesTool.execute({ keyword: 'cat' }, actor);
assert.equal(foundByName.data.images[0].mediaAssetId, downloadedImage.data.mediaAssetId);
assert.equal(foundByName.data.nextOffset, null);
assert.equal(foundByName.modelContent, JSON.stringify(foundByName.data));
assert.deepEqual((await imageTools.QueryDownloadedImagesTool.execute({ media_asset_id: 'snow-1' }, context('ai-two'))).data.images, []);
const { matchesAgentToolInputSchema } = load('src/shared/aiTools/AgentToolInputSchema.ts', agentToolSchemaDependencies);
const querySchema = imageTools.QueryDownloadedImagesTool.definition.parameters;
for (const input of [{ media_asset_id: asset.id }, { keyword: '雪山' }, { keyword: '雪山', offset: 2, limit: 1 }]) {
  assert.equal(matchesAgentToolInputSchema(input, querySchema), true);
}
for (const input of [{}, { keyword: '' }, { media_asset_id: asset.id, keyword: '雪山' }, { keyword: '雪山', limit: 51 },
  { keyword: '雪山', offset: -1 }, { keyword: '雪山', date: '2026-10-11' }]) {
  assert.equal(matchesAgentToolInputSchema(input, querySchema), false, '参数互斥和分页限制由统一 schema 边界裁决');
}
const abortedQuery = new AbortController();
abortedQuery.abort(new Error('查询已取消'));
await assert.rejects(imageTools.QueryDownloadedImagesTool.execute({ keyword: '雪山' }, { ...actor, abortSignal: abortedQuery.signal }), /查询已取消/);

// 发送复用现有素材，工具不写消息、不复制文件；文件错误与取消交给既有边界。
const resolverErrors = load('src/features/media/application/MediaAssetResolver.ts', {
  './MediaAssetBacking': { MediaAssetBackingNotFoundError: class extends Error {} },
});
const imageFailure = load('src/features/media/application/MediaImageToolResult.ts', {
  './MediaAssetResolver': resolverErrors, '@platform/device': { ImageFileReadError: class extends Error {} },
});
let resolveForSend = async () => ({ asset, localUri: 'file:///cat.png' });
const { SendImageTool } = load('src/features/chat/reply/agent/SendImageTool.ts', {
  '@features/media': { ...imageFailure, resolveMediaAsset: id => resolveForSend(id) },
  '@shared/aiTools': load('src/shared/aiTools/ToolCompletionIntent.ts'), '@shared/runtime/abortSignal': abort,
});
const sendContext = { ...actor, toolCallId: 'send-image' };
const sendInput = { media_asset_id: downloadedImage.data.mediaAssetId, file_name: 'cat.png', on_success: 'finish' };
const sentImage = await SendImageTool.execute(sendInput, sendContext);
assert.equal(sentImage.status, 'success');
assert.equal(sentImage.data.attachment.mediaAssetId, downloadedImage.data.mediaAssetId);
assert.equal(sentImage.data.attachment.fileName, 'cat.png');
assert.equal(sentImage.data.attachment.type, 'image');
assert.equal(sentImage.data.attachment.localUri, undefined);
assert.deepEqual(sentImage.metadata, { fulfillsUserVisibleOutput: true, completionIntent: 'finish' });
assert.equal(downloadedCommits, 1, '发送已有素材不会重复下载或创建素材');
const sendSchema = SendImageTool.definition.parameters;
assert.equal(matchesAgentToolInputSchema(sendInput, sendSchema), true);
for (const input of [{ media_asset_id: asset.id }, { media_asset_id: '', on_success: 'finish' },
  { url: 'https://example.com/cat.png', on_success: 'finish' }, { ...sendInput, on_success: 'other' }]) {
  assert.equal(matchesAgentToolInputSchema(input, sendSchema), false);
}
resolveForSend = async () => ({ asset: { ...asset, mimeType: 'audio/mpeg' } });
assert.equal((await SendImageTool.execute(sendInput, sendContext)).code, 'IMAGE_REQUIRED');
for (const [ErrorType, code] of [[resolverErrors.MediaAssetNotFoundError, 'IMAGE_NOT_FOUND'],
  [resolverErrors.MediaAssetMissingError, 'IMAGE_MISSING']]) {
  resolveForSend = async () => { throw new ErrorType(asset.id); };
  assert.equal((await SendImageTool.execute(sendInput, sendContext)).code, code);
}
resolveForSend = async () => { throw new Error('数据库异常'); };
await assert.rejects(SendImageTool.execute(sendInput, sendContext), /数据库异常/, '内部契约失败不能静默转为图片错误');
const sendAbort = new AbortController();
resolveForSend = async () => { sendAbort.abort(new Error('发送已取消')); return { asset }; };
await assert.rejects(SendImageTool.execute(sendInput, { ...sendContext, abortSignal: sendAbort.signal }), /发送已取消/);
resolveForSend = async () => { throw new Error('取消后不应读取素材'); };
await assert.rejects(SendImageTool.execute(sendInput, { ...sendContext, abortSignal: sendAbort.signal }), /发送已取消/);
downloadsDb.close();
const modelGateway = load('src/platform/agentRuntime/BaseAIClientAgentModelGateway.ts', {
  '@platform/ai': {}, '@shared/diagnostics/TurnTimelineLog': {},
});
const history = [
  { role: 'assistant', content: '', toolCalls: [{ id: 'image', name: 'view_image', arguments: '{}' }, { id: 'other', name: 'read', arguments: '{}' }] },
  { role: 'tool', toolCallId: 'image', name: 'view_image', content: viewed.modelContent, images: viewed.modelImages },
  { role: 'tool', toolCallId: 'other', name: 'read', content: '第二个结果' },
  { role: 'assistant', content: '看过了', toolCalls: [] },
];
const messages = modelGateway.buildAgentModelMessages([], history);
assert.deepEqual(messages.map(m => m.role), ['assistant', 'tool', 'tool', 'user', 'assistant']);
assert.equal(messages[3].content.find(p => p.type === 'image_url').image_url.url, viewed.modelImages[0].url);
assert.equal(history.length, 4, '模型适配不改变真实 Chat 历史');

// 通用看图复用角色视觉选择，辅助模型获得同一取消信号，失败明确标记未看到原图。
let selection = { status: 'unconfigured' }, visionOptions;
let respond = async () => ({ success: true, text: '图中文字是晚安' });
let readVisionImage = async () => ({ base64: 'AAA', mimeType: 'image/png' });
let readOCRPrompt = async () => '图片任务说明';
let assembleOCRPrompt = async () => ({ systemPrompt: '看图' });
let visionRequests = 0;
const resolver = load('src/features/chat/reply/application/ResolveChatImageModelInput.ts', {
  '@platform/ai': { getErrorDisplayInfo: load('src/platform/ai/errorMapping.ts').getErrorDisplayInfo,
    createAIClient: () => ({ chat: async (_, options) => {
    visionRequests++; visionOptions = options; return respond(options);
  } }) },
  '@shared/runtime/abortSignal': abort,
  './ReplyTaskPromptBlocks': { buildVisionOCRPromptBlocks: () => [] },
  './ChatReplyRuntimeDependencies': { getChatReplyRuntimeDependencies: () => ({
    media: { readVisionImage: input => readVisionImage(input) }, vision: { resolveOCRModel: async () => selection },
    prompt: { assembleStandalone: input => assembleOCRPrompt(input), resolveVisionOCRPrompt: input => readOCRPrompt(input) },
  }) },
});
const visionInput = { assistantId: 'ai-two', imageUri: 'file:///cat.png', mimeType: 'image/png', contextText: '查看图片' };
assert.equal((await resolver.resolveChatImageModelInput(visionInput)).parts[1].type, 'image_url');
selection = { status: 'active', model: { modelConfigId: 'vision', model: 'vision', baseURL: 'https://example.invalid' } };
const visionController = new AbortController();
const auxiliary = await resolver.resolveChatImageModelInput({ ...visionInput, signal: visionController.signal });
assert.equal(auxiliary.route, 'ocr');
assert.equal(auxiliary.ocrSucceeded, true);
assert.ok(auxiliary.parts.every(p => p.type === 'text'));
assert.equal(visionOptions.signal, visionController.signal);
assert.equal(visionOptions.allowImageContentFallback, false);
respond = async () => ({ success: false, text: '', error: '识图请求失败' });
assert.equal((await resolver.resolveChatImageModelInput(visionInput)).ocrSucceeded, false);
respond = async () => { visionController.abort(new Error('用户发来新消息')); throw new Error('模型取消'); };
await assert.rejects(resolver.resolveChatImageModelInput({ ...visionInput, signal: visionController.signal }), /用户发来新消息/);

// 文件与提示词读取不能原生取消；返回后必须停止，不能再发起下一阶段网络请求。
const preparationStages = [
  [() => readVisionImage, value => { readVisionImage = value; }],
  [() => readOCRPrompt, value => { readOCRPrompt = value; }],
  [() => assembleOCRPrompt, value => { assembleOCRPrompt = value; }],
];
for (const [getStage, setStage] of preparationStages) {
  const original = getStage();
  const controller = new AbortController();
  const reason = new Error('图片预处理期间取消');
  const before = visionRequests;
  setStage(async (...args) => { controller.abort(reason); return original(...args); });
  await assert.rejects(resolver.resolveChatImageModelInput({ ...visionInput, signal: controller.signal }), error => error === reason);
  assert.equal(visionRequests, before, '预处理返回后观察取消，不发起 OCR 请求');
  setStage(original);
}
for (const response of [{ success: true, text: '迟到的识别' }, { success: false, text: '', error: '请求取消' }]) {
  const controller = new AbortController();
  const reason = new Error('OCR 请求期间取消');
  respond = async () => { controller.abort(reason); return response; };
  await assert.rejects(resolver.resolveChatImageModelInput({ ...visionInput, signal: controller.signal }), error => error === reason,
    '取消不能被成功结果或失败说明吞掉');
}

// 有其他有效向量时，识别失败的自己收藏也必须进入词面候选排名。
const failedSticker = { ...userSticker, id: 'failed', ownerAssistantId: 'ai-two', annotationStatus: 'failed', name: '晚安' };
const search = load('src/features/stickers/application/StickerSearch.ts', {
  '../domain/StickerEmbedding': embeddingDomain,
  '../domain/StickerSearch': load('src/features/stickers/domain/StickerSearch.ts'),
  './StickerSystemModels': { resolveStickerEmbeddingModel: async () => model },
  '@shared/runtime/abortSignal': abort,
  './StickerRuntime': { getStickersRuntimeDependencies: () => ({
    embeddings: { embedTexts: async () => [[-1, 0]] }, repository: {
      searchStickers: async () => [failedSticker], listReadyStickersForSemanticSearch: async () => [userSticker],
      listStickerEmbeddingsByStickerIds: async () => [{ stickerId: userSticker.id, modelConfigId: model.id,
        modelConfigUpdatedAt: model.updatedAt, semanticRevision: userSticker.semanticRevision, dimension: 2, vector: [1,0] }],
    },
  }) },
});
assert.equal((await search.searchStickersForAI({ assistantId: 'ai-two', query: '晚安', limit: 1 }))[0].id, 'failed');

// 历史模型原文保留图片身份；预览文字不暴露 ID，旧 URI 附件不伪造媒体身份。
const { projectChatContextMessage } = load('src/features/chat/summary/domain/ChatContext.ts', {
  '../../messages/domain/chatMessageMetadata': chatMetadata, '../../messages/domain/ChatSticker': chatSticker,
  '../../messages/domain/SharedChatRecord': sharedRecord,
  '../../messages/domain/SharedMoment': sharedMoment,
});
const legacyImage = { id: 'legacy-attachment', type: 'image', source: 'gallery', fileName: 'legacy.png', localUri: 'file:///legacy.png' };
const historical = { ...receivedMessage, replyToText: '上一张是哪张？', metadataJson: JSON.stringify({ kind: 'mixed', attachments: [
  receivedImage, { ...receivedImage, id: 'other-attachment', mediaAssetId: 'other-image' }, legacyImage,
  { id: 'file-attachment', type: 'file', source: 'document', fileName: 'notes.txt', mediaAssetId: 'file-media' },
] }) };
const projected = projectChatContextMessage(historical, [now, historical.id, 0, historical.id]);
assert.match(projected.content, /mediaAssetId=image-1/);
assert.match(projected.content, /mediaAssetId=other-image/);
assert.match(projected.content, /收藏这张猫猫/);
assert.match(projected.content, /上一张是哪张/);
assert.equal(projected.role, 'user');
assert.equal(projected.content.includes('file-media'), false);
assert.equal(projected.content.includes('file:///'), false);
assert.equal(chatMetadata.buildSessionPreviewTextFromMessage(receivedMessage).includes(asset.id), false);
const legacyOnly = { ...receivedMessage, metadataJson: JSON.stringify({ kind: 'image', attachments: [legacyImage] }) };
assert.equal(projectChatContextMessage(legacyOnly, [now, 101, 0, 101]).content.includes('mediaAssetId='), false);

// 读取失败与成功共用同一图片说明，模型仍能引用失败图片的 ID；显示文本不变。
let imageReadFails = true;
let attachmentRoute = 'direct_vision';
let imageReminder = '自定义图片防幻觉提醒';
let reminderReads = 0;
let resolveAttachmentInput = async input => {
  if (imageReadFails) throw new Error('图片已被删除');
  return { route: attachmentRoute, parts: attachmentRoute === 'direct_vision'
    ? [{ type: 'text', text: input.contextText }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }]
    : [{ type: 'text', text: attachmentRoute === 'ocr' ? 'OCR 结果或失败说明' : '视觉识别不可用' }] };
};
const { buildChatUserMessageModelInput } = load('src/features/chat/reply/application/BuildChatBatchAIInput.ts', {
  '@features/media': { mediaImageFailure: error => error.message === '图片已被删除'
    ? { status: 'error', code: 'IMAGE_UNREADABLE', modelContent: error.message } : null },
  '@features/chat/messages/domain': chatMetadata, '../../messages/domain/ChatSticker': chatSticker,
  '../../messages/domain/SharedChatRecord': sharedRecord,
  '../../messages/domain/SharedMoment': sharedMoment,
  './ChatReplyRuntimeDependencies': { getChatReplyRuntimeDependencies: () => ({ prompt: {
    readImageGroundingReminder: async assistantId => { assert.equal(assistantId, 'ai-two'); reminderReads++; return imageReminder; },
  } }) },
  './ResolveChatImageModelInput': { resolveChatImageModelInput: input => resolveAttachmentInput(input) },
});
const unreadable = await buildChatUserMessageModelInput(historical, 'ai-two');
assert.equal(typeof unreadable.modelInput, 'string');
assert.match(unreadable.modelInput, /mediaAssetId=image-1/);
assert.match(unreadable.modelInput, /mediaAssetId=other-image/);
assert.match(unreadable.modelInput, /暂时无法读取/);
assert.equal(unreadable.displayText.includes('mediaAssetId='), false);
assert.equal((await buildChatUserMessageModelInput(legacyOnly, 'ai-two')).modelInput.includes('mediaAssetId='), false);
imageReadFails = false;
const readable = await buildChatUserMessageModelInput(receivedMessage, 'ai-two');
assert.ok(readable.modelInput.some(part => part.type === 'text' && part.text.includes('mediaAssetId=image-1')));
assert.ok(readable.modelInput.some(part => part.type === 'image_url'));
assert.ok(readable.modelInput.some(part => part.type === 'text' && part.text === imageReminder));
assert.equal(readable.displayText.includes(imageReminder), false, '提醒不进入用户消息展示正文');
assert.equal(reminderReads, 1, '图片读取失败时不再叠加提醒');
imageReminder = null;
const reminderDisabled = await buildChatUserMessageModelInput(receivedMessage, 'ai-two');
assert.ok(reminderDisabled.modelInput.some(part => part.type === 'image_url'), '关闭提醒不影响图片');
assert.equal(reminderDisabled.modelInput.length, readable.modelInput.length - 1, '关闭后完全省略提醒片段');
imageReminder = '不应进入 OCR 路线的提醒';
const readsBeforeOCR = reminderReads;
for (const route of ['ocr', 'vision_unavailable']) {
  attachmentRoute = route;
  const result = await buildChatUserMessageModelInput(receivedMessage, 'ai-two');
  assert.equal(result.modelInput.includes(imageReminder), false);
}
assert.equal(reminderReads, readsBeforeOCR, '已配置 OCR 的成功、失败或不可用路线均不读取提醒');

// 从真实回合入口经过附件组装到 OCR：宿主超时与新消息取消均须停止等待，不能进入主模型。
resolveAttachmentInput = resolver.resolveChatImageModelInput;
const turnInputBuilder = load('src/features/chat/reply/application/BuildChatTurnAIInput.ts', {
  './BuildChatBatchAIInput': { buildChatUserMessageModelInput },
  './ChatTurnPresentationRuntime': { getChatInterruptedTurnContext: async () => [] },
});
let mainModelRequests = 0, presentationFinishes = 0;
const { executeUserReplyTurn } = load('src/features/chat/reply/application/ExecuteUserReplyTurn.ts', {
  '../../messages/application/ChatMessageRuntime': {},
  './BuildChatTurnAIInput': turnInputBuilder,
  './ProcessAIReply': { processAIReply: async () => { mainModelRequests++; } },
  './SingleTransactionTurnCommit': { createSingleTransactionTurnCommit: () => ({}) },
  './ChatTurnPresentationRuntime': { ChatTurnPresentation: class {
    async start() {}
    async finish() { presentationFinishes++; }
  } },
});
for (const text of ['', '看看这张图']) {
  for (const reason of [new Error('用户发来新消息'), new Error('execution_host_timeout')]) {
    const controller = new AbortController();
    let requestStarted;
    const started = new Promise(resolve => { requestStarted = resolve; });
    respond = options => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      requestStarted();
    });
    const execution = executeUserReplyTurn({
      run: { runId: 'image-turn', sessionId: 'image-session', replyCursorAtClaim: 0, inputHighWatermark: receivedMessage.id },
      aiConfig: { id: 'ai-two' }, signal: controller.signal,
      repository: { listUserMessagesInRange: async () => [{ ...receivedMessage, text }] },
    });
    const rejected = assert.rejects(execution, error => error === reason);
    await Promise.race([started, execution]);
    controller.abort(reason);
    await rejected;
    assert.equal(visionOptions.signal, controller.signal);
  }
}
assert.equal(mainModelRequests, 0, '图片识别期间取消的回合不再请求主模型');
assert.equal(presentationFinishes, 4, '取消和超时均经过回合展示收尾');

// 上传前验证真实文件格式及长截图尺寸，拒绝超限图时不进行模型编码。
let dimensions = { width: 1080, height: 20000 }, imageEncodings = 0;
const nativeImageMocks = { 'expo-file-system': { File: class {
  exists = true; size = 32;
  async bytes() { return Uint8Array.from([255,216,255,0]); }
  async base64() { imageEncodings++; return 'JPEG'; }
} }, 'react-native': { Image: { getSize: async () => dimensions } },
  './ImageAnimation': { detectImageAnimation: () => false } };
const inspectModule = load('src/platform/device/InspectLocalImage.ts', nativeImageMocks);
const imagePreparation = load('src/platform/device/PrepareVisionImage.ts', {
  'expo-file-system': nativeImageMocks['expo-file-system'], './InspectLocalImage': inspectModule,
});
await assert.rejects(imagePreparation.readVisionImageAsBase64('file:///long.jpg'), /8192.*长截图/);
assert.equal(imageEncodings, 0);
dimensions = { width: 1080, height: 1920 };
assert.deepEqual(await imagePreparation.readVisionImageAsBase64('file:///wrong-extension.png'), { base64: 'JPEG', mimeType: 'image/jpeg' });

// HTTP 图片拒绝只降级一次；覆盖 complete、fetch stream 与 Android XHR stream，含工具入口。
const { BaseAIClient } = load('src/platform/ai/BaseAIClient.ts', {
  './HttpExchangeCapture': { beginAIHttpCapture: async () => null },
  './baseUrl': { normalizeAIBaseURL: value => value },
  './errorMapping': load('src/platform/ai/errorMapping.ts'),
});
const savedFetch = globalThis.fetch, savedXHR = globalThis.XMLHttpRequest;
const requests = [];
let rejectionStatus = 400, rejectText = false;
const rejectedMessage = '.messages[101].image[0]: You have uploaded an unsupported image.';
const answer = '这张图没能读取，你可以分段发送；文字聊天可以继续。';
const replyChunk = JSON.stringify({ id: 'reply', choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] });
const doneChunk = JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
const sse = `data: ${replyChunk}\n\ndata: ${doneChunk}\n\ndata: [DONE]\n\n`;
const imageMessages = [{ role: 'user', content: [
  { type: 'text', text: '长截图；mediaAssetId=image-1\n[视觉输入状态：原图已直接提供]\n本轮输入实际包含图片。' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,REJECTED' } },
] }];
const hasImages = body => body.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
const makeClient = () => new BaseAIClient({ baseURL: 'https://example.invalid', apiKey: 'test', model: 'deepseek-flash', maxTokens: 100 });
try {
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    if (hasImages(body) || rejectText) return new Response(JSON.stringify({ error: { message: rejectedMessage } }), { status: rejectionStatus });
    return body.stream ? new Response(sse) : new Response(JSON.stringify({ id: 'reply', choices: [{ message: { content: answer }, finish_reason: 'stop' }] }));
  };
  class MockXHR {
    open() {} setRequestHeader() {} abort() {}
    send(bodyText) {
      const body = JSON.parse(bodyText); requests.push(body);
      queueMicrotask(() => {
        this.status = hasImages(body) || rejectText ? rejectionStatus : 200;
        this.responseText = hasImages(body) || rejectText ? JSON.stringify({ error: { message: rejectedMessage } }) : sse;
        this.onprogress?.(); this.onload();
      });
    }
  }
  for (const transport of ['complete', 'fetch-stream', 'xhr-stream']) {
    globalThis.XMLHttpRequest = transport === 'xhr-stream' ? MockXHR : undefined;
    for (const withTools of [false, true]) {
      const invoke = (client, options) => transport === 'complete'
        ? withTools ? client.chatWithTools(imageMessages, [], options) : client.chat(imageMessages, options)
        : withTools ? client.chatStreamWithTools(imageMessages, [], options) : client.chatStream(imageMessages, options);
      requests.length = 0; rejectionStatus = 400;
      const reply = await invoke(makeClient(), { allowImageContentFallback: true });
      assert.equal(reply.success, true, `${transport} 应恢复文字回复`);
      assert.equal(requests.length, 2);
      assert.equal(hasImages(requests[1]), false);
      assert.match(JSON.stringify(requests[1].messages), /mediaAssetId=image-1/);
      assert.match(JSON.stringify(requests[1].messages), /未收到原图/);
      assert.equal(JSON.stringify(requests[1].messages).includes('原图已直接提供'), false);
      requests.length = 0; rejectText = true;
      assert.equal((await invoke(makeClient(), { allowImageContentFallback: true })).success, false);
      assert.equal(requests.length, 2, '文字降级也失败时停止，不形成无限重试');
      rejectText = false;
      requests.length = 0;
      assert.equal((await invoke(makeClient(), { allowImageContentFallback: false })).success, false);
      assert.equal(requests.length, 1, '工具看图严格模式不能假装成功');
      for (const status of [401, 403, 429, 500]) {
        requests.length = 0; rejectionStatus = status;
        assert.equal((await invoke(makeClient(), { allowImageContentFallback: true })).success, false);
        assert.equal(requests.length, 1, '认证、权限、配额或服务错误不重试为文字');
      }
    }
  }
} finally {
  globalThis.fetch = savedFetch; globalThis.XMLHttpRequest = savedXHR;
}
console.log('AI 图片工具验证通过：迁移/收藏隔离、单次失败/显式修复、取消/持久 fence、共享引用回收和多模态批次。');

// 聊天展示稳定的中文说明；原始错误保留诊断价值，路径和请求 ID 不冒充 HTTP 状态。
const { getErrorDisplayInfo } = load('src/platform/ai/errorMapping.ts');
for (const code of [401, 402, 403, 404, 408, 429, 504, 2049]) {
  const raw = `.messages[${code}].image[0]: You have uploaded an unsupported image. (request_id: 123-${code}-abc)`;
  const error = new Error(raw);
  const display = getErrorDisplayInfo(error);
  assert.equal(display.message, '接口未能处理这张图片，请换一张或稍后再试。');
  assert.equal(display.type, 'request');
  assert.equal(error.message, raw, '展示映射不删除原始错误信息');
}
for (const [raw, type] of [['HTTP 401: Unauthorized','auth'], ['HTTP 403: Forbidden','permission'],
  ['HTTP 404: Not Found','not_found'], ['HTTP 402: Payment Required','quota'], ['HTTP 429: Too Many Requests','service_busy']]) {
  assert.equal(getErrorDisplayInfo(raw).type, type);
}
assert.equal(getErrorDisplayInfo('image input is not supported').title, '图片处理失败');
assert.equal(getErrorDisplayInfo('Unexpected response \uFFFD (request_id: 123-403-abc)').message,
  '模型服务暂时无法完成回复，请稍后再试。');
assert.equal(getErrorDisplayInfo('temperature must be 1').type, 'param');
