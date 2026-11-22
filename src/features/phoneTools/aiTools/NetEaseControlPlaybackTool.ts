/** 向网易云当前活动播放会话派发控制请求，不自动观察最终状态。 */

import type { Tool, ToolContext } from '@shared/aiTools';
import {
  controlNetEasePlayback,
  NetEasePlaybackError,
} from '../application/NetEasePlayback';
import type { NetEasePlaybackCommand } from '../application/NetEasePlaybackRuntimeDependencies';
import {
  netEaseToolFailure,
  netEaseToolSuccess,
  runNetEaseToolAsCurrentHost,
} from './NetEaseToolExecution';

export interface NetEaseControlPlaybackArgs {
  command: NetEasePlaybackCommand;
}

export const netEaseControlPlaybackDefinition = {
  name: 'netease_control_playback',
  description: '控制网易云当前播放会话的播放命令。返回派发状态；新状态需重新读取播放状态。',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        enum: ['pause', 'resume', 'next', 'previous'],
        description: '要派发给当前网易云播放会话的控制命令',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
} as const;

export type ControlNetEasePlaybackCapability = typeof controlNetEasePlayback;

export function createNetEaseControlPlaybackTool(
  controlPlayback: ControlNetEasePlaybackCapability = controlNetEasePlayback,
): Tool<NetEaseControlPlaybackArgs, ToolContext> {
  return {
    name: netEaseControlPlaybackDefinition.name,
    definition: netEaseControlPlaybackDefinition,
    execute: (args, context) => runNetEaseToolAsCurrentHost(context, async () => {
      try {
        const result = await controlPlayback(args.command);
        return netEaseToolSuccess(
          'playback_command_dispatched: 播放控制请求已经派发给网易云；最终播放状态尚未重新确认。',
          result,
        );
      } catch (error) {
        if (!(error instanceof NetEasePlaybackError)) throw error;
        return netEaseToolFailure({ code: error.reason, message: error.message });
      }
    }),
  };
}
