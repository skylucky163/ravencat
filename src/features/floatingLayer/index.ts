/** Floating Layer 功能公共 API；只暴露当前跨 Feature 与路由入口所需能力。 */

export {
  addConversationDisplayedListener,
  addConversationRefreshListener,
  updateConversationPreview,
  clearTogetherListeningPresentation,
  completeScreenCaptureVisibility,
  getBatteryOptimizationState,
  isFloatingLayerRunning,
  isOverlayPermissionGranted,
  openBatteryOptimizationSettings,
  openOverlayPermissionSettings,
  recordFloatingMessageTaskCompletion,
  requestIgnoreBatteryOptimizations,
  setAppForeground,
  stopFloatingLayer,
  updateReplyPreview,
  updateTargetPreview,
  updateTogetherListeningPresentation,
} from './application/FloatingLayerFacade';
export type {
  FloatingTogetherListeningPresentation,
  FloatingConversationPreview,
  ConversationDisplayedEvent,
} from './application/FloatingLayerPort';
export { reconcileFloatingInteraction } from './application/FloatingInteractionFacade';
export { default as FloatingInteractionScreen } from './presentation/FloatingInteractionScreen';
