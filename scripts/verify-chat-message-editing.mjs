/** 验证真实改写事务、预览、并发冲突与菜单行为，不读取用户数据库。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createChatMessageMutationFixture, load } from './helpers/chat-message-mutation-fixture.mjs';

const require = createRequire(import.meta.url);
const { db, metadata, persistence, messages, groups } = createChatMessageMutationFixture();
const policy = load('src/features/chat/messages/domain/ChatMessageEditing.ts', { './chatMessageMetadata': metadata });
const patches = [];
const { editChatMessage } = load('src/features/chat/messages/application/EditChatMessage.ts', {
  '@platform/persistence': persistence,
  './ChatMessageRuntime': { getChatMessageRuntimeDependencies: () => ({ messages }) },
  '../../group/application/ChatGroupRuntime': { getChatGroupRuntimeDependencies: () => ({ groups }) },
  '../domain/chatMessageMetadata': metadata,
  '../domain/ChatMessageEditing': policy,
  '../events/ChatEvents': { emitChatMessagesPatched: (patch) => patches.push(patch), emitChatTurnExecutionChanged() {} },
});
const time = '2026-10-07T08:00:00.000Z';
function insert(session, text, sender = 'user', metadataJson = null) {
  return Number(db.prepare(`INSERT INTO messages
    (session_id, text, sender_type, is_me, created_at, time, metadata_json, agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'agent-a')`).run(session, text, sender, Number(sender === 'user'), time, time, metadataJson).lastInsertRowid);
}
const edit = (id, expectedText, text) => editChatMessage({ messageId: id, expectedText, text });
db.prepare('INSERT INTO sessions VALUES (?, ?, ?, NULL, ?)').run('single', '旧正文', time, time);
const first = insert('single', '旧正文');
const edited = await edit(first, '旧正文', '  新正文\n第二行  ');
assert.equal(edited.text, '新正文\n第二行');
assert.equal(edited.senderType, 'user');
assert.equal(edited.agentId, 'agent-a');
assert.equal(edited.createdAt, time);
assert.deepEqual({ ...db.prepare('SELECT last_message, last_time FROM sessions').get() }, { last_message: edited.text, last_time: time });
assert.deepEqual(patches.at(-1), { sessionId: 'single', updatedMessageIds: [first] });
const latest = insert('single', '最新 AI', 'assistant');
db.prepare('UPDATE sessions SET last_message = ?').run('最新 AI');
await edit(first, edited.text, '历史消息改写');
assert.equal(db.prepare('SELECT last_message FROM sessions').get().last_message, '最新 AI');
await edit(latest, '最新 AI', '手动改写 AI');
assert.equal(db.prepare('SELECT sender_type FROM messages WHERE id = ?').get(latest).sender_type, 'assistant');
assert.equal(db.prepare('SELECT last_message FROM sessions').get().last_message, '手动改写 AI');

// 清历史后的隐藏消息不能复活预览。
db.prepare("UPDATE sessions SET visible_after_message_id = ?, last_message = ''").run(latest);
await edit(latest, '手动改写 AI', '隐藏消息改写');
assert.equal(db.prepare('SELECT last_message FROM sessions').get().last_message, '');

const groupOld = insert('group', '群旧话');
const groupLatest = insert('group', '群 AI', 'assistant');
db.prepare('INSERT INTO group_chats VALUES (?, ?, ?, ?, ?)').run('group', '群 AI', time, groupLatest, time);
await edit(groupOld, '群旧话', '改写群旧话');
assert.equal(db.prepare('SELECT last_message FROM group_chats').get().last_message, '群 AI');
await edit(groupLatest, '群 AI', '改写群 AI');
assert.deepEqual({ ...db.prepare('SELECT last_message, last_time, last_message_id FROM group_chats').get() }, {
  last_message: '改写群 AI', last_time: time, last_message_id: groupLatest,
});

const count = patches.length;
await assert.rejects(edit(groupLatest, '过期正文', '覆盖'), /正文已发生变化/u);
await assert.rejects(edit(groupLatest, '改写群 AI', '  '), /不能为空/u);
await assert.rejects(edit(9999, '', '不存在'), /已被删除/u);
assert.equal(patches.length, count, '失败不发布已提交事实');
const races = await Promise.allSettled([
  edit(groupLatest, '改写群 AI', '并发 A'), edit(groupLatest, '改写群 AI', '并发 B'),
]);
assert.equal(races.filter((result) => result.status === 'fulfilled').length, 1);
assert.equal(db.prepare('SELECT last_message FROM group_chats').get().last_message, '并发 A');

// 群预览写失败时，正文也必须回滚。
db.exec("CREATE TRIGGER fail_group_preview BEFORE UPDATE ON group_chats BEGIN SELECT RAISE(ABORT, 'preview failure'); END;");
await assert.rejects(edit(groupLatest, '并发 A', '不能只保存正文'), /preview failure/u);
assert.equal(db.prepare('SELECT text FROM messages WHERE id = ?').get(groupLatest).text, '并发 A');
db.exec('DROP TRIGGER fail_group_preview');
for (const [sender, meta, status] of [
  ['reasoning', null, 'sent'], ['user', null, 'pending'],
  ['assistant', JSON.stringify({ kind: 'voice', voice: {
    schemaVersion: 1, mediaAssetId: 'voice-a', mimeType: 'audio/aac', durationMs: 1000, transcriptSource: 'assistant_source_text',
  } }), 'sent'],
  ['user', JSON.stringify({ kind: 'sticker', sticker: {
    stickerId: 'sticker-a', mediaAssetId: 'sticker-media', name: '表情', description: null, tags: [],
    emotion: null, mimeType: 'image/png', width: 10, height: 10, isAnimated: false,
  } }), 'sent'],
  ['user', JSON.stringify({ type: 'callStatus' }), 'sent'],
  ['user', JSON.stringify({ kind: 'image' }), 'sent'],
]) {
  const id = insert('single', '不能改写', sender, meta);
  db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, id);
  await assert.rejects(edit(id, '不能改写', '禁止修改'), /不能改写/u);
}
const attachmentMetadata = JSON.stringify({ kind: 'mixed', attachments: [{ type: 'image', mediaAssetId: 'image-a', fileName: '图片' }] });
const mixed = insert('single', '图文正文', 'user', attachmentMetadata);
const mixedEdited = await edit(mixed, '图文正文', '改写图文正文');
assert.equal(mixedEdited.metadataJson, attachmentMetadata, '改写不得更换附件或其它原消息事实');
assert.equal(db.prepare('SELECT last_message FROM sessions').get().last_message, '[图片] 改写图文正文');
const deleted = insert('single', '稍后删除');
db.prepare('DELETE FROM messages WHERE id = ?').run(deleted);
await assert.rejects(edit(deleted, '稍后删除', '不复活'), /已被删除/u);

// 剪贴板传入完整正文，包括换行。
let copied;
const clipboard = load('src/platform/device/Clipboard.ts', {
  'react-native': { Clipboard: { setString: (text) => { copied = text; } } },
  // Clipboard 重新导出原生读能力；本用例只验证写入，读取必须显式失败。
  '../../../modules/device-observer': { readDeviceClipboardText: async () => { throw new Error('复制用例不读取系统剪贴板'); } },
});
clipboard.copyTextToClipboard('正文\n第二行');
assert.equal(copied, '正文\n第二行');

// 改写和删除原消息不重写已发送引用；提交引用时保留调用方提供的快照。
db.prepare('INSERT INTO sessions VALUES (?, ?, ?, NULL, ?)').run('quotes', '被引用原文', time, time);
const quoteSource = insert('quotes', '被引用原文');
const quotedReply = await messages.commitMessage({ message: {
  sessionId: 'quotes', text: '引用回复', senderType: 'assistant', isMe: false,
  time, createdAt: time, replyToId: quoteSource, replyToText: '被引用原文',
}, previewText: '引用回复' });
await edit(quoteSource, '被引用原文', '改写后的原文');
assert.equal((await messages.getMessageById(quotedReply.id)).replyToText, '被引用原文');
await messages.deleteMessagesWithMediaCandidates([quoteSource]);
assert.equal((await messages.getMessageById(quotedReply.id)).replyToText, '被引用原文');
const sentDraft = await messages.commitMessage({ message: {
  sessionId: 'quotes', text: '发送引用草稿', senderType: 'user', isMe: true,
  time, createdAt: time, replyToId: quoteSource, replyToText: '草稿中的引用快照',
}, previewText: '发送引用草稿' });
assert.equal(sentDraft.replyToText, '草稿中的引用快照');

// 真实渲染菜单：消息能力只影响启用状态，操作位置与菜单尺寸保持稳定。
const React = require('react');
const renderer = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: Menu } = load('src/features/chat/presentation/messages/components/ChatMessageActionMenu.tsx', {
  'react-native': {
    Modal: 'Modal', View: 'View', Text: 'Text', TouchableOpacity: 'Button', TouchableWithoutFeedback: 'Backdrop',
    StyleSheet: { create: (styles) => styles }, useWindowDimensions: () => ({ width: 400, height: 800 }),
  },
  '@expo/vector-icons': { Ionicons: 'Icon' },
  'lucide-react-native': { History: 'Icon', Pin: 'Icon', PinOff: 'Icon', Star: 'Icon', TextSelect: 'Icon' },
  '@shared/theme': { useTheme: () => ({ mode: 'light', colors: { brand: { onPrimary: 'white' }, text: { primary: 'black' }, border: { strong: 'gray' } } }) },
});
let rendered;
let copyCalls = 0;
let closeCalls = 0;
await renderer.act(async () => {
  rendered = renderer.create(React.createElement(Menu, {
    visible: true, onClose: () => closeCalls++, onCopy: () => copyCalls++, onRewrite: () => {}, onDelete: () => {},
  }));
});
const buttons = rendered.root.findAllByType('Button');
const labels = ['复制', '选择文字', '改写', '重写', '历史版本', '删除', '多选', '固定', '转文字', '引用', '翻译', '分享', '收藏'];
assert.deepEqual(buttons.map((button) => button.props.accessibilityLabel), labels);
const menuGeometry = () => rendered.root.findAllByType('View')
  .find((node) => Array.isArray(node.props.style) && node.props.style[1]?.width).props.style[1];
const initialGeometry = menuGeometry();
for (const label of labels.filter((label) => !['复制', '改写', '删除'].includes(label))) {
  const placeholder = buttons.find((button) => button.props.accessibilityLabel === label);
  assert.equal(placeholder.props.disabled, true);
  assert.equal(placeholder.props.accessibilityState.disabled, true);
  assert.equal(placeholder.props.onPress, undefined);
}
await renderer.act(async () => buttons[0].props.onPress());
assert.equal(copyCalls, 1);
assert.equal(closeCalls, 1);
let multiCalls = 0;
let shareCalls = 0;
await renderer.act(async () => rendered.update(React.createElement(Menu, {
  visible: true, onClose: () => closeCalls++, onMultiSelect: () => multiCalls++, onForward: () => shareCalls++,
})));
assert.deepEqual(rendered.root.findAllByType('Button').map((button) => button.props.accessibilityLabel), labels);
assert.deepEqual(menuGeometry(), initialGeometry, '可用操作减少不能改变菜单尺寸与锚点');
for (const label of ['多选', '分享']) {
  const enabled = rendered.root.findAllByType('Button').find((button) => button.props.accessibilityLabel === label);
  assert.equal(enabled.props.disabled, false);
  await renderer.act(async () => enabled.props.onPress());
}
assert.equal(multiCalls, 1);
assert.equal(shareCalls, 1);
assert.equal(closeCalls, 3);
let transcriptCalls = 0;
await renderer.act(async () => rendered.update(React.createElement(Menu, {
  visible: true, onClose: () => closeCalls++, onToggleVoiceTranscript: () => transcriptCalls++,
})));
assert.deepEqual(rendered.root.findAllByType('Button').map((button) => button.props.accessibilityLabel), labels);
assert.deepEqual(menuGeometry(), initialGeometry, '语音操作启用时不能挤动其他操作');
await renderer.act(async () => rendered.root.findByProps({ accessibilityLabel: '转文字' }).props.onPress());
assert.equal(transcriptCalls, 1);
assert.equal(closeCalls, 4);
await renderer.act(async () => rendered.update(React.createElement(Menu, {
  visible: true, onClose() {}, onToggleVoiceTranscript() {}, isVoiceTranscriptExpanded: true,
})));
assert.deepEqual(rendered.root.findAllByType('Button').map((button) => button.props.accessibilityLabel),
  labels.map((label) => label === '转文字' ? '收起文字' : label));
await renderer.act(async () => rendered.update(React.createElement(Menu, { visible: true, onClose() {} })));
assert.equal(rendered.toJSON(), null, '没有可执行操作时不显示菜单');
await renderer.act(async () => rendered.unmount());

// 保存失败保留草稿；取消不写入，成功后返回原消息的已提交版本。
let saveInput;
let failSave = true;
const { default: Editor } = load('src/features/chat/presentation/messages/components/ChatMessageEditor.tsx', {
  'react-native': { StyleSheet: { create: (styles) => styles }, View: 'View' },
  '@shared/ui': { ModalSheet: 'Sheet', Button: 'Button', InputField: 'Input' },
  '@shared/theme': { useTheme: () => ({ spacing: { lg: 16 } }) },
  '../../../messages/application/EditChatMessage': { editChatMessage: async (input) => {
    saveInput = input;
    if (failSave) throw new Error('写入失败');
    return { ...edited, text: input.text };
  } },
});
let saved;
let editorCloseCalls = 0;
await renderer.act(async () => {
  rendered = renderer.create(React.createElement(Editor, {
    message: edited, onClose: () => editorCloseCalls++, onSaved: (message) => { saved = message; },
  }));
});
await renderer.act(async () => rendered.root.findByType('Input').props.onChangeText('我的修改草稿'));
await renderer.act(async () => rendered.root.findAllByType('Button').find((button) => button.props.title === '保存').props.onPress());
assert.equal(rendered.root.findByType('Input').props.value, '我的修改草稿');
assert.equal(rendered.root.findByType('Input').props.error, '写入失败');
assert.equal(editorCloseCalls, 0);
assert.equal(saved, undefined);
failSave = false;
await renderer.act(async () => rendered.root.findAllByType('Button').find((button) => button.props.title === '保存').props.onPress());
assert.deepEqual(saveInput, { messageId: edited.id, expectedText: edited.text, text: '我的修改草稿' });
assert.equal(saved.text, '我的修改草稿');
assert.equal(editorCloseCalls, 1);
await renderer.act(async () => rendered.unmount());
saveInput = undefined;
await renderer.act(async () => {
  rendered = renderer.create(React.createElement(Editor, {
    message: edited, onClose: () => editorCloseCalls++, onSaved: () => {},
  }));
});
await renderer.act(async () => rendered.root.findAllByType('Button').find((button) => button.props.title === '取消').props.onPress());
assert.equal(saveInput, undefined, '取消编辑不写消息');
await renderer.act(async () => rendered.unmount());
db.close();
console.log('Chat 消息复制、改写事务、预览、并发冲突与菜单行为验证通过');
