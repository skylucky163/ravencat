/** 向 Host 与 Presentation 暴露 Soft Lock application 用例，不泄漏具体仓储或原生模块。 */

import { DeviceControlFacade } from './DeviceControlFacade';
import { getDeviceControlRuntimeDependencies } from './DeviceControlRuntimeDependencies';

let facade: DeviceControlFacade | null = null;

function getFacade(): DeviceControlFacade {
  if (facade) {
    return facade;
  }

  const dependencies = getDeviceControlRuntimeDependencies();
  facade = new DeviceControlFacade({
    repository: dependencies.repositories.softAppLocks,
    port: dependencies.native.deviceControl,
    generateId: dependencies.generateSoftAppLockId,
  });
  return facade;
}

export function activateAiSoftLock(input: {
  targetPackage: string;
  sourceAiId: string;
  reason?: string;
  expiresAtEpochMs: number;
}, abortSignal?: AbortSignal) {
  return getFacade().activateAiSoftLock(input, abortSignal);
}

export function releaseAiSoftLock(input: {
  targetPackage: string;
  sourceAiId: string;
}, abortSignal?: AbortSignal) {
  return getFacade().releaseAiSoftLock(input, abortSignal);
}

export function reconcileDeviceControl() {
  return getFacade().reconcileDeviceControl();
}

export function quiesceDeviceControlForFactoryReset() {
  return getFacade().quiesceForFactoryReset();
}

export function resumeDeviceControlAfterFactoryReset() {
  getFacade().resumeAfterFactoryReset();
}
