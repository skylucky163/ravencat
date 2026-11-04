/** 摘要页面的设置草稿、开关和两级编辑行为，不锁定组件内部写法。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import ts from 'typescript';
import { mock } from 'node:test';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = new Map();
const writes = [];
let summaryTasks = [], summaryPageListener, finishRetry;
const settings = { generationEnabled: true, injectEnabled: true, fixedMessageId: null, secondaryEnabled: true, secondaryTokenThreshold: 8000, requestTimeoutSeconds: 300, maxOutputTokens: null, modelConfigId: null, groupTriggerCount: 40 };
let segments = [
  { id: 'p', level: 'primary', sequence:1, contextSequence:1, compactionId: 's', content: '一级原记录', createdAt: '2026-10-11T00:00:00.000Z', updatedAt:'2026-10-11T00:00:00.000Z', sourceStartAt: null },
  { id: 's', level: 'secondary', sequence:2, contextSequence:1, compactionId: null, content: '二级归纳', createdAt: '2026-10-11T00:00:00.000Z', updatedAt:'2026-10-11T00:00:00.000Z', sourceStartAt: null },
];
let fixedSnapshot = { settings, fixedStart: null };
let fixedSummaryListener;
let fixedMessageBus;
const fixedWrites = [];
const mocks = {
  react: React,
  'react-native': { ...Object.fromEntries(['Text','TextInput','View','Pressable','ScrollView','ActivityIndicator','KeyboardAvoidingView','Modal','TouchableOpacity','TouchableWithoutFeedback'].map(name=>[name,name])),
    AppState:{addEventListener:()=>({remove(){}})},BackHandler:{addEventListener:()=>({remove(){}})},
    Dimensions:{get:()=>({width:400,height:800})},useWindowDimensions:()=>({width:400,height:800}),StyleSheet:{create:value=>value} },
  '@react-navigation/native': { useFocusEffect: callback => React.useEffect(callback,[callback]) },
  'expo-router': { useFocusEffect: callback => React.useEffect(callback,[callback]) },
  '@expo/vector-icons': {Ionicons:'Ionicons'},
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  'lucide-react-native': Object.fromEntries(['Plus','Settings','Pin','PinOff','Star','History','TextSelect','ChevronRight','ChevronDown','Layers3'].map(name=>[name,name])),
  '@shared/theme': { ThemedSurface:'ThemedSurface', useTheme: () => ({ colors: { brand: { primary: 'blue' }, text: { tertiary: 'gray',secondary:'gray' }, feedback: { error: 'red' }, border:{strong:'gray'} } }), useThemedStyles: () => ({}) },
  '@shared/ui': { AppTextInput: 'TextInput', KeyboardAvoidingContainer: 'KeyboardAvoidingContainer', NavigationHeader: 'NavigationHeader', Toggle: 'Toggle', ConfiguredModelPicker: 'ConfiguredModelPicker', useBusyBackHandler() {}, showAppDialog() {} },
  '@features/assistants': { getAuxiliaryModelSelection: async () => ({}), requireAuxiliaryModel: async () => {}, subscribeAuxiliaryModelsChanged: () => () => {} },
  '@shared/ui/AutoSaveErrors': {AutoSaveErrors:'AutoSaveErrors'},
  '@shared/prompt': { estimateTextTokens: text => text.length },
  './chatSummaryStyles': {},
  './chatSettingsStyles': {createStyles:()=>({})},
  '../../summary/application/ChatSummary': {
    getChatInterruptedTurnContext: async () => [], getChatSummaryContext: async () => fixedSnapshot,
    setFixedChatContextStart: async (...args) => { fixedWrites.push(args); },
  },
  '../../summary/application/ChatSummaryRuntime': {subscribeChatSummaryChanged:listener=>{fixedSummaryListener=listener;return()=>{};}},
  '../../messages/events/ChatEvents': {setChatEventBus:bus=>{fixedMessageBus=bus;return()=>{};}},
  '../application/ChatSummaryRuntime': { subscribeChatSummaryChanged: listener => {summaryPageListener=listener;return()=>{};} },
  '../application/ChatSummary': {
    getChatInterruptedTurnContext: async () => [], getChatSummaryContext: async () => ({ settings, segments, tasks: summaryTasks }),
    updateChatSummarySettings: async (conversationId, patch) => { writes.push(['settings',conversationId,patch]); },
    retryChatSummaryTask: async (...args) => { writes.push(['retry',...args]); await new Promise(resolve=>{finishRetry=resolve;}); },
    editChatSummary: async (...args) => { writes.push(['edit', ...args]); },
    editCombinedSecondarySummary: async (...args) => { writes.push(['combined', ...args]); },
    deleteCombinedSecondarySummary: async (...args) => { writes.push(['delete-combined', ...args]); },
    createChatSummary: async (...args) => { writes.push(['create', ...args]); },
    deleteChatSummary: async (...args) => { writes.push(['delete', ...args]); },
  },
};
function load(relative) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} }; cache.set(filename, module);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  new Function('require','module','exports',compiled)(name => {
    if (Object.hasOwn(mocks,name)) return mocks[name];
    for (const suffix of ['.tsx','.ts']) {
      const candidate = path.resolve(path.dirname(filename),name)+suffix;
      if (fs.existsSync(candidate)) return load(candidate);
    }
    throw new Error('未装配的 UI 边界 '+name);
  },module,module.exports);
  return module.exports;
}
mocks['@shared/ui/useAutoSaveDraft'] = load('src/shared/ui/useAutoSaveDraft.ts');
mocks['./Toggle'] = { default: 'Toggle', __esModule: true };
mocks['@shared/ui'].ToggleField = load('src/shared/ui/ToggleField.tsx').default;
const Panel = load('src/features/chat/summary/presentation/ChatSummarySettingsPanel.tsx').default;
let renderer;
const saves = [];
await act(async () => { renderer = TestRenderer.create(React.createElement(Panel, { settings, pendingTokens: 9000, busy: false, onSave: value => saves.push(value) })); });
const input = () => renderer.root.findByProps({accessibilityLabel:'一级摘要最大 token'});
mock.timers.enable({apis:['setTimeout']});
await act(async () => { input().props.onChangeText('9000'); mock.timers.tick(999); });
assert.equal(saves.length,0,'输入过程中不保存');
await act(async () => { input().props.onChangeText('9100'); mock.timers.tick(999); });
assert.equal(saves.length,0,'继续输入不提交草稿');
await act(async () => { mock.timers.tick(10000); });
assert.equal(saves.length,0,'停输仍然等待失焦');
await act(async () => { input().props.onBlur(); });
assert.deepEqual(saves.pop(),{secondaryTokenThreshold:9100},'失焦保存最新阈值');
await act(async () => { input().props.onBlur(); });
assert.equal(saves.length,0,'没有修改时失焦不重复提交');
await act(async () => { input().props.onChangeText('9200'); });
await act(async () => { input().props.onBlur(); });
assert.deepEqual(saves.pop(), {secondaryTokenThreshold:9200},'失焦保存');
await act(async () => {renderer.root.findByProps({accessibilityLabel:'摘要输出 token 上限'}).props.onChangeText('4096');mock.timers.tick(1000);});
await act(async () => {renderer.root.findByProps({accessibilityLabel:'摘要输出 token 上限'}).props.onBlur();});
assert.deepEqual(saves.pop(),{maxOutputTokens:4096});
await act(async () => {renderer.root.findByProps({accessibilityLabel:'摘要输出 token 上限'}).props.onChangeText('');mock.timers.tick(1000);});
await act(async () => {renderer.root.findByProps({accessibilityLabel:'摘要输出 token 上限'}).props.onBlur();});
assert.deepEqual(saves.pop(),{maxOutputTokens:null},'留空恢复继承聊天设置');
await act(async () => {renderer.root.findByProps({accessibilityLabel:'摘要最长等待秒数'}).props.onChangeText('600');mock.timers.tick(1000);});
await act(async () => {renderer.root.findByProps({accessibilityLabel:'摘要最长等待秒数'}).props.onBlur();});
assert.deepEqual(saves.pop(),{requestTimeoutSeconds:600});
let failThresholdSave = true;
const retrySave = async value => { if(failThresholdSave) throw new Error('阈值写入失败'); saves.push(value); };
await act(async () => {renderer.update(React.createElement(Panel,{settings,pendingTokens:9000,busy:false,onSave:retrySave}));});
await act(async () => {input().props.onChangeText('9300');mock.timers.tick(1000);});
await act(async () => {input().props.onBlur();});
assert.equal(input().props.value,'9300','写入失败保留草稿');
assert.ok(renderer.root.findByType('AutoSaveErrors').props.error);
failThresholdSave=false;
await act(async () => {renderer.root.findByType('AutoSaveErrors').props.retry();});
assert.deepEqual(saves.pop(),{secondaryTokenThreshold:9300});
await act(async () => { input().props.onChangeText('0'); mock.timers.tick(1000); });
await act(async () => { input().props.onBlur(); });
assert.equal(saves.length,0);
assert.equal(input().props.value,'0','非法输入不写入，保留待修改');
assert.equal(renderer.root.findByProps({accessibilityRole:'alert'}).children.join(''),'请填写正整数 token 阈值');
await act(async () => { renderer.root.findByProps({accessibilityLabel:'开启一级摘要'}).props.onValueChange(false); });
assert.deepEqual(saves.pop(),{generationEnabled:false},'无效阈值不阻止独立开关保存');
await act(async () => { renderer.update(React.createElement(Panel,{settings:{...settings,generationEnabled:false, injectEnabled:false},pendingTokens:9000,busy:false,onSave:value=>saves.push(value)})); });
assert.equal(renderer.root.findByProps({accessibilityLabel:'开启二级摘要'}).props.disabled,false);
assert.equal(input().props.editable,true,'暂停生成仍可调整保存的阈值');
await act(async () => { renderer.update(React.createElement(Panel,{settings:{...settings,generationEnabled:false,fixedMessageId:41},pendingTokens:9000,busy:false,onSave:value=>saves.push(value)})); });
assert.equal(renderer.root.findByProps({accessibilityLabel:'开启一级摘要'}).props.disabled,true);
assert.equal(renderer.root.findByProps({accessibilityLabel:'注入已有摘要'}).props.disabled,false);
await act(async () => { renderer.root.findByProps({accessibilityLabel:'注入已有摘要'}).props.onValueChange(false); });
assert.deepEqual(saves.pop(),{injectEnabled:false},'固定期间仍能独立关闭摘要注入');
await act(async () => { renderer.unmount(); });
mock.timers.reset();

const SettingsScreen = load('src/features/chat/summary/presentation/ChatSummarySettingsScreen.tsx').default;
let leftSettings = 0;
await act(async () => { renderer = TestRenderer.create(React.createElement(SettingsScreen,{conversationId:'conversation',onBack:()=>leftSettings++})); });
await act(async () => { input().props.onChangeText('6100'); });
await act(async () => { renderer.root.findByType('NavigationHeader').props.onGoBack(); });
assert.deepEqual(writes.pop(),['settings','conversation',{secondaryTokenThreshold:6100}],'离开设置页立即保存未到自动保存时限的草稿');
assert.equal(leftSettings,1);
await act(async () => { input().props.onChangeText('0'); });
await act(async () => { renderer.root.findByType('NavigationHeader').props.onGoBack(); });
assert.equal(leftSettings,1,'非法草稿阻止离开并保留供修正');
await act(async () => { input().props.onChangeText('6200'); });
await act(async () => { renderer.root.findByType('NavigationHeader').props.onGoBack(); });
assert.deepEqual(writes.pop(),['settings','conversation',{secondaryTokenThreshold:6200}]);
assert.equal(leftSettings,2);
await act(async () => { renderer.unmount(); });

const Editor = load('src/features/chat/summary/presentation/ChatSummaryEditorScreen.tsx').default;
let returned = 0;
await act(async () => { renderer = TestRenderer.create(React.createElement(Editor,{conversationId:'conversation',segmentId:'p',onEditSource(){},onBack:()=>returned++})); });
assert.equal(renderer.root.findByType('TextInput').props.value,'一级原记录');
await act(async () => { renderer.root.findByType('TextInput').props.onChangeText('手动修正一级正文'); });
await act(async () => { renderer.root.findByType('NavigationHeader').props.rightButton.props.onPress(); });
assert.deepEqual(writes,[['edit','conversation','p','手动修正一级正文']],'一级原文仍单独编辑');
assert.equal(returned,1);
await act(async () => { renderer.unmount(); });

summaryTasks=[{id:'failed-task',conversationId:'conversation',level:'secondary',status:'failed',attemptCount:3,
  automaticFailures:3,nextAttemptAt:null,segmentIds:[],createdAt:'2026-10-12T00:00:00.000Z',updatedAt:'2026-10-12T00:00:00.000Z',
  error:{kind:'output_limit',message:'模型输出被 token 上限截断',retryable:false,occurredAt:'2026-10-12T00:00:00.000Z'},
  calls:[{model:'model',requestedMaxTokens:20,timeoutSeconds:300,durationMs:1000,promptTokens:100,completionTokens:20,
    totalTokens:120,cachedTokens:50,finishReason:'length',contentCharacters:12,reasoningCharacters:15,serverError:null}]}];
const SummaryList=load('src/features/chat/summary/presentation/ChatSummaryScreen.tsx').default;
let openedTask, openedSecondary=0;
segments=[...segments,{...segments[0],id:'timestamp-test',compactionId:null,content:'显示保存日期的摘要',sourceStartAt:'2026-04-08T00:00:00.000Z',createdAt:'2026-10-12T00:00:00.000Z'}];
await act(async()=>{renderer=TestRenderer.create(React.createElement(SummaryList,{conversationId:'conversation',onBack(){},onCreateSummary(){},onEditSummary(){},onEditSecondary:()=>openedSecondary++,onSettings(){},onTask:id=>openedTask=id}));});
assert.ok(renderer.root.findAllByType('Text').some(node=>node.children.join('')==='保存于 '+new Date('2026-10-12T00:00:00.000Z').toLocaleString()),'卡片标注摘要保存时间，不能显示首条来源消息日期');
assert.ok(!renderer.root.findAllByType('Text').some(node=>node.children.join('').includes(new Date('2026-04-08T00:00:00.000Z').toLocaleString())));
const failedLabel=renderer.root.findAllByType('Text').find(node=>node.children.join('')==='二级摘要2：失败，查看失败原因');
assert.ok(failedLabel);
await act(async()=>{renderer.root.findAllByType('Pressable').find(node=>node.findAllByType('Text').includes(failedLabel)).props.onPress();});
assert.equal(openedTask,'failed-task');
assert.equal(renderer.root.findAllByType('Toggle').length,0,'设置移入独立页面');
assert.ok(!renderer.root.findAllByType('Text').some(node=>node.children.join('')==='一级原记录'),'已归纳原文不在一级列表重复显示');
await act(async()=>{renderer.root.findByProps({accessibilityLabel:'编辑二级摘要'}).props.onPress();});
assert.equal(openedSecondary,1,'二级只保留一个集中编辑入口');
await act(async()=>{renderer.unmount();});
segments=segments.filter(segment=>segment.id!=='timestamp-test');
const TaskDetail=load('src/features/chat/summary/presentation/ChatSummaryTaskScreen.tsx').default;
let leftTask=0;
await act(async()=>{renderer=TestRenderer.create(React.createElement(TaskDetail,{conversationId:'conversation',taskId:'failed-task',onBack:()=>leftTask++,onSettings(){},onEditSummary(){},onEditSecondary:()=>openedSecondary++}));});
assert.ok(renderer.root.findAllByType('Text').some(node=>node.children.join('').includes('输出 token：20')));
assert.ok(renderer.root.findAllByType('Text').some(node=>node.children.join('').includes('length')));
assert.ok(renderer.root.findAllByType('Text').some(node=>node.children.join('').includes('最多自动重试 1 次')),'历史尝试次数与当前自动重试预算分开说明');
await act(async()=>{renderer.root.findByProps({accessibilityLabel:'重试摘要任务'}).props.onPress();});
assert.deepEqual(writes.at(-1),['retry','conversation','failed-task']);
await act(async()=>{renderer.root.findByType('NavigationHeader').props.onGoBack();});
assert.equal(leftTask,1,'排队尚未完成时用户也可立即离开');
await act(async()=>{finishRetry();});
summaryTasks=[{...summaryTasks[0],status:'completed',segmentIds:['s']}];
await act(async()=>{summaryPageListener('conversation');});
assert.ok(renderer.root.findAllByType('Text').some(node=>node.children.join('')==='已完成'));
await act(async()=>{renderer.root.findAllByType('Text').find(node=>node.children.join('')==='查看二级摘要').parent.props.onPress();});
assert.equal(openedSecondary,2,'成功任务也进入集中二级编辑');
await act(async()=>{renderer.unmount();});
segments=[...segments,
  {...segments[0],id:'p2',sequence:3,content:'较早的一级来源',sourceStartAt:'2026-10-10T00:00:00.000Z',compactionId:'s2'},
  {...segments[1],id:'s2',sequence:4,contextSequence:3,content:'后来的二级归纳'},
  {...segments[0],id:'pending',sequence:5,compactionId:null,content:'尚未归纳的一级'},
];
const Secondary=load('src/features/chat/summary/presentation/ChatSecondarySummaryScreen.tsx').default;
let openedSource, secondarySaved=0;
await act(async()=>{renderer=TestRenderer.create(React.createElement(Secondary,{conversationId:'conversation',onBack:()=>secondarySaved++,onEditSource:id=>openedSource=id}));});
assert.equal(renderer.root.findAllByType('TextInput').length,1,'所有二级正文只有一个编辑框');
assert.equal(renderer.root.findByType('TextInput').props.value,'二级归纳\n\n后来的二级归纳');
await act(async()=>{renderer.root.findByType('TextInput').props.onChangeText('统一修改后的二级正文');});
await act(async()=>{renderer.root.findByProps({accessibilityLabel:'展开已归纳原摘要'}).props.onPress();});
const sourceRows=()=>renderer.root.findAll(node=>node.type==='Pressable' && node.props.accessibilityLabel?.startsWith('编辑原摘要：'));
assert.deepEqual(sourceRows().map(node=>node.props.accessibilityLabel),['编辑原摘要：较早的一级来源','编辑原摘要：一级原记录'],'来源跨批次按时间排列，未归纳记录不混入');
assert.ok(sourceRows()[0].findAllByType('Text').some(node=>node.children.join('')==='保存于 '+new Date('2026-10-11T00:00:00.000Z').toLocaleString()),'二级来源卡片也显示保存时间，来源日期只用于原时间顺序');
await act(async()=>{sourceRows()[0].props.onPress();});
assert.equal(openedSource,'p2');
segments=segments.map(segment=>segment.id==='p2'?{...segment,content:'修改后的原摘要'}:segment);
await act(async()=>{summaryPageListener('conversation');});
assert.ok(renderer.root.findAllByType('Text').some(node=>node.children.join('')==='修改后的原摘要'),'编辑来源后原位置刷新');
assert.equal(renderer.root.findByType('TextInput').props.value,'统一修改后的二级正文','刷新来源不覆盖二级草稿');
await act(async()=>{renderer.root.findByProps({accessibilityLabel:'展开二级摘要调用记录'}).props.onPress();});
assert.ok(renderer.root.findAllByType('Text').some(node=>node.children.join('').includes('总 token：120')),'成功摘要仍能查看用量');
await act(async()=>{renderer.root.findByType('NavigationHeader').props.rightButton.props.onPress();});
assert.equal(secondarySaved,1);
assert.deepEqual(writes.at(-1).slice(0,2),['combined','conversation']);
assert.deepEqual(writes.at(-1)[2].map(value=>value.id),['s','s2']);
assert.equal(writes.at(-1)[3],'统一修改后的二级正文');
await act(async()=>{renderer.unmount();});
// 通过已有 segmentId 打开二级记录也进入同一个合并编辑框。
await act(async()=>{renderer=TestRenderer.create(React.createElement(Editor,{conversationId:'conversation',segmentId:'s',onBack(){},onEditSource(){}}));});
assert.equal(renderer.root.findByType('TextInput').props.value,'二级归纳\n\n后来的二级归纳');
await act(async()=>{renderer.unmount();});

const FixedSection = load('src/features/chat/presentation/conversation/FixedChatContextSection.tsx').default;
let chosen = 0;
const fixedChanges = [];
const fixedProps = {conversationId:'only-this-ai',onChoose:()=>chosen++,onFixedChange:value=>fixedChanges.push(value)};
await act(async () => { renderer=TestRenderer.create(React.createElement(FixedSection,fixedProps)); });
assert.ok(renderer.root.findAllByType('Text').some(node=>node.children.join('')==='选择起点'));
await act(async () => {renderer.root.findByType('Pressable').props.onPress();});
assert.equal(chosen,1);
fixedSnapshot={settings:{...settings,generationEnabled:false,fixedMessageId:42},fixedStart:{messageId:42,content:'固定的原消息',messageCount:7}};
await act(async () => {fixedSummaryListener('different-ai');});
assert.equal(fixedChanges.at(-1),false,'其他 AI 的事件不改变当前页面');
await act(async () => {fixedSummaryListener('only-this-ai');});
assert.equal(fixedChanges.at(-1),true);
assert.ok(renderer.root.findAllByType('Text').some(node=>node.children.join('')==='固定的原消息'));
assert.ok(renderer.root.findAllByType('Text').some(node=>node.children.join('').includes('7 条逻辑对话')));
fixedSnapshot={...fixedSnapshot,fixedStart:{...fixedSnapshot.fixedStart,messageCount:8}};
await act(async () => {fixedMessageBus.emit('messagesUpdated',{sessionId:'only-this-ai'});});
assert.ok(renderer.root.findAllByType('Text').some(node=>node.children.join('').includes('8 条逻辑对话')));
fixedSnapshot={...fixedSnapshot,fixedStart:{...fixedSnapshot.fixedStart,messageCount:7}};
await act(async () => {fixedMessageBus.emit('messagesDeleted',{sessionId:'only-this-ai',deletedMessageIds:[43]});});
assert.ok(renderer.root.findAllByType('Text').some(node=>node.children.join('').includes('7 条逻辑对话')),'删除后固定窗口计数同步减少');
await act(async () => {renderer.root.findAllByType('Pressable')[1].props.onPress();});
assert.deepEqual(fixedWrites,[['only-this-ai',null]],'取消只提交当前会话起点');
await act(async () => {renderer.unmount();});

const ContextSection = load('src/features/chat/presentation/conversation/ContextWindowSection.tsx').default;
await act(async () => {renderer=TestRenderer.create(React.createElement(ContextSection,{values:{privatePrimary:'30',privateSecondary:'10',groupPrimary:'40',groupSecondary:'5'},fixed:true,onChange(){}}));});
assert.equal(renderer.root.findByProps({accessibilityLabel:'当前单聊消息注入'}).props.editable,false);
assert.equal(renderer.root.findByProps({accessibilityLabel:'当前单聊消息注入'}).props.value,'30');
assert.equal(renderer.root.findByProps({accessibilityLabel:'单聊消息注入'}).props.editable,true);
await act(async () => {renderer.unmount();});

const Menu = load('src/features/chat/presentation/messages/components/ChatMessageActionMenu.tsx').default;
let pinned = 0,closed = 0;
await act(async () => {renderer=TestRenderer.create(React.createElement(Menu,{visible:true,onClose:()=>closed++,onFixedStart:()=>pinned++,isFixedStart:false}));});
await act(async () => {renderer.root.findByProps({accessibilityLabel:'固定'}).props.onPress();});
assert.equal(pinned,1);assert.equal(closed,1);
await act(async () => {renderer.update(React.createElement(Menu,{visible:true,onClose(){},onFixedStart(){},isFixedStart:true}));});
assert.ok(renderer.root.findByProps({accessibilityLabel:'取消固定'}));
await act(async () => {renderer.unmount();});
console.log('摘要与固定起点页面验证通过：独立开关、阈值草稿、两级编辑、会话隔离、计数刷新、消息菜单与近期参数保留。');
