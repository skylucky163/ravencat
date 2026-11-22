/** 用真实 React 生命周期覆盖冷静期入口、任命失败反馈和解除后的任命流程。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';

const require = createRequire(import.meta.url);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function load(file, mocks) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', code)(id => {
    if (id === 'react' || id === 'react/jsx-runtime') return require(id);
    assert.ok(Object.hasOwn(mocks, id), `${file}: 缺少依赖 ${id}`);
    return mocks[id];
  }, module, module.exports);
  return module.exports;
}

const available = { id: 'a', name: '主理候选', model: 'chat-model', isBlocked: false };
const candidates = [available, { ...available, id: 'b', name: '被限制', isBlocked: true }, { ...available, id: 'c', name: '未配置', model: '' }];
let inCooldown = true;
let hostAI = null;
let dialog;
let appointmentCalls = 0;
let finishAppointment;
let rejectAppointment;
let listError = null;
const cooldownStatus = () => ({ appointment: { isInCooldown: inCooldown, remainingDays: inCooldown ? 7 : 0 } });
const { createHostAIAppointmentDialog } = load('src/features/assistants/presentation/HostAIAppointmentDialog.ts', {});
const { default: Screen } = load('src/features/companion/presentation/CompanionSettingsScreen.tsx', {
  'lucide-react-native': { ChevronRight: 'ChevronRight', LockKeyhole: 'LockKeyhole', UserRoundPlus: 'UserRoundPlus' },
  '@features/assistants': {
    getAssistantDisplayName: assistant => assistant.name,
    createHostAIAppointmentDialog,
    getHostAICooldownStatus: async () => cooldownStatus(),
    listAIAssistantSummaries: async () => { if (listError) throw listError; return candidates; },
    appointHostAIAssistant: () => {
      appointmentCalls++;
      return new Promise((resolve, reject) => {
        finishAppointment = () => { hostAI = available; resolve(true); };
        rejectAppointment = reject;
      });
    },
  },
  './CompanionFollowUpSettings': { CompanionFollowUpSettings: 'CompanionFollowUpSettings' },
  '@shared/theme': {
    ThemedSurface: 'ThemedSurface',
    useTheme: () => ({ colors: { brand: {}, text: {} } }),
    useThemedStyles: () => ({}),
  },
  '@shared/ui': {
    AIAvatar: 'AIAvatar', AIInfoCard: 'AIInfoCard', Button: 'Button', ToggleField: 'ToggleField',
    ModalSheet: props => props.visible ? React.createElement('ModalSheet', props) : null,
    showAppDialog: options => { dialog = options; },
  },
  '@shared/ui/NavigationHeader': { default: 'NavigationHeader', __esModule: true },
  'react-native': {
    ActivityIndicator: 'ActivityIndicator', RefreshControl: 'RefreshControl', ScrollView: 'ScrollView',
    Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View',
    AppState: { addEventListener: () => ({ remove() {} }) },
    InteractionManager: { runAfterInteractions: callback => { callback(); return { cancel() {} }; } },
  },
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  '../application': {
    loadCompanionProductState: async () => ({ hostAI, settings: {}, state: { activationStatus: 'disabled' } }),
  },
  './CompanionControls': { QuietHoursWheel: 'QuietHoursWheel' },
  './CompanionSettingsShared.styles': { createStyles: () => ({}) },
});

let screen;
await act(async () => { screen = create(React.createElement(Screen, { onBack() {}, onOpenScreen() {} })); });
const entry = () => screen.root.findAllByType('TouchableOpacity').find(node => node.props.accessibilityLabel);
const picker = () => screen.root.findByType('ModalSheet');
const items = () => picker().findAllByType('TouchableOpacity');
const textWithin = node => node.findAllByType('Text').map(text => text.props.children).flat().join(' ');
const pullRefresh = async () => {
  await act(async () => { screen.root.findAllByType('ScrollView')[0].props.refreshControl.props.onRefresh(); });
};
const confirm = async () => {
  await act(async () => { items()[0].props.onPress(); });
  await act(async () => { dialog.buttons.find(button => button.onPress).onPress(); });
};

assert.equal(entry().props.disabled, true, '冷静期禁止打开候选列表');
assert.equal(entry().props.accessibilityState.disabled, true);
assert.match(textWithin(screen.root), /剩余 7 天/);
assert.equal(screen.root.findByType('ToggleField').props.disabled, true, '无主理 AI 时伴随模式不可开启');
assert.equal(screen.root.findAllByType('ModalSheet').length, 0);
assert.equal(appointmentCalls, 0);

inCooldown = false;
await pullRefresh();
assert.equal(entry().props.disabled, false, '解除或到期后刷新恢复选择入口');
listError = new Error('AI 列表读取失败');
await act(async () => { await entry().props.onPress(); });
assert.match(textWithin(picker()), /AI 列表读取失败/, '读取失败直接出现在当前弹窗');
await act(async () => { picker().props.onClose(); });
listError = null;
await act(async () => { await entry().props.onPress(); });
assert.deepEqual(items().map(node => node.props.disabled), [false, true, true]);
assert.doesNotMatch(textWithin(picker()), /AI 列表读取失败/, '重新打开清除旧反馈');

await confirm();
assert.equal(appointmentCalls, 1);
assert.ok(items().every(node => node.props.disabled), '任命进行中不能重复选择');
assert.match(textWithin(picker()), /正在任命/);
inCooldown = true;
await act(async () => { rejectAppointment(new Error('撤销主理 AI 后需要等待七天才能重新任命')); });
assert.match(textWithin(picker()), /需要等待七天/, '确认失败的原因必须显示在仍打开的弹窗内');
assert.ok(items().every(node => node.props.disabled), '提交时出现冷静期后刷新并禁用候选');
assert.equal(entry().props.disabled, true);

await act(async () => { picker().props.onClose(); });
inCooldown = false;
await pullRefresh();
await act(async () => { await entry().props.onPress(); });
await confirm();
await act(async () => { finishAppointment(); });
assert.equal(appointmentCalls, 2);
assert.equal(screen.root.findAllByType('ModalSheet').length, 0, '任命成功后关闭选择弹窗');
assert.equal(screen.root.findByType('AIInfoCard').props.name, available.name);
assert.equal(screen.root.findByType('ToggleField').props.disabled, false, '任命成功后可开启伴随模式');
await act(async () => { screen.unmount(); });
console.log('通过：冷静期入口禁用、解除后恢复、弹窗内错误反馈、提交期间禁用与成功后刷新。');
