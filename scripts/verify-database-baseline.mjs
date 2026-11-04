/** 新建库、当前公开版升级、数据保留、失败回滚与恢复出厂后的基线验证。 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { bootstrapSqlite, createSqliteExecutor, DATABASE_SCHEMA_VERSION } from './helpers/sqlite-bootstrap-fixture.mjs';
const tables = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
// 这里只比较既有业务事实；服务设置默认行与新引用列由服务迁移专项验证。
const data = db => tables(db).filter(name=>!['assistant_nickname_changes','model_service_settings'].includes(name)).map(name=>({name, rows:db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map(row=>{ if(row.service_config_id===null)delete row.service_config_id;return row; })})).filter(table=>table.rows.length>0);
const structure = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(row => row.type !== 'table' ? row : ({
 ...row, sql: undefined,
 columns: db.prepare(`PRAGMA table_info("${row.name}")`).all().map(({cid,...column}) => column).sort((a,b)=>a.name.localeCompare(b.name)),
 foreignKeys: db.prepare(`PRAGMA foreign_key_list("${row.name}")`).all().map(({id,...key})=>key).sort((a,b)=>a.from.localeCompare(b.from)),
}));
function check(db){
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
}
const create = () => {const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');return db;};
// 旧版本没有用户备注列与修改历史，升级 fixture 必须还原真实旧结构。
function removeServiceSchema(db) {
 for (const table of ['auxiliary_model_configs','ai_assistants','group_chat_admin_configs']) {
  if (db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'service_config_id')) db.exec(`ALTER TABLE ${table} DROP COLUMN service_config_id`);
 }
 db.exec('DROP TABLE IF EXISTS model_service_configs; DROP TABLE IF EXISTS model_service_settings;');
}
function removeNicknameSchema(db) {
 removeServiceSchema(db);
 db.exec('ALTER TABLE ai_assistants DROP COLUMN show_action_steps; ALTER TABLE ai_assistants DROP COLUMN streaming_reply;');
 db.exec('ALTER TABLE raven_cat_ai_schedules DROP COLUMN system_calendar;');
 db.exec('DROP TABLE IF EXISTS assistant_nickname_changes; ALTER TABLE ai_assistants DROP COLUMN nickname;');
 removeSummaryModelSchema(db);
}
function removeSummaryModelSchema(db) {
 db.exec('ALTER TABLE chat_summary_request_settings DROP COLUMN model_config_id; ALTER TABLE chat_summary_request_settings DROP COLUMN group_trigger_count; ALTER TABLE chat_summary_request_settings DROP COLUMN primary_limit;');
}

function installLegacyNicknameAudit(db) {
 db.exec('ALTER TABLE ai_assistants DROP COLUMN show_action_steps; ALTER TABLE ai_assistants DROP COLUMN streaming_reply;');
 db.exec('ALTER TABLE raven_cat_ai_schedules DROP COLUMN system_calendar;');
 db.exec(`CREATE TABLE assistant_nickname_changes (id INTEGER PRIMARY KEY AUTOINCREMENT,
 assistant_id TEXT NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE, previous_nickname TEXT,
 nickname TEXT, acknowledged INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);`);
}

function seed(db){
 const t='2026-10-10T12:00:00.000Z';
 db.prepare("INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at) VALUES ('ai-proof','agent-proof','测试角色','test-model',?,?)").run(t,t);
 db.prepare("INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at) VALUES ('direct-proof','ai-proof','测试单聊',?,?)").run(t,t);
 db.exec("INSERT INTO chat_conversations VALUES ('direct-proof','direct'); INSERT INTO chat_conversations VALUES ('group-proof','group');");
 db.prepare("INSERT INTO group_chats(id,name,created_at,updated_at) VALUES ('group-proof','测试群聊',?,?)").run(t,t);
 const insert=db.prepare('INSERT INTO messages(id,session_id,text,is_me,sender_type,created_at) VALUES (?,?,?,?,?,?)');
 insert.run(41,'direct-proof','单聊保留正文',1,'user',t);insert.run(42,'group-proof','群聊保留正文',0,'assistant',t);
 db.prepare("INSERT INTO protocols(id,ai_assistant_id,content,created_at,updated_at) VALUES ('protocol-proof','ai-proof','保留协议正文',?,?)").run(t,t);
 const profile=db.prepare('SELECT id FROM user_profile LIMIT 1').get().id;
 db.prepare("INSERT INTO memory_pools(id,user_profile_id,ai_assistant_id,created_at,updated_at) VALUES ('pool-proof',?,'ai-proof',?,?)").run(profile,t,t);
 db.prepare("INSERT INTO memory_items(id,pool_id,content,normalized_content,remembered_at,created_at,updated_at) VALUES ('memory-proof','pool-proof','保留记忆正文','保留记忆正文',?,?,?)").run(t,t,t);
 db.exec("INSERT INTO memory_item_embeddings(memory_id,content_revision,status,model_fingerprint,model_name,vector_json,dimension) VALUES ('memory-proof',1,'ready','test-fingerprint','test-embedding','[0.25,0.75]',2)");
 db.exec("INSERT INTO memory_trigger_groups VALUES ('trigger-proof','pool-proof',1); INSERT INTO memory_trigger_keywords VALUES ('trigger-proof','保留','保留',0); INSERT INTO memory_passive_associations VALUES ('trigger-proof','memory-proof'); INSERT INTO memory_passive_disabled VALUES ('trigger-proof','memory-proof');");
 db.prepare("INSERT INTO chat_summary_segments(id,conversation_id,sequence,content,time_zone,created_at,updated_at) VALUES ('summary-proof','direct-proof',1,'保留摘要正文','Asia/Shanghai',?,?)").run(t,t);
 db.prepare("INSERT INTO moments(id,author_type,author_id,author_name_snapshot,content,created_at) VALUES ('moment-proof','user',?,'测试用户','保留朋友圈正文',?)").run(profile,t);
 db.prepare("INSERT INTO mcp_servers(id,name,url,created_at,updated_at) VALUES ('mcp-proof','测试服务','https://example.invalid/mcp',?,?)").run(t,t);
 db.exec("INSERT INTO mcp_server_assistants VALUES ('mcp-proof','ai-proof')");
 db.prepare("INSERT INTO mcp_tool_grants(server_id,remote_tool_name,local_tool_name,schema_fingerprint,updated_at) VALUES ('mcp-proof','remote','local','test',?)").run(t);
 db.prepare("INSERT INTO raven_cat_ai_schedules(schedule_id,owner_ai_id,remind_at,summary,details,status,created_at,updated_at) VALUES ('schedule-proof','ai-proof',?,'保留日程','保留日程正文','scheduled',?,?)").run(t,t,t);
}

/** 构造发布时的真实词表契约，升级用例不把新版表伪标为旧版本。 */
function installLegacySummary(db) {
 db.exec('ALTER TABLE ai_assistants DROP COLUMN show_token_usage;');
 db.exec('ALTER TABLE chat_summary_segments DROP COLUMN level; ALTER TABLE chat_summary_segments DROP COLUMN compaction_id; ALTER TABLE chat_summary_segments DROP COLUMN context_sequence; DROP TABLE chat_summary_settings;');
}
function installLegacyTriggers(db, version) {
 removeServiceSchema(db);
 installLegacySummary(db);
 const words=db.prepare('SELECT t.id,t.pool_id,k.keyword,k.normalized_keyword FROM memory_trigger_groups t JOIN memory_trigger_keywords k ON k.group_id=t.id').all();
 const associations=db.prepare('SELECT * FROM memory_passive_associations').all();
 const disabled=db.prepare('SELECT * FROM memory_passive_disabled').all();
 db.exec(`DROP TABLE memory_passive_associations; DROP TABLE memory_passive_disabled; DROP TABLE memory_trigger_keywords; DROP TABLE memory_trigger_groups;
 CREATE TABLE memory_passive_triggers (id TEXT PRIMARY KEY,pool_id TEXT NOT NULL REFERENCES memory_pools(id) ON DELETE CASCADE,keyword TEXT NOT NULL,normalized_keyword TEXT NOT NULL,UNIQUE(pool_id,normalized_keyword));
 CREATE TABLE memory_passive_associations (trigger_id TEXT NOT NULL REFERENCES memory_passive_triggers(id) ON DELETE CASCADE,memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,PRIMARY KEY(trigger_id,memory_id));
 CREATE TABLE memory_passive_disabled (trigger_id TEXT NOT NULL REFERENCES memory_passive_triggers(id) ON DELETE CASCADE,memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,PRIMARY KEY(trigger_id,memory_id));`);
 for(const row of words)db.prepare('INSERT INTO memory_passive_triggers VALUES (?,?,?,?)').run(row.id,row.pool_id,row.keyword,row.normalized_keyword);
 for(const row of associations)db.prepare('INSERT INTO memory_passive_associations VALUES (?,?)').run(row.trigger_id,row.memory_id);
 for(const row of disabled)db.prepare('INSERT INTO memory_passive_disabled VALUES (?,?)').run(row.trigger_id,row.memory_id);
 db.exec(`ALTER TABLE group_chat_members DROP COLUMN muted; ALTER TABLE group_chat_members DROP COLUMN joined_during_plan_id; DROP TABLE group_chat_history; PRAGMA user_version=${version}`);
}

const db=create();
await bootstrapSqlite(createSqliteExecutor(db));
assert.equal(db.prepare('PRAGMA user_version').get().user_version,DATABASE_SCHEMA_VERSION);
for(const retired of ['memories','memory_entries','capability_bindings','raven_cat_self_wakes','raven_cat_contact_traces']) assert.ok(!tables(db).includes(retired));
assert.ok(!tables(db).includes('call_background_legacy_migration'),'新库不创建旧文件迁移标记');
seed(db);check(db);
const before=data(db), schema=structure(db);
// 164 的真实结构没有主页封面表；建表和版本必须一起提交，升级不改已有资料。
const coverUpgrade=create(); await bootstrapSqlite(createSqliteExecutor(coverUpgrade)); seed(coverUpgrade);
coverUpgrade.exec('DROP TABLE assistant_profile_covers; PRAGMA user_version=164;');
const coverRaw=createSqliteExecutor(coverUpgrade), coverBefore=data(coverUpgrade);
await assert.rejects(bootstrapSqlite({ ...coverRaw, execAsync: async sql => {
 if(sql.includes('PRAGMA user_version =')) throw new Error('封面升级提交失败');
 return coverRaw.execAsync(sql);
} }), /封面升级提交失败/);
assert.equal(coverUpgrade.prepare('PRAGMA user_version').get().user_version,164);
assert.ok(!tables(coverUpgrade).includes('assistant_profile_covers'));
assert.deepEqual(data(coverUpgrade),coverBefore);
await bootstrapSqlite(coverRaw);
assert.equal(coverUpgrade.prepare('PRAGMA user_version').get().user_version,DATABASE_SCHEMA_VERSION);
assert.ok(tables(coverUpgrade).includes('assistant_profile_covers'));
assert.deepEqual(data(coverUpgrade),coverBefore); check(coverUpgrade); coverUpgrade.close();
// 151 的开关由实际模型选择迁出；失败回滚列与版本，正文、向量和失效引用均保留。
for (const selectedModelId of [null, 'previous-model', 'deleted-model']) {
 const memoryUpgrade=create(); await bootstrapSqlite(createSqliteExecutor(memoryUpgrade)); seed(memoryUpgrade);
 memoryUpgrade.prepare('UPDATE memory_model_settings SET embedding_model_config_id = ?').run(selectedModelId);
 // 151 尚未建立组合收藏，fixture 同时还原该版本的单侧皮肤表。
 removeServiceSchema(memoryUpgrade);memoryUpgrade.exec(`DROP TABLE chat_bubble_selections; DROP TABLE chat_bubble_preset_decorations; DROP TABLE chat_bubble_presets;
  CREATE TABLE chat_bubble_skins (role TEXT PRIMARY KEY CHECK(role IN ('user','ai')),
   media_asset_id TEXT NOT NULL REFERENCES media_assets(id), width INTEGER NOT NULL, height INTEGER NOT NULL, config_json TEXT NOT NULL);
  ALTER TABLE memory_model_settings DROP COLUMN embedding_enabled; PRAGMA user_version=151;`);
 const originalItems=memoryUpgrade.prepare('SELECT * FROM memory_items').all();
 const originalVectors=memoryUpgrade.prepare('SELECT * FROM memory_item_embeddings').all();
 const upgrade=createSqliteExecutor(memoryUpgrade);
 await assert.rejects(bootstrapSqlite({...upgrade,execAsync:async sql=>{
  if(sql.includes('PRAGMA user_version =')) throw new Error('记忆开关迁移提交失败');
  return upgrade.execAsync(sql);
 }}),/记忆开关迁移提交失败/);
 assert.equal(memoryUpgrade.prepare('PRAGMA user_version').get().user_version,151);
 assert.equal(memoryUpgrade.prepare('PRAGMA table_info(memory_model_settings)').all().some(column=>column.name==='embedding_enabled'),false);
 await bootstrapSqlite(upgrade);
 const settings=()=>({...memoryUpgrade.prepare('SELECT * FROM memory_model_settings').get()});
 assert.deepEqual(settings(),{id:1,embedding_model_config_id:selectedModelId,embedding_enabled:selectedModelId===null?0:1});
 assert.deepEqual(memoryUpgrade.prepare('SELECT * FROM memory_items').all(),originalItems);
 assert.deepEqual(memoryUpgrade.prepare('SELECT * FROM memory_item_embeddings').all(),originalVectors);
 memoryUpgrade.exec('UPDATE memory_model_settings SET embedding_enabled=0;');
 await bootstrapSqlite(upgrade);
 assert.deepEqual(settings(),{id:1,embedding_model_config_id:selectedModelId,embedding_enabled:0},'重复启动不重新开启');
 check(memoryUpgrade); memoryUpgrade.close();
}
// 148 升级到日程交接版本时，既有资料、外键和索引必须完整保留。
const scheduleUpgrade=create();
await bootstrapSqlite(createSqliteExecutor(scheduleUpgrade)); seed(scheduleUpgrade);
removeServiceSchema(scheduleUpgrade);scheduleUpgrade.exec('DROP TABLE raven_cat_ai_schedule_context; PRAGMA user_version=148;');
const scheduleBefore=data(scheduleUpgrade);
await bootstrapSqlite(createSqliteExecutor(scheduleUpgrade));
assert.deepEqual(data(scheduleUpgrade),scheduleBefore);
assert.deepEqual(structure(scheduleUpgrade),schema); check(scheduleUpgrade);
scheduleUpgrade.close();
// 147 的运行正文没有已读位：升级不补造旧红点，正式已读值与失败回滚均保留。
const readUpgrade=create(); await bootstrapSqlite(createSqliteExecutor(readUpgrade)); seed(readUpgrade);
removeServiceSchema(readUpgrade);readUpgrade.exec(`INSERT INTO messages(id,session_id,text,is_me,sender_type,is_read,created_at)
 VALUES (43,'direct-proof','已读正文',0,'assistant',1,'2026-10-27'),
        (44,'direct-proof','未读正文',0,'assistant',0,'2026-10-27');
 INSERT INTO conversation_turn_runs(run_id,session_id,kind,reply_cursor_at_claim,input_high_watermark,revision_at_claim,status,created_at)
 VALUES ('read-upgrade','direct-proof','user_reply',0,41,1,'superseded','2026-10-27');
 INSERT INTO chat_turn_presentations(run_id,session_id,state,updated_at) VALUES ('read-upgrade','direct-proof','interrupted','2026-10-27');
 INSERT INTO chat_turn_display_items(run_id,identity,version,snapshot_json,shown_version,shown_json,message_id)
 VALUES ('read-upgrade','unbound',1,'{}',1,'{}',NULL),
        ('read-upgrade','read',1,'{}',1,'{}',43),('read-upgrade','unread',1,'{}',1,'{}',44);
 ALTER TABLE chat_turn_display_items DROP COLUMN is_read; PRAGMA user_version=147;`);
const readExecutor=createSqliteExecutor(readUpgrade);
await assert.rejects(bootstrapSqlite({ ...readExecutor, execAsync: async sql => {
 if(sql.startsWith('UPDATE chat_turn_display_items SET is_read')) throw new Error('已读迁移回填失败');
 return readExecutor.execAsync(sql);
} }),/已读迁移回填失败/);
assert.equal(readUpgrade.prepare('PRAGMA user_version').get().user_version,147);
assert.equal(readUpgrade.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('chat_turn_display_items') WHERE name='is_read'").get().n,0);
await bootstrapSqlite(readExecutor);
assert.deepEqual(readUpgrade.prepare('SELECT identity,is_read FROM chat_turn_display_items ORDER BY identity').all().map(row=>[row.identity,row.is_read]),
 [['read',1],['unbound',1],['unread',0]]);
readUpgrade.exec("UPDATE chat_turn_display_items SET is_read=0 WHERE identity='unbound'");
await bootstrapSqlite(readExecutor);
assert.equal(readUpgrade.prepare("SELECT is_read FROM chat_turn_display_items WHERE identity='unbound'").get().is_read,0,'重复初始化不重置新的已读事实');
check(readUpgrade); readUpgrade.close();
// 144 的图片记录只存错误码：新增原因列不重放识别，迁移失败整笔回滚。
const analysisUpgrade=create(); await bootstrapSqlite(createSqliteExecutor(analysisUpgrade)); seed(analysisUpgrade);
removeServiceSchema(analysisUpgrade);analysisUpgrade.exec(`
 INSERT INTO media_assets(id,storage_backend,storage_key,hash_algorithm,content_hash,mime_type,byte_size,status,created_at,updated_at)
 VALUES ('analysis-asset','persistent-image','moments/test.jpg','sha256','${'a'.repeat(64)}','image/jpeg',12,'ready','2026-10-25','2026-10-25');
 INSERT INTO moment_media(id,moment_id,media_asset_id,sort_order,analysis_status,analysis_error_code,created_at,updated_at)
 VALUES ('analysis-proof','moment-proof','analysis-asset',0,'failed','model_request_failed','2026-10-25','2026-10-25');
 ALTER TABLE moment_media DROP COLUMN analysis_error_message; PRAGMA user_version=144;
`);
const analysisBefore=data(analysisUpgrade), analysisSchemaBefore=structure(analysisUpgrade), analysisRaw=createSqliteExecutor(analysisUpgrade);
await assert.rejects(bootstrapSqlite({...analysisRaw,execAsync:async sql=>{
 if(sql.includes('PRAGMA user_version =')) throw new Error('识别原因迁移提交失败');
 return analysisRaw.execAsync(sql);
}}),/识别原因迁移提交失败/);
assert.deepEqual(data(analysisUpgrade),analysisBefore); assert.deepEqual(structure(analysisUpgrade),analysisSchemaBefore);
assert.equal(analysisUpgrade.prepare('PRAGMA user_version').get().user_version,144);
await bootstrapSqlite(analysisRaw);
assert.deepEqual({...analysisUpgrade.prepare('SELECT analysis_status,analysis_error_code,analysis_error_message FROM moment_media').get()},
 {analysis_status:'failed',analysis_error_code:'model_request_failed',analysis_error_message:null});
assert.deepEqual(structure(analysisUpgrade),schema); check(analysisUpgrade);
const upgradedAnalysisData=data(analysisUpgrade);
await bootstrapSqlite(analysisRaw);
assert.deepEqual(data(analysisUpgrade),upgradedAnalysisData); analysisUpgrade.close();
// 141 没有持久摘要队列：升级只补一次既有来源，失败回滚不留下队列或新版本号。
const queueUpgrade=create(); await bootstrapSqlite(createSqliteExecutor(queueUpgrade)); seed(queueUpgrade);
for(const {name} of queueUpgrade.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'chat_summary_queue_%'").all()) {
 queueUpgrade.exec(`DROP TRIGGER "${name}"`);
}
removeServiceSchema(queueUpgrade);queueUpgrade.exec('DROP TABLE chat_summary_work_queue; PRAGMA user_version=141;');
const queueBefore=data(queueUpgrade),queueSchemaBefore=structure(queueUpgrade),queueRaw=createSqliteExecutor(queueUpgrade);
await assert.rejects(bootstrapSqlite({...queueRaw,execAsync:async sql=>{
 if(sql.includes('PRAGMA user_version =')) throw new Error('摘要队列升级提交失败');
 return queueRaw.execAsync(sql);
}}),/摘要队列升级提交失败/);
assert.deepEqual(data(queueUpgrade),queueBefore);assert.deepEqual(structure(queueUpgrade),queueSchemaBefore);
assert.equal(queueUpgrade.prepare('PRAGMA user_version').get().user_version,141);
await bootstrapSqlite(queueRaw);
assert.deepEqual(queueUpgrade.prepare('SELECT conversation_id FROM chat_summary_work_queue WHERE revision>checked_revision ORDER BY conversation_id').all().map(row=>row.conversation_id),['direct-proof','group-proof']);
queueUpgrade.exec('UPDATE chat_summary_work_queue SET checked_revision=revision;');
await bootstrapSqlite(queueRaw);
assert.equal(queueUpgrade.prepare('SELECT COUNT(*) n FROM chat_summary_work_queue WHERE revision>checked_revision').get().n,0,'升级后的普通启动不再补扫来源');
assert.deepEqual(structure(queueUpgrade),schema);check(queueUpgrade);queueUpgrade.close();
// 140 的成员关系升级后仍启用、默认不禁言；退出历史表与新列必须一起回滚或提交。
const membershipUpgrade=create(); await bootstrapSqlite(createSqliteExecutor(membershipUpgrade)); seed(membershipUpgrade);
removeServiceSchema(membershipUpgrade);membershipUpgrade.exec("INSERT INTO group_chat_members(id,group_id,ai_assistant_id,agent_id,created_at,updated_at) VALUES ('old-member','group-proof','ai-proof','agent-proof','2026-10-10','2026-10-10'); ALTER TABLE group_chat_members DROP COLUMN muted; ALTER TABLE group_chat_members DROP COLUMN joined_during_plan_id; DROP TABLE group_chat_history; PRAGMA user_version=140;");
const membershipBefore=data(membershipUpgrade), membershipSchema=structure(membershipUpgrade), membershipRaw=createSqliteExecutor(membershipUpgrade);
await assert.rejects(bootstrapSqlite({...membershipRaw,execAsync:async sql=>{
 if(sql.includes('PRAGMA user_version =')) throw new Error('成员升级提交失败');
 return membershipRaw.execAsync(sql);
}}),/成员升级提交失败/);
assert.deepEqual(data(membershipUpgrade),membershipBefore); assert.deepEqual(structure(membershipUpgrade),membershipSchema);
await bootstrapSqlite(membershipRaw);
assert.deepEqual({...membershipUpgrade.prepare('SELECT enabled,muted,joined_during_plan_id FROM group_chat_members').get()}, {enabled:1,muted:0,joined_during_plan_id:null});
assert.deepEqual(structure(membershipUpgrade),schema); check(membershipUpgrade); membershipUpgrade.close();
// 138 升级按 AI 增加展示选择，不改写 Token 选择或消息；失败整笔回滚。
const displayUpgrade=create(); await bootstrapSqlite(createSqliteExecutor(displayUpgrade)); seed(displayUpgrade);
removeServiceSchema(displayUpgrade);displayUpgrade.exec("UPDATE ai_assistants SET show_token_usage=0; ALTER TABLE ai_assistants DROP COLUMN show_action_steps; ALTER TABLE ai_assistants DROP COLUMN streaming_reply; ALTER TABLE group_chat_members DROP COLUMN muted; ALTER TABLE group_chat_members DROP COLUMN joined_during_plan_id; DROP TABLE group_chat_history; PRAGMA user_version=138;");
const displayBefore=data(displayUpgrade), displaySchemaBefore=structure(displayUpgrade), displayRaw=createSqliteExecutor(displayUpgrade);
await assert.rejects(bootstrapSqlite({...displayRaw,execAsync:async sql=>{
 if(sql.includes('PRAGMA user_version =')) throw new Error('展示配置迁移提交失败');
 return displayRaw.execAsync(sql);
}}),/展示配置迁移提交失败/);
assert.deepEqual(data(displayUpgrade),displayBefore);
assert.deepEqual(structure(displayUpgrade),displaySchemaBefore);
assert.equal(displayUpgrade.prepare('PRAGMA user_version').get().user_version,138);
await bootstrapSqlite(displayRaw);
assert.equal(displayUpgrade.prepare('SELECT show_action_steps FROM ai_assistants').get().show_action_steps,1);
assert.equal(displayUpgrade.prepare('SELECT show_token_usage FROM ai_assistants').get().show_token_usage,0);
assert.deepEqual(displayUpgrade.prepare('SELECT * FROM messages ORDER BY id').all(),db.prepare('SELECT * FROM messages ORDER BY id').all());
displayUpgrade.exec('UPDATE ai_assistants SET show_action_steps=0;');
await bootstrapSqlite(displayRaw);
assert.equal(displayUpgrade.prepare('SELECT show_action_steps FROM ai_assistants').get().show_action_steps,0,'重复启动保留关闭选择');
check(displayUpgrade); displayUpgrade.close();
// 139 升级保留现有资料；新旧角色默认跟随主题，提交失败回滚整笔迁移。
const streamingUpgrade=create(); await bootstrapSqlite(createSqliteExecutor(streamingUpgrade)); seed(streamingUpgrade);
removeServiceSchema(streamingUpgrade);streamingUpgrade.exec('ALTER TABLE ai_assistants DROP COLUMN streaming_reply; ALTER TABLE group_chat_members DROP COLUMN muted; ALTER TABLE group_chat_members DROP COLUMN joined_during_plan_id; DROP TABLE group_chat_history; PRAGMA user_version=139;');
const streamingBefore=data(streamingUpgrade), streamingSchemaBefore=structure(streamingUpgrade), streamingRaw=createSqliteExecutor(streamingUpgrade);
await assert.rejects(bootstrapSqlite({...streamingRaw,execAsync:async sql=>{
 if(sql.includes('PRAGMA user_version =')) throw new Error('回复方式迁移提交失败');
 return streamingRaw.execAsync(sql);
}}),/回复方式迁移提交失败/);
assert.deepEqual(data(streamingUpgrade),streamingBefore);
assert.deepEqual(structure(streamingUpgrade),streamingSchemaBefore);
assert.equal(streamingUpgrade.prepare('PRAGMA user_version').get().user_version,139);
await bootstrapSqlite(streamingRaw);
assert.equal(streamingUpgrade.prepare('SELECT streaming_reply FROM ai_assistants').get().streaming_reply,null);
assert.deepEqual(structure(streamingUpgrade),schema);
for(const choice of [1,0,null]) {
 streamingUpgrade.prepare('UPDATE ai_assistants SET streaming_reply=?').run(choice);
 await bootstrapSqlite(streamingRaw);
 assert.equal(streamingUpgrade.prepare('SELECT streaming_reply FROM ai_assistants').get().streaming_reply,choice);
}
check(streamingUpgrade); streamingUpgrade.close();
// 130 的展示快照已存在，新增运行状态列不得改变可见版本或回合资格。
const observableUpgrade=create(); await bootstrapSqlite(createSqliteExecutor(observableUpgrade)); seed(observableUpgrade);
installLegacyNicknameAudit(observableUpgrade);
removeServiceSchema(observableUpgrade);observableUpgrade.exec(`INSERT INTO conversation_turn_state(session_id,reply_cursor,revision,updated_at) VALUES ('direct-proof',0,7,'2026-10-15');
 INSERT INTO conversation_turn_runs(run_id,session_id,kind,reply_cursor_at_claim,input_high_watermark,revision_at_claim,status,created_at)
 VALUES ('display-proof','direct-proof','user_reply',0,41,7,'superseded','2026-10-15');
 INSERT INTO chat_turn_presentations(run_id,session_id,state,updated_at) VALUES ('display-proof','direct-proof','interrupted','2026-10-15');
 INSERT INTO chat_turn_display_items(run_id,identity,version,snapshot_json,shown_version,shown_json)
 VALUES ('display-proof','display-proof:1',2,'{"text":"hidden tail"}',1,'{"text":"shown prefix"}');
 ALTER TABLE conversation_turn_state DROP COLUMN host_request_revision;
 ALTER TABLE conversation_turn_state DROP COLUMN host_request_input_id;
 ALTER TABLE conversation_turn_state DROP COLUMN host_request_status;
 ALTER TABLE conversation_turn_state DROP COLUMN host_request_at;
 ALTER TABLE chat_turn_presentations DROP COLUMN phase;
 ALTER TABLE chat_turn_presentations DROP COLUMN phase_at;
 ALTER TABLE chat_summary_request_settings DROP COLUMN primary_limit;
 ALTER TABLE group_chat_members DROP COLUMN muted; ALTER TABLE group_chat_members DROP COLUMN joined_during_plan_id; DROP TABLE group_chat_history; PRAGMA user_version=130;`);
const savedDisplay=observableUpgrade.prepare('SELECT * FROM chat_turn_display_items').all();
const observableExecutor=createSqliteExecutor(observableUpgrade);
await assert.rejects(bootstrapSqlite({ ...observableExecutor, execAsync: async sql => {
 if(sql.includes('PRAGMA user_version =')) throw new Error('运行状态迁移提交失败');
 return observableExecutor.execAsync(sql);
} }),/运行状态迁移提交失败/);
assert.equal(observableUpgrade.prepare('PRAGMA user_version').get().user_version,130);
assert.equal(observableUpgrade.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('chat_turn_presentations') WHERE name='phase'").get().n,0);
assert.deepEqual(observableUpgrade.prepare('SELECT * FROM chat_turn_display_items').all(),savedDisplay);
await bootstrapSqlite(createSqliteExecutor(observableUpgrade));
assert.deepEqual(observableUpgrade.prepare('SELECT * FROM chat_turn_display_items').all(),savedDisplay);
assert.equal(observableUpgrade.prepare('SELECT revision FROM conversation_turn_state').get().revision,7);
assert.equal(observableUpgrade.prepare('SELECT phase FROM chat_turn_presentations').get().phase,'preparing');
assert.equal(observableUpgrade.prepare('PRAGMA user_version').get().user_version,DATABASE_SCHEMA_VERSION);
check(observableUpgrade); observableUpgrade.close();
// 131 的真机故障：过程没有屏幕回执、完成后卡在交付、输入被误判为展示中断。
const publicationUpgrade=create(); await bootstrapSqlite(createSqliteExecutor(publicationUpgrade)); seed(publicationUpgrade);
for (const [runId, status, displayState, reason] of [
 ['old-process','superseded','interrupted','new_input'],
 ['old-pacing','committed','interrupted','new_input'],
 ['old-finished','committed','open',null],
 ['old-restarted','committed','interrupted','process_restarted'],
 ['old-timeout','committed','interrupted','execution_host_timeout'],
]) {
 publicationUpgrade.prepare(`INSERT INTO conversation_turn_runs(run_id,session_id,kind,reply_cursor_at_claim,input_high_watermark,revision_at_claim,status,created_at)
 VALUES (?,'direct-proof','user_reply',0,41,2,?,'2026-10-15')`).run(runId,status);
 publicationUpgrade.prepare(`INSERT INTO chat_turn_presentations(run_id,session_id,state,reason,updated_at) VALUES (?,'direct-proof',?,?,'2026-10-15')`).run(runId,displayState,reason);
 const add = (identity, kind, text, canonical, published) => {
  let messageId = null;
  if(canonical) messageId=Number(publicationUpgrade.prepare(`INSERT INTO messages(session_id,text,is_me,sender_type,created_at) VALUES ('direct-proof',?,0,?,'2026-10-15')`).run(text,kind==='tool'?'system':kind).lastInsertRowid);
  const json=JSON.stringify({runId,kind,text});
  publicationUpgrade.prepare(`INSERT INTO chat_turn_display_items(run_id,identity,version,snapshot_json,shown_version,shown_json,message_id) VALUES (?,?,1,?,?,?,?)`).run(runId,identity,json,published?1:0,published?json:null,messageId);
 };
 add(runId+':process','reasoning','可恢复的过程',status==='committed',false);
 add(runId+':body','assistant','已经交付',status==='committed',true);
 if(!['old-finished','old-restarted'].includes(runId)) add(runId+':tail','assistant','未交付尾部',status==='committed',false);
}
installLegacyNicknameAudit(publicationUpgrade);
removeServiceSchema(publicationUpgrade);publicationUpgrade.exec('ALTER TABLE chat_summary_request_settings DROP COLUMN primary_limit; ALTER TABLE group_chat_members DROP COLUMN muted; ALTER TABLE group_chat_members DROP COLUMN joined_during_plan_id; DROP TABLE group_chat_history; PRAGMA user_version=131');
await bootstrapSqlite(createSqliteExecutor(publicationUpgrade));
assert.equal(publicationUpgrade.prepare("SELECT shown_json FROM chat_turn_display_items WHERE identity='old-process:process'").get().shown_json.includes('可恢复的过程'),true);
assert.equal(publicationUpgrade.prepare("SELECT shown_json FROM chat_turn_display_items WHERE identity='old-process:tail'").get().shown_json,null);
assert.equal(publicationUpgrade.prepare("SELECT shown_json FROM chat_turn_display_items WHERE identity='old-pacing:tail'").get().shown_json.includes('未交付尾部'),true);
assert.equal(publicationUpgrade.prepare("SELECT state FROM chat_turn_presentations WHERE run_id='old-finished'").get().state,'completed');
assert.equal(publicationUpgrade.prepare("SELECT state FROM chat_turn_presentations WHERE run_id='old-restarted'").get().state,'completed');
assert.equal(publicationUpgrade.prepare("SELECT shown_json FROM chat_turn_display_items WHERE identity='old-timeout:tail'").get().shown_json,null);
check(publicationUpgrade); publicationUpgrade.close();
// 120/121 的库确实没有新列；升级保留原资料，后续启动不覆盖关闭选择。
for (const version of [120, 121]) {
 const previous=create(); await bootstrapSqlite(createSqliteExecutor(previous)); seed(previous);
 const previousData=data(previous);
 removeNicknameSchema(previous);
 previous.exec(`ALTER TABLE ai_assistants DROP COLUMN show_token_usage; ALTER TABLE group_chat_members DROP COLUMN muted; ALTER TABLE group_chat_members DROP COLUMN joined_during_plan_id; DROP TABLE group_chat_history; PRAGMA user_version=${version};`);
 await bootstrapSqlite(createSqliteExecutor(previous));
 assert.deepEqual(data(previous),previousData); assert.deepEqual(structure(previous),schema);
 previous.exec("UPDATE ai_assistants SET show_token_usage=0 WHERE id='ai-proof';");
 await bootstrapSqlite(createSqliteExecutor(previous));
 assert.equal(previous.prepare("SELECT show_token_usage FROM ai_assistants WHERE id='ai-proof'").get().show_token_usage,0);
 check(previous); previous.close();
}
// 135 的既有日程保持仅内部；新字段与版本一起提交，失败必须整体回滚。
const calendarUpgrade=create(); await bootstrapSqlite(createSqliteExecutor(calendarUpgrade)); seed(calendarUpgrade);
removeServiceSchema(calendarUpgrade);calendarUpgrade.exec('ALTER TABLE ai_assistants DROP COLUMN show_action_steps; ALTER TABLE ai_assistants DROP COLUMN streaming_reply; ALTER TABLE raven_cat_ai_schedules DROP COLUMN system_calendar; ALTER TABLE chat_summary_request_settings DROP COLUMN primary_limit; ALTER TABLE group_chat_members DROP COLUMN muted; ALTER TABLE group_chat_members DROP COLUMN joined_during_plan_id; DROP TABLE group_chat_history; PRAGMA user_version=135;');
const calendarBefore=data(calendarUpgrade), calendarRaw=createSqliteExecutor(calendarUpgrade);
await assert.rejects(bootstrapSqlite({...calendarRaw,execAsync:async sql=>{
 if(sql.includes('PRAGMA user_version =')) throw new Error('日历迁移提交失败');
 return calendarRaw.execAsync(sql);
}}),/日历迁移提交失败/);
assert.deepEqual(data(calendarUpgrade),calendarBefore);
assert.equal(calendarUpgrade.prepare('PRAGMA user_version').get().user_version,135);
await bootstrapSqlite(calendarRaw);
assert.equal(calendarUpgrade.prepare("SELECT system_calendar FROM raven_cat_ai_schedules WHERE schedule_id='schedule-proof'").get().system_calendar,0);
assert.deepEqual(structure(calendarUpgrade),schema); check(calendarUpgrade); calendarUpgrade.close();
// 136 的原消息和业务数据原样升级，版本表与 user_version 同事务建立。
const versionUpgrade=create(); await bootstrapSqlite(createSqliteExecutor(versionUpgrade)); seed(versionUpgrade);
removeServiceSchema(versionUpgrade);versionUpgrade.exec('ALTER TABLE ai_assistants DROP COLUMN show_action_steps; ALTER TABLE ai_assistants DROP COLUMN streaming_reply; DROP TABLE chat_reply_versions; DROP TABLE chat_reply_version_sets; ALTER TABLE chat_summary_request_settings DROP COLUMN primary_limit; ALTER TABLE group_chat_members DROP COLUMN muted; ALTER TABLE group_chat_members DROP COLUMN joined_during_plan_id; DROP TABLE group_chat_history; PRAGMA user_version=136;');
const versionBefore=data(versionUpgrade), versionRaw=createSqliteExecutor(versionUpgrade);
await assert.rejects(bootstrapSqlite({...versionRaw,execAsync:async sql=>{
 if(sql.includes('PRAGMA user_version =')) throw new Error('回复版本迁移提交失败');
 return versionRaw.execAsync(sql);
}}),/回复版本迁移提交失败/);
assert.deepEqual(data(versionUpgrade),versionBefore);
assert.equal(versionUpgrade.prepare('PRAGMA user_version').get().user_version,136);
await bootstrapSqlite(versionRaw);
assert.equal(versionUpgrade.prepare('SELECT COUNT(*) n FROM chat_reply_versions').get().n,0);
assert.deepEqual(data(versionUpgrade).filter(table=>!['chat_reply_versions','chat_reply_version_sets'].includes(table.name)),
 versionBefore.map(table=>table.name==='ai_assistants'?{...table,rows:table.rows.map(row=>Object.assign(Object.create(null),row,{show_action_steps:1,streaming_reply:null}))}:table));
assert.deepEqual(structure(versionUpgrade),schema); check(versionUpgrade); versionUpgrade.close();
const statements=[];
await bootstrapSqlite(createSqliteExecutor(db,statements));
assert.deepEqual(data(db),before);
assert.deepEqual(structure(db),schema);
assert.ok(statements.every(sql=>!/(?:ALTER|DROP|CREATE)\s/i.test(sql)),'普通启动不重放 DDL');
assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='messages'").get().seq,42);
// 公开版最终结构以108保存；正常记录全部保留，115的孤立MCP授权仍被清理。
removeNicknameSchema(db);installLegacyTriggers(db,108);db.exec('PRAGMA foreign_keys=OFF;');
db.exec("INSERT INTO mcp_server_assistants VALUES ('deleted-service','ai-proof')");
db.exec('PRAGMA foreign_keys=ON;');
await bootstrapSqlite(createSqliteExecutor(db));
assert.deepEqual(data(db),before);
assert.deepEqual(structure(db),schema);
assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='messages'").get().seq,42);check(db);
// 116 基线也通过同一组迁移进入新版，业务数据和开关保持一致。
removeNicknameSchema(db);installLegacyTriggers(db,116);
await bootstrapSqlite(createSqliteExecutor(db));
assert.deepEqual(data(db),before);assert.deepEqual(structure(db),schema);check(db);
// 117 已经具有新版词组，只升级摘要结构，不重新迁移或改写记忆关系。
removeNicknameSchema(db);installLegacySummary(db);removeServiceSchema(db);db.exec('ALTER TABLE group_chat_members DROP COLUMN muted; ALTER TABLE group_chat_members DROP COLUMN joined_during_plan_id; DROP TABLE group_chat_history; PRAGMA user_version=117');
await bootstrapSqlite(createSqliteExecutor(db));
assert.deepEqual(data(db),before);assert.deepEqual(structure(db),schema);check(db);
// 118 的旧总开关升级为两个同值的独立开关；摘要正文和处理游标不变。
db.exec(`INSERT INTO chat_summary_settings (conversation_id,enabled,inject_enabled) VALUES ('direct-proof',0,0);
 INSERT INTO chat_summary_state (conversation_id,processed_cursor) VALUES ('direct-proof','["2026-10-10T12:00:00.000Z",41,0,41]');`);
const before118=data(db);
removeNicknameSchema(db);removeServiceSchema(db);db.exec('ALTER TABLE ai_assistants DROP COLUMN show_token_usage; ALTER TABLE chat_summary_settings DROP COLUMN fixed_message_id; ALTER TABLE chat_summary_settings DROP COLUMN inject_enabled; ALTER TABLE group_chat_members DROP COLUMN muted; ALTER TABLE group_chat_members DROP COLUMN joined_during_plan_id; DROP TABLE group_chat_history; PRAGMA user_version=118;');
await bootstrapSqlite(createSqliteExecutor(db));
assert.deepEqual(data(db),before118);assert.deepEqual(structure(db),schema);check(db);
db.exec("DELETE FROM chat_summary_settings; DELETE FROM chat_summary_state;");
// 122 已发布结构增加收藏表，既有角色配置与消息不改写；升级失败整体回滚。
const favoritesUpgrade=create();await bootstrapSqlite(createSqliteExecutor(favoritesUpgrade));seed(favoritesUpgrade);
const expectedFavoritesUpgrade=data(favoritesUpgrade);
removeNicknameSchema(favoritesUpgrade);removeServiceSchema(favoritesUpgrade);favoritesUpgrade.exec('DROP TABLE chat_favorites; ALTER TABLE group_chat_members DROP COLUMN muted; ALTER TABLE group_chat_members DROP COLUMN joined_during_plan_id; DROP TABLE group_chat_history; PRAGMA user_version=122;');
const beforeFavorites=data(favoritesUpgrade), favoriteExecutor=createSqliteExecutor(favoritesUpgrade);
await assert.rejects(bootstrapSqlite({...favoriteExecutor,execAsync:async sql=>{
 if(sql.includes('PRAGMA user_version ='))throw new Error('收藏升级失败');
 return favoriteExecutor.execAsync(sql);
}}),/收藏升级失败/);
assert.deepEqual(data(favoritesUpgrade),beforeFavorites);
assert.equal(favoritesUpgrade.prepare('PRAGMA user_version').get().user_version,122);
await bootstrapSqlite(favoriteExecutor);
assert.deepEqual(data(favoritesUpgrade),expectedFavoritesUpgrade);
assert.equal(favoritesUpgrade.prepare('SELECT COUNT(*) n FROM chat_favorites').get().n,0);
assert.equal(favoritesUpgrade.prepare('PRAGMA user_version').get().user_version,DATABASE_SCHEMA_VERSION);
check(favoritesUpgrade);favoritesUpgrade.close();
// 123 升级只新增摘要任务与请求设置；旧正文、摘要和处理状态不变。
const summaryUpgrade=create();await bootstrapSqlite(createSqliteExecutor(summaryUpgrade));seed(summaryUpgrade);
const beforeSummaryUpgrade=data(summaryUpgrade);
removeNicknameSchema(summaryUpgrade);removeServiceSchema(summaryUpgrade);summaryUpgrade.exec('DROP TABLE chat_summary_tasks; DROP TABLE chat_summary_request_settings; ALTER TABLE group_chat_members DROP COLUMN muted; ALTER TABLE group_chat_members DROP COLUMN joined_during_plan_id; DROP TABLE group_chat_history; PRAGMA user_version=123;');
await bootstrapSqlite(createSqliteExecutor(summaryUpgrade));
assert.deepEqual(data(summaryUpgrade),beforeSummaryUpgrade);check(summaryUpgrade);summaryUpgrade.close();
// 124 升级新增昵称，公开名称、聊天和其他资料保持不变。
const nicknameUpgrade=create();await bootstrapSqlite(createSqliteExecutor(nicknameUpgrade));seed(nicknameUpgrade);
const beforeNicknameUpgrade=data(nicknameUpgrade);
removeNicknameSchema(nicknameUpgrade);removeServiceSchema(nicknameUpgrade);nicknameUpgrade.exec('ALTER TABLE group_chat_members DROP COLUMN muted; ALTER TABLE group_chat_members DROP COLUMN joined_during_plan_id; DROP TABLE group_chat_history; PRAGMA user_version=124;');
await bootstrapSqlite(createSqliteExecutor(nicknameUpgrade));
assert.deepEqual(data(nicknameUpgrade),beforeNicknameUpgrade);check(nicknameUpgrade);nicknameUpgrade.close();
// 建库失败不留下表或版本；重试能够正常建立。
// 125 升级保留请求参数、群归属、正文与进度；模型选择初始化为明确的所属模型模式。
const modelUpgrade=create();await bootstrapSqlite(createSqliteExecutor(modelUpgrade));seed(modelUpgrade);
modelUpgrade.exec("INSERT INTO chat_summary_request_settings(conversation_id,timeout_seconds,max_output_tokens) VALUES ('group-proof',600,2048);");
installLegacyNicknameAudit(modelUpgrade);
removeSummaryModelSchema(modelUpgrade);removeServiceSchema(modelUpgrade);modelUpgrade.exec('ALTER TABLE group_chat_members DROP COLUMN muted; ALTER TABLE group_chat_members DROP COLUMN joined_during_plan_id; DROP TABLE group_chat_history; PRAGMA user_version=125;');
await bootstrapSqlite(createSqliteExecutor(modelUpgrade));
assert.deepEqual({...modelUpgrade.prepare("SELECT * FROM chat_summary_request_settings WHERE conversation_id='group-proof'").get()},
 {conversation_id:'group-proof',timeout_seconds:600,max_output_tokens:2048,model_config_id:null,group_trigger_count:40,primary_limit:null});
check(modelUpgrade);modelUpgrade.close();
// 126 的三轮状态直接清空重建；所有其他业务资料和升级原子性保持不变。
const packageUpgrade=create();await bootstrapSqlite(createSqliteExecutor(packageUpgrade));seed(packageUpgrade);
packageUpgrade.exec("INSERT INTO chat_tool_package_exposure VALUES ('direct-proof','ai-proof','memory'); INSERT INTO chat_tool_package_exposure VALUES ('direct-proof','ai-proof','neteaseMusic');");
const packageExpected=data(packageUpgrade).map(table=>table.name==='chat_tool_package_exposure'?{...table,rows:[]}:table).filter(table=>table.rows.length>0);
installLegacyNicknameAudit(packageUpgrade);
removeServiceSchema(packageUpgrade);packageUpgrade.exec(`DROP TABLE chat_tool_package_exposure;
 CREATE TABLE chat_tool_package_exposure (
  session_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  assistant_id TEXT NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL, remaining_turns INTEGER NOT NULL CHECK(remaining_turns BETWEEN 1 AND 3),
  PRIMARY KEY(session_id,assistant_id,package_id));
 INSERT INTO chat_tool_package_exposure VALUES ('direct-proof','ai-proof','memory',1);
 INSERT INTO chat_tool_package_exposure VALUES ('direct-proof','ai-proof','neteaseMusic',3);
 ALTER TABLE chat_summary_request_settings DROP COLUMN primary_limit;
 ALTER TABLE group_chat_members DROP COLUMN muted; ALTER TABLE group_chat_members DROP COLUMN joined_during_plan_id; DROP TABLE group_chat_history; PRAGMA user_version=126;`);
const packageBefore=data(packageUpgrade), packageBeforeSchema=structure(packageUpgrade), packageRaw=createSqliteExecutor(packageUpgrade);
await assert.rejects(bootstrapSqlite({...packageRaw,execAsync:async sql=>{
 if(sql.includes('PRAGMA user_version ='))throw new Error('注入工具包迁移提交失败');
 return packageRaw.execAsync(sql);
}}),/注入工具包迁移提交失败/);
assert.deepEqual(data(packageUpgrade),packageBefore);assert.deepEqual(structure(packageUpgrade),packageBeforeSchema);
assert.equal(packageUpgrade.prepare('PRAGMA user_version').get().user_version,126);
await bootstrapSqlite(packageRaw);
assert.deepEqual(data(packageUpgrade),packageExpected);assert.deepEqual(structure(packageUpgrade),schema);
assert.equal(packageUpgrade.prepare('PRAGMA user_version').get().user_version,DATABASE_SCHEMA_VERSION);
check(packageUpgrade);packageUpgrade.close();
const failed=create();const raw=createSqliteExecutor(failed);
await assert.rejects(bootstrapSqlite({...raw,execAsync:async sql=>{
 if(sql.includes('CREATE UNIQUE INDEX'))throw new Error('注入索引失败');
 return raw.execAsync(sql);
}}),/注入索引失败/);
assert.equal(tables(failed).length,0);assert.equal(failed.prepare('PRAGMA user_version').get().user_version,0);
await bootstrapSqlite(raw);check(failed);
// 升级事务失败保留原库、版本、孤立授权；恢复启动门可按原错误回滚文件。
removeNicknameSchema(db);installLegacyTriggers(db,108);db.exec('PRAGMA foreign_keys=OFF;');
db.exec("INSERT INTO mcp_server_assistants VALUES ('deleted-service','ai-proof')");db.exec('PRAGMA foreign_keys=ON;');
const beforeFailed=data(db), upgradeRaw=createSqliteExecutor(db);
await assert.rejects(bootstrapSqlite({...upgradeRaw,execAsync:async sql=>{
 if(sql.includes('PRAGMA user_version ='))throw new Error('注入版本提交失败');
 return upgradeRaw.execAsync(sql);
}}),/注入版本提交失败/);
assert.deepEqual(data(db),beforeFailed);assert.equal(db.prepare('PRAGMA user_version').get().user_version,108);
await bootstrapSqlite(upgradeRaw);check(db);
// 不支持的旧开发结构和未来版本在任何写入前失败。
const unsupported=create();removeServiceSchema(unsupported);unsupported.exec('CREATE TABLE development_only (id TEXT); PRAGMA user_version=108;');
const original=structure(unsupported);
await assert.rejects(bootstrapSqlite(createSqliteExecutor(unsupported)),/开发版本/);assert.deepEqual(structure(unsupported),original);
unsupported.exec(`PRAGMA user_version=${DATABASE_SCHEMA_VERSION+1}`);await assert.rejects(bootstrapSqlite(createSqliteExecutor(unsupported)),/不受当前版本支持/);
// 恢复出厂保留schema/version并清空所有应用表，随后正常启动补回默认记录。
failed.exec('PRAGMA foreign_keys=OFF;');for(const table of tables(failed))failed.exec(`DELETE FROM "${table}"`);failed.exec('PRAGMA foreign_keys=ON;');
await bootstrapSqlite(createSqliteExecutor(failed));
for(const name of ['user_profile','host_ai_relationship_state','memory_model_settings','memory_v3_state','speech_recognition_settings','translation_settings','model_service_settings'])assert.equal(failed.prepare(`SELECT COUNT(*) c FROM ${name}`).get().c,1);
check(failed);
for(const database of [db,failed,unsupported])database.close();
console.log('数据库基线验证通过：新建库、当前公开版升级、正文/向量/摘要/授权保留、版本原子性、幂等、恢复出厂和外键完整性');
