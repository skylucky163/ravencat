/** 解析场景目标绑定和用户静态片段后，再委托统一 Prompt Pack 组装器。 */

import {
  listPromptCustomBlocks,
  resolveAssistantPromptConfiguration,
  resolveLegacyPromptPreset,
} from '@features/prompting';
import type {
  AssemblePromptPackParams,
  AssembleStandalonePromptPackParams, PromptPack,
  PromptPackBlock, PromptPackScenario,
} from '@shared/prompt';
import { promptPackAssembler } from './PromptPackAssembler';
import { promptPackCompiler } from './compiler';
import { createDeviceBatteryPromptBlocks } from './DeviceBatteryPromptBlock';
import { promptPackBlockFactory } from './PromptPackBlockFactory';
import { PARAGRAPH_BREAK_SCENARIOS } from './PromptBuiltInContent';

const BATTERY_PRESET_ITEM = {
  definitionId: 'context.device_battery', slot: 'dynamic_context' as const,
  sortOrder: 195, enabled: true, required: false, protection: 'overridable' as const,
};

export async function assembleResolvedChatPromptPack(
  params: AssemblePromptPackParams
): Promise<PromptPack> {
  const scenario = resolveChatScenario(params);
  return promptPackAssembler.assembleChatPromptPack(await resolveParams(scenario, params));
}
export async function assembleResolvedSummaryPromptPack(params: AssemblePromptPackParams, task: PromptPackBlock): Promise<PromptPack> {
  return promptPackAssembler.assembleSummaryPromptPack(await resolveParams('chat.private_reply', params, false), task);
}

export async function assembleResolvedLedgerPromptPack(
  params: AssemblePromptPackParams
): Promise<PromptPack> {
  return promptPackAssembler.assembleLedgerPromptPack(await resolveParams('ledger.reply', params));
}

export async function assembleResolvedStandalonePromptPack(
  params: AssembleStandalonePromptPackParams
): Promise<PromptPack> {
  const resolved = await resolveLegacyPromptPreset({
    scenarioId: params.scenarioId,
    assistantId: params.assistantId || null,
    groupId: params.groupId || null,
  });
  const customBlocks = await resolveCustomBlocks(
    params.scenarioId,
    resolved.preset.items.map((item) => item.definitionId)
  );
  const currentInput = { role: 'user' as const, content: params.currentInput };
  const includeNickname = params.assistantId && ['call.post_user_hangup', 'together_listening.post_user_decline', 'raven_cat.ai_schedule_trigger'].includes(params.scenarioId);
  const nicknameBlocks = includeNickname ? [await promptPackBlockFactory.createAssistantNicknameBlock(
    params.assistantId!,
  )] : [];
  return promptPackCompiler.compile({
    scenario: params.scenarioId,
    blocks: [
      ...params.blocks,
      ...customBlocks,
      ...nicknameBlocks,
      {
        key: 'current_input',
        title: '当前任务输入',
        content: params.currentInput,
        required: true,
        status: 'ready',
        source: 'runtime.currentInput',
        truncatable: false,
        scenario: params.scenarioId,
        placement: 'input',
      },
    ],
    recentMessages: [],
    currentInput,
    preset: { ...resolved.preset, items: [...resolved.preset.items,
      ...(includeNickname ? [{ definitionId: 'context.assistant_nickname', slot: 'persona' as const,
        sortOrder: 32, enabled: true, required: false, protection: 'locked' as const }] : []),
    ] },
  });
}

async function resolveParams(
  scenarioId: PromptPackScenario,
  params: AssemblePromptPackParams,
  includeDynamicContext = true
): Promise<AssemblePromptPackParams> {
  const resolved = await resolveLegacyPromptPreset({
    scenarioId,
    assistantId: params.aiConfig.id,
    groupId: params.runtimeContext?.groupChat?.groupId || null,
  });
  const assistantConfiguration = await resolveAssistantPromptConfiguration({
    assistantId: params.aiConfig.id,
    scenarioId,
    hasImage: params.runtimeContext?.capabilities?.some((capability) => capability.includes('vision')),
    toolsEnabled: params.aiConfig.enableTools === true,
  });
  const legacyCustomBlocks = await resolveCustomBlocks(
    scenarioId,
    resolved.preset.items.map((item) => item.definitionId)
  );
  const userBlocks = assistantConfiguration.userPrompts.map((prompt): PromptPackBlock => ({
    key: 'persona',
    instanceId: `assistant-user:${prompt.id}`,
    definitionId: `assistant-user:${prompt.id}`,
    slot: 'user_rules',
    protection: 'editable',
    title: prompt.name,
    content: prompt.content,
    required: false,
    status: 'ready',
    source: 'assistant_user_prompts',
    truncatable: false,
    scenario: scenarioId,
    placement: 'system',
  }));
  const userContents = new Set(userBlocks.map((block) => block.content));
  const customBlocks = [
    ...legacyCustomBlocks.filter((block) => !userContents.has(block.content)),
    ...userBlocks,
  ];
  const paragraphBreaksEnabled = includeDynamicContext && assistantConfiguration.paragraphBreaksEnabled
    && PARAGRAPH_BREAK_SCENARIOS.some((scenario) => scenario === scenarioId);
  const actionDescriptionEnabled = includeDynamicContext && assistantConfiguration.actionDescriptionEnabled
    && PARAGRAPH_BREAK_SCENARIOS.some((scenario) => scenario === scenarioId);
  return {
    ...params,
    aiConfig: {
      ...params.aiConfig,
      promptDefinitionOverrides: assistantConfiguration.overrides,
      disabledPromptDefinitionIds: [
        ...assistantConfiguration.disabledDefinitionIds,
        // 对应内容是受保护定义，通用禁用过滤不覆盖 locked 条目，这里显式传给 Host 组装层。
        ...(assistantConfiguration.userStateEnabled ? [] : ['context.together_listening_runtime'] as const),
        ...(assistantConfiguration.socialEnabled ? [] : ['context.moments_social_inbox'] as const),
      ],
      messageTimestampsEnabled: assistantConfiguration.messageTimestampsEnabled,
      agentRegistryExcludedAssistantIds: assistantConfiguration.agentRegistryExcludedAssistantIds,
    },
    preset: {
      ...resolved.preset,
      items: resolved.preset.items.map((item) => (
        (item.definitionId === 'context.time_awareness' && !assistantConfiguration.timeEnabled)
          || (item.definitionId === 'context.together_listening_runtime' && !assistantConfiguration.userStateEnabled)
          || (item.definitionId === 'context.moments_social_inbox' && !assistantConfiguration.socialEnabled)
          || (assistantConfiguration.disabledDefinitionIds.includes(item.definitionId)
            && item.protection !== 'locked')
          ? { ...item, enabled: false }
          : item
      )).filter((item) => item.definitionId !== BATTERY_PRESET_ITEM.definitionId).concat({
        ...BATTERY_PRESET_ITEM, enabled: assistantConfiguration.batteryEnabled,
      }).filter((item) => item.definitionId !== 'output.paragraph_breaks' && item.definitionId !== 'output.action_description').concat({
        definitionId: 'output.paragraph_breaks', slot: 'foundation', sortOrder: 25,
        enabled: paragraphBreaksEnabled, required: false, protection: 'overridable',
      }).concat({
        definitionId: 'output.action_description', slot: 'foundation', sortOrder: 26,
        enabled: actionDescriptionEnabled, required: false, protection: 'overridable',
      }),
    },
    additionalBlocks: [
      ...(params.additionalBlocks || []),
      ...(includeDynamicContext ? await createDeviceBatteryPromptBlocks(assistantConfiguration.batteryEnabled, scenarioId) : []),
      ...(paragraphBreaksEnabled ? [promptPackBlockFactory.createParagraphBreaksBlock({
        ...params.aiConfig, promptDefinitionOverrides: assistantConfiguration.overrides,
      })] : []),
      ...(actionDescriptionEnabled ? [promptPackBlockFactory.createActionDescriptionBlock({
        ...params.aiConfig, promptDefinitionOverrides: assistantConfiguration.overrides,
      })] : []),
      ...customBlocks,
    ],
  };
}

async function resolveCustomBlocks(
  scenarioId: PromptPackScenario,
  referencedDefinitionIds: string[]
): Promise<PromptPackBlock[]> {
  const referencedIds = new Set(referencedDefinitionIds);
  return (await listPromptCustomBlocks())
    .filter((block) => referencedIds.has(block.id))
    .map((block): PromptPackBlock => ({
      key: 'persona',
      instanceId: `custom:${block.id}`,
      definitionId: block.id,
      slot: block.defaultSlot,
      protection: 'editable',
      title: block.name,
      content: block.content,
      required: false,
      status: 'ready',
      source: 'prompt_custom_blocks',
      truncatable: true,
      scenario: scenarioId,
      placement: 'system',
    }));
}

function resolveChatScenario(
  params: AssemblePromptPackParams
): PromptPackScenario {
  if (params.runtimeContext?.groupChat) return 'chat.group_member_reply';
  if (params.runtimeContext?.triggerSource === 'call_outgoing_decision') return 'call.outgoing_decision';
  if (params.runtimeContext?.triggerSource === 'call') return 'call.live_reply';
  return 'chat.private_reply';
}
