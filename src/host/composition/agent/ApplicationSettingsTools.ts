/** Host 组合各设置 owner；工具分包不改变业务数据所有权或媒体视觉链路。 */
import { Dimensions } from 'react-native';
import { Asset } from 'expo-asset';
import { DEFAULT_MOMENTS_COVER_SOURCE } from '@features/moments';
import { getGroupAvatarForAssistant } from '@features/chat';
import {
  ApplicationSettingsAccessError, assertApplicationSettingsAccessInTransaction,
  changeAssistantAvatarFromMediaAsset, changeAssistantSpaceCoverFromMediaAsset, changeAssistantPublicName, listAIAssistantSummaries,
  DEFAULT_ASSISTANT_SPACE_COVER_SOURCE, getAssistantSpaceCoverImageSelection,
} from '@features/assistants';
import {
  changeCurrentUserAvatarFromMediaAsset, changeCurrentUserMomentsCoverFromMediaAsset,
  changeWallpaperFromMediaAsset, getCurrentUserMomentsCoverImageSelection, getWallpaperImageSelection,
} from '@features/profile';
import { changeCallBackgroundFromMediaAsset, getCallBackgroundImageSelection } from '@features/calls';
import { mediaImageFailure, viewImageSource, ViewImageTool } from '@features/media';
import { CoordinatedDatabaseError, type DatabaseTransactionExecutor } from '@platform/persistence';
import type { AgentToolExecutionContext, AgentToolExecutionResult, ToolDefinition } from '@shared/aiTools';
import { SettingChangeConflictError } from '@shared/errors/SettingChangeConflictError';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { loadStoredThemeId } from '@shared/theme/themeStorage';
import { getDefaultGroupAvatarAsset } from '@shared/avatar/avatarRegistry';
import { assertImageToolRunCurrent } from './assertImageToolRunCurrent';

type Context = AgentToolExecutionContext;
type Result = AgentToolExecutionResult<unknown>;
type TargetInput = { agent_id?: string };
type ImageInput = TargetInput & ({ action: 'set'; media_asset_id: string } | { action: 'reset' });
type Parameters = ToolDefinition['parameters'];

const agentProperty = { agent_id: { type: 'string', minLength: 1, maxLength: 120,
  description: '目标 AI 的稳定 agentId；省略表示自己。其他 AI 的名称和背景设置仅当前主理 AI 可修改或查询。' } };
const ownOrHost = '省略 agent_id 表示自己；指定其他 AI 需要当前主理 AI 身份。';
const imageInstructions = '可在权限范围内自主布置，无需逐次向用户确认。action=set 时必须传 media_asset_id，系统自动居中裁剪并等比处理，不拉伸；action=reset 恢复默认，不传图片 ID。动态图片只使用单帧。不确定内容时先看图。';

function imageParameters(targeted: boolean) {
  return {
    type: 'object', properties: {
      ...(targeted ? agentProperty : {}),
      action: { type: 'string', enum: ['set', 'reset'] },
      media_asset_id: { type: 'string', minLength: 1, maxLength: 120, description: '消息、下载或图片获取工具提供的媒体 ID。' },
    }, required: ['action'], additionalProperties: false,
    oneOf: [
      { properties: { action: { const: 'set' } }, required: ['media_asset_id'] },
      { properties: { action: { const: 'reset' } }, not: { required: ['media_asset_id'] } },
    ],
  };
}

class SettingTargetUnavailableError extends Error {}

function tool<T>(name: string, description: string, parameters: Parameters, execute: (input: T, context: Context) => Promise<Result>) {
  return { name, definition: { name, description, parameters }, async execute(input: T, context: Context): Promise<Result> {
    throwIfAbortSignalAborted(context.abortSignal);
    try { return await execute(input, context); }
    catch (caught) {
      // Host 拥有跨 Feature 设置提交及注入的权限 guard，在这里恢复已知业务拒绝。
      const error = caught instanceof CoordinatedDatabaseError ? caught.cause : caught;
      if (error instanceof ApplicationSettingsAccessError) return failure('SETTING_ACCESS_DENIED', error.message);
      if (error instanceof SettingChangeConflictError) return failure('SETTING_CHANGE_CONFLICT', error.message);
      if (error instanceof SettingTargetUnavailableError) return failure('SETTING_TARGET_UNAVAILABLE', error.message);
      const mediaFailure = mediaImageFailure(error);
      if (mediaFailure) return mediaFailure;
      throw caught;
    }
  } };
}

function failure(code: string, modelContent: string): Result { return { status: 'error', code, modelContent, retryable: false }; }
function success(data: Record<string, unknown>): Result { return { status: 'success', data, modelContent: JSON.stringify(data) }; }

async function targetFor(context: Context, agentId: string | undefined, access: 'avatar_read' | 'manage' | 'global') {
  const assistants = await listAIAssistantSummaries();
  const actor = assistants.find(ai => ai.id === context.task.assistantId);
  if (!actor) throw new SettingTargetUnavailableError('当前 AI 已不存在。');
  const target = agentId === undefined ? actor : assistants.find(ai => ai.agentId === agentId);
  if (!target) throw new SettingTargetUnavailableError('未找到目标 agent_id；请使用 AI 身份目录中的稳定 agentId。');
  if ((access === 'global' || (access === 'manage' && target.id !== actor.id)) && !actor.isHostAI) {
    throw new ApplicationSettingsAccessError();
  }
  return target;
}

/** 与 owner 的 CAS 共用提交事务；处理图片期间撤销主理或打断回合，迟到提交均失效。 */
function guardFor(context: Context, targetId: string | null) {
  return async (tx: DatabaseTransactionExecutor) => {
    await assertImageToolRunCurrent(tx, context);
    await assertApplicationSettingsAccessInTransaction(tx, context.task.assistantId, targetId);
  };
}

function screenAspect(): readonly [number, number] {
  const screen = Dimensions.get('screen');
  return [screen.width, screen.height];
}
function selectedImageId(input: ImageInput) { return input.action === 'reset' ? null : input.media_asset_id; }
function chatKey(target: Awaited<ReturnType<typeof targetFor>>): string {
  if (target.canonicalConversationId === null) throw new SettingTargetUnavailableError('目标 AI 尚无单聊会话，无法操作聊天背景。');
  return `single:${target.canonicalConversationId}`;
}

async function showSelection(selection: { mediaAssetId: string | null; legacyUri: string | null }, label: string,
  source: string, context: Context): Promise<Result> {
  if (selection.mediaAssetId === null && selection.legacyUri === null) {
    return success({ mediaAssetId: null, label, source, hasImage: false, message: '当前使用系统默认绘制背景，没有可获取的图片或媒体 ID。' });
  }
  const result = await viewImageSource({ mediaAssetId: selection.mediaAssetId ?? undefined,
    imageUri: selection.legacyUri ?? undefined, label }, context);
  if (result.status !== 'success') return result;
  return { ...result, data: { ...result.data as Record<string, unknown>, source },
    modelContent: `${JSON.stringify({ source })}\n${result.modelContent}` };
}

const emptyParameters = { type: 'object', properties: {}, additionalProperties: false };
const targetParameters = { type: 'object', properties: agentProperty, additionalProperties: false };

const getUserAvatar = tool<Record<string, never>>('get_user_avatar', '获取并查看当前用户头像，无需参数；沿用当前 AI 的视觉能力。', emptyParameters,
  async (_input, context) => ViewImageTool.execute({ target: 'user_avatar' }, context));
const getAIAvatar = tool<TargetInput>('get_ai_avatar', '获取并查看 AI 头像；不填 agent_id 获取自己，填写稳定 agentId 可查看其他 AI 的公开头像。', targetParameters,
  async (input, context) => {
    const target = await targetFor(context, input.agent_id, 'avatar_read');
    return ViewImageTool.execute({ target: 'assistant_avatar', selector: target.agentId }, context);
  });
const getGroupAvatar = tool<{ group_id?: string }>('get_group_avatar', '获取并查看群聊头像。群聊中省略 group_id 表示当前群；其他场景必须指定群聊 ID。普通 AI 只能查看自己当前仍启用的群成员关系所在群，当前主理 AI 可查看所有群。沿用当前 AI 的视觉能力。',
  { type: 'object', properties: { group_id: { type: 'string', minLength: 1, maxLength: 120, description: '群聊身份背景中的 group_id，或跨会话背景中 kind=group 的 conversationId；只有在当前群聊中才可省略。' } }, additionalProperties: false },
  async (input, context) => {
    if (input.group_id === undefined && context.task.type !== 'group_chat_reply') {
      return failure('SETTING_TARGET_REQUIRED', '当前运行不在群聊中，请提供 group_id；不能把单聊会话 ID 当作群聊 ID。');
    }
    const groupId = input.group_id ?? context.task.sessionId!;
    const actor = await targetFor(context, undefined, 'avatar_read');
    const selection = await getGroupAvatarForAssistant(groupId, actor.id, actor.isHostAI);
    if (selection.status === 'not_found') return failure('SETTING_TARGET_UNAVAILABLE', '目标群聊不存在或已被删除。');
    if (selection.status === 'forbidden') return failure('SETTING_ACCESS_DENIED', '普通 AI 只能查看自己当前仍启用的群成员关系所在群的头像。');
    let imageUri = selection.avatar ?? undefined;
    if (selection.avatarMediaAssetId === null && selection.avatar === null) {
      const bundled = await Asset.fromModule(getDefaultGroupAvatarAsset()).downloadAsync();
      imageUri = bundled.localUri!;
    }
    const result = await viewImageSource({ mediaAssetId: selection.avatarMediaAssetId ?? undefined,
      imageUri, label: `${selection.name}的群头像` }, context);
    if (result.status !== 'success') return result;
    const group = { groupId: selection.groupId, groupName: selection.name };
    return { ...result, data: { ...result.data as Record<string, unknown>, ...group },
      modelContent: `${JSON.stringify(group)}\n${result.modelContent}` };
  });
const getChatBackground = tool<TargetInput>('get_chat_background', `获取并查看单聊实际背景，并说明是独立设置、玻璃主题全局图还是默认绘制。${ownOrHost}`, targetParameters,
  async (input, context) => {
    const target = await targetFor(context, input.agent_id, 'manage');
    const selection = await getWallpaperImageSelection(chatKey(target));
    if (selection.mediaAssetId !== null || selection.legacyUri !== null) return showSelection(selection, `${target.name}的单聊背景`, 'conversation', context);
    if (await loadStoredThemeId() === 'liquid-glass') {
      return showSelection(await getWallpaperImageSelection('app'), `${target.name}单聊当前继承的玻璃主题全局背景`, 'global_glass', context);
    }
    return showSelection(selection, `${target.name}的单聊背景`, 'theme_default', context);
  });
const getCallBackground = tool<TargetInput>('get_call_background', `获取并查看 AI 的通话背景。${ownOrHost}`, targetParameters,
  async (input, context) => {
    const target = await targetFor(context, input.agent_id, 'manage');
    return showSelection(await getCallBackgroundImageSelection(target.id), `${target.name}的通话背景`, 'call', context);
  });
const getGlobalBackground = tool<Record<string, never>>('get_global_background', '获取并查看玻璃主题全局背景图，无需参数；不切换当前主题。', emptyParameters,
  async (_input, context) => {
    await targetFor(context, undefined, 'global');
    return showSelection(await getWallpaperImageSelection('app'), '玻璃主题全局背景', 'global_glass', context);
  });
const getMomentsCover = tool<Record<string, never>>('get_moments_cover', '获取并查看当前朋友圈（时刻）封面，无需参数。', emptyParameters,
  async (_input, context) => {
    const selection = await getCurrentUserMomentsCoverImageSelection();
    if (selection.mediaAssetId !== null || selection.legacyUri !== null) return showSelection(selection, '朋友圈封面', 'moments_cover', context);
    const bundled = await Asset.fromModule(DEFAULT_MOMENTS_COVER_SOURCE).downloadAsync();
    return showSelection({ mediaAssetId: null, legacyUri: bundled.localUri! }, '朋友圈默认封面', 'default_cover', context);
  });

const setAIAvatar = tool<ImageInput>('set_ai_avatar', `更换或恢复 AI 头像，可自主布置自己的头像。${ownOrHost}${imageInstructions}`, imageParameters(true),
  async (input, context) => {
    const target = await targetFor(context, input.agent_id, 'manage');
    const result = await changeAssistantAvatarFromMediaAsset(target.id, selectedImageId(input), context.abortSignal, guardFor(context, target.id));
    return success({ agentId: target.agentId, action: input.action, ...result });
  });
const setChatBackground = tool<ImageInput>('set_chat_background', `更换或恢复 AI 单聊背景；只修改目标单聊，不修改群聊或全局背景。${ownOrHost}${imageInstructions}`, imageParameters(true),
  async (input, context) => {
    const target = await targetFor(context, input.agent_id, 'manage');
    const result = await changeWallpaperFromMediaAsset(chatKey(target), { mediaAssetId: selectedImageId(input), aspect: screenAspect(), signal: context.abortSignal }, guardFor(context, target.id));
    return success({ agentId: target.agentId, action: input.action, ...result });
  });
const setCallBackground = tool<ImageInput>('set_call_background', `更换或恢复 AI 通话背景。${ownOrHost}${imageInstructions}`, imageParameters(true),
  async (input, context) => {
    const target = await targetFor(context, input.agent_id, 'manage');
    const result = await changeCallBackgroundFromMediaAsset(target.id, { mediaAssetId: selectedImageId(input), aspect: screenAspect(), signal: context.abortSignal }, guardFor(context, target.id));
    return success({ agentId: target.agentId, action: input.action, ...result });
  });
const setUserAvatar = tool<ImageInput>('set_user_avatar', `更换或恢复用户头像。${imageInstructions}`, imageParameters(false),
  async (input, context) => {
    await targetFor(context, undefined, 'global');
    return success({ action: input.action, ...await changeCurrentUserAvatarFromMediaAsset(selectedImageId(input), context.abortSignal, guardFor(context, null)) });
  });
const setMomentsCover = tool<ImageInput>('set_moments_cover', `更换或恢复朋友圈（时刻）封面。${imageInstructions}`, imageParameters(false),
  async (input, context) => {
    await targetFor(context, undefined, 'global');
    return success({ action: input.action, ...await changeCurrentUserMomentsCoverFromMediaAsset(selectedImageId(input), context.abortSignal, guardFor(context, null)) });
  });
const setGlobalBackground = tool<ImageInput>('set_global_background', `更换或恢复玻璃主题全局背景图；其他主题下也可保存，不自动切换主题。${imageInstructions}`, imageParameters(false),
  async (input, context) => {
    await targetFor(context, undefined, 'global');
    const result = await changeWallpaperFromMediaAsset('app', { mediaAssetId: selectedImageId(input), aspect: screenAspect(), signal: context.abortSignal }, guardFor(context, null));
    return success({ action: input.action, ...result, message: '已保存玻璃主题背景选择；使用玻璃主题时显示，不改变独立设置的单聊背景。' });
  });
const setAIName = tool<TargetInput & { name: string }>('set_ai_name', `修改 AI 公开名称，可在权限范围内自主使用，无需逐次向用户确认。${ownOrHost}不修改用户私有昵称、人设或历史消息。`,
  { type: 'object', properties: { ...agentProperty, name: { type: 'string', minLength: 1, pattern: '\\S', description: '新的公开名称，不能为空。' } }, required: ['name'], additionalProperties: false },
  async (input, context) => {
    const target = await targetFor(context, input.agent_id, 'manage');
    const name = input.name.trim();
    await changeAssistantPublicName(target.id, name, guardFor(context, target.id));
    return success({ agentId: target.agentId, name, message: '公开名称已保存；用户若设置了私有昵称，其界面仍可能显示昵称。' });
  });

const getOwnSpaceCover = tool<Record<string, never>>('get_own_space_cover',
  '获取并查看自己的 AI 个人空间封面，个人主页与自己的朋友圈顶部共用这张图片，无需参数。自定义封面返回媒体 ID；未设置时查看默认星空图片，默认图片没有媒体 ID。沿用当前 AI 的视觉能力。', emptyParameters,
  async (_input, context) => {
    const selection = await getAssistantSpaceCoverImageSelection(context.task.assistantId);
    if (selection === null) throw new SettingTargetUnavailableError('当前 AI 已不存在。');
    if (selection.mediaAssetId !== null) {
      return showSelection({ ...selection, legacyUri: null }, '自己的 AI 个人空间封面（主页与朋友圈共用）', 'space_cover', context);
    }
    const bundled = await Asset.fromModule(DEFAULT_ASSISTANT_SPACE_COVER_SOURCE).downloadAsync();
    return showSelection({ mediaAssetId: null, legacyUri: bundled.localUri! }, '自己的 AI 个人空间默认封面（主页与朋友圈共用）', 'default_space_cover', context);
  });

const setOwnSpaceCover = tool<{ media_asset_id: string }>('set_own_space_cover',
  '更换自己的 AI 个人空间封面，同时更新个人主页与自己的朋友圈顶部，不修改用户的朋友圈封面。只需传入消息、下载或图片工具提供的 media_asset_id；系统自动居中裁剪为 2:1，不拉伸、不修改原图。可自主使用，无需逐次确认；不确定图片内容时先看图。',
  { type: 'object', properties: { media_asset_id: { type: 'string', minLength: 1, maxLength: 120, description: '已有图片的媒体 ID。' } },
    required: ['media_asset_id'], additionalProperties: false },
  async (input, context) => {
    // 唯一目标来自可信执行上下文；主理身份也不扩大此工具的修改范围。
    const result = await changeAssistantSpaceCoverFromMediaAsset(context.task.assistantId, input.media_asset_id,
      context.abortSignal, tx => assertImageToolRunCurrent(tx, context));
    return success(result);
  });

/** 产品元数据与工具实现一起交给唯一注册表；不维护另一份运行权限目录。 */
export const applicationSettingsTools = [
  { tool: getUserAvatar, owner: 'profile', hostOnly: false, mutating: false },
  { tool: getAIAvatar, owner: 'assistants', hostOnly: false, mutating: false },
  { tool: getGroupAvatar, owner: 'chat', hostOnly: false, mutating: false },
  { tool: getChatBackground, owner: 'profile', hostOnly: false, mutating: false },
  { tool: getCallBackground, owner: 'calls', hostOnly: false, mutating: false },
  { tool: getGlobalBackground, owner: 'profile', hostOnly: true, mutating: false },
  { tool: getMomentsCover, owner: 'profile', hostOnly: false, mutating: false },
  { tool: getOwnSpaceCover, owner: 'assistants', hostOnly: false, mutating: false },
  { tool: setAIAvatar, owner: 'assistants', hostOnly: false, mutating: true },
  { tool: setOwnSpaceCover, owner: 'assistants', hostOnly: false, mutating: true },
  { tool: setChatBackground, owner: 'profile', hostOnly: false, mutating: true },
  { tool: setCallBackground, owner: 'calls', hostOnly: false, mutating: true },
  { tool: setUserAvatar, owner: 'profile', hostOnly: true, mutating: true },
  { tool: setMomentsCover, owner: 'profile', hostOnly: true, mutating: true },
  { tool: setGlobalBackground, owner: 'profile', hostOnly: true, mutating: true },
  { tool: setAIName, owner: 'assistants', hostOnly: false, mutating: true },
] as const;
