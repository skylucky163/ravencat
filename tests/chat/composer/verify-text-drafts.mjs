/** 真实 SQLite 和 React 生命周期验证文字草稿恢复、交接及列表投影。 */
import { repoRoot as root } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { bootstrapSqlite, createSqliteExecutor, DATABASE_SCHEMA_VERSION, restoreLegacyModelServicesFixture } from '../../helpers/sqlite-bootstrap-fixture.mjs';

const require = createRequire(import.meta.url);
const React = require('react');
const { act, create } = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const timers = new Map();
let timerSequence = 0;
function load(file, dependencies = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', compiled)(id => {
    if (id === 'react' || id === 'react/jsx-runtime') return require(id);
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    throw new Error(`未装配草稿验证依赖：${file} -> ${id}`);
  }, module, module.exports, callback => { const id = ++timerSequence; timers.set(id, callback); return id; }, id => timers.delete(id));
  return module.exports;
}
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
const executor = createSqliteExecutor(db);
await bootstrapSqlite(executor);
// 当前结构升级时只增加草稿表，保留会话身份；模型服务需一并回到 146 的分组前形态。
db.exec("INSERT INTO chat_conversations VALUES ('direct-one', 'direct'), ('group-one', 'group'); DROP TABLE chat_text_drafts;");
restoreLegacyModelServicesFixture(db);
db.exec('PRAGMA user_version=146;');
await bootstrapSqlite(executor);
assert.equal(db.prepare('PRAGMA user_version').get().user_version, DATABASE_SCHEMA_VERSION);
assert.equal(db.prepare('SELECT COUNT(*) n FROM chat_conversations').get().n, 2);
const { SQLiteChatTextDraftRepository } = load('src/features/chat/conversation/infrastructure/SQLiteChatTextDraftRepository.ts', {
  '@platform/persistence': { databaseCoordinator: {
    read: (_meta, callback) => callback(executor),
    async transaction(_meta, callback) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = await callback(executor); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  } },
});
const repository = new SQLiteChatTextDraftRepository();
const storeModule = load('src/features/chat/conversation/application/ChatTextDraftStore.ts');
const { ChatTextDraftStore } = storeModule;
const store = new ChatTextDraftStore(repository, assert.fail);
await store.load();
store.change('direct-one', ' 第一行\n第二行  ');
store.change('group-one', '群聊原文 @角色');
await store.flush();
const reopened = new ChatTextDraftStore(repository, assert.fail);
await reopened.load();
assert.equal(reopened.read('direct-one').text, ' 第一行\n第二行  ');
assert.equal(reopened.read('group-one').text, '群聊原文 @角色');
const submitted = reopened.read('direct-one');
reopened.change('direct-one', '发送期间新写的下一段');
reopened.replaceIfUnchanged('direct-one', submitted, '');
assert.equal(reopened.read('direct-one').text, '发送期间新写的下一段', '旧发送回执不能清除新草稿');
const current = reopened.read('direct-one');
reopened.replaceIfUnchanged('direct-one', current, '');
await reopened.flush();
assert.equal((await repository.list()).some(draft => draft.conversationId === 'direct-one'), false);

let saveFails = true;
const failedSave = new ChatTextDraftStore({ list: () => repository.list(), save: batch => {
  if (saveFails) throw new Error('测试：磁盘写入失败');
  return repository.save(batch);
} }, assert.fail);
await failedSave.load();
failedSave.change('direct-one', '保存失败仍保留的原文');
await assert.rejects(failedSave.flush(), /磁盘写入失败/);
assert.equal(failedSave.read('direct-one').text, '保存失败仍保留的原文');
saveFails = false;
await failedSave.flush();
assert.equal((await repository.list()).find(draft => draft.conversationId === 'direct-one').text, '保存失败仍保留的原文');

let finishWrite;
let writes = 0;
const racing = new ChatTextDraftStore({
  list: () => repository.list(),
  async save(batch) {
    writes++;
    if (writes === 1) await new Promise(resolve => { finishWrite = resolve; });
    await repository.save(batch);
  },
}, assert.fail);
await racing.load();
racing.change('direct-one', '先写入的旧版本');
const draining = racing.flush();
await Promise.resolve();
racing.change('direct-one', '写入期间的新版本');
finishWrite();
await draining;
assert.equal((await repository.list()).find(draft => draft.conversationId === 'direct-one').text, '写入期间的新版本');
db.exec("DELETE FROM chat_conversations WHERE id='group-one'");
await repository.save([{ conversationId: 'group-one', text: '删除后迟到的保存' }]);
assert.equal((await repository.list()).some(draft => draft.conversationId === 'group-one'), false, '删除级联清理且迟到保存不能复活草稿');

// 宿主内共享草稿：切会话、失焦、后台与重新挂载保留原文。
let background;
let editor;
const dialogs = [];
const providerModule = load('src/features/chat/presentation/shell/ChatTextDraftProvider.tsx', {
  'react-native': { AppState: { addEventListener: (_event, listener) => { background = listener; return { remove() { background = null; } }; } } },
  '@shared/ui': { showAppDialog: dialog => dialogs.push(dialog) },
  '../../conversation/application/ChatTextDraftStore': storeModule,
  '../../conversation/application/ChatTextDraftRuntime': { getChatTextDraftRepository: () => repository },
});
function Editor({ id, active = true }) { editor = providerModule.useChatTextDraft(id, active); return null; }
const tree = (id, active = true) => React.createElement(providerModule.ChatTextDraftProvider, { enabled: true }, React.createElement(Editor, { id, active }));
let rendered;
await act(async () => { rendered = create(tree('direct-one')); });
assert.equal(editor.ready, true);
assert.equal(editor.text, '写入期间的新版本');
await act(async () => { editor.setText('保留\n原始换行 '); });
await act(async () => { rendered.update(tree('other', false)); });
assert.equal(editor.text, '');
await act(async () => { rendered.update(tree('direct-one')); });
assert.equal(editor.text, '保留\n原始换行 ');
await act(async () => { editor.setText('进入后台前的文字'); background('background'); });
assert.equal((await repository.list()).find(draft => draft.conversationId === 'direct-one').text, '进入后台前的文字');
await act(async () => { rendered.unmount(); });
assert.equal(background, null);
await act(async () => { rendered = create(tree('direct-one')); });
assert.equal(editor.text, '进入后台前的文字');
await act(async () => { rendered.unmount(); });
assert.deepEqual(dialogs, []);

// 误触遮罩或关闭键盘只收起通话输入；重新打开继续编辑相同文字。
const keyboardListeners = new Map();
const CallTextInputModal = load('src/features/calls/presentation/components/CallTextInputModal.tsx', {
  'react-native': {
    Keyboard: { dismiss() {}, addListener: (event, callback) => { keyboardListeners.set(event, callback); return { remove: () => keyboardListeners.delete(event) }; } },
    Modal: 'Modal', Pressable: 'Backdrop', TextInput: 'NativeInput', TouchableOpacity: 'Button', View: 'View',
  },
  '@expo/vector-icons': { Ionicons: 'Icon' }, '@shared/ui': { AppTextInput: 'Input' },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ bottom: 0 }) },
  '@shared/theme': { useTheme: () => ({ colors: { text: {}, brand: {}, icon: {} } }), useThemedStyles: () => ({}) },
  '../styles': {},
}).default;
let modal;
function CallEditor() {
  const [visible, setVisible] = React.useState(true);
  const [text, setText] = React.useState('');
  modal = { setVisible, text };
  return React.createElement(CallTextInputModal, { visible, text, onChangeText: setText, onClose: () => setVisible(false), onSend() {} });
}
await act(async () => { rendered = create(React.createElement(CallEditor)); });
await act(async () => { rendered.root.findByType('Input').props.onChangeText('还没写完\n的通话文字'); });
await act(async () => { rendered.root.findByType('Backdrop').props.onPress(); });
assert.equal(rendered.root.findByType('Modal').props.visible, false);
await act(async () => { modal.setVisible(true); });
assert.equal(rendered.root.findByType('Input').props.value, '还没写完\n的通话文字');
await act(async () => { keyboardListeners.get('keyboardDidHide')(); });
assert.equal(modal.text, '还没写完\n的通话文字');
await act(async () => { rendered.unmount(); });
assert.equal(keyboardListeners.size, 0);

// 列表仅覆盖摘要；时间、未读和排序继续取真实会话事实。
const theme = load('src/shared/theme/themes/defaultLight.ts').defaultLightTheme;
const ordering = load('src/shared/utils/conversationListOrdering.ts');
const listItems = load('src/features/assistants/presentation/management/conversationListItems.ts', {
  '@shared/utils/conversationListOrdering': ordering,
});
const { default: ConversationList } = load('src/features/assistants/presentation/management/ConversationList.tsx', {
  '../../AssistantNickname': { getAssistantDisplayName: ai => ai.name },
  'react-native': {
    View: 'View', Text: 'Text', TouchableOpacity: 'Button', Modal: 'Modal', TouchableWithoutFeedback: 'Backdrop',
    StyleSheet: { create: styles => styles }, Dimensions: { get: () => ({ height: 800 }) },
    Animated: { Value: class {}, View: 'AnimatedView' },
    FlatList: props => React.createElement('List', props, props.data.map(item => React.createElement(React.Fragment, { key: item.id }, props.renderItem({ item })))),
  },
  '@expo/vector-icons': { Ionicons: 'Icon' }, 'lucide-react-native': { Pin: 'Pin' },
  '@shared/theme': { GlassSurface: 'Glass', ThemedSurface: 'Surface', useTheme: () => theme, useThemedStyles: factory => factory(theme) },
  '@shared/ui/EmptyState': 'Empty', '@shared/ui/NavigationHeader': 'Header',
  '@shared/utils/timeFormat': { formatChatTime: time => time },
  '@shared/ui': { AIAvatar: 'Avatar', GroupAvatar: 'GroupAvatar', useFloatingTabBarScrollPadding: () => 0, showAppDialog: assert.fail },
  './conversationListItems': listItems,
});
const listProps = {
  aiList: [{ id: 'ai', name: '角色', canonicalConversationId: 'direct-one', lastMessage: '最新真实消息', lastTime: 'message-time', createdAt: '2026-01-01' }],
  groupChats: [{ id: 'group', name: '群聊', lastMessage: '群聊真实消息', lastTime: 'group-time', createdAt: '2026-01-02' }],
  unreadMessages: { ai: 3 }, onRefresh() {}, onSelectAI() {},
};
await act(async () => { rendered = create(React.createElement(ConversationList, listProps)); });
const originalOrder = rendered.root.findByType('List').props.data.map(item => item.id);
await act(async () => { rendered.update(React.createElement(ConversationList, { ...listProps, textDrafts: { 'direct-one': '我的\n草稿', group: '群聊草稿' } })); });
function textContent(node) {
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (typeof node === 'string') return node;
  return node?.children ? textContent(node.children) : '';
}
const visibleText = textContent(rendered.toJSON());
assert.ok(visibleText.includes('[草稿] 我的 草稿'));
assert.ok(visibleText.includes('[草稿] 群聊草稿'));
assert.ok(visibleText.includes('message-time'));
assert.ok(visibleText.includes('3'));
assert.deepEqual(rendered.root.findByType('List').props.data.map(item => item.id), originalOrder);
await act(async () => { rendered.update(React.createElement(ConversationList, listProps)); });
assert.ok(rendered.root.findAllByType('Text').some(node => node.props.children === '最新真实消息'));
await act(async () => { rendered.unmount(); });
db.close();
console.log('文字草稿验证通过：升级、恢复、原文、会话隔离、发送版本、并发保存、删除级联、后台与列表摘要。');
