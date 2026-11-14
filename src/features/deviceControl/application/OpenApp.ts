/**
 * Device Control action foundation：exact Android package → Protected Apps admission
 * → native front-door launch request。
 *
 * 固定顺序：validate package → load Protected Apps → assert action allowed → native launch。
 * 成功语义 launch_dispatched 只代表启动请求已交给 Android，不代表目标 App 已进入前台；
 * 执行请求与设备事实分离，不做 foreground 验证、不重试、不内部搜索。
 */

import {
  assertProtectedAppCapabilityAllowed,
  loadCurrentProtectedPackages,
  ProtectedAppsPolicyError,
} from '@features/phoneTools';
import { getDeviceControlRuntimeDependencies } from './DeviceControlRuntimeDependencies';
import { isValidExactTargetPackage } from './ExactPackageTarget';

export type OpenAppResult = {
  status: 'launch_dispatched';
  targetPackage: string;
};

export type OpenAppFailureReason =
  | 'invalid_target_package'
  | 'protected_app'
  | 'app_not_launchable'
  | 'launch_failed';

/** 预期的业务失败统一收敛为一个 error contract，由 open_app Tool 单点处理。 */
export class OpenAppError extends Error {
  readonly reason: OpenAppFailureReason;

  constructor(reason: OpenAppFailureReason, message: string) {
    super(message);
    this.reason = reason;
    this.name = 'OpenAppError';
  }
}

export async function openAppByPackage(packageName: string): Promise<OpenAppResult> {
  if (!isValidExactTargetPackage(packageName)) {
    throw new OpenAppError(
      'invalid_target_package',
      '必须提供不含空白的精确 Android package name',
    );
  }

  // 保留调用者给出的 exact package 身份，不做 toLowerCase 改写；
  // Protected Apps 比较由 policy 内部自行 normalization。
  const targetPackage = packageName.trim();

  const protectedPackages = await loadCurrentProtectedPackages();
  try {
    assertProtectedAppCapabilityAllowed(targetPackage, protectedPackages, 'action');
  } catch (error) {
    if (!(error instanceof ProtectedAppsPolicyError)) {
      throw error;
    }
    throw new OpenAppError('protected_app', error.message);
  }

  const result = await getDeviceControlRuntimeDependencies()
    .native
    .deviceControl
    .openApp(targetPackage);

  if (result.status === 'launch_dispatched') {
    return { status: 'launch_dispatched', targetPackage: result.packageName };
  }

  throw new OpenAppError(result.status, `应用启动失败：${result.reason}`);
}
