/** 组装 Floating Layer 的用户意图、Bubble Skin、原生投影与 Headless 执行入口。 */

import {
  bubbleSkinRepository,
  configureFloatingLayerRuntimeDependencies,
  floatingInteractionSettingsRepository,
  floatingLayerAdapter,
} from '@features/floatingLayer/composition';
import { configureFloatingConversationProjection } from '../runtime/FloatingConversationProjection';

let configured = false;

export function configureFloatingLayerRuntime(): void {
  if (configured) {
    return;
  }
  configured = true;

  configureFloatingLayerRuntimeDependencies({
    repositories: {
      bubbleSkins: bubbleSkinRepository,
      floatingInteractionSettings: floatingInteractionSettingsRepository,
    },
    native: {
      floatingLayer: floatingLayerAdapter,
    },
  });
  configureFloatingConversationProjection();
}
