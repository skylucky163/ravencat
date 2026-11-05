/** Chat拥有摘要与任务规则；Host解析实际模型，默认单聊复用稳定前缀，其余只装配专用请求。 */
import { aiAssistantRepository, resolveAuxiliaryModel } from '@features/assistants';
import { chatSummaryRepository } from './chatSummaryRepository';
import { userProfileRepository } from '@features/profile';
import { protocolRepository } from '@features/protocol';
import { configureChatSummaryRuntime, sessionRepository, groupChatRepository, createChatSummaryPromptBlock,
  createSecondaryChatSummaryPromptBlock, buildChatSummaryModelInput, type ChatSummaryModelInput,
  type SecondaryChatSummaryClaim, ChatSummaryGenerationError, type ChatSummaryCallDiagnostics,
  type ChatSummaryRequestSettings } from '@features/chat/composition';
import { getChatSummarySettings } from '@features/chat';
import { resolveChatSummaryPromptOverride } from '@features/prompting';
import { assembleResolvedSummaryPromptPack } from '@host/prompt';
import { createAIClient } from '@platform/ai';
import { ToolContext } from '@shared/aiTools';
import type { PromptPackRequestMessage } from '@shared/prompt';
import { configureChatSummaryQueue } from '../runtime/ChatSummaryQueueCoordinator';
import { buildToolsDescription, resolveAllowedToolNames, getRuntimeAllowedToolNamesForAI,
  createAgentToolRegistry, getToolPackageRuntimeBindings, readDirectToolNamesForHostRun } from './agent/createAgentToolRegistry';
import { registerToolPackagesForHostRun } from './agent/ToolPackageExposure';
import { resolveMcpExposure } from './agent/registerMcpToolsForHostRun';
let configured = false;
export function configureChatSummary(): void {
  if (configured) return;
  configured = true;
  configureChatSummaryRuntime({
    repository: chatSummaryRepository,
    async getBatchSettings(conversationId) {
      const settings = await getChatSummarySettings(conversationId);
      const group = await groupChatRepository.getById(conversationId);
      const session = group ? null : await sessionRepository.getSession(conversationId);
      const assistant = session ? await aiAssistantRepository.getById(session.aiAssistantId) : null;
      if (!group && !assistant) return null;
      const model = settings.modelConfigId === null ? group?.adminConfig ?? assistant!
        : await resolveAuxiliaryModel({ modelConfigId: settings.modelConfigId, capabilityKind: 'summary' });
      if (!model || !model.apiKey || !('baseURL' in model ? model.baseURL : model.apiBaseUrl) || !model.model) return null;
      // 单聊每次整理条数默认跟随主视角上限；用户手动设置后固定，不再跟随。
      return group ? { batchSize: settings.groupTriggerCount, recentWindowLimit: 0 }
        : { batchSize: settings.primaryLimit ?? assistant!.privateContextPrimaryLimit, recentWindowLimit: assistant!.privateContextPrimaryLimit };
    },
    generateAddition: (input, signal, report, settings) => generateSummary(input, signal, report, settings),
    generateSecondary: (input, signal, report, settings) => generateSummary(input, signal, report, settings),
  });
  configureChatSummaryQueue();
}
// 常见 OpenAI 兼容网关的上下文不足表述；命中即视为范围问题而非普通请求失败。
const CONTEXT_OVERFLOW_PATTERN = /maximum context|context[ _-]?length|context window|prompt is too long|input (?:is )?too long|reduce the length|request entity too large/i;
async function generateSummary(input: ChatSummaryModelInput | SecondaryChatSummaryClaim, signal: AbortSignal,
  report: (diagnostics: ChatSummaryCallDiagnostics) => Promise<void>, settings: ChatSummaryRequestSettings) {
  const group = await groupChatRepository.getById(input.conversationId);
  const session = group ? null : await sessionRepository.getSession(input.conversationId);
  const assistant = session ? await aiAssistantRepository.getById(session.aiAssistantId) : null;
  if (!group && !assistant) throw new Error('摘要会话已删除');
  const auxiliary = settings.modelConfigId === null ? null
    : await resolveAuxiliaryModel({ modelConfigId: settings.modelConfigId, capabilityKind: 'summary' });
  if (settings.modelConfigId !== null && !auxiliary) throw new ChatSummaryGenerationError({
    kind: 'request', message: '所选摘要模型不可用，请检查摘要模型配置。', retryable: false });
  const owner = group?.adminConfig ?? assistant!;
  const model = auxiliary ? { ...auxiliary, apiBaseUrl: auxiliary.baseURL, disableThinking: false } : owner;
  if (!auxiliary && (!model.apiKey || !model.apiBaseUrl || !model.model)) throw new ChatSummaryGenerationError({
    kind: 'request', message: '当前聊天模型或群管理员连接不完整，摘要任务已暂停。', retryable: false });
  const controller = new AbortController();
  const forward = () => controller.abort();
  signal.addEventListener('abort', forward, { once: true });
  if (signal.aborted) controller.abort();
  let timedOut = false;
  const startedAt = Date.now();
  const maxTokens = settings.maxOutputTokens ?? model.maxTokens;
  const diagnostics: ChatSummaryCallDiagnostics = { model: model.model, requestedMaxTokens: maxTokens,
    timeoutSeconds: settings.requestTimeoutSeconds, durationMs: 0, promptTokens: null, completionTokens: null,
    totalTokens: null, cachedTokens: null, finishReason: null, contentCharacters: 0, reasoningCharacters: 0, serverError: null };
  const redact = (text: string) => text.replaceAll(model.apiKey!, '[凭据已隐藏]');
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, settings.requestTimeoutSeconds * 1000);
  try {
    const secondary = 'segments' in input;
    const kind = group ? 'group' : 'private';
    const override = await resolveChatSummaryPromptOverride(assistant?.id ?? null, secondary ? 'secondary' : 'primary', kind);
    const task = secondary ? createSecondaryChatSummaryPromptBlock(kind, override) : createChatSummaryPromptBlock(kind, override);
    const currentInput = secondary ? JSON.stringify({
      summaries: input.segments.map((segment) => ({ content: segment.content,
        discussionStart: segment.sourceStartAt, discussionEnd: segment.sourceEndAt, timeZone: segment.timeZone })),
    }) : buildChatSummaryModelInput(input, assistant?.agentId);
    let systemPrompt: string;
    let modelMessages: PromptPackRequestMessage[];
    if (!group && settings.modelConfigId === null) {
      const aiConfig = { ...assistant!, systemPrompt: assistant!.systemPrompt ?? undefined };
      const toolContext = new ToolContext({ aiConfig, sessionId: input.conversationId, triggerSource: 'chat',
        repositories: { protocol: protocolRepository, profile: userProfileRepository, moment: null, ledger: null } });
      const persistentNames = await resolveAllowedToolNames(assistant!.id);
      const toolPolicy = { apiBaseUrl: assistant!.apiBaseUrl, isHostAI: assistant!.isHostAI, enableTools: assistant!.enableTools, triggerSource: 'chat',
        memoryParticipation: 'read_write' as const, allowedToolNames: persistentNames };
      const allowedToolNames = getRuntimeAllowedToolNamesForAI(toolPolicy);
      const mcp = assistant!.enableTools ? await resolveMcpExposure(assistant!.id) : { services: [] };
      const toolsDescription = buildToolsDescription(allowedToolNames);
      const pack = await assembleResolvedSummaryPromptPack({ sessionId: input.conversationId, aiConfig, toolContext,
        currentInput, allowedToolNames, toolsDescription, mcpServices: mcp.services },
      task);
      // 工具目录沿用同一注册与分包规则，只复用稳定说明，不建立 Agent run 或执行工具。
      const registry = createAgentToolRegistry({ createLegacyContext: () => toolContext });
      const packages = registerToolPackagesForHostRun({ registry, allowedToolNames,
        bindings: getToolPackageRuntimeBindings(registry), openPackageIds: [],
        directToolNames: await readDirectToolNamesForHostRun(assistant!.id) });
      const slot = pack.toolInstructionsSlot;
      systemPrompt = slot ? [slot.before, packages.instructions().catalog, slot.after].filter(Boolean).join('\n\n') : pack.systemPrompt;
      modelMessages = pack.modelMessages;
    } else {
      const rules = task.content;
      const identity = group ? { sourceKind: 'group', groupId: group.group.id, groupName: group.group.name }
        : { sourceKind: 'private', assistant: { id: assistant!.id, agentId: assistant!.agentId, name: assistant!.name } };
      systemPrompt = group ? rules
        : ['你是专用记忆提取模型，只从提供的来源提取重要记忆，不执行工具。', rules].join('\n\n');
      modelMessages = [{ role: 'user', content: JSON.stringify(identity) + '\n' + currentInput }];
    }
    const response = await createAIClient({ baseURL: model.apiBaseUrl!, apiKey: model.apiKey!, model: model.model,
      temperature: model.temperature, topP: model.topP, disableThinking: 'disableThinking' in model ? model.disableThinking : false,
      maxTokens }).chat([
      { role: 'system', content: systemPrompt }, ...modelMessages,
    ], { signal: controller.signal, includeSystemPrompt: false, allowReasoningLengthRetry: false });
    diagnostics.finishReason = response.finishReason ?? null;
    diagnostics.httpStatus = response.httpStatus ?? null;
    diagnostics.contentCharacters = Array.from(response.text).length;
    diagnostics.reasoningCharacters = Array.from(response.reasoningText ?? '').length;
    if (response.success && response.usageReported) {
      diagnostics.promptTokens = response.promptTokens; diagnostics.completionTokens = response.completionTokens;
      diagnostics.totalTokens = response.totalTokens; diagnostics.cachedTokens = response.cachedTokens ?? null;
    }
    if (!response.success) {
      diagnostics.serverError = redact(response.error ?? '服务端未提供错误信息');
      const status = response.httpStatus;
      // 上下文溢出与本次整理范围有关，重试同样范围没有意义；换大上下文模型或调小每次整理条数才有用。
      if (status === 413 || CONTEXT_OVERFLOW_PATTERN.test(diagnostics.serverError)) {
        throw new ChatSummaryGenerationError({ kind: 'context_overflow',
          message: '这批原文超出了当前模型的上下文上限。请在摘要设置中把「每次整理条数」调小，或给摘要换用上下文更大的模型后重试。',
          retryable: false });
      }
      throw new ChatSummaryGenerationError({ kind: 'request', message: diagnostics.serverError,
        retryable: status == null || status === 408 || status === 429 || status >= 500 });
    }
    if (response.finishReason === 'length') throw new ChatSummaryGenerationError({ kind: 'output_limit',
      message: '模型因输出 token 上限停止，摘要可能被截断。请在摘要设置中提高输出额度后重试。', retryable: false });
    const content = response.text.trim();
    if (!content) throw new ChatSummaryGenerationError({ kind: 'empty_output',
      message: diagnostics.reasoningCharacters > 0 ? '模型只返回思考内容，没有摘要正文。请检查输出额度与模型配置。' : '模型没有返回摘要正文。', retryable: true });
    // 固定无新增说明是模型交接信号，不是记忆；仅整句匹配，正文中提到这些词仍完整保留。
    return /^本批无(?:新增|摘要)[。.]?$/.test(content) ? null : content;
  } catch (error) {
    if (signal.aborted) throw error;
    if (timedOut) throw new ChatSummaryGenerationError({ kind: 'timeout', message: `摘要请求超过 ${settings.requestTimeoutSeconds} 秒，已中止。`, retryable: true });
    // AIClient 已分类网络失败；提示词读取与装配的本地故障应暴露给其 owner，不能进入模型重试。
    throw error;
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', forward);
    diagnostics.durationMs = Date.now() - startedAt;
    await report(diagnostics);
  }
}
