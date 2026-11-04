/** 共享普通与流式工具回复的状态文案和元数据。 */
import type { ModelToolCall } from '@platform/ai';
import type { ChatMessage } from '../../messages/domain/ChatMessage';
import type { IMessageRepository } from '../../messages/domain/MessageRepository';
import { buildChatToolStatusMessageMetadata } from '../application/ChatReplyMetadata';
import { emitChatMessagesPatched } from '../../messages/events/ChatEvents';
import type {
  AIReplyConfig,
  AIReplyRuntimeContext,
} from '../application/ChatReplyTypes';

export function buildToolStatusMetadata(params: {
  aiConfig: AIReplyConfig;
  runtimeContext: AIReplyRuntimeContext;
  status: 'running' | 'completed' | 'failed';
  toolNames: string[];
  toolDisplayNames: string[];
  displayText: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const metadata = buildChatToolStatusMessageMetadata({
    aiConfig: params.aiConfig,
    runtimeContext: params.runtimeContext,
    status: params.status,
    toolNames: params.toolNames,
    toolDisplayNames: params.toolDisplayNames,
    displayText: params.displayText,
  });
  return params.extra ? { ...metadata, ...params.extra } : metadata;
}

export async function updateToolStatusMessage(params: {
  repository: IMessageRepository;
  sessionId: string;
  message: ChatMessage;
  aiConfig: AIReplyConfig;
  runtimeContext: AIReplyRuntimeContext;
  status: 'completed' | 'failed';
  toolNames: string[];
  toolDisplayNames: string[];
  extra?: Record<string, unknown>;
  displayText?: string;
}): Promise<void> {
  const displayText = params.displayText ?? buildToolStatusText(
    joinToolDisplayNames(params.toolDisplayNames),
    params.status
  );
  await params.repository.updateMessage(params.message.id, {
    text: displayText,
    status: params.status === 'failed' ? 'failed' : 'sent',
    metadataJson: JSON.stringify(buildToolStatusMetadata({
      aiConfig: params.aiConfig,
      runtimeContext: params.runtimeContext,
      status: params.status,
      toolNames: params.toolNames,
      toolDisplayNames: params.toolDisplayNames,
      displayText,
      extra: params.extra,
    })),
  });
  emitChatMessagesPatched({
    sessionId: params.sessionId,
    updatedMessageIds: [params.message.id],
  });
}

export function resolveToolDisplayName(toolName: string): string {
  const musicName = phonePackageDisplayAliases.neteaseMusic.tools[toolName];
  if (musicName) return `cloudmusic.${musicName}`;
  const displayNameByTool: Record<string, string> = {
    kimi_web_search: 'Kimi 官方搜索',
    kimi_web_fetch: 'Kimi 官方网页读取',
    kimi_mew: 'Kimi 猫叫与祝福',
    web_search: '联网搜索',
    web_fetch: '读取网页',
    download_file: '下载文件',
    get_app_usage: '读取应用使用时长',
    requestVideoCall: '视频电话',
    send_voice_message: '发送语音',
    send_image: '发送图片',
    share_moment: '分享时刻',
    search_stickers: '搜索表情包',
    list_sticker_groups: '表情包分组',
    list_stickers_in_group: '浏览表情包分组',
    select_sticker: '选择表情包',
    lookAtUser: '查看用户状态',
    blockAIAssistant: '拉黑 AI',
    unblockAIAssistant: '解除拉黑',
    aiCommentMoment: '时刻评论',
    aiCreateMoment: '发布时刻',
    aiDeleteOwnMoment: '删除时刻',
    aiDeleteOwnMomentComment: '删除时刻评论',
    aiLikeMoment: '时刻点赞',
    aiReplyMomentComment: '回复时刻评论',
    aiUnlikeMoment: '取消时刻点赞',
    getMomentDetail: '时刻详情',
    searchMoments: '时刻',
    getLedgerContext: '账本',
    schedule_self_wake: '安排自主醒来',
    addProtocol: '协议空间',
    deleteProtocol: '协议空间',
    getProtocols: '协议空间',
    searchProtocols: '协议空间',
    updateProtocol: '协议空间',
    mcp_list_tools: 'MCP 工具清单',
    mcp_call_tool: 'MCP 工具',
    open_tool_package: '拆开工具包',
    close_tool_package: '收起工具包',
  };

  return displayNameByTool[toolName] || toolName;
}

export function resolveToolCallDisplayName(
  toolCall: ModelToolCall,
): string {
  if (toolCall.name === 'open_tool_package' || toolCall.name === 'close_tool_package') {
    const id = displayArgument(parseMetaToolInput(toolCall.arguments)?.package_id);
    const label = resolveToolDisplayName(toolCall.name);
    return id ? `${label}（${id}）` : label;
  }
  if (toolCall.name === 'phone_package_list_tools' || toolCall.name === 'phone_package_call_tool') {
    return resolvePhonePackageToolCallDisplayName(toolCall);
  }
  if (toolCall.name !== 'mcp_list_tools' && toolCall.name !== 'mcp_call_tool') {
    return resolveToolDisplayName(toolCall.name);
  }
  const input = parseMetaToolInput(toolCall.arguments);
  const serverName = displayArgument(input?.serverName);
  const remoteToolName = displayArgument(input?.remoteToolName);
  if (toolCall.name === 'mcp_list_tools') {
    if (serverName && remoteToolName) {
      return `MCP 工具参数（${serverName} / ${remoteToolName}）`;
    }
    return serverName ? `MCP 工具清单（${serverName}）` : 'MCP 工具清单';
  }
  return serverName && remoteToolName
    ? `MCP 工具（${serverName} / ${remoteToolName}）`
    : 'MCP 工具';
}

// Phone Package 展示名是 presentation-only 的用户可见语义别名，与 runtime
// protocol identity（package_id / tool_name）严格分离：runtime 永远使用
// neteaseMusic.netease_search_songs 这类原始 ID，timeline 只把已知映射换成
// 冻结的可见别名；未知 package / tool 原样透传，不做强制映射。
const phonePackageDisplayAliases: Record<string, {
  packageAlias: string;
  tools: Record<string, string>;
}> = {
  neteaseMusic: {
    packageAlias: 'cloudmusic',
    tools: {
      netease_search_songs: 'search_songs',
      netease_search_public_playlists: 'search_public_playlists',
      netease_get_public_playlist: 'get_public_playlist',
      netease_get_song_lyrics: 'get_song_lyrics',
      netease_resolve_share_link: 'resolve_share_link',
      netease_play_song: 'play_song',
      netease_get_playback_state: 'get_playback_state',
      netease_control_playback: 'control_playback',
    },
  },
};

function resolvePhonePackageToolCallDisplayName(toolCall: ModelToolCall): string {
  const input = parseMetaToolInput(toolCall.arguments);
  const packageId = displayArgument(input?.package_id);
  const toolName = displayArgument(input?.tool_name);
  const packageAliases = packageId ? phonePackageDisplayAliases[packageId] : undefined;
  const displayPackageId = packageAliases?.packageAlias ?? packageId;
  const displayToolName = (toolName && packageAliases?.tools[toolName]) || toolName;
  const semanticName = [displayPackageId, displayToolName].filter(Boolean).join('.');
  return semanticName || toolCall.name;
}

function parseMetaToolInput(argumentsJson: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(argumentsJson);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function displayArgument(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 80 ? `${normalized.slice(0, 79)}…` : normalized;
}

export function joinToolDisplayNames(toolDisplayNames: string[]): string {
  const counts = new Map<string, number>();
  for (const name of toolDisplayNames.filter(Boolean)) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name);
  return names.length > 0 ? names.join('、') : '工具';
}

export function buildToolStatusText(
  joinedToolDisplayNames: string,
  status: 'running' | 'completed' | 'failed'
): string {
  if (status === 'running') {
    return `正在调用：${joinedToolDisplayNames}`;
  }

  if (status === 'failed') {
    return `调用失败：${joinedToolDisplayNames}`;
  }

  return `调用完成：${joinedToolDisplayNames}`;
}
