/** 解析单个网易云分享 URL，只返回稳定资源 identity。 */

import type { Tool, ToolContext } from '@shared/aiTools';
import type { NetEaseShareLinkBackend } from '../application/NetEaseShareLinkResolver';
import {
  netEaseToolFailure,
  netEaseToolSuccess,
  runNetEaseToolAsCurrentHost,
} from './NetEaseToolExecution';

export interface NetEaseResolveShareLinkArgs {
  url: string;
}

export const netEaseResolveShareLinkDefinition = {
  name: 'netease_resolve_share_link',
  description: '解析网易云分享链接，返回 song 或 playlist 的稳定数字 ID。',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: '单个网易云分享 URL；不要传入包含 URL 的自然语言文本',
        minLength: 1,
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
} as const;

export function createNetEaseResolveShareLinkTool(
  backend: NetEaseShareLinkBackend,
): Tool<NetEaseResolveShareLinkArgs, ToolContext> {
  return {
    name: netEaseResolveShareLinkDefinition.name,
    definition: netEaseResolveShareLinkDefinition,
    execute: (args, context) => runNetEaseToolAsCurrentHost(context, async () => {
      const result = await backend.resolveNetEaseShareLink(args.url);
      if (result.ok === false) return netEaseToolFailure(result.error);
      return netEaseToolSuccess(`已解析网易云分享链接：${result.data.type}。`, result.data);
    }),
  };
}
