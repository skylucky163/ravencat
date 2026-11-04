/** 个人主页资料与对话设置真实交互：字段独立保存、错误草稿与返回等待。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(file, dependencies = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `${file} 缺少依赖 ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const { AutoSaveDraftEditor } = load('src/shared/ui/AutoSaveDraftEditor.ts');
const chatSettingsDraft = load('src/features/chat/presentation/conversation/chatSettingsDraft.ts', {
  '@shared/ui/draftValidation': load('src/shared/ui/draftValidation.ts'),
});
const contextSettingsDraft = load('src/features/chat/presentation/conversation/contextSettingsDraft.ts', {
  '@shared/ui/draftValidation': load('src/shared/ui/draftValidation.ts'),
});
const assistantProfileDraft = load('src/features/assistants/presentation/profile/assistantProfileDraft.ts');
assert.deepEqual(contextSettingsDraft.parseContextSettingsDraft({privateSecondary:'0',groupSecondary:'1000'},['privateSecondary','groupSecondary']).patch,
  {privateContextSecondaryLimit:0,groupContextSecondaryLimit:1000},'客条数允许0与高于主条数，不增加大小关系限制');
assert.ok(contextSettingsDraft.parseContextSettingsDraft({privatePrimary:'0'},['privatePrimary']).errors.privatePrimary);
assert.ok(contextSettingsDraft.parseContextSettingsDraft({groupSecondary:'-1'},['groupSecondary']).errors.groupSecondary);
const tick = async () => { for (let count = 0; count < 30; count++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function screen(kind = 'settings') {
  const state = []; let cursor = 0; let editor; let latestSave; let avatarFailure = false; let avatarWork; let infoFailure = false;
  const writes = []; const updates = []; const alerts = []; let returned = 0;
  const backgrounds = new Map([['ai', 'file:///ai-background.jpg'], ['other-ai', 'file:///other-background.jpg']]);
  const backgroundReads = []; const backgroundWrites = [];
  let cancelBackground = false;
  const imagePicker = {
    requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
    launchImageLibraryAsync: async (options) => {
      assert.equal(options.allowsEditing, true, '更换通话背景先进入裁剪');
      assert.deepEqual(options.aspect, [1080, 2400]);
      return cancelBackground ? { canceled: true, assets: null }
        : { canceled: false, assets: [{ uri: 'file:///cropped-background.jpg', width: 1080 }] };
    },
  };
  const cropping = load('src/platform/device/pickCroppedImage.ts', {
    'react-native': { Dimensions: { get: () => ({ width: 360, height: 800, scale: 3 }) } },
    'expo-image-picker': imagePicker,
  });
  const persisted = { id: 'ai', name: '旧名称', systemPrompt: '原始人设', avatar: 'old.jpg', avatarMediaAssetId: 'old-asset', model: 'chat', updatedAt: 'old',
    privateContextPrimaryLimit: 30, privateContextSecondaryLimit: 10, groupContextPrimaryLimit: 40, groupContextSecondaryLimit: 5,
    allowMultipleBubbles: true, streamingReply: null, showTokenUsage: true, showActionSteps: true };
  let uri = persisted.avatar; let draft = null; let committedUri = uri;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], (value) => { state[index] = value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = { current: initial };
      return state[index];
    },
    useCallback: (callback) => callback, useMemo: (factory) => factory(),
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = state[index];
      if (previous && dependencies.every((value, position) => Object.is(value, previous.dependencies[position]))) return;
      previous?.cleanup?.();
      state[index] = { dependencies, cleanup: effect() };
    },
  };
  const { default: renderHook } = load(kind === 'profile' ? 'src/features/assistants/presentation/profile/useAssistantProfile.ts' : kind === 'context' ? 'src/features/chat/presentation/conversation/useContextSettings.ts' : 'src/features/chat/presentation/conversation/useChatSettings.ts', {
    react,
    './chatSettingsDraft': chatSettingsDraft,
    './contextSettingsDraft': contextSettingsDraft,
    './assistantProfileDraft': assistantProfileDraft,
    '@shared/ui': { showAppDialog: ({ title, buttons }) => alerts.push({ title, buttons }) },
    'react-native': { Alert: { alert: (title, _message, buttons) => alerts.push({ title, buttons }) } },
    'expo-image-picker': imagePicker,
    '@features/calls': {
      subscribeCallBackgroundChanged: () => () => {},
      loadCallBackgroundUri: async (id) => { backgroundReads.push(id); return backgrounds.get(id) ?? null; },
      setCustomCallBackground: async (input) => { backgroundWrites.push(input); backgrounds.set(input.assistantId, input.sourceUri); return input.sourceUri; },
      clearCallBackground: async (id) => { backgroundWrites.push({ clearedAssistantId: id }); backgrounds.delete(id); },
    },
    [kind === 'profile' ? '../../AIAssistantManagement' : '@features/assistants']: {
      getAIAssistantById: async () => ({ ...persisted }),
      updateAIAssistantSettings: async (_id, patch) => { if (infoFailure) throw new Error('资料写入失败'); writes.push(patch); Object.assign(persisted, patch); return true; },
      updateAIAssistantAvatarFromDraft: async (...args) => {
        assert.equal(args.length, 2, '头像命令不得携带名称草稿');
        if (avatarWork) await avatarWork.promise;
        if (avatarFailure) throw new Error('头像写入失败');
        writes.push({ avatar: args[1].uri });
        Object.assign(persisted, { avatar: args[1].uri, avatarMediaAssetId: 'new-asset', updatedAt: 'new' });
        return { ...persisted };
      },
    },
    '@platform/device/DeviceMediaService': {
      ...cropping,
      PERSISTENT_IMAGE_CATEGORY: { aiAvatar: 'ai' },
      usePersistentAvatarDraft: () => ({
        avatarUri: uri, isPickingAvatar: false, isCommittingAvatar: false,
        pickAvatar: async () => { uri = 'new.jpg'; draft = { uri }; return { status: 'selected', uri }; },
        resetAvatar: async () => { uri = null; draft = null; return true; },
        discardAvatarDraft: async () => { uri = committedUri; draft = null; },
        commitAvatar: async (save, project) => {
          const result = await save(uri, draft);
          uri = project(result); committedUri = uri; draft = null;
          return result;
        },
      }),
    },
    '@shared/ui/useAutoSaveDraft': {
      useAutoSaveDraft: (options) => {
        latestSave = options.save;
        if (!editor) editor = new AutoSaveDraftEditor(options.initial, options.parse, (patch) => latestSave(patch));
        else editor.rebase(options.initial);
        return { ...editor.getSnapshot(), change: editor.change, commit: editor.commit, flush: editor.flush, restore: editor.restore };
      },
      useAutoSaveNavigation: (flush, back, blocked) => {
        const leave = async (action) => { if (await flush()) action(); else blocked(); };
        return {leave,back:()=>leave(back)};
      },
    },
  });
  const render = () => {
    cursor = 0;
    const result = renderHook({ aiAssistant: { ...persisted }, onUpdated: (patch) => updates.push(patch), onBack: () => { returned++; } });
    return kind === 'profile' ? { ...result, back: async () => { if (await result.flush()) returned++; } } : result;
  };
  const chooseAvatar = async () => {
    render().handleAvatarPress();
    alerts.at(-1).buttons.find((button) => button.text === '从相册选择').onPress();
    await tick();
  };
  return { render, chooseAvatar, writes, updates, alerts, persisted, backgrounds, backgroundReads, backgroundWrites,
    cancelBackground: () => { cancelBackground = true; },
    failAvatar: (value) => { avatarFailure = value; },
    failInfo: (value) => { infoFailure = value; },
    delayAvatar: () => { avatarWork = deferred(); return avatarWork; },
    returned: () => returned,
  };
}

mock.timers.enable({ apis: ['setTimeout'] });
try {
  const context = screen('context');
  assert.deepEqual(context.render().contextLimits, { privatePrimary: '30', privateSecondary: '10', groupPrimary: '40', groupSecondary: '5' });
  context.render().handleContextLimitChange('privatePrimary', '48');
  mock.timers.tick(999); await tick();
  assert.deepEqual(context.writes, []);
  mock.timers.tick(10000); await tick();
  assert.deepEqual(context.writes, [], '条数停输后仍等待失焦');
  await context.render().commit();
  assert.deepEqual(context.writes, [{ privateContextPrimaryLimit: 48 }]);
  assert.equal(context.persisted.privateContextPrimaryLimit, 48);
  context.render().handleContextLimitChange('privateSecondary', '12');
  context.render().handleContextLimitChange('groupPrimary', '60');
  context.render().handleContextLimitChange('groupSecondary', '8');
  await context.render().flush();
  assert.deepEqual(context.writes.at(-1), { privateContextSecondaryLimit: 12, groupContextPrimaryLimit: 60, groupContextSecondaryLimit: 8 });
  const displaySettings = screen();
  displaySettings.render().setAllowMultipleBubbles(false); await tick();
  assert.deepEqual(displaySettings.writes.at(-1), { allowMultipleBubbles: false }, '开关立即提交且不覆盖模型配置');
  assert.equal(displaySettings.render().allowMultipleBubbles, false);
  assert.equal(chatSettingsDraft.getChatSettingsDraft(displaySettings.persisted).allowMultipleBubbles, false, '重新进入保留已保存的开关');
  for (const streamingReply of [true, false, null]) {
    displaySettings.render().setStreamingReply(streamingReply); await tick();
    assert.deepEqual(displaySettings.writes.at(-1), { streamingReply }, '回复方式独立即时保存');
    assert.equal(chatSettingsDraft.getChatSettingsDraft(displaySettings.persisted).streamingReply, streamingReply, '重进保留回复方式');
  }
  displaySettings.render().setShowTokenUsage(false); await tick();
  assert.deepEqual(displaySettings.writes.at(-1), { showTokenUsage: false }, 'Token 开关立即保存且不覆盖模型或气泡设置');
  assert.equal(chatSettingsDraft.getChatSettingsDraft(displaySettings.persisted).showTokenUsage, false, '重新进入保留 Token 显示选择');
  displaySettings.render().setShowActionSteps(false); await tick();
  assert.deepEqual(displaySettings.writes.at(-1), { showActionSteps: false }, '行动步骤开关独立立即保存');
  assert.equal(chatSettingsDraft.getChatSettingsDraft(displaySettings.persisted).showActionSteps, false, '重新进入保留行动步骤选择');

  // 未手动选择时采用主题默认，操作后按 AI 保存，切换主题不覆盖选择。
  const tokenPage = screen();
  const variants = load('src/shared/theme/themeVariants.ts');
  let theme = { id: 'daylight', colors: { chat: { screen: '#fff' }, text: { tertiary: '#999' } } };
  const react = { createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}], useMemo: (factory) => factory() };
  const { default: Settings } = load('src/features/chat/presentation/conversation/ChatSettings.tsx', {
    react: { ...react, default: react },
    'react-native': { View: 'View', Text: 'Text', ScrollView: 'ScrollView', Pressable: 'Pressable' },
    'lucide-react-native': { ChevronRight: 'ChevronRight' },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '@shared/ui/NavigationHeader': { default: 'NavigationHeader' },
    '@shared/ui': { AIInfoCard: 'AIInfoCard', BackgroundPickerCard: 'BackgroundPickerCard', InputField: 'InputField', KeyboardAvoidingContainer: 'KeyboardAvoidingContainer', ToggleField: 'ToggleField' },
    '@features/assistants': { ContextLimitsApply: 'ContextLimitsApply' },
    '@features/calls': { CallRingtoneSettings: 'CallRingtoneSettings' },
    '@shared/ui/AutoSaveErrors': { AutoSaveErrors: 'AutoSaveErrors' },
    './useChatSettings': { default: () => tokenPage.render() },
    './chatSettingsStyles': { createStyles: () => ({}) },
    '@shared/theme': { ...variants, ThemedSurface: 'ThemedSurface', useTheme: () => theme, useThemedStyles: () => ({}) },
    '@shared/ui/commonStyles': { createCommonStyles: () => ({}) },
    '../messages/components/ChatWallpaperSettings': { default: 'ChatWallpaperSettings' },
    './ContextWindowSection': { default: 'ContextWindowSection' },
    './FixedChatContextSection': { default: 'FixedChatContextSection' },
    './HistoricalGroupsSection': { default: 'HistoricalGroupsSection' },
  });
  const findToggle = (node, label) => {
    if (node?.props?.label === label) return node;
    for (const child of node?.children ?? []) { const found = findToggle(child, label); if (found) return found; }
    return null;
  };
  const toggle = (label) => findToggle(Settings({ aiAssistant: tokenPage.persisted, onOpenContextSettings() {} }), label);
  for (const id of ['default-light', 'default-dark', 'liquid-glass', 'paper-note', 'moon-kimi']) {
    theme = { ...theme, id };
    assert.equal(toggle('流式输出').props.value, ['paper-note', 'moon-kimi'].includes(id), `${id} 的开关采用主题默认`);
    assert.equal(tokenPage.writes.length, 0, '查看默认开关不写入手动选择');
  }
  for (const id of ['default-light', 'default-dark', 'liquid-glass', 'paper-note', 'moon-kimi']) {
    const writesBeforeTheme = tokenPage.writes.length;
    theme = { ...theme, id };
    const streamingToggle = () => toggle('流式输出');
    assert.equal(streamingToggle().props.value, false, `${id} 保留此前关闭选择`);
    assert.equal(tokenPage.writes.length, writesBeforeTheme, '切换主题不产生配置写入');
    for (const value of [true, false]) {
      streamingToggle().props.onValueChange(value); await tick();
      assert.equal(streamingToggle().props.value, value, `${id} 可自由开关流式输出`);
      assert.deepEqual(tokenPage.writes.at(-1), { streamingReply: value }, '开关独立保存布尔选择');
    }
    for (const label of ['显示 Token 用量', '显示行动步骤']) {
      assert.equal(toggle(label).props.value, true, `${id} 保留开启选择`);
      assert.notEqual(toggle(label).props.disabled, true, `${id} 允许操作`);
    }
    toggle('显示 Token 用量').props.onValueChange(false); await tick();
    assert.equal(toggle('显示 Token 用量').props.value, false);
    assert.equal(toggle('显示行动步骤').props.value, true, 'Token 开关不影响行动步骤');
    toggle('显示行动步骤').props.onValueChange(false); await tick();
    assert.equal(toggle('显示行动步骤').props.value, false);
    toggle('显示 Token 用量').props.onValueChange(true); await tick();
    assert.equal(toggle('显示行动步骤').props.value, false, '行动步骤开关独立保存');
    toggle('显示行动步骤').props.onValueChange(true); await tick();
  }
  for (const invalid of ['', '0', '1.5']) {
    context.render().handleContextLimitChange('privatePrimary', invalid);
    assert.equal(await context.render().flush(), false);
    assert.equal(context.render().contextLimits.privatePrimary, invalid);
    assert.ok(context.render().settingsErrors.privatePrimary);
  }
  displaySettings.render().setAllowMultipleBubbles(true); await tick();
  assert.deepEqual(displaySettings.writes.at(-1), { allowMultipleBubbles: true }, '上下文错误不影响独立页面偏好的保存');
  await context.render().back(); assert.equal(context.returned(), 0, '无效上下文阻止返回');
  await context.render().restoreInfo();
  assert.equal(context.render().contextLimits.privatePrimary, '48', '恢复使用最后保存的条数');
  await context.render().back(); assert.equal(context.returned(), 1);

  const choosingFixedStart = screen('context');
  let openedMessages = 0;
  choosingFixedStart.render().handleContextLimitChange('privatePrimary','0');
  await choosingFixedStart.render().leave(()=>openedMessages++);
  assert.equal(openedMessages,0,'去设置固定起点也需处理无效草稿');
  await choosingFixedStart.render().restoreInfo();
  choosingFixedStart.render().handleContextLimitChange('privatePrimary','47');
  await choosingFixedStart.render().leave(()=>openedMessages++);
  assert.equal(openedMessages,1);
  assert.equal(choosingFixedStart.persisted.privateContextPrimaryLimit,47,'跳转消息列表前保存近期参数');

  const contextFailure = screen('context'); contextFailure.failInfo(true);
  contextFailure.render().handleContextLimitChange('privatePrimary', '50');
  await contextFailure.render().back();
  assert.equal(contextFailure.returned(), 0);
  assert.equal(contextFailure.render().contextLimits.privatePrimary, '50');
  assert.ok(contextFailure.render().infoSaveError);
  contextFailure.failInfo(false); await contextFailure.render().flush();
  assert.equal(contextFailure.persisted.privateContextPrimaryLimit, 50);

  const roleBackground = screen();
  roleBackground.render(); await tick();
  assert.deepEqual(roleBackground.backgroundReads, ['ai']);
  assert.equal(roleBackground.render().callBackgroundUri, 'file:///ai-background.jpg');
  await roleBackground.render().handlePickCallBackground();
  assert.equal(roleBackground.backgroundWrites.at(-1).assistantId, 'ai', '选图绑定设置页中的角色');
  assert.equal(roleBackground.backgroundWrites.at(-1).sourceUri, 'file:///cropped-background.jpg', '保存裁剪后的图片');
  assert.equal(roleBackground.backgroundWrites.at(-1).sourceWidth, 1080, '压缩使用裁剪后的宽度');
  roleBackground.cancelBackground();
  await roleBackground.render().handlePickCallBackground();
  assert.equal(roleBackground.backgroundWrites.length, 1, '取消裁剪不写入、不替换现有通话背景');
  assert.equal(roleBackground.backgrounds.get('other-ai'), 'file:///other-background.jpg');
  roleBackground.persisted.id = 'other-ai';
  roleBackground.render(); await tick();
  assert.deepEqual(roleBackground.backgroundReads, ['ai', 'other-ai'], '切换角色后重新读取该角色背景');
  assert.equal(roleBackground.render().callBackgroundUri, 'file:///other-background.jpg');
  roleBackground.render().handleClearCallBackground();
  await roleBackground.alerts.at(-1).buttons.find((button) => button.text === '恢复默认').onPress();
  assert.deepEqual(roleBackground.backgroundWrites.at(-1), { clearedAssistantId: 'other-ai' });
  assert.equal(roleBackground.backgrounds.get('ai'), 'file:///cropped-background.jpg', '清除只影响当前角色');

  const page = screen('profile');
  page.render().setName(' 新名称 ');
  mock.timers.tick(999); await tick();
  assert.deepEqual(page.writes, []);
  mock.timers.tick(10000); await tick();
  assert.deepEqual(page.writes, [], '名称停输后仍等待失焦');
  await page.render().commit();
  assert.deepEqual(page.writes, [{ name: '新名称' }]);

  page.render().setSystemPrompt(' 新人设\n保持原始排版 ');
  await page.render().commit();
  assert.deepEqual(page.writes.at(-1), { systemPrompt: ' 新人设\n保持原始排版 ' });
  assert.equal(page.persisted.systemPrompt, ' 新人设\n保持原始排版 ', '提示词消费者读取助手持久化的人设');
  page.render().setSystemPrompt(''); await page.render().flush();
  assert.equal(page.persisted.systemPrompt, '', '允许清除人设');

  page.render().setName(''); await page.render().commit();
  assert.ok(page.render().nameError);
  page.render().setSystemPrompt('空名称不阻止人设保存');
  await page.render().flush();
  assert.equal(page.persisted.systemPrompt, '空名称不阻止人设保存');
  await page.chooseAvatar();
  assert.deepEqual(page.writes.at(-1), { avatar: 'new.jpg' });
  assert.equal(page.render().name, '', '头像确认不得覆盖名称草稿');
  await page.render().back(); assert.equal(page.returned(), 0);
  await page.render().restoreInfo(); await page.render().back(); assert.equal(page.returned(), 1);
  assert.ok(page.alerts.every(({ title }) => title !== '成功'), '正常自动保存不弹成功提示');

  const personaFailure = screen('profile'); personaFailure.failInfo(true);
  personaFailure.render().setSystemPrompt('未保存的人设');
  await personaFailure.render().back();
  assert.equal(personaFailure.returned(), 0);
  assert.equal(personaFailure.render().systemPrompt, '未保存的人设');
  assert.ok(personaFailure.render().infoSaveError);
  assert.equal(personaFailure.persisted.systemPrompt, '原始人设');
  personaFailure.failInfo(false); await personaFailure.render().flush();
  assert.equal(personaFailure.persisted.systemPrompt, '未保存的人设');
  personaFailure.render().setSystemPrompt('待恢复的人设'); await personaFailure.render().restoreInfo();
  assert.equal(personaFailure.render().systemPrompt, '未保存的人设');

  const failed = screen('profile'); failed.failAvatar(true);
  await failed.chooseAvatar();
  assert.equal(failed.render().avatarUrl, 'new.jpg');
  assert.ok(failed.render().avatarError);
  await failed.render().back(); assert.equal(failed.returned(), 0);
  failed.failAvatar(false); failed.render().retryAvatar(); await tick();
  assert.equal(failed.render().avatarError, null);
  await failed.render().back(); assert.equal(failed.returned(), 1);

  const restored = screen('profile'); restored.failAvatar(true); await restored.chooseAvatar();
  await restored.render().restoreAvatar();
  assert.equal(restored.render().avatarUrl, 'old.jpg');
  assert.equal(restored.render().avatarError, null);
  await restored.render().back(); assert.equal(restored.returned(), 1);

  const pending = screen('profile'); const work = pending.delayAvatar(); await pending.chooseAvatar();
  pending.render().setName('头像保存期间的新名称');
  await pending.render().commit();
  let left = false; const leaving = pending.render().back().then(() => { left = true; });
  await tick(); assert.equal(left, false, '返回必须等待已开始的头像提交');
  work.resolve(); await leaving; assert.equal(pending.returned(), 1);
  assert.equal(pending.render().name, '头像保存期间的新名称');

  const reset = screen('profile'); reset.render().handleAvatarPress();
  reset.alerts.at(-1).buttons.find((button) => button.text === '恢复默认').onPress();
  reset.alerts.at(-1).buttons.find((button) => button.text === '恢复默认').onPress();
  await tick();
  assert.deepEqual(reset.writes, [{ avatar: null, avatarMediaAssetId: null }]);
  assert.equal(reset.persisted.name, '旧名称');
} finally { mock.timers.reset(); }
console.log('个人主页与对话设置：资料和上下文独立保存、错误保留、头像恢复与返回等待验证通过。');
