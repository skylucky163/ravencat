/** Host 按用途冻结已授权工具；拆包只改变 schema 暴露，不改变执行权限。 */
import type { AgentTool, AgentToolExecutionResult, JsonSchema } from '@shared/aiTools';
import type { AgentToolRegistry } from '@platform/agentRuntime';
import type { PromptToolInstructions } from '@shared/prompt';

export interface ToolPackageRuntimeBinding {
  packageId: string;
  tool: AgentTool;
}

const PACKAGE_DESCRIPTIONS: Record<string, { title: string; whenToUse: string }> = {
  codeWorks: { title: '作品库', whenToUse: '查询自己的网页作品名称和稳定 ID，读取封面与源码；加入或移出作品库，编辑作品名，上传或替换封面。' },
  xiaohongshu: { title: '小红书文字笔记', whenToUse: '按步骤创建写想法的文字卡片笔记：确认页面、进入创作菜单、打开写文字、选择写想法、填写卡片、下一步、选样式、填写标题正文、逐个添加话题、设可见范围，再取得一次性凭据单独发布。每步返回当前页面；可返回或停下让用户检查。' },
  kimiOfficial: { title: 'Kimi 官方工具', whenToUse: '通过当前 AI 的 Moonshot 官方账号搜索、读网页、换算单位、整理想法、随机选择、分析 Excel/CSV、处理日期和 Base64，或用猫叫与祝福互动。' },
  deepseekOfficial: { title: 'DeepSeek 官方工具', whenToUse: '通过当前 AI 的 DeepSeek 官方账号搜索公开信息、读取网页原文。' },
  webTools: { title: '联网工具包', whenToUse: '搜索公开信息、读取网页正文，或将公开链接中的文件下载到手机。' },
  media: { title: '图片', whenToUse: '下载或生成图片到私有媒体库，浏览自己下载、生成的图片列表，或按媒体 ID、文件名关键词找回图片。通过媒体 ID 查看或发送图片，也可给自己图库里的图片改名或移除。' },
  applicationSettings: { title: '应用设置工具', whenToUse: '获取用户、AI 或可见群聊的头像，以及单聊背景、通话背景、朋友圈封面；自主更换自己的头像、公开名称和背景，或恢复默认。' },
  groupChat: { title: '群聊', whenToUse: '按群名关键词搜索群的真实名称和 ID，直接申请加入群聊，或邀请指定 Agent ID 的 AI 入群；退出或修改仍参加的群名。所有 AI 均可搜索、加入和邀请，主理 AI 另可移除、禁言或解除禁言自己群内的成员。' },
  protocol: { title: '协议空间', whenToUse: '查找、新增、修改或删除你与用户的协议约定。' },
  moments: { title: '时刻互动', whenToUse: '浏览或搜索可见时刻、读取详情与未读社交待办；分享时刻卡片、发布或编辑自己的文字与图片时刻、评论或回复、点赞或取消，以及撤回自己的时刻或评论。' },
  wallet: { title: '羽库记账', whenToUse: '记账工具；查询账单与统计、搜索定位、新增编辑删除账单，以及查询、创建、编辑、删除和使用快捷记账模板。' },
  calls: { title: '通话', whenToUse: '主动向用户发起来电邀请；视频通话中可按需查看用户当前画面。' },
  memory: {
    title: '记忆与聊天记录',
    whenToUse: '自行决定何时维护记忆和聊天摘要，缺少信息时，可主动调用记忆工具获取。主动记下值得长期保留的信息，按需补充、纠正或重写、删除已有记忆和聊天摘要。可检索记忆和摘要、查询聊天原文，也可将已退出群聊的历史提炼为独立记忆。',
  },
  assistants: { title: '人机关系工具', whenToUse: '向用户发卡片申请成为记账 AI 或主理 AI。' },
  deviceControl: { title: '手机应用操作', whenToUse: '搜索本机可启动应用、打开指定应用，为应用设置限时软锁或解除软锁；设置系统闹钟、打开闹钟页面、取消下一次响铃、稍后再响，或查询下一个登记时间。具体边界见工具参数。' },
  phoneTools: { title: '手机环境感知', whenToUse: '按需获取手机当前位置及精度、测量时间，查询当前前台应用及受保护状态、应用前台使用时长，或读取当前剪贴板文字。' },
  screenCapture: { title: '手机屏幕读取', whenToUse: '通过无障碍读取当前页面文字与界面结构，或截图后用本地 OCR 读取可见文字；不理解非文字画面，不操作界面。' },
  companion: { title: '自主唤醒与日程', whenToUse: '用于在未来唤醒自己一次；创建、浏览、读取、修改或取消自己的 AI 日程。' },
  chat: { title: '消息与语音', whenToUse: '向用户发送语音。' },
  stickers: { title: '表情包', whenToUse: '搜索用户与自己的表情包，发送表情包，收藏图片制作表情包。维护自己的语义和向量、删除自己的收藏。' },
  togetherListening: { title: '一起听', whenToUse: '邀请用户一起听网易云音乐、接受或拒绝用户邀请，或结束一起听。' },
  neteaseMusic: { title: '网易云音乐', whenToUse: '搜索歌曲或公开歌单、读取歌单与歌词、解析分享链接；播放指定歌曲、查询播放状态，或暂停、恢复、切歌。' },
};

export const OPEN_TOOL_PACKAGE_NAME = 'open_tool_package';
export const CLOSE_TOOL_PACKAGE_NAME = 'close_tool_package';

export function registerToolPackagesForHostRun(input: {
  registry: AgentToolRegistry;
  allowedToolNames: readonly string[];
  bindings: readonly ToolPackageRuntimeBinding[];
  openPackageIds: readonly string[];
  directToolNames?: readonly string[];
}): {
  packageToolNames: string[];
  metaToolNames: string[];
  visibleToolNames: () => string[];
  instructions: () => PromptToolInstructions;
} {
  const allowed = new Set(input.allowedToolNames);
  const packages = new Map<string, AgentTool[]>();
  for (const { packageId, tool } of input.bindings) {
    if (!allowed.has(tool.descriptor.name)) continue;
    if (!PACKAGE_DESCRIPTIONS[packageId]) throw new Error(`工具包缺少用途描述：${packageId}`);
    const tools = packages.get(packageId);
    if (tools) tools.push(tool);
    else packages.set(packageId, [tool]);
  }
  // 特批仅从本次已授权集合中选出；偏好不能扩大 task 的调用权限。
  const directNames = new Set(input.directToolNames ?? []);
  const directTools = [...packages.values()].flat().filter((tool) => directNames.has(tool.descriptor.name));
  const packedTools = new Map<string, AgentTool[]>();
  for (const [id, tools] of packages) {
    const remaining = tools.filter((tool) => !directNames.has(tool.descriptor.name));
    if (remaining.length > 0) packedTools.set(id, remaining);
  }
  const openIds = new Set(input.openPackageIds.filter((id) => packedTools.has(id)));
  const directCatalog = directTools.length === 0 ? '' : [
    '【用户特批工具】',
    '用户指定以下工具常驻暴露，无需 open_tool_package 即可直接调用；用途与参数见当前 function schema，特批不改变调用权限与场景身份限制。',
    ...directTools.map(({ descriptor }) => JSON.stringify({ name: descriptor.name })),
  ].join('\n');
  // 用途目录由本次冻结的授权与特批配置决定；拆包不删除简介，保持缓存前缀。
  // 目录只提供选包线索；逐工具说明由 schema 唯一提供，避免展开后重复注入。
  const packageCatalog = packedTools.size === 0 ? '' : [
    '【本次运行的工具包用途目录】',
    '以下按包概括用途，tools 仅列出本次已授权且需拆包的工具名；需要时用 open_tool_package 拆开，具体工具用途与参数见展开后的 function schema。',
    '普通单聊中，正式回复提交后已拆开的包持续保持展开，不按轮数自动关闭。预计后续还会使用时保持展开；不再需要时主动调用 close_tool_package 收起。其他运行的开关只在当前 run 生效。',
    ...[...packedTools].map(([id, tools]) => JSON.stringify({
      id, ...PACKAGE_DESCRIPTIONS[id],
      tools: tools.map(({ descriptor }) => descriptor.name),
    })),
  ].join('\n');
  const catalog = [directCatalog, packageCatalog].filter(Boolean).join('\n\n');
  if (packedTools.size > 0) {
    // 两个控制工具使用同一份固定目录 enum；开关状态不改写控制工具 schema。
    const inputSchema: JsonSchema = {
      type: 'object',
      properties: { package_id: { type: 'string', enum: [...packedTools.keys()], description: '可用工具包 ID' } },
      required: ['package_id'],
      additionalProperties: false,
    };
    input.registry.register({
      descriptor: {
        name: OPEN_TOOL_PACKAGE_NAME,
          description: '拆开工具包，包内工具从本轮下一步起可用；已展开的无需重复拆开。',
        inputSchema,
        owner: 'host:tool-packages', source: 'local', risk: 'safe_read', idempotency: 'idempotent',
      },
      async execute(value): Promise<AgentToolExecutionResult<unknown>> {
        const { package_id: id } = value as { package_id: string };
        // 参数已通过 Runtime 的模型输出边界校验；这里信任 enum 契约。
        const alreadyOpen = openIds.has(id);
        openIds.add(id);
        return {
          status: 'success',
          data: { packageId: id },
          modelContent: alreadyOpen
            ? `工具包 ${id} 已展开，无需重复拆开，参数以 function schema 为准。`
            : `工具包 ${id} 已拆开。`,
          ...(alreadyOpen ? {} : { metadata: { toolPackageChange: { packageId: id, action: 'open' } } }),
        };
      },
    });
    input.registry.register({
      descriptor: {
        name: CLOSE_TOOL_PACKAGE_NAME,
        description: '不再需要一个已展开工具包时将它收起；用户特批工具仍常驻。',
        inputSchema,
        owner: 'host:tool-packages', source: 'local', risk: 'safe_read', idempotency: 'idempotent',
      },
      async execute(value): Promise<AgentToolExecutionResult<unknown>> {
        const { package_id: id } = value as { package_id: string };
        const changed = openIds.delete(id);
        return {
          status: 'success', data: { packageId: id },
          modelContent: changed
            ? `工具包 ${id} 已收起。`
            : `工具包 ${id} 已处于收起状态。`,
          ...(changed ? { metadata: { toolPackageChange: { packageId: id, action: 'close' } } } : {}),
        };
      },
    });
  }
  return {
    packageToolNames: [...packages.values()].flatMap((tools) => tools.map(({ descriptor }) => descriptor.name)),
    metaToolNames: packedTools.size > 0 ? [OPEN_TOOL_PACKAGE_NAME, CLOSE_TOOL_PACKAGE_NAME] : [],
    visibleToolNames: () => [
      ...directTools.map(({ descriptor }) => descriptor.name),
      ...[...packedTools].flatMap(([id, tools]) => (
        openIds.has(id) ? tools.map(({ descriptor }) => descriptor.name) : []
      )),
    ],
    instructions: () => ({ catalog }),
  };
}
