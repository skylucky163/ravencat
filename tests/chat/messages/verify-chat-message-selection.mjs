/** 验证整轮选择、20 条上限、跨分页删除、原子预览与页面多选行为，不读取用户数据库。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createChatMessageMutationFixture, load } from '../../helpers/chat-message-mutation-fixture.mjs';

const require = createRequire(import.meta.url);
const { db, metadata, persistence, messages, groups } = createChatMessageMutationFixture();
const selectionPolicy = load('src/features/chat/messages/domain/ChatMessageSelection.ts', { './chatMessageMetadata': metadata });
const deletions = [];
const released = [];
const invalidated = [];
const { deleteChatSelection } = load('src/features/chat/messages/application/DeleteChatSelection.ts', {
  '@platform/persistence': persistence,
  '@features/media': { releaseMediaAssetCandidates: async (ids) => released.push([...ids]) },
  './ChatMessageRuntime': { getChatMessageRuntimeDependencies: () => ({ messages, regeneration: { onInvalidated: async (id) => invalidated.push(id) } }) },
  '../../group/application/ChatGroupRuntime': { getChatGroupRuntimeDependencies: () => ({ groups }) },
  '../domain/ChatMessageSelection': selectionPolicy,
  '../domain/chatMessageMetadata': metadata,
  '../events/ChatEvents': { emitChatMessagesDeleted: (sessionId, ids) => deletions.push({ sessionId, ids: [...ids] }), emitChatTurnExecutionChanged() {} },
});
const time = '2026-10-09T08:00:00.000Z';
function insert(session, text, { sender = 'user', run = null, logical = null, agent = null, metadata: meta = null } = {}) {
  return Number(db.prepare(`INSERT INTO messages
    (session_id, text, sender_type, is_me, created_at, time, turn_run_id, logical_message_id, agent_id, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(session, text, sender, Number(sender === 'user'), time, time, run, logical, agent, meta && JSON.stringify(meta)).lastInsertRowid);
}
function session(id) {
  db.prepare('INSERT INTO sessions (id, last_message, last_time) VALUES (?, ?, ?)').run(id, '旧预览', time);
}
const { getChatSelectionKey, canSelectChatMessage, toggleChatSelection, MAX_CHAT_SELECTION_UNITS } = selectionPolicy;
const makeMessage = (id, extra = {}) => ({ id, sessionId: 'single', text: '正文', senderType: 'assistant', status: 'sent', ...extra });
const firstStep = makeMessage(1, { turnRunId: 'run-a', logicalMessageId: 'step-1' });
const secondStep = makeMessage(2, { turnRunId: 'run-a', logicalMessageId: 'step-2' });
assert.equal(getChatSelectionKey(firstStep), getChatSelectionKey(secondStep), '连续工具步骤属于同一轮');
assert.notEqual(getChatSelectionKey(firstStep), getChatSelectionKey(makeMessage(3, { turnRunId: 'run-b' })), '群聊不同 AI 的运行分别计数');
assert.notEqual(getChatSelectionKey(makeMessage(4, { senderType: 'user', logicalMessageId: 'submission' })), getChatSelectionKey(makeMessage(5, { senderType: 'user', logicalMessageId: 'submission' })), '用户消息逐条计数');
assert.equal(getChatSelectionKey(makeMessage(6, { metadataJson: JSON.stringify({ replyRunId: 'run-a' }) })), getChatSelectionKey(firstStep));
for (const extra of [{ status: 'streaming' }, { id: -1 }, { senderType: 'reasoning' }, { senderType: 'system' }, { deliveryStatus: 'cancelled' }, { metadataJson: JSON.stringify({ type: 'callStatus' }) }]) {
  assert.equal(canSelectChatMessage(makeMessage(7, extra)), false);
}
assert.equal(canSelectChatMessage(makeMessage(8, { text: '', metadataJson: JSON.stringify({ kind: 'image', attachments: [{ type: 'image' }] }) })), true, '纯媒体正文可选择');
let selected = [];
for (let id = 1; id <= MAX_CHAT_SELECTION_UNITS; id++) selected = toggleChatSelection(selected, { key: `run:${id}`, anchorMessageId: id });
assert.equal(selected.length, 20);
assert.equal(toggleChatSelection(selected, { key: 'run:21', anchorMessageId: 21 }), selected, '第 21 条不能加入');
selected = toggleChatSelection(selected, { key: 'run:1', anchorMessageId: 100 });
assert.equal(selected.length, 19, '同轮另一气泡取消整轮');
selected = toggleChatSelection(selected, { key: 'message:21', anchorMessageId: 21 });
assert.equal(selected.length, 20);

// UI 只持有末尾正文锚点，删除仍覆盖全部 step、思考和工具记录。
session('single');
const keep = insert('single', '保留用户消息');
const user = insert('single', '所选用户消息');
const reasoning = insert('single', '思考', { sender: 'reasoning', run: 'whole-run', logical: 'step-1' });
const preamble = insert('single', '工具前言', { sender: 'assistant', run: 'whole-run', logical: 'step-1', agent: 'agent-a' });
const tool = insert('single', '', { sender: 'system', run: 'whole-run', logical: 'step-1', metadata: { type: 'toolStatus', status: 'completed' } });
const nextReasoning = insert('single', '下一步思考', { sender: 'reasoning', run: 'whole-run', logical: 'step-2' });
const answer = insert('single', '最终回复', { sender: 'assistant', run: 'whole-run', logical: 'step-2', metadata: { attachments: [{ mediaAssetId: 'image-a' }] } });
const businessCard = insert('single', '一起听已发出邀请', { sender: 'assistant', run: 'whole-run', metadata: { type: 'togetherListening' } });
const ids = await deleteChatSelection('single', [user, answer]);
assert.deepEqual([...ids].sort((a, b) => a - b), [user, reasoning, preamble, tool, nextReasoning, answer]);
assert.equal((await messages.getMessageById(keep)).text, '保留用户消息');
assert.equal((await messages.getMessageById(businessCard)).text, '一起听已发出邀请', '独立业务卡片不属于 canonical 回复删除范围');
assert.deepEqual(released.at(-1), ['image-a']);
assert.deepEqual(deletions, [{ sessionId: 'single', ids: [...ids] }], '提交后发布实际联删身份');
assert.deepEqual(invalidated, ['single']);
const releaseCount = released.length;
assert.deepEqual(await deleteChatSelection('single', [answer]), [], '已删除轮次不会复活');
assert.equal(released.length, releaseCount);
await assert.rejects(deleteChatSelection('single', []), /请选择/u);
await assert.rejects(deleteChatSelection('single', Array(21).fill(keep)), /20/u);

// 群聊交错运行互不影响，删除后预览身份同时交接。
db.prepare('INSERT INTO group_chats (id, last_message) VALUES (?, ?)').run('group', '旧预览');
const groupA = insert('group', 'A 前言', { sender: 'assistant', run: 'a', agent: 'agent-a' });
const groupB = insert('group', 'B 回答', { sender: 'assistant', run: 'b', agent: 'agent-b' });
const groupATool = insert('group', 'A 工具', { sender: 'system', run: 'a', metadata: { type: 'toolStatus' } });
const groupAFinal = insert('group', 'A 最终回答', { sender: 'assistant', run: 'a', agent: 'agent-a' });
assert.deepEqual(await deleteChatSelection('group', [groupAFinal]), [groupA, groupATool, groupAFinal]);
assert.equal(db.prepare('SELECT last_message_id FROM group_chats WHERE id = ?').get('group').last_message_id, groupB);
await groups.updatePreviewForCommittedMessage('group', groupAFinal, '不能复活', time);
assert.equal(db.prepare('SELECT last_message FROM group_chats WHERE id = ?').get('group').last_message, 'B 回答');
await deleteChatSelection('group', [groupB]);
assert.deepEqual({ ...db.prepare('SELECT last_message, last_time, last_message_id FROM group_chats WHERE id = ?').get('group') }, { last_message: '', last_time: null, last_message_id: null });

// 隐藏历史不进入预览，遗留分段按已有 logical identity 完整删除。
session('clear');
const hidden = insert('clear', '隐藏历史');
db.prepare('UPDATE sessions SET visible_after_message_id = ? WHERE id = ?').run(hidden, 'clear');
const legacyReasoning = insert('clear', '旧思考', { sender: 'reasoning', logical: 'legacy' });
const legacyA = insert('clear', '旧分段一', { sender: 'assistant', logical: 'legacy' });
const legacyB = insert('clear', '旧分段二', { sender: 'assistant', logical: 'legacy' });
assert.deepEqual(await deleteChatSelection('clear', [legacyB]), [legacyReasoning, legacyA, legacyB]);
assert.equal(db.prepare('SELECT last_message FROM sessions WHERE id = ?').get('clear').last_message, '');
assert.equal(db.prepare('SELECT last_time FROM sessions WHERE id = ?').get('clear').last_time, null);
assert.ok(await messages.getMessageById(hidden));

// 预览写失败时整批消息保留，commit 后的通知和媒体释放均不能发生。
session('rollback');
const rollbackUser = insert('rollback', '保留一');
const rollbackAI = insert('rollback', '保留二', { sender: 'assistant', run: 'rollback-run' });
db.exec("CREATE TRIGGER reject_preview BEFORE UPDATE ON sessions WHEN NEW.id = 'rollback' BEGIN SELECT RAISE(ABORT, 'preview rejected'); END");
const beforeFailure = [deletions.length, released.length, invalidated.length];
await assert.rejects(deleteChatSelection('rollback', [rollbackUser, rollbackAI]), /preview rejected/u);
assert.ok(await messages.getMessageById(rollbackUser));
assert.ok(await messages.getMessageById(rollbackAI));
assert.deepEqual([deletions.length, released.length, invalidated.length], beforeFailure);
await assert.rejects(deleteChatSelection('single', [rollbackUser]), /所选消息已变化/u, '不能跨会话删除');
db.exec('DROP TRIGGER reject_preview');

// 真实 React hook：进入、整轮联动、零选择、返回键与失焦退出。
const React = require('react');
const renderer = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let back;
let dialog;
let hookState;
let props;
const toasts = [];
let hookDelete = deleteChatSelection;
const hook = load('src/features/chat/presentation/messages/components/useChatMessageSelection.ts', {
  'react-native': { BackHandler: { addEventListener: (_name, handler) => { back = handler; return { remove: () => { back = undefined; } }; } }, ToastAndroid: { SHORT: 0, show: (text) => toasts.push(text) } },
  '@shared/ui': { showAppDialog: (input) => { dialog = input; } },
  '../../../messages/domain/ChatMessageSelection': selectionPolicy,
  '../../../messages/application/DeleteChatSelection': { deleteChatSelection: (...args) => hookDelete(...args) },
});
const hookMessages = [makeMessage(101, { turnRunId: 'hook-a' }), makeMessage(102, { turnRunId: 'hook-a' }), makeMessage(103, { senderType: 'user' })];
props = { sessionId: 'single', isActive: true, messages: hookMessages, onDeleted: () => {} };
function Harness() { hookState = hook.useChatMessageSelection(props); return null; }
let rendered;
await renderer.act(async () => { rendered = renderer.create(React.createElement(Harness)); });
await renderer.act(async () => hookState.enter(hookMessages[0]));
assert.equal(hookState.selecting, true);
assert.equal(hookState.count, 1);
await renderer.act(async () => hookState.toggle(getChatSelectionKey(hookMessages[1])));
assert.equal(hookState.count, 0);
assert.equal(hookState.selecting, true, '零选择仍保持多选模式');
await renderer.act(async () => hookState.toggle(getChatSelectionKey(hookMessages[2])));
assert.equal(hookState.count, 1);
await renderer.act(async () => { assert.equal(back(), true); });
assert.equal(hookState.selecting, false);
assert.equal(back, undefined);
const twentyOne = Array.from({ length: 21 }, (_, index) => makeMessage(200 + index, { turnRunId: `hook-${index}` }));
props = { ...props, messages: twentyOne };
await renderer.act(async () => rendered.update(React.createElement(Harness)));
await renderer.act(async () => hookState.enter(twentyOne[0]));
await renderer.act(async () => { for (const message of twentyOne.slice(1)) hookState.toggle(getChatSelectionKey(message)); });
assert.equal(hookState.count, 20);
assert.equal(toasts.length, 1);
props = { ...props, messages: [...twentyOne, makeMessage(300, { turnRunId: 'new-arrival' })] };
await renderer.act(async () => rendered.update(React.createElement(Harness)));
assert.equal(hookState.count, 20, '新消息到达不自动选择');
props = { ...props, isActive: false };
await renderer.act(async () => rendered.update(React.createElement(Harness)));
assert.equal(hookState.selecting, false);
assert.equal(hookState.count, 0);

// 删除失败保留选择，成功退出，取消确认不改变选择。
props = { sessionId: 'rollback', isActive: true, messages: [await messages.getMessageById(rollbackUser)], onDeleted: () => {} };
await renderer.act(async () => rendered.update(React.createElement(Harness)));
await renderer.act(async () => hookState.enter(props.messages[0]));
await renderer.act(async () => hookState.requestDelete());
assert.equal(hookState.count, 1);
db.exec("CREATE TRIGGER reject_preview BEFORE UPDATE ON sessions WHEN NEW.id = 'rollback' BEGIN SELECT RAISE(ABORT, 'preview rejected'); END");
await renderer.act(async () => dialog.buttons.find((button) => button.text === '删除').onPress());
assert.equal(dialog.title, '删除失败');
assert.equal(hookState.selecting, true);
assert.equal(hookState.count, 1);
db.exec('DROP TRIGGER reject_preview');
await renderer.act(async () => hookState.requestDelete());
await renderer.act(async () => dialog.buttons.find((button) => button.text === '删除').onPress());
assert.equal(hookState.selecting, false);
// 旧页面删除结果不得清除新会话的选择。
let finishOldDelete;
hookDelete = () => new Promise((resolve) => { finishOldDelete = resolve; });
props = { ...props, messages: [makeMessage(500, { sessionId: 'rollback', senderType: 'user' })] };
await renderer.act(async () => rendered.update(React.createElement(Harness)));
await renderer.act(async () => hookState.enter(props.messages[0]));
await renderer.act(async () => hookState.requestDelete());
let pendingDelete;
await renderer.act(async () => { pendingDelete = dialog.buttons.find((button) => button.text === '删除').onPress(); });
props = { ...props, sessionId: 'other', messages: [makeMessage(501, { sessionId: 'other', senderType: 'user' })] };
await renderer.act(async () => rendered.update(React.createElement(Harness)));
await renderer.act(async () => hookState.enter(props.messages[0]));
await renderer.act(async () => { finishOldDelete([500]); await pendingDelete; });
assert.equal(hookState.selecting, true);
assert.equal(hookState.count, 1);
await renderer.act(async () => rendered.unmount());

// 删除和分享在零条时禁用，单条／满额时共用当前选择。
const bars = load('src/features/chat/presentation/messages/components/ChatSelectionBars.tsx', {
  'react-native': { StyleSheet: { create: (value) => value, hairlineWidth: 1 }, Text: 'Text', View: 'View', TouchableOpacity: 'Button' },
  'lucide-react-native': { Share2: 'ShareIcon', Trash2: 'TrashIcon' },
  '@shared/theme': { useTheme: () => ({ colors: { brand: { primary: 'blue' }, feedback: { error: 'red' }, text: { secondary: 'gray' } } }), useThemedStyles: () => ({}) },
  '../../../messages/domain/ChatMessageSelection': selectionPolicy,
});
for (const count of [0, 1, 20]) {
  let shares = 0;
  await renderer.act(async () => { rendered = renderer.create(React.createElement(bars.ChatSelectionFooter, { count, isDeleting: false, paddingBottom: 8, onDelete: () => {}, onShare: () => shares++ })); });
  const buttons = rendered.root.findAllByType('Button');
  assert.equal(buttons[0].props.disabled, count === 0);
  assert.equal(buttons[1].props.disabled, count === 0);
  if (count) { buttons[1].props.onPress(); assert.equal(shares, 1); }
  await renderer.act(async () => rendered.unmount());
}
db.close();
console.log('verify-chat-message-selection: all assertions passed');
