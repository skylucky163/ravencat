/** 应用级持续后台运行；原生配置拥有开关，业务任务只消费执行保障。 */
import { requireNativeModule } from 'expo-modules-core';

export interface BackgroundRuntimeState {
  enabled: boolean;
  running: boolean;
}

interface BackgroundRuntimeNativeModule {
  getState(): Promise<BackgroundRuntimeState>;
  setEnabled(enabled: boolean): Promise<BackgroundRuntimeState>;
  reconcile(): Promise<BackgroundRuntimeState>;
  connect(): Promise<void>;
  post(kind: ApplicationExecutionKind, data: object, timeoutMs: number): Promise<boolean>;
  takePending(): Promise<ApplicationExecutionRequest[]>;
  complete(id: string): Promise<void>;
  addListener(name: 'onExecutionRequests', listener: () => void): { remove(): void };
}

export type ApplicationExecutionKind = 'conversation' | 'relationship' | 'companion' | 'floating' | 'call' | 'call_action' | 'together_action';
export interface ApplicationExecutionRequest {
  id: string;
  kind: ApplicationExecutionKind;
  data: Record<string, unknown>;
  remainingMs: number | null;
}

const nativeModule = requireNativeModule<BackgroundRuntimeNativeModule>('BackgroundRuntime');
export const getBackgroundRuntimeState = () => nativeModule.getState();
export const setBackgroundRuntimeEnabled = (enabled: boolean) => nativeModule.setEnabled(enabled);
export const reconcileBackgroundRuntime = () => nativeModule.reconcile();
export const connectApplicationExecutionHost = () => nativeModule.connect();
export const postApplicationExecution = (kind: ApplicationExecutionKind, data: object, timeoutMs: number) => nativeModule.post(kind, data, timeoutMs);
export const takeApplicationExecutions = () => nativeModule.takePending();
export const completeApplicationExecution = (id: string) => nativeModule.complete(id);
export const subscribeApplicationExecutions = (listener: () => void) => nativeModule.addListener('onExecutionRequests', listener);
