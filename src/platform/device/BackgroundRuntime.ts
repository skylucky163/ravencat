/** 通用后台保障的唯一设置入口，独立于悬浮交互、通话和主动伴随开关。 */
export {
  getBackgroundRuntimeState,
  setBackgroundRuntimeEnabled,
  reconcileBackgroundRuntime,
  type BackgroundRuntimeState,
  connectApplicationExecutionHost,
  postApplicationExecution,
  takeApplicationExecutions,
  completeApplicationExecution,
  subscribeApplicationExecutions,
  type ApplicationExecutionRequest,
} from '../../../modules/background-runtime';
