/** Floating Layer 应用层公共出口。 */


export {
  addCaptureScreenRequestListener,
  addConversationDisplayedListener,
  addSendMessageListener,
  completeScreenCaptureVisibility,
  clearTogetherListeningPresentation,
  getBatteryOptimizationState,
  isFloatingLayerRunning,
  isOverlayPermissionGranted,
  openOverlayPermissionSettings,
  openBatteryOptimizationSettings,
  recordFloatingMessageTaskCompletion,
  restoreAfterScreenCapture,
  requestIgnoreBatteryOptimizations,
  setAppForeground,
  startFloatingLayer,
  stopFloatingLayer,
  updateReplyPreview,
  updateTargetPreview,
  updateTogetherListeningPresentation,
} from './FloatingLayerFacade';
export type {
  BatteryOptimizationState,
  CaptureScreenRequestEvent,
  EventSubscription,
  FloatingLayerPort,
  FloatingTogetherListeningPresentation,
  ConversationDisplayedEvent,
  ReplyPreview,
  ReplyPreviewStatus,
  SendMessageEvent,
  TargetPreview,
  TargetPreviewStatus,
} from './FloatingLayerPort';

export {
  loadFloatingInteractionState,
  reconcileFloatingInteraction,
  FloatingInteractionOverlayPermissionError,
  setFloatingInteractionEnabled,
} from './FloatingInteractionFacade';
export type {
  FloatingInteractionState,
} from './FloatingInteractionFacade';

export {
  deleteBubbleSkin,
  importBubbleSkin,
  listBubbleSkins,
  renameBubbleSkin,
  selectBubbleSkin,
  updateBubbleSkinImage,
  setBubbleSize,
} from './BubbleSkinFacade';
