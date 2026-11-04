/**
 * Floating Layer 运行时依赖契约。
 *
 * 悬浮层持有自己的用户意图、Bubble Skin 仓储和原生投影端口；Headless
 * 宿主只取得 Host 注入的单一消息执行 command，不取得 Companion、AI 或 Chat 依赖。
 */

import { createRuntimeSlot } from '@shared/runtime/RuntimeSlot';
import type { IBubbleSkinRepository } from '../domain/BubbleSkinRepository';
import type { IFloatingInteractionSettingsRepository } from '../domain/FloatingInteractionSettingsRepository';
import type { FloatingLayerPort } from './FloatingLayerPort';

export interface FloatingLayerRuntimeDependencies {
  repositories: {
    bubbleSkins: IBubbleSkinRepository;
    floatingInteractionSettings: IFloatingInteractionSettingsRepository;
  };
  native: {
    floatingLayer: FloatingLayerPort;
  };
}

const floatingLayerRuntimeSlot = createRuntimeSlot<FloatingLayerRuntimeDependencies>(
  'FloatingLayer',
);

export function configureFloatingLayerRuntimeDependencies(
  dependencies: FloatingLayerRuntimeDependencies,
): void {
  floatingLayerRuntimeSlot.configure(dependencies);
}

export function getFloatingLayerRuntimeDependencies(): FloatingLayerRuntimeDependencies {
  return floatingLayerRuntimeSlot.get();
}
