/** 显式装配应用后台业务共用的运行时；不依赖任何 React 页面先加载。 */

import { configureAIRuntime } from './configureAIRuntime';
import { configureChatRuntime } from './configureChatRuntime';
import { configureMemoryRuntime } from './configureMemoryRuntime';
import { configureChatSummary } from './configureChatSummaryRuntime';
import { configureCompanionRuntime } from './configureCompanionRuntime';
import { configurePromptingRuntime } from './configurePromptingRuntime';
import { configureMcpToolsRuntime } from './configureMcpToolsRuntime';
import { configureMediaRuntime } from './configureMediaRuntime';
import { configureAIImageTools } from './configureAIImageTools';
import { configureAIMessageDeliveryCoordinator } from '../runtime/AIMessageDeliveryCoordinator';
import { configureDeviceControlRuntime } from './configureDeviceControlRuntime';
import { configureFloatingLayerRuntime } from './configureFloatingLayerRuntime';
import { configurePhoneToolsRuntime } from './configurePhoneToolsRuntime';
import { configureTogetherListeningRuntime } from './configureTogetherListeningRuntime';
import { configureStickerRuntime } from '@features/stickers/composition';
import { updateStickerEmbeddingModel } from '../runtime/StickerEmbeddingQueueCoordinator';
import { recognizeSticker } from './StickerAnnotationModelGateway';
import { assertImageToolRunCurrent } from './agent/assertImageToolRunCurrent';
import { configureWebToolsRuntime, sqliteSearchSettingsRepository, secureSearchCredentialStore } from '@features/webTools/composition';

let configured = false;

export function configureBackgroundExecutionRuntime(): void {
  if (configured) {
    return;
  }
  configured = true;

  configureWebToolsRuntime({ settings: sqliteSearchSettingsRepository, credentials: secureSearchCredentialStore });
  configurePhoneToolsRuntime();
  configureTogetherListeningRuntime();
  configureDeviceControlRuntime();
  configureFloatingLayerRuntime();
  configurePromptingRuntime();
  configureMediaRuntime();
  configureAIImageTools();
  // Agent Sticker 工具可在 Android execution host 中运行，但标注队列只属于前台 Host。
  configureStickerRuntime(recognizeSticker, assertImageToolRunCurrent, updateStickerEmbeddingModel);
  // 应用执行宿主 不经过前台页面；MCP Repository/Client 依赖必须在
  // Chat runtime 之前显式装配，冷启动回复才能使用同一套 MCP policy 边界。
  configureMcpToolsRuntime();
  configureChatRuntime();
  configureAIRuntime();
  configureMemoryRuntime();
  // 后台也读取摘要；生成队列仍只由前台状态激活，不依赖页面先加载。
  configureChatSummary();
  configureCompanionRuntime();
  // 统一交付策略随每个 runtime 注册：应用执行宿主 落库后也能发系统通知。
  configureAIMessageDeliveryCoordinator();
}
