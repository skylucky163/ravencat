/** 默认页只表达注入顺序；正文、权限和列表留在各自详情页。 */
import { getAssistantDisplayName } from '@features/assistants';
import { InputField, KeyboardAvoidingContainer, ToggleField, showAppDialog, type ToggleFieldProps } from '@shared/ui';
import { CHAT_PROMPT_READING_FLOW, type ChatPromptReadingStep } from '@shared/prompt';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { ChevronDown, ChevronRight, Square, SquareCheck, Star } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GlassSurface, ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import NavigationHeader from '@shared/ui/NavigationHeader';
import ModalSheet from '@shared/ui/ModalSheet';
import { getPromptCenterSnapshot } from '../application/GetPromptCenterSnapshot';
import { deleteDefaultUserPrompt, getAgentRegistrySettings, getDefaultPromptEditor, getPromptAssistant, moveDefaultUserPrompt, resetDefaultDefinition, saveDefaultDefinition, saveDefaultUserPrompt, setAgentRegistryAssistantIncluded, setDefaultPromptSwitch } from '../application/ManagePromptDefaults';
import { applyAssistantDefinitionGlobally, applyAssistantDirectToolsGlobally, createAssistantUserPrompt, deleteAssistantUserPrompt, getAssistantPromptEditorDetails, getSummaryPromptGenerationState, reorderAssistantUserPrompts, resetAssistantDefinitionOverride, saveAssistantDefinitionOverride, saveAssistantDefinitionState, setAssistantToolPermission, setAssistantDirectToolExposure, updateAssistantUserPrompt } from '../application/ManageAssistantPrompts';
import type { AssistantPromptEditorDetails } from '../application/ManageAssistantPrompts';
import type { PromptAssistantOption, PromptAssistantSummary } from '../application/PromptingRuntimeDependencies';
import type { DefaultUserPrompt } from '../domain/PromptDefaults';
import type { AssistantUserPrompt } from '../domain/Prompting';
import { CustomPromptRow } from './CustomPromptRow';
import { createPromptCenterStyles } from './promptCenterStyles';

type RuleDefinitionId = 'foundation.default_core' | 'output.paragraph_breaks' | 'input.image_grounding' | 'internal.chat_summary' | 'internal.chat_secondary_summary' | 'internal.vision_ocr';
export type PromptCenterPage = { kind: 'overview' } | { kind: 'conditional' } | { kind: 'other' } | { kind: 'registry' } | { kind: 'custom' } | { kind: 'tools' } | { kind: 'package'; id: string } | { kind: 'editor'; definitionId: RuleDefinitionId } | { kind: 'userEditor'; promptId?: string } | { kind: 'persona' };
type Snapshot = Awaited<ReturnType<typeof getDefaultPromptEditor>>;
type ToggleSetting = Pick<ToggleFieldProps, 'value' | 'onValueChange' | 'disabled' | 'accessibilityLabel'>;
const RULE_NAMES: Record<RuleDefinitionId, string> = {
  'foundation.default_core': '系统基础规则',
  'output.paragraph_breaks': '换行规则',
  'input.image_grounding': '图片防幻觉提醒',
  'internal.chat_summary': '一级摘要提示词',
  'internal.chat_secondary_summary': '二级摘要提示词',
  'internal.vision_ocr': '图片识别提示词',
};
const PACKAGE_NAMES: Record<string, string> = { kimiOfficial: 'Kimi 官方工具', webTools: '联网工具包', media: '图片', applicationSettings: '应用设置工具', groupChat: '群聊', protocol: '协议空间', moments: '时刻', wallet: '羽库记账', calls: '通话', memory: '记忆', chat: '语音', stickers: '表情包', togetherListening: '一起听', host: '主理 AI 专属' };

/** 展示按产品用途分包；摘要工具仍由 Chat 拥有，主理工具统一在专属包管理。 */
function getToolPackageId(tool: Snapshot['tools'][number]): string {
  if (tool.packageId) return tool.packageId;
  if (tool.hostOnly) return 'host';
  return tool.owner;
}

interface Props {
  assistants: PromptAssistantOption[];
  assistantListError: boolean;
  onSelectAssistant: (assistantId: string) => void;
  onOpenGlobalPrompts: () => void;
  page: PromptCenterPage;
  refreshRevision: number;
  onOpenPage: (page: PromptCenterPage) => void;
  assistantId?: string;
  onBack: () => void;
  onOpenMcp: () => void;
  onOpenWebSearch: () => void;
  onOpenUserProfile: () => void;
  onOpenProtocols: (assistantId: string) => void;
}

export default function PromptCenterScreen({ assistants, assistantListError, onSelectAssistant, onOpenGlobalPrompts, page, refreshRevision, onOpenPage, assistantId, onBack, onOpenMcp, onOpenWebSearch, onOpenUserProfile, onOpenProtocols }: Props) {
  const theme = useTheme();
  const styles = useThemedStyles(createPromptCenterStyles);
  const catalog = useMemo(() => getPromptCenterSnapshot(), []);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [registrySettings, setRegistrySettings] = useState<Awaited<ReturnType<typeof getAgentRegistrySettings>>>([]);
  const [assistant, setAssistant] = useState<PromptAssistantSummary | null>(null);
  const [details, setDetails] = useState<AssistantPromptEditorDetails | null>(null);
  const initialized = useRef(false);
  const mounted = useRef(false);
  const [content, setContent] = useState('');
  const ruleId = page.kind === 'editor' ? page.definitionId : 'foundation.default_core';
  const summaryRule = ruleId === 'internal.chat_summary' || ruleId === 'internal.chat_secondary_summary';
  const readSummaryState = page.kind === 'other' || summaryRule;
  const [summaryState, setSummaryState] = useState<Awaited<ReturnType<typeof getSummaryPromptGenerationState>> | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [directToolsExpanded, setDirectToolsExpanded] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const refresh = useCallback(async () => {
    const next = await getDefaultPromptEditor();
    if (page.kind === 'registry') setRegistrySettings(await getAgentRegistrySettings());
    if (assistantId) {
      const [selected, editorDetails] = await Promise.all([getPromptAssistant(assistantId), getAssistantPromptEditorDetails(assistantId, next)]);
      setAssistant(selected); setDetails(editorDetails);
      if (readSummaryState) setSummaryState(await getSummaryPromptGenerationState(assistantId));
    }
    setSnapshot(next);
  }, [assistantId, page.kind, readSummaryState]);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const next = await getDefaultPromptEditor();
        const selected = assistantId ? await getPromptAssistant(assistantId) : null;
        const editorDetails = assistantId ? await getAssistantPromptEditorDetails(assistantId, next) : null;
        const registry = page.kind === 'registry' ? await getAgentRegistrySettings() : [];
        const summary = assistantId && readSummaryState ? await getSummaryPromptGenerationState(assistantId) : null;
        if (active) {
          if (!initialized.current) {
            if (page.kind === 'editor') {
              const definitionId = page.definitionId;
              const override = editorDetails?.overrides.find((item) => item.definitionId === definitionId && item.locale === 'zh-CN');
              setContent(override?.content ?? next.overrides[definitionId] ?? catalog.definitions.find((item) => item.id === definitionId)!.defaultContent!);
            }
            else if (page.kind === 'userEditor' && page.promptId) {
              const prompt = (assistantId ? editorDetails!.userPrompts : next.userPrompts).find((item) => item.id === page.promptId);
              if (!prompt) throw new Error('该提示词不存在');
              setName(prompt.name); setContent(prompt.content);
            }
            initialized.current = true;
          }
          setSnapshot(next); setAssistant(selected); setDetails(editorDetails); setRegistrySettings(registry); setSummaryState(summary); setLoadError(false);
        }
      } catch (error) { if (active) { setLoadError(true); showAppDialog({ title: '读取失败', message: errorMessage(error), tone: 'error' }); } }
    })();
    return () => { active = false; };
  }, [assistantId, catalog, page, refreshRevision, readSummaryState]);
  async function mutate(action: () => Promise<unknown>, after?: () => void) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      // 保存期间可能已被系统返回弹出，完成后不能再次退出父页。
      if (!mounted.current) return;
      await refresh();
      if (mounted.current) after?.();
    } catch (error) {
      if (mounted.current) showAppDialog({ title: '保存失败', message: errorMessage(error), tone: 'error' });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function openUser(prompt: DefaultUserPrompt | AssistantUserPrompt | null) { onOpenPage({ kind: 'userEditor', promptId: prompt?.id }); }
  function saveEditor() {
    void mutate(async () => {
      if (page.kind === 'editor') {
        if (assistantId) await saveAssistantDefinitionOverride({ assistantId, definitionId: ruleId, locale: 'zh-CN', content });
        else await saveDefaultDefinition(ruleId, content);
      } else if (page.kind === 'userEditor') {
        const sortOrder = Math.max(0, ...prompts.map((item) => item.sortOrder)) + 10;
        if (assistantId) {
          if (editingPrompt) await updateAssistantUserPrompt({ ...(editingPrompt as AssistantUserPrompt), name, content });
          else await createAssistantUserPrompt({ assistantId, name, content, condition: 'always', enabled: true, sortOrder });
        } else {
          await saveDefaultUserPrompt({
            id: editingPrompt?.id ?? `default_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name, content, enabled: editingPrompt?.enabled ?? true,
            sortOrder: editingPrompt?.sortOrder ?? sortOrder,
          });
        }
      }
    }, onBack);
  }
  function resetRule() {
    showAppDialog({ title: '恢复默认', message: '恢复这一项的默认正文？', buttons: [
      { text: '取消', style: 'cancel' },
      { text: '恢复', onPress: () => {
        void mutate(async () => {
          if (assistantId) await resetAssistantDefinitionOverride({ assistantId, definitionId: ruleId, locale: 'zh-CN' });
          else await resetDefaultDefinition(ruleId);
        }, () => {
          const codeDefault = catalog.definitions.find((item) => item.id === ruleId)!.defaultContent!;
          const restored = assistantId ? snapshot!.overrides[ruleId] ?? codeDefault : codeDefault;
          setContent(restored);
        });
      } },
    ] });
  }
  function applyRuleGlobally() {
    void mutate(() => applyAssistantDefinitionGlobally({ definitionId: ruleId, content }),
      () => showAppDialog({ title: '已全局应用', message: '当前正文已同步到所有现有 AI 的这一项提示词，各自的开关保持不变。' }));
  }
  function togglePrompt(prompt: DefaultUserPrompt | AssistantUserPrompt, enabled: boolean) {
    void mutate(() => assistantId
      ? updateAssistantUserPrompt({ ...(prompt as AssistantUserPrompt), enabled })
      : saveDefaultUserPrompt({ ...prompt, enabled }));
  }
  function movePrompt(prompt: DefaultUserPrompt | AssistantUserPrompt, index: number, offset: number) {
    const target = prompts[index + offset];
    if (target) void mutate(() => assistantId
      ? reorderAssistantUserPrompts(prompt as AssistantUserPrompt, target as AssistantUserPrompt)
      : moveDefaultUserPrompt(prompt, target));
  }
  function deletePrompt(prompt: DefaultUserPrompt) {
    showAppDialog({ title: assistantId ? '删除提示词' : '删除全局提示词', message: assistantId ? `删除“${prompt.name}”？` : `删除“${prompt.name}”后，所有 AI 将不再注入这条常驻提示词。`, buttons: [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => {
        void mutate(() => assistantId ? deleteAssistantUserPrompt(prompt.id, assistantId) : deleteDefaultUserPrompt(prompt.id));
      } },
    ] });
  }
  function toggleTool(toolName: string, enabled: boolean) {
    void mutate(() => assistantId ? setAssistantToolPermission(assistantId, toolName, enabled)
      : setDefaultPromptSwitch(`tool:${toolName}`, enabled));
  }
  const tools = snapshot?.tools.filter((tool) => !tool.cooldownOnly || assistant?.isInHostCooldown).map((tool) => {
    const selected = details?.tools.find((item) => item.name === tool.name);
    return { ...tool, enabled: selected?.enabled ?? tool.enabled, unavailableReason: selected?.unavailableReason };
  }) ?? [];
  const directToolNames = new Set(details?.directToolNames);
  const directTools = tools.filter((tool) => directToolNames.has(tool.name));
  const toolIsUnavailable = (tool: typeof tools[number]) => Boolean(tool.unavailableReason);
  const toolIsReadOnly = (tool: typeof tools[number]) => busy || toolIsUnavailable(tool)
    || (tool.hostOnly && !(tool.cooldownOnly ? assistant?.isInHostCooldown : assistant?.isHostAI));
  const packages = [...new Set(tools.map(getToolPackageId))]
    .sort((a, b) => a === 'host' ? -1 : b === 'host' ? 1 : 0);
  const prompts = assistantId ? details?.userPrompts ?? [] : snapshot?.userPrompts ?? [];
  const editingPrompt = page.kind === 'userEditor' ? prompts.find((item) => item.id === page.promptId) : undefined;
  const title = page.kind === 'overview' ? '提示词中心' : page.kind === 'conditional' ? '条件提示词' : page.kind === 'other' ? '其他提示词' : page.kind === 'registry' ? 'AI 身份池' : page.kind === 'custom' ? (assistantId ? '自定义提示词' : '全局常驻提示词') : page.kind === 'tools' ? '工具调用' : page.kind === 'package' ? PACKAGE_NAMES[page.id] ?? page.id : page.kind === 'editor' ? RULE_NAMES[ruleId] : page.kind === 'persona' ? 'AI 人设' : page.promptId ? '编辑提示词' : '添加提示词';
  /** 概览与条件条目复用玻璃材质；普通主题使用自己的卡片底色。 */
  function row(label: string, description: string, action?: () => void, number?: number | null, disabled = false, toggle?: ToggleSetting, glass = false) {
    const leading = number !== undefined && <Text style={[styles.number, number === null && styles.numberPlaceholder]}>{number === null ? '' : String(number).padStart(2, '0')}</Text>;
    const body = <>
      {leading}
      <View style={styles.copy}><Text style={styles.title}>{label}</Text><Text style={styles.subtitle}>{description}</Text></View>
      {action && !disabled ? <ChevronRight size={18} color={theme.colors.text.tertiary} /> : null}
    </>;
    const useGlass = glass && theme.effects.glass.enabled;
    const surfaceStyle = [useGlass ? styles.glassRowInner : styles.row, disabled && styles.muted];
    const content = toggle
      ? <ToggleField layout="inline" rowStyle={surfaceStyle} label={label} hint={description} leading={leading}
          contentStyle={styles.copy} labelStyle={styles.title} hintStyle={styles.subtitle} {...toggle} />
      : action
      ? <TouchableOpacity accessibilityRole="button" disabled={disabled || busy} onPress={action} activeOpacity={0.7} style={surfaceStyle}>{body}</TouchableOpacity>
      : <View style={surfaceStyle}>{body}</View>;
    if (useGlass) {
      return <GlassSurface key={label} material={{ cornerRadius: theme.radius.lg }} style={styles.glassRow}>{content}</GlassSurface>;
    }
    return <React.Fragment key={label}>{content}</React.Fragment>;
  }
  const overviewRow = (label: string, description: string, action?: () => void, number?: number | null, disabled = false, toggle?: ToggleSetting) =>
    row(label, description, action, number, disabled, toggle, true);
  function injectionSetting(definitionId: 'output.paragraph_breaks' | 'input.image_grounding'): ToggleSetting {
    const enabled = definitionId === 'output.paragraph_breaks' ? details?.paragraphBreaksEnabled ?? false : details?.imageGroundingEnabled ?? true;
    return { accessibilityLabel: `注入${RULE_NAMES[definitionId]}`, disabled: busy || !assistant, value: enabled,
      onValueChange: (value) => { void mutate(() => saveAssistantDefinitionState({ assistantId: assistantId!, definitionId, enabled: value })); } };
  }
  function summaryStatus(level: 'primary' | 'secondary') {
    if (!summaryState) return '选择 AI 后显示对应摘要的启用状态';
    const enabled = level === 'primary' ? summaryState.primaryEnabled : summaryState.secondaryEnabled;
    return `${enabled ? '已开启' : '已关闭'} · 跟随${level === 'primary' ? '一级摘要' : '一级与二级摘要'}设置`;
  }
  function readingStep(step: ChatPromptReadingStep, position: number) {
    switch (step) {
      case 'foundation': return overviewRow('系统基础规则', '运行环境与通用行为边界', () => onOpenPage({ kind: 'editor', definitionId: 'foundation.default_core' }), position);
      case 'paragraphs': return overviewRow('换行规则', '默认关闭 · 普通聊天正文的分段方式', () => onOpenPage({ kind: 'editor', definitionId: 'output.paragraph_breaks' }), position);
      case 'persona': return <ThemedSurface variant="card" style={styles.card}>
        <View style={styles.cardHeader}><Text style={styles.number}>{String(position).padStart(2, '0')}</Text><Text style={styles.title}>人设</Text></View>
        {row('AI 人设', assistant ? '查看当前人设 · 在 AI 个人主页中修改' : '当前未绑定 AI，无法查看', assistant ? () => onOpenPage({ kind: 'persona' }) : undefined, undefined, !assistant)}
        {row('用户人设', '在个人资料中修改 · 自动保存 · 所有 AI 共用', onOpenUserProfile)}
      </ThemedSurface>;
      case 'group_identity': return overviewRow('群聊身份背景', '群聊时提供群名称、成员及当前 AI 的群内身份', undefined, position);
      case 'protocol': return overviewRow('协议空间常驻提示词', assistant ? '你与 AI 均可修改的固定注入信息，全部持续生效' : '当前未绑定 AI，无法查看', assistant ? () => onOpenProtocols(assistant.id) : undefined, position, !assistant);
      case 'agent_registry': return overviewRow('AI 身份池', '入池 AI 相互可见 · 未入池的 AI 与身份池双向隔离', () => onOpenPage({ kind: 'registry' }), position);
      case 'custom': return overviewRow('自定义提示词', `${prompts.length} 条${assistant ? '专属' : '全局'}提示词 · 按列表顺序拼接`, () => onOpenPage({ kind: 'custom' }), position);
      case 'tools': return overviewRow('工具调用', '按用途管理工具包与调用权限', () => onOpenPage({ kind: 'tools' }), position);
      case 'mcp': return overviewRow('MCP', '外部服务由 MCP 模块按需注入', onOpenMcp, position);
      case 'history': return overviewRow('历史聊天', '聊天、用户操作与应用事件按发生顺序进入历史和摘要', undefined, position);
      case 'tool_runtime': return overviewRow('工具运行上下文', '有可用工具时提供本轮调用的运行上下文', undefined, position);
      case 'user_state': return overviewRow('用户状态与一起听', assistant ? '仅一起听期间提供播放状态、输出设备与当前歌词 · 关闭后不注入 · 仅对这位 AI 生效' : '选择 AI 后可调整一起听状态注入', undefined, position, false,
        { accessibilityLabel: '注入用户状态与一起听', disabled: busy || !assistant, value: details?.userStateEnabled ?? true, onValueChange: (enabled) => { void mutate(() => saveAssistantDefinitionState({ assistantId: assistantId!, definitionId: 'context.user_state', enabled })); } });
      case 'social': return overviewRow('时刻社交信息', assistant ? '单聊与群聊均提供当前 AI 的未读事件 · 关闭后不注入 · 仅对这位 AI 生效' : '选择 AI 后可调整时刻社交信息注入', undefined, position, false,
        { accessibilityLabel: '注入时刻社交信息', disabled: busy || !assistant, value: details?.socialEnabled ?? true, onValueChange: (enabled) => { void mutate(() => saveAssistantDefinitionState({ assistantId: assistantId!, definitionId: 'context.social', enabled })); } });
      case 'environment': return overviewRow('环境信息', '当前单聊、群聊或通话 · 本轮由用户、账本或日程等来源触发', undefined, position);
      case 'assistant_state': return overviewRow('AI 当前身份状态', '按需提供原主理 AI 冷静期及剩余时间', undefined, position);
      case 'memory': return overviewRow('被动记忆', '按当前输入触发的历史资料', undefined, position);
      case 'battery': return overviewRow('手机电量', assistant ? '本轮电量与充电状态 · 关闭后不读取 · 仅对这位 AI 生效' : '选择 AI 后可调整电量注入', undefined, position, false,
        { accessibilityLabel: '注入手机电量', disabled: busy || !assistant, value: details?.batteryEnabled ?? true, onValueChange: (enabled) => { void mutate(() => saveAssistantDefinitionState({ assistantId: assistantId!, definitionId: 'context.device_battery', enabled })); } });
      case 'time': return <>
        {overviewRow('当前时间', assistant ? '为本轮校准现在 · 开关仅对这位 AI 生效' : '选择 AI 后可调整时间注入', undefined, position, false,
          { accessibilityLabel: '注入当前时间', disabled: busy || !assistant, value: details?.timeEnabled ?? true, onValueChange: (enabled) => { void mutate(() => saveAssistantDefinitionState({ assistantId: assistantId!, definitionId: 'context.time_awareness', enabled })); } })}
        {overviewRow('消息时间戳', '默认关闭 · 为历史及本轮消息提供时间，帮助理解先后与间隔。开启会增加输入 Token；部分模型仍可能模仿时间格式。独立于当前时间，仅对所选 AI 生效。', undefined, null, false,
          { accessibilityLabel: '注入消息时间戳', disabled: busy || !assistant, value: details?.messageTimestampsEnabled ?? false, onValueChange: (enabled) => { void mutate(() => saveAssistantDefinitionState({ assistantId: assistantId!, definitionId: 'context.message_timestamps', enabled })); } })}
      </>;
      case 'output': return overviewRow('本轮回应要求', '按场景提供记账回复、日程行动等本轮执行与输出要求', undefined, position);
      case 'input': return overviewRow('当前聊天', '真实用户输入位于最后；账本、日程等应用触发时省略', undefined, position);
    }
  }
  const readingSections = { identity: '先认识彼此', capabilities: '可用的能力', context: '从过去，回到现在' };
  // 页面规则说明挂在标题后的问号里，正文只留可操作内容。
  const headerHelp = page.kind === 'conditional' ? {
    sections: [
      { title: '触发与编辑', body: '按功能管理满足条件时才使用的提示词。触发条件由功能决定，正文可以修改或恢复默认。' },
      { title: '图片提醒', body: '仅在未配置 OCR、聊天图片附件直接传给模型时附加；OCR 成功、识别失败或工具取得的画面均不追加。默认开启，关闭后不增加提醒文字。' },
      { title: '生效范围', body: assistant ? '开关与正文覆盖仅对当前 AI 生效；恢复默认正文不会改变开关。' : '未选择 AI 时只能编辑全局默认正文，开关需选择 AI 后调整。' },
    ],
  } : page.kind === 'other' ? {
    sections: [
      { title: '用途与编辑', body: '按功能管理其他任务使用的提示词。选择条目可修改正文、恢复默认，或将当前正文应用到所有现有 AI。' },
      { title: '生效条件', body: '每项提示词随所属功能的设置生效，具体用途与启用条件可在对应编辑页查看。' },
      { title: '图片识别', body: '仅在该 AI 绑定了视觉识别模型时参与图片转述；正文按 AI 保存，未单独覆盖时使用全局默认，输出格式不受正文影响。' },
    ],
  } : page.kind === 'editor' && summaryRule ? {
    sections: [
      { title: '摘要提示词', body: '一级从聊天和通话原文提取记忆，二级从一级正文提炼与合并。正文只用于对应的摘要任务，不进入普通聊天。请保留纯正文输出要求，输入字段和日期含义可参考默认内容。' },
      { title: '启用状态', body: '状态随当前 AI 的摘要设置变化，这里不另设开关。自动生成关闭或固定消息起点时两级都停用；仅关闭二级时一级仍可使用。关闭期间仍可编辑，恢复生成后使用保存的正文。' },
      { title: '保存与恢复', body: assistant ? '保存只修改当前 AI 的正文，恢复默认删除这位 AI 的覆盖。已有摘要不重写，正在执行的请求沿用开始时的提示词，后续请求使用新正文。' : '未选择 AI 时编辑全局默认正文。未单独覆盖的 AI 和群摘要使用这里的内容；群摘要保持中立身份，不借用群成员的专属正文。' },
      ...(assistant ? [{ title: '全局应用', body: '直接使用当前编辑草稿覆盖所有现有 AI 的这一项正文，不改摘要开关和全局默认；之后新增的 AI 仍使用默认正文。' }] : []),
    ],
  } : page.kind === 'editor' ? {
    sections: [
      { title: '生效范围', body: assistant ? '保存为当前 AI 的正文覆盖；恢复默认后使用全局默认正文。恢复正文不会改变开关。' : '编辑全局默认正文，未单独覆盖的 AI 会使用这里的内容。开关需选择 AI 后调整。' },
      ...(ruleId === 'foundation.default_core' ? [{ title: '清空正文', body: '清空并保存后不注入系统基础规则，AI 人设与其他提示词照常生效；点击恢复默认可重新使用默认正文。' }] : []),
      ...(assistant ? [{ title: '全局应用', body: '直接使用当前编辑框的正文，无需先保存，一次覆盖所有现有 AI 的这一项提示词。保留每位 AI 的开关和其他提示词；之后新增的 AI 仍使用全局默认。' }] : []),
      ...(ruleId === 'output.paragraph_breaks' ? [{ title: '注入条件', body: '默认关闭。开启后在普通聊天、群聊、记账回应与日程消息的稳定提示词中注入，紧随系统基础规则、位于 AI 人设之前；通话、OCR、摘要和内部决策任务不使用。' }] : []),
      ...(ruleId === 'input.image_grounding' ? [{ title: '注入条件', body: '默认开启，仅在未配置 OCR 且聊天图片附件直接传图时附加；关闭后完全省略，不改变图片发送。' }] : []),
    ],
  } : page.kind === 'registry' ? {
    sections: [
      { title: '入池规则', body: '选择加入身份池的 AI，默认全部勾选，新添加的 AI 也默认入选。名单为全局设置，修改自动保存。' },
      { title: '可见范围', body: '入池 AI 可通过身份池了解彼此及底层模型名；未勾选的 AI 不会出现在身份池中，也不会收到其他 AI 的身份池信息。' },
    ],
  } : page.kind === 'tools' ? {
    sections: [
      { title: '单项权限', body: assistant ? '这位 AI 的单项权限；工具总开关、场景与身份边界仍共同决定本轮可用工具。' : '全局默认权限；AI 的单独设置可以覆盖默认值，主理专属工具仍只授予主理 AI。' },
      ...(assistant ? [{ title: '全局应用', body: '全局应用会以点击时的普通工具星标覆盖所有现有 AI，主理专属星标与调用权限保持不变。' }] : []),
    ],
  } : undefined;
  const rightButton = page.kind === 'custom' ? <TouchableOpacity disabled={busy} onPress={() => openUser(null)}><Text style={styles.action}>添加</Text></TouchableOpacity> : undefined;
  return <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}><KeyboardAvoidingContainer enabled={page.kind === 'editor' || page.kind === 'userEditor'} style={styles.screen}>
    <NavigationHeader title={title} onGoBack={onBack} rightButton={rightButton} help={headerHelp} />
    {assistantListError ? <Text style={styles.description}>未能读取 AI 列表，请返回后重新打开。</Text> : !snapshot ? loadError ? <Text style={styles.description}>未能读取提示词配置，请返回后重新打开。</Text> : <ActivityIndicator style={styles.loading} /> : <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      {page.kind === 'overview' && <>
        <View style={styles.hero}><Text style={styles.eyebrow}>{assistant ? getAssistantDisplayName(assistant) : '全局默认'} · 中文</Text><Text style={styles.heading}>从身份，到此刻</Text><Text style={styles.description}>单聊、群聊、记账回应和日程唤醒共用以下顺序。
有内容且满足场景条件的条目才会带入。</Text></View>
        {overviewRow('编辑对象', assistant ? `${getAssistantDisplayName(assistant)}${assistant.isHostAI ? ' · 主理 AI' : ''} · 专属配置只对这位 AI 生效，身份池名单全局共用` : '暂无 AI', () => setSelectorOpen(true), undefined, !assistants.length)}
        {CHAT_PROMPT_READING_FLOW.map((step, index) => <React.Fragment key={step.id}>
          {(index === 0 || CHAT_PROMPT_READING_FLOW[index - 1].section !== step.section)
            && <Text style={styles.section}>{readingSections[step.section]}</Text>}
          {readingStep(step.id, index + 1)}
        </React.Fragment>)}
        <Text style={styles.section}>按需提示</Text>
        {overviewRow('条件提示词', '按功能管理开关与正文', () => onOpenPage({ kind: 'conditional' }))}
        {overviewRow('其他提示词', '管理其他任务使用的提示词', () => onOpenPage({ kind: 'other' }))}
      </>}
      {page.kind === 'conditional' && <>
        <Text style={styles.section}>图片</Text>
        {overviewRow('图片防幻觉提醒', '未配置 OCR · 图片附件直接传图时使用', () => onOpenPage({ kind: 'editor', definitionId: 'input.image_grounding' }))}
      </>}
      {page.kind === 'other' && <>
        <Text style={styles.section}>聊天摘要</Text>
        {overviewRow('一级摘要提示词', summaryStatus('primary'), () => onOpenPage({ kind: 'editor', definitionId: 'internal.chat_summary' }))}
        {overviewRow('二级摘要提示词', summaryStatus('secondary'), () => onOpenPage({ kind: 'editor', definitionId: 'internal.chat_secondary_summary' }))}
        <Text style={styles.section}>图片</Text>
        {overviewRow('图片识别提示词', '为这位 AI 绑定视觉识别模型后生效 · 输出格式由运行时固定', () => onOpenPage({ kind: 'editor', definitionId: 'internal.vision_ocr' }))}
      </>}
      {page.kind === 'registry' && <>
        {!registrySettings.length && <Text style={styles.body}>暂无 AI，添加后可在这里选择。</Text>}
        {registrySettings.map((item) => <TouchableOpacity key={item.id} accessibilityRole="checkbox" accessibilityLabel={`将 ${item.name} 加入身份池`}
          accessibilityState={{ checked: item.included, disabled: busy }} disabled={busy} activeOpacity={0.7} style={styles.row}
          onPress={() => { void mutate(() => setAgentRegistryAssistantIncluded(item.id, !item.included)); }}>
          <View style={styles.copy}><Text style={styles.title}>{item.name}</Text><Text style={styles.subtitle}>底层模型：{item.model}</Text></View>
          {item.included ? <SquareCheck size={22} color={theme.colors.brand.primary} /> : <Square size={22} color={theme.colors.text.tertiary} />}
        </TouchableOpacity>)}
      </>}
      {page.kind === 'persona' && <>
        <Text style={styles.description}>人设在这位 AI 的个人主页中修改，保存后同步显示在这里。</Text>
        <ThemedSurface variant="card" style={styles.card}><Text selectable style={styles.body}>{assistant!.persona || '尚未设置 AI 人设'}</Text></ThemedSurface>
      </>}
      {(page.kind === 'editor' || page.kind === 'userEditor') && <>
        {page.kind === 'userEditor' && !assistantId && <Text style={styles.description}>全局常驻提示词 · 保存后对所有 AI 生效。</Text>}
        {page.kind === 'editor' && summaryRule && row('启用状态', summaryStatus(ruleId === 'internal.chat_summary' ? 'primary' : 'secondary'))}
        {page.kind === 'editor' && (ruleId === 'output.paragraph_breaks' || ruleId === 'input.image_grounding') && row('注入提示词', assistant ? '仅对当前 AI 生效' : '选择 AI 后可调整', undefined, undefined, false, injectionSetting(ruleId))}
        {page.kind === 'userEditor' && <InputField label="提示词名称" placeholder="提示词名称" value={name} onChangeText={setName} editable={!busy} />}
        <InputField label="提示词正文" placeholder="写下你的提示词…" multiline
          value={content} onChangeText={setContent} inputStyle={styles.editor} editable={!busy} />
        {page.kind === 'editor' && <View style={styles.actions}>
          <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={resetRule} style={styles.actionButton}><Text style={styles.action}>恢复默认</Text></TouchableOpacity>
          {assistant && <TouchableOpacity accessibilityRole="button" accessibilityLabel="全局应用提示词" disabled={busy} onPress={applyRuleGlobally} style={styles.actionButton}><Text style={styles.action}>全局应用</Text></TouchableOpacity>}
        </View>}
        <TouchableOpacity disabled={busy} style={styles.button} onPress={saveEditor}><Text style={styles.buttonText}>{busy ? '保存中…' : '保存'}</Text></TouchableOpacity>
      </>}
      {page.kind === 'custom' && <>
        <Text style={styles.description}>长按卡片上下移动，列表顺序就是这些提示词的拼接顺序。{assistant ? `下面的修改只对 ${getAssistantDisplayName(assistant)} 生效。` : '这里是无 AI 时添加的全局常驻提示词，修改、关闭或删除会影响所有 AI。'}</Text>
        {assistant && row('全局常驻提示词', `${snapshot.userPrompts.length} 条 · 单独管理对所有 AI 生效的提示词`, onOpenGlobalPrompts)}
        {!prompts.length && <ThemedSurface variant="card" style={styles.card}><Text style={styles.title}>留一点空间给你的想法</Text><Text style={styles.body}>还没有自定义提示词，点击右上角添加。</Text></ThemedSurface>}
        {prompts.map((prompt, index) => <CustomPromptRow key={prompt.id} prompt={prompt} index={index} disabled={busy} styles={styles}
          onEdit={() => openUser(prompt)} onToggle={(enabled) => togglePrompt(prompt, enabled)}
          onMove={(offset) => movePrompt(prompt, index, offset)} onDelete={() => deletePrompt(prompt)} />)}
      </>}
      {page.kind === 'tools' && <>
        <ThemedSurface variant="card" style={styles.card}>
          <View style={styles.cardHeader}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="特批工具" accessibilityState={{ expanded: directToolsExpanded }}
              activeOpacity={0.7} style={[styles.cardHeader, styles.collapsibleHeader, styles.copy]} onPress={() => setDirectToolsExpanded((expanded) => !expanded)}>
              <Star size={20} color={theme.colors.brand.primary} fill={theme.colors.brand.primary} />
              <Text style={[styles.title, styles.copy]}>特批工具</Text>
              <Text style={styles.subtitle}>{directTools.length} 个</Text>
              {directToolsExpanded ? <ChevronDown size={18} color={theme.colors.text.tertiary} /> : <ChevronRight size={18} color={theme.colors.text.tertiary} />}
            </TouchableOpacity>
            {assistant && <TouchableOpacity accessibilityRole="button" accessibilityLabel="全局应用特批工具" accessibilityState={{ disabled: busy }}
              disabled={busy} style={styles.actionButton} onPress={() => {
                const snapshotNames = [...directToolNames];
                void mutate(() => applyAssistantDirectToolsGlobally(snapshotNames), () => showAppDialog({ title: '已全局应用', message: '普通工具星标已同步到所有现有 AI；主理专属星标与调用权限保持不变。' }));
              }}><Text style={[styles.action, busy && styles.muted]}>全局应用</Text></TouchableOpacity>}
          </View>
          {directToolsExpanded && (directTools.length > 0 ? directTools.map((tool) => {
            const packageId = getToolPackageId(tool);
            return row(tool.name, `${PACKAGE_NAMES[packageId] ?? packageId} · ${tool.unavailableReason ?? (tool.enabled ? '允许调用' : '单项权限已关闭')}`,
              () => onOpenPage({ kind: 'package', id: packageId }));
          }) : <Text style={styles.body}>{assistant ? '暂无特批工具，进入下方工具包点亮工具旁的星标即可添加。' : '选择 AI 后可在工具包中配置特批工具。'}</Text>)}
        </ThemedSurface>
        {packages.map((id) => {
          const members = tools.filter((tool) => getToolPackageId(tool) === id);
          const unavailable = members.every(toolIsUnavailable);
          return <View key={id} style={unavailable && styles.muted}>{row(PACKAGE_NAMES[id] ?? id,
            `${members.length} 个工具${unavailable ? ' · 当前接口不支持，仅限 Moonshot 官方 API' : ''}`,
            () => onOpenPage({ kind: 'package', id }))}</View>;
        })}
      </>}
      {page.kind === 'package' && <>
        {page.id === 'webTools' && row('搜索来源配置', '设置默认来源、Tavily 与 Brave 密钥；也可从「AI 工具 → 联网搜索」进入', onOpenWebSearch)}
        {tools.filter((tool) => getToolPackageId(tool) === page.id).map((tool) => <ThemedSurface variant="card" nativeGlass={false} key={tool.name} style={[styles.card, toolIsUnavailable(tool) && styles.muted]}>
          <ToggleField layout="inline" rowStyle={styles.cardHeader} label={tool.name} accessibilityLabel={`启用 ${tool.name}`}
            disabled={toolIsReadOnly(tool)} value={!toolIsUnavailable(tool) && tool.enabled} onValueChange={(enabled) => toggleTool(tool.name, enabled)}>
            <Text style={[styles.title, styles.copy]}>{tool.name}</Text>
            {assistantId && <TouchableOpacity accessibilityRole="switch" accessibilityLabel={`直接暴露 ${tool.name}`} accessibilityState={{ checked: !toolIsUnavailable(tool) && directToolNames.has(tool.name), disabled: toolIsReadOnly(tool) }}
              disabled={toolIsReadOnly(tool)} style={styles.starButton}
              onPress={() => { void mutate(() => setAssistantDirectToolExposure(assistantId, tool.name, !directToolNames.has(tool.name))); }}>
              <Star size={22} color={!toolIsUnavailable(tool) && directToolNames.has(tool.name) ? theme.colors.brand.primary : theme.colors.text.tertiary} fill={!toolIsUnavailable(tool) && directToolNames.has(tool.name) ? theme.colors.brand.primary : 'none'} />
            </TouchableOpacity>}
          </ToggleField>
          {tool.unavailableReason && <Text style={styles.subtitle}>{tool.unavailableReason}{`\n已保存偏好：${tool.enabled ? '允许调用' : '禁止调用'}${directToolNames.has(tool.name) ? '，已设特批' : ''}`}</Text>}
          <Text selectable style={styles.body}>{tool.description}</Text>
        </ThemedSurface>)}
      </>}
    </ScrollView>}
    {selectorOpen && <ModalSheet visible onClose={() => setSelectorOpen(false)} title="选择编辑的 AI">
      <ScrollView contentContainerStyle={styles.content}>
        {assistants.map((option) => row(option.name, `${option.isHostAI ? '主理 AI · ' : ''}${option.id === assistantId ? '当前编辑对象' : '仅调整这位 AI 的提示词'}`, () => { setSelectorOpen(false); onSelectAssistant(option.id); }))}
      </ScrollView>
    </ModalSheet>}
  </KeyboardAvoidingContainer></SafeAreaView>;
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : '操作失败'; }
