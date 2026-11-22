/**
 * deviceControl 暴露给模型的 Agent Tool 清单。
 *
 * 新增工具等于扩大设备控制面，属于产品决策：必须同时更新此清单，
 * 并在对应架构文档说明它的权限与失败边界。
 * 多处契约检查共用同一份清单，避免各自维护导致同时失效。
 */
export const DEVICE_CONTROL_AGENT_TOOLS = [
  'OpenAppTool.ts',
  'ReleaseSoftLockTool.ts',
  'SearchInstalledAppsTool.ts',
  'SetAlarmTool.ts',
  'SoftLockAppTool.ts',
];
