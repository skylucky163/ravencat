/** 应用执行宿主等待整通电话终态；原生取消只经现有 Calls 结束入口收口。 */
import { endCall, getCallSession } from '@features/calls';
import { createCallMediaRuntime, registerHostedCallMediaRuntime } from '@features/calls/composition';
import {
  nativeCallRuntime, pendingNativeCallCommands,
  subscribeNativeCallCancellation, subscribeNativeCallCommand,
  type NativeCallCommand,
} from '../../../modules/call-runtime';
import { ensureHostDatabaseReady } from '../composition/ensureHostDatabaseReady';

export async function executeCall(data: { callId?: string }): Promise<void> {
  const callId = data.callId?.trim();
  if (!callId) throw new Error('通话执行任务缺少 callId');
  const processed = new Map<string, Promise<void>>();
  let runtime: ReturnType<typeof createCallMediaRuntime> | null = null;
  let resumeMicrophone = false;
  const handleCommand = (command: NativeCallCommand): Promise<void> => {
    if (command.callId !== callId) return Promise.resolve();
    const previous = processed.get(command.requestId);
    if (previous) return previous;
    const operation = (async () => {
      let errorMessage: string | null = null;
      try {
        if (!runtime) throw new Error('通话执行尚未就绪');
        if (command.action === 'mute') {
          if (command.muted) {
            resumeMicrophone = runtime.getSnapshot().isListening;
            await runtime.getSnapshot().stopRealtimeSpeech();
          } else if (resumeMicrophone) {
            resumeMicrophone = false;
            // 解除静音的系统回执不等待 ASR 网络；执行期仍由本任务持有。
            void runtime.getSnapshot().startRealtimeSpeech().catch(error => console.error('[Calls] 解除静音失败', error));
          }
        } else {
          await endCall(callId, command.action === 'interrupted' ? 'runtimeError' : 'userEnded');
        }
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : '通话动作失败';
      }
      await nativeCallRuntime.acknowledge(command.requestId, errorMessage);
    })();
    processed.set(command.requestId, operation);
    return operation;
  };
  // 先注册，再读取原生状态，取消发生在初始化之前也不会丢失。
  const commands = subscribeNativeCallCommand(command => { void handleCommand(command); });
  let cancelled = false;
  const cancellation = subscribeNativeCallCancellation(event => {
    if (event.callId !== callId) return;
    cancelled = true;
    if (runtime) void endCall(callId, 'runtimeError').catch(async error => {
      console.error('[Calls] 宿主取消收口失败', error);
      await runtime!.stopMedia();
      runtime!.complete();
    });
  });
  try {
    await ensureHostDatabaseReady();
    const call = await getCallSession(callId);
    if (!call) throw new Error(`通话 ${callId} 不存在`);
    if (cancelled || !await nativeCallRuntime.isAlive(callId)) {
      await endCall(callId, 'runtimeError');
      return;
    }
    runtime = createCallMediaRuntime(callId);
    registerHostedCallMediaRuntime(callId, runtime);
    await runtime.initialize();
    if (cancelled || !await nativeCallRuntime.isAlive(callId)) {
      await endCall(callId, 'runtimeError');
      return;
    }
    await nativeCallRuntime.ready(callId);
    for (const command of await pendingNativeCallCommands(callId)) await handleCommand(command);
    await runtime.terminal;
    await Promise.all(processed.values());
  } catch (error) {
    console.error('[Calls] 通话执行失败', error);
    await endCall(callId, 'runtimeError');
    throw error;
  } finally {
    commands.remove(); cancellation.remove();
    try {
      await runtime?.stopMedia();
      await runtime?.drain();
    } finally { await nativeCallRuntime.finish(callId); }
  }
}
