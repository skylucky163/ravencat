/** 验证代码独立分泡、流式稳定、逐字复制、快照事务和来源删除后的数据保留。 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadTypeScriptModule as load } from '../../helpers/load-typescript-module.mjs';
import { createChatMessageMutationFixture, load as loadReact } from '../../helpers/chat-message-mutation-fixture.mjs';
import { bootstrapSqlite, createSqliteExecutor, DATABASE_SCHEMA_VERSION, loadSqliteModule } from '../../helpers/sqlite-bootstrap-fixture.mjs';
import React from 'react';
import { act, create } from 'react-test-renderer';

const code = load('src/features/chat/messages/domain/ChatCodeBlock.ts');
const segmentation = load('src/features/chat/reply/application/AssistantReplySegmentation.ts', { '../../messages/domain/ChatCodeBlock': code });
const fenced = '```html\n<!doctype html>\n<html><head><title>小花园</title></head>\n\n<body>\n<script>\n' + 'const text = "空行与分号都要保留。";\n'.repeat(20) + '</script>\n</body></html>\n```';

for (const mode of ['single-bubble', 'multi-bubble']) {
  assert.deepEqual(segmentation.segmentAssistantReplyText(`开始说明\n${fenced}\n结束说明`, mode), ['开始说明', fenced, '结束说明']);
  assert.deepEqual(segmentation.segmentAssistantReplyText(`${fenced}\n${fenced}`, mode), [fenced, fenced]);
  for (const sample of [
    `说明\n\n${fenced}\n\n后续`,
    '````html\n<script>const fence = "```";</script>\n```\n````\n解释',
    '~~~html\r\n<div>🙂</div>\r\n\r\n~~~\r\n后续',
    '解释\n   ```js\n  const value = 1;  \n   ```\n结束',
    '第一段\n\n`行内代码`不会隐藏到整轮结束',
    '```html\n<div>没有闭合围栏\n  ',
  ]) {
    let previous = [];
    for (let end = 1; end <= sample.length; end++) {
      const next = segmentation.segmentAssistantReplyProgress(sample.slice(0, end), mode, false);
      previous.forEach((part, index) => {
        assert.ok(next[index]?.text.startsWith(part.text), `${mode} 第 ${end} 个字符使已展示内容回缩`);
        if (part.completed) assert.deepEqual(next[index], part, '已闭合消息不得搬动或改写');
      });
      previous = next;
    }
    const final = segmentation.segmentAssistantReplyProgress(sample, mode, true);
    assert.deepEqual(final.map(part => part.text), previous.map(part => part.text));
    assert.deepEqual(final.map(part => part.text), segmentation.segmentAssistantReplyText(sample, mode));
  }
}
const block = code.readChatCodeBlock(fenced);
assert.equal(block.complete, true);
assert.equal(block.source, fenced.slice('```html\n'.length, -3));
assert.equal(code.chatCodeTitle(block), '小花园');
assert.equal(code.canRenderChatCode(block), true);
assert.equal(code.readChatCodeBlock('```html\n<div>未完成\n  ').complete, false);
assert.equal(code.canRenderChatCode(code.readChatCodeBlock('```html\n<div>未完成')), false);
assert.equal(code.canRenderChatCode(code.readChatCodeBlock('```python\nprint(1)\n```')), false);
assert.equal(code.canRenderChatCode(code.readChatCodeBlock('```\n<!doctype html><div>无语言标记</div>\n```')), true);
assert.equal(code.readChatCodeBlock('`行内代码`'), null);
assert.equal(code.readChatCodeBlock(`${fenced}\n其他内容`), null);

const db = new DatabaseSync(':memory:');
await bootstrapSqlite(createSqliteExecutor(db));
const fixture = createChatMessageMutationFixture(db);
const { messages, codePreviews, metadata } = fixture;
db.exec('PRAGMA foreign_keys = ON');
for (const [id, agentId] of [['code-ai', 'code-agent'], ['other-ai', 'other-agent']]) {
  db.prepare('INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(id, agentId, id, 'test-model', '2026-11-10', '2026-11-10');
}
db.prepare("INSERT INTO chat_conversations(id,kind) VALUES(?,'direct')").run('code-chat');
db.prepare('INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)')
  .run('code-chat', 'code-ai', '代码预览', '2026-11-10', '2026-11-10');
const message = (text, clientMessageId) => ({ sessionId: 'code-chat', agentId: 'code-agent', text, clientMessageId, isMe: false,
  senderType: 'assistant', status: 'sent', createdAt: '2026-11-10T00:00:00.000Z', time: '08:00' });
const actions = load('src/features/chat/messages/domain/ChatMessageActions.ts', {
  './ChatCodeBlock': code,
  './ChatAttachment': load('src/features/chat/messages/domain/ChatAttachment.ts'),
  './chatMessageMetadata': metadata,
});
const editing = load('src/features/chat/messages/domain/ChatMessageEditing.ts', { './ChatCodeBlock': code, './chatMessageMetadata': metadata });
const presentation = load('src/features/chat/presentation/messages/components/chatMessagePresentation.ts', {
  '../../../messages/domain/ChatCodeBlock': code, '@features/chat/messages/domain': metadata,
});
try {
  const saved = await messages.commitMessage({ message: message(fenced, 'code-one'), previewText: '网页' });
  const preview = await codePreviews.get('code-one');
  assert.equal(preview.source, block.source);
  assert.equal(preview.title, '小花园');
  assert.equal(preview.canRender, true);
  assert.equal(preview.agentId, 'code-agent');
  assert.equal(preview.inLibrary, false, '生成网页不自动加入作品库');
  assert.deepEqual(await codePreviews.listLibrary('code-ai'), []);
  assert.equal(db.prepare('SELECT source_message_id FROM chat_code_previews WHERE id = ?').get('code-one').source_message_id, saved.id);
  assert.equal(actions.getChatMessageActions(saved).quote, true);
  assert.equal(actions.getChatMessageActions(saved).translate, false);
  assert.equal(actions.getChatMessageActions(saved).favorite, false);
  assert.equal(editing.canEditChatMessage(saved), false);

  const items = ['前文一', '前文二', fenced, '后文一', '后文二'].map((text, index) => ({ ...saved, id: index + 100, text, logicalMessageId: 'same-reply', segmentIndex: index }));
  assert.deepEqual(presentation.collapseAssistantSegmentsForPresentation(items, { enableAssistantMessageSegmentation: false })
    .map(item => item.text), ['前文一\n\n前文二', fenced, '后文一\n\n后文二']);

  const snapshot = { ...preview, id: 'opened-before-t3' };
  await fixture.persistence.databaseCoordinator.transaction({}, tx => codePreviews.saveInTransaction(tx, snapshot, null));
  const committed = await messages.commitMessage({ message: message(fenced, snapshot.id), previewText: '网页' });
  assert.equal(db.prepare('SELECT source_message_id FROM chat_code_previews WHERE id = ?').get(snapshot.id).source_message_id, committed.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_code_previews WHERE id = ?').get(snapshot.id).n, 1);

  await codePreviews.setInLibrary('code-one', true, 'code-one.jpg');
  await codePreviews.setInLibrary('code-one', true, 'code-one.jpg');
  assert.equal((await codePreviews.get('code-one')).inLibrary, true);
  assert.equal((await codePreviews.listLibrary('code-ai')).length, 1, '重复加入同一版本只有一条记录');
  assert.deepEqual(await codePreviews.listLibrary('other-ai'), [], '作品库按真实来源 AI 隔离');
  await codePreviews.setInLibrary(snapshot.id, true);
  assert.equal((await codePreviews.listLibrary('code-ai')).length, 2, '同名网页的两个源码快照可以同时收纳');
  const listed = await codePreviews.listLibrary('code-ai');
  assert.ok(listed.every(item => 'coverFile' in item && !('source' in item) && !('excerpt' in item)), '列表只读取卡片摘要与封面文件名');
  assert.equal(listed.find(item => item.id === 'code-one').coverFile, 'code-one.jpg', '收纳时记录封面文件名');
  const removedCover = await codePreviews.setInLibrary('code-one', false);
  assert.equal(removedCover, 'code-one.jpg', '移出时归还封面文件名供调用方清理');
  assert.equal((await codePreviews.get('code-one')).source, block.source, '移出作品库不改写源码');
  assert.equal((await messages.getMessageById(saved.id)).text, fenced, '移出作品库不删除消息');
  await codePreviews.setInLibrary('code-one', true);
  assert.equal((await codePreviews.listLibrary('code-ai')).length, 2, '移出的版本可以再次加入');
  assert.equal((await codePreviews.listLibrary('code-ai')).find(item => item.id === 'code-one').coverFile, null, '再次加入未带截图时不伪造封面');
  assert.equal((await codePreviews.get('code-one')).source, block.source);
  await codePreviews.saveInTransaction(fixture.persistence.databaseCoordinator.openTaskExecutor(), {
    id: 'non-html', agentId: 'code-agent', language: 'python', source: 'print(1)', title: 'Python', canRender: false, createdAt: preview.createdAt,
  }, null);
  await assert.rejects(codePreviews.setInLibrary('non-html', true), /完整网页/);
  await assert.rejects(codePreviews.setInLibrary('missing-preview', true), /不存在/);

  await assert.rejects(fixture.persistence.databaseCoordinator.transaction({}, async tx => {
    await messages.commitMessageInTransaction(tx, { message: message(fenced, 'rollback-code'), previewText: '网页' });
    throw new Error('模拟本轮提交回滚');
  }), /模拟本轮提交回滚/);
  assert.equal(await codePreviews.get('rollback-code'), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE client_message_id = ?').get('rollback-code').n, 0);
  await messages.commitMessage({ message: message('```html\n<div>未完成', 'incomplete-code'), previewText: '未完成' });
  assert.equal(await codePreviews.get('incomplete-code'), null);
  db.prepare('DELETE FROM messages WHERE id = ?').run(saved.id);
  assert.equal((await codePreviews.get('code-one')).source, block.source);
  assert.equal(db.prepare('SELECT source_message_id FROM chat_code_previews WHERE id = ?').get('code-one').source_message_id, null);
  assert.equal((await codePreviews.get('code-one')).inLibrary, true, '删除来源消息不撤销已收纳版本');
  assert.equal((await codePreviews.listLibrary('code-ai')).length, 2, '消息删除后仍按快照作者读取作品');
  const fileOps = { copies: [], deletes: [] };
  const coverRoot = 'file:///document/persistent-media/covers/chat-code/';
  let coverSequence = 0;
  const deviceStubs = {
    '@platform/device': { getPersistentMediaRootUri: () => 'file:///document/persistent-media/' },
    '@platform/device/DeviceMediaService': {
      PERSISTENT_IMAGE_CATEGORY: { chatCodeCover: 'chatCodeCover' },
      getPersistentImageCategoryPrefix: () => 'covers/chat-code/',
      copyPickedImageToAppStorage: async ({ sourceUri, entityId, compression }) => {
        if (sourceUri === 'file:///tmp/broken.jpg') throw new Error('模拟封面落盘失败');
        fileOps.copies.push([sourceUri, entityId, compression?.maxWidth ?? null]);
        return `${coverRoot}${entityId}_${++coverSequence}.jpg`;
      },
      deleteManagedPersistentImageIfExists: async uri => { fileOps.deletes.push(uri); return true; },
    },
  };
  const application = load('src/features/chat/messages/application/ChatCodePreview.ts', {
    '@platform/persistence': fixture.persistence,
    '@shared/runtime/RuntimeSlot': load('src/shared/runtime/RuntimeSlot.ts'),
    '../domain/ChatCodeBlock': code,
    '../domain/ChatCodePreview': fixture.codeWorkDomain,
    ...deviceStubs,
  });
  application.configureChatCodePreview(codePreviews);
  let committedChanges = 0;
  const unsubscribe = application.subscribeChatCodeLibraryChanged(() => { committedChanges++; });
  await application.setChatCodeInLibrary('code-one', false);
  assert.equal(committedChanges, 1, '成功提交后发布收纳变化');
  assert.equal((await codePreviews.get('code-one')).inLibrary, false);
  await assert.rejects(application.setChatCodeInLibrary('missing-preview', true), /不存在/);
  assert.equal(committedChanges, 1, '保存失败不发布成功事实');
  await application.setChatCodeInLibrary('code-one', true, 'file:///tmp/capture.jpg');
  assert.equal(committedChanges, 2);
  assert.deepEqual(fileOps.copies, [['file:///tmp/capture.jpg', 'code-one', null]], '截图落盘到备份媒体根');
  assert.equal((await codePreviews.listLibrary('code-ai')).find(item => item.id === 'code-one').coverFile, 'code-one_1.jpg');
  assert.equal(application.chatCodeCoverUri('code-one_1.jpg'), `${coverRoot}code-one_1.jpg`, '列表只通过本层把文件名解析成可加载地址');
  await application.updateChatCodeCover('code-one', 'file:///picked.jpg', 1600);
  assert.deepEqual(fileOps.copies.at(-1), ['file:///picked.jpg', 'code-one', 1080], '用户上传封面按 4:3 裁剪后压缩落盘');
  assert.equal((await codePreviews.listLibrary('code-ai')).find(item => item.id === 'code-one').coverFile, 'code-one_2.jpg');
  assert.deepEqual(fileOps.deletes, [`${coverRoot}code-one_1.jpg`], '换封面 commit 后定向删旧封面');
  await application.setChatCodeInLibrary('code-one', false);
  assert.deepEqual(fileOps.deletes.at(-1), `${coverRoot}code-one_2.jpg`, '移出作品库后清理封面文件');
  await application.setChatCodeInLibrary('code-one', true, 'file:///tmp/broken.jpg');
  assert.equal((await codePreviews.get('code-one')).inLibrary, true, '截图落盘失败不阻断收纳');
  assert.equal((await codePreviews.listLibrary('code-ai')).find(item => item.id === 'code-one').coverFile, null, '失败不伪造封面引用');
  await assert.rejects(application.updateChatCodeCover('missing-preview', 'file:///picked.jpg'), /不在作品库/);
  assert.equal(fileOps.deletes.at(-1), `${coverRoot}missing-preview_3.jpg`, '事务拒绝时清掉已落盘但无引用的封面');
  unsubscribe();
} finally { db.close(); }

/** 170～173 的夹具恢复当时的服务表与时刻列，不能只把当前库改成旧版本号。 */
function prepareCodePreviewUpgrade(database, version) {
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM model_service_configs').get().count, 0);
  database.exec('DROP TABLE model_service_configs; DROP TABLE model_service_groups;');
  database.exec(loadSqliteModule('modelServiceSchema').LEGACY_MODEL_SERVICE_SCHEMA);
  database.exec('ALTER TABLE moments DROP COLUMN edited_at; ALTER TABLE moments DROP COLUMN edit_revision;');
  database.exec(`PRAGMA user_version=${version};`);
}

const upgrade = new DatabaseSync(':memory:');
try {
  const executor = createSqliteExecutor(upgrade);
  await bootstrapSqlite(executor);
  upgrade.exec('DROP TABLE chat_code_previews;');
  prepareCodePreviewUpgrade(upgrade, 170);
  await bootstrapSqlite(executor);
  assert.ok(upgrade.prepare("SELECT 1 FROM sqlite_master WHERE name='chat_code_previews'").get());
  assert.equal(upgrade.prepare('PRAGMA user_version').get().user_version, DATABASE_SCHEMA_VERSION);
  upgrade.exec(`DROP TABLE chat_code_library; ALTER TABLE chat_code_previews DROP COLUMN agent_id;
    INSERT INTO ai_assistants(id, agent_id, name, model, created_at, updated_at)
      VALUES ('migration-ai','migration-agent','测试 AI','test','2026-11-11','2026-11-11');
    INSERT INTO sessions(id, ai_assistant_id, name, created_at, updated_at)
      VALUES ('migration-session','migration-ai','测试','2026-11-11','2026-11-11');
    INSERT INTO chat_conversations(id, kind) VALUES ('migration-session','direct');
    INSERT INTO messages(session_id, agent_id, text, is_me, sender_type, time, created_at)
      VALUES ('migration-session','migration-agent','旧网页',0,'assistant','00:00','2026-11-11');
    INSERT INTO chat_code_previews(id, language, source, title, can_render, created_at, source_message_id)
      VALUES ('old-preview','html','<button>旧网页</button>','旧网页',1,'2026-11-11',last_insert_rowid());`);
  prepareCodePreviewUpgrade(upgrade, 171);
  await bootstrapSqlite(executor);
  assert.equal(upgrade.prepare('SELECT agent_id FROM chat_code_previews WHERE id = ?').get('old-preview').agent_id, 'migration-agent');
  assert.ok(upgrade.prepare("PRAGMA table_info('chat_code_library')").all().some(column => column.name === 'cover_file'), '旧库升级补齐封面列');
  assert.equal(upgrade.prepare('SELECT COUNT(*) AS n FROM chat_code_library').get().n, 0, '升级不把旧网页自动加入作品库');
  assert.deepEqual(upgrade.prepare('PRAGMA foreign_key_check').all(), []);
  upgrade.exec('ALTER TABLE chat_code_library DROP COLUMN cover_file;');
  prepareCodePreviewUpgrade(upgrade, 172);
  await bootstrapSqlite(executor);
  assert.ok(upgrade.prepare("PRAGMA table_info('chat_code_library')").all().some(column => column.name === 'cover_file'), '172 老库升级补上封面列');
  assert.equal(upgrade.prepare('PRAGMA user_version').get().user_version, DATABASE_SCHEMA_VERSION);
  upgrade.exec("INSERT INTO chat_code_library(preview_id, added_at, cover_file) VALUES ('old-preview', '2026-11-11', 'old-location.jpg');");
  prepareCodePreviewUpgrade(upgrade, 173);
  await bootstrapSqlite(executor);
  assert.equal(upgrade.prepare('SELECT cover_file FROM chat_code_library WHERE preview_id = ?').get('old-preview').cover_file, null,
    '173 旧位置的封面引用升级时置空，避免备份指向未归档文件');
  assert.equal(upgrade.prepare('PRAGMA user_version').get().user_version, DATABASE_SCHEMA_VERSION);
  assert.deepEqual(upgrade.prepare('PRAGMA foreign_key_check').all(), []);
} finally { upgrade.close(); }

// 真实组件只把有界摘要交给原生 Text；打开与复制消费完整源码。
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const theme = load('src/shared/theme/themes/defaultLight.ts').defaultLightTheme;
const native = { Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: value => value, hairlineWidth: 1 }, ToastAndroid: { show() {}, SHORT: 0 } };
const themeApi = { useTheme: () => theme, useThemedStyles: factory => factory(theme) };
const navigation = loadReact('src/features/chat/presentation/messages/components/ChatCodeNavigation.tsx');
const prepared = [], navigated = [], copied = [], longPressed = [];
const { default: Card } = loadReact('src/features/chat/presentation/messages/components/ChatCodeCard.tsx', {
  'react-native': native, '@shared/theme': themeApi,
  '@shopify/flash-list': { useRecyclingState: initial => React.useState(initial) },
  'lucide-react-native': { ChevronRight: 'ChevronRight', Code2: 'Code2', Globe2: 'Globe2' },
  '@shared/ui': { showAppDialog: error => { throw new Error(error.message); } },
  '../../../messages/application/ChatCodePreview': { prepareChatCodePreview: async (...args) => { prepared.push(args); } },
  '../../../messages/domain/ChatCodeBlock': code,
  './ChatCodeNavigation': navigation,
});
const longBlock = { ...block, source: block.source.repeat(1000) };
let card;
act(() => { card = create(React.createElement(navigation.ChatCodeNavigationProvider, { openPreview: id => navigated.push(id) },
  React.createElement(Card, { block: longBlock, previewId: 'long-code', sourceMessageId: null, agentId: 'code-agent', generating: false,
    onLongPress: point => longPressed.push(point) }))); });
assert.ok(JSON.stringify(card.toJSON()).length < 6000, '长代码卡的原生渲染内容必须保持有界');
const cardButton = card.root.findByType('Pressable');
act(() => cardButton.props.onLongPress({ nativeEvent: { pageX: 30, pageY: 50 } }));
assert.deepEqual(longPressed, [{ x: 30, y: 50 }]);
await act(async () => { cardButton.props.onPress(); });
assert.equal(prepared[0][1].source, longBlock.source);
assert.equal(prepared[0][3], 'code-agent', '打开运行片段时同步保留真实作者');
assert.deepEqual(navigated, ['long-code']);
act(() => card.unmount());

const { default: SourceView } = loadReact('src/features/chat/presentation/messages/ChatCodeSourceView.tsx', {
  'react-native': native, '@shared/theme': themeApi,
  'lucide-react-native': { Copy: 'Copy' }, '@platform/device': { copyTextToClipboard: text => copied.push(text), TextSelectionScrollView: 'ScrollView' },
});
for (const source of ['', block.source, 'a'.repeat(3999) + '🙂' + 'b'.repeat(16000), longBlock.source]) {
  let sourceView;
  act(() => { sourceView = create(React.createElement(SourceView, { source, language: 'html' })); });
  const selectableText = sourceView.root.findAllByType('Text').filter(node => node.props.selectable);
  assert.equal(selectableText.length, 1, '完整源码应在连续的原生文字选区中，可跨任意行选择');
  assert.equal(selectableText[0].props.children, source, '源码显示必须逐字保留原文');
  act(() => sourceView.root.findByProps({ accessibilityLabel: '复制全部源码' }).props.onPress());
  assert.equal(copied.at(-1), source, '全文复制必须逐字保留原文');
  act(() => sourceView.unmount());
}

console.log('聊天代码预览验证通过：代码独立分泡、任意 delta 稳定、源码逐字复制、卡片交互、作品库手动收纳与自定义封面、封面落盘失败清理、同名版本隔离、删除与再次加入、快照事务与 170/171/172/173 升级。');
