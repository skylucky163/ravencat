/** Headless 任务持有的唯一媒体会话；React 展示端只订阅状态和调用命令。 */
import type { AIProfile } from '@features/assistants';
import { listAIAssistants, subscribeAIAssistantUpdated } from '@features/assistants';
import { getCurrentUserProfile, subscribeUserProfileUpdated, type UserProfile } from '@features/profile';
import { startRealtimeSpeechToText, type RealtimeSpeechToTextSession } from '@features/speech';
import { realtimeSpeechAudioSource, temporarySpeechAudioStore, type RealtimeSpeechAudioSourceSession } from '@platform/device';
import type { CallSession } from '../../domain/CallSession';
import type { CallEvent } from '../../domain/CallEvent';
import type { CallInputAudio } from '../../domain/CallHistory';
import { acceptCall, endCall, rejectCall } from '../lifecycle';
import { getCallSession, listCallEvents } from '../queries/GetCallSession';
import { loadCallBackgroundUri, subscribeCallBackgroundChanged } from '../CallBackgroundSettings';
import { appendCallErrorEvent } from '../events/AppendCallSystemEvent';
import { appendCallCameraStateEvent } from '../events/AppendCallCameraStateEvent';
import { subscribeCallTranscriptFacts } from '../events/CallTranscriptFacts';
import { attachCallSnapshot } from '../snapshots/AttachCallSnapshot';
import { registerCallSnapshotProvider, type CallSnapshotProviderResult, type CallSnapshotRequestReason } from '../snapshots/CallSnapshotProviderRegistry';
import { submitCallUserInput } from './RunCallTurn';
import { getCallReplyRunPhase, subscribeCallReplyRunPhase, type CallTurnPhase } from './CallReplyRunState';
import { callTTSPlaybackQueue, subscribeCallSentencePlayback } from './CallTTSPlaybackQueue';
import { getCallRuntimeDependencies, type CallAudioRoute, type CallAudioRouteState } from './CallRuntimeDependencies';
import { computeCallDurationSeconds, isCallTerminalState, resolveUserHangUpReason } from './CallRuntimeHelpers';
import { CallSpeechDuplexGuard } from './CallSpeechDuplexGuard';
import { registerCallMediaOwner } from './CallMediaSession';
type CameraType = 'front' | 'back';

export interface CallRuntimeView {
  call: CallSession | null;
  events: CallEvent[];
  aiProfile: AIProfile | null;
  userProfile: Pick<UserProfile, 'name' | 'avatar'> | null;
  backgroundUri: string | null;
  cameraEnabled: boolean;
  cameraFacing: CameraType;
  isCameraReady: boolean;
  audioRoute: CallAudioRoute | null;
  availableAudioRoutes: CallAudioRoute[];
  isAudioRouteSwitching: boolean;
  isListening: boolean;
  interimSpeechText: string | null;
  /** 已提交但正式事件尚未读回的用户文本；占位保留到正式行出现。 */
  pendingUserSpeechText: string | null;
  isSendingText: boolean;
  /** 回合相位由 calls runtime 持有并广播；presentation 不得用局部布尔反推 AI 状态。 */
  turnPhase: CallTurnPhase;
  isEnding: boolean;
  shouldExit: boolean;
  elapsedSeconds: number;
  isLoading: boolean;
  errorMessage: string | null;
  accept: () => Promise<void>;
  reject: () => Promise<boolean>;
  hangUp: () => Promise<boolean>;
  cycleAudioRoute: () => Promise<void>;
  toggleRealtimeSpeech: () => Promise<void>;
  startRealtimeSpeech: () => Promise<void>;
  stopRealtimeSpeech: () => Promise<void>;
  toggleCamera: () => Promise<void>;
  switchCameraFacing: () => Promise<void>;
  sendCallText: (text: string) => Promise<void>;
  textDraft: string;
  changeTextDraft: (text: string) => void;
  refresh: () => Promise<void>;
}

export function createCallMediaRuntime(callId: string) {
  const listeners = new Set<() => void>();
  let snapshot: CallRuntimeView;
  let textDraft = '';
  let textDraftRevision = 0;
  const changeTextDraft = (text: string) => { textDraft = text; textDraftRevision++; publish(); };
  function publish() { snapshot = buildView(); for (const listener of listeners) listener(); }
  let call: CallSession | null = null;
  const setCall = (value: CallSession | null) => { call = value; publish(); };
  let events: CallEvent[] = [];
  const setEvents = (value: CallEvent[]) => { events = value; publish(); };
  let aiProfile: AIProfile | null = null;
  const setAIProfile = (value: AIProfile | null) => { aiProfile = value; publish(); };
  let userProfile: Pick<UserProfile, 'name' | 'avatar'> | null = null;
  const setUserProfile = (value: Pick<UserProfile, 'name' | 'avatar'> | null) => { userProfile = value; publish(); };
  let backgroundUri: string | null = null;
  const setBackgroundUri = (value: string | null) => { backgroundUri = value; publish(); };
  let cameraEnabled: boolean = false;
  const setCameraEnabled = (value: boolean) => { cameraEnabled = value; publish(); };
  let cameraFacing: CameraType = 'front';
  const setCameraFacing = (value: CameraType) => { cameraFacing = value; publish(); };
  let isCameraReady: boolean = false;
  const setIsCameraReady = (value: boolean) => { isCameraReady = value; publish(); };
  let audioRouteState: CallAudioRouteState | null = null;
  const setAudioRouteState = (value: CallAudioRouteState | null) => { audioRouteState = value; publish(); };
  let isRequestingAudioRoute: boolean = false;
  const setIsRequestingAudioRoute = (value: boolean) => { isRequestingAudioRoute = value; publish(); };
  let isListening: boolean = false;
  const setIsListening = (value: boolean) => { isListening = value; publish(); };
  let interimSpeechText: string | null = null;
  const setInterimSpeechText = (value: string | null) => { interimSpeechText = value; publish(); };
  let pendingUserSpeechText: string | null = null;
  const setPendingUserSpeechText = (value: string | null) => { pendingUserSpeechText = value; publish(); };
  let isSendingText: boolean = false;
  const setIsSendingText = (value: boolean) => { isSendingText = value; publish(); };
  let turnPhase: CallTurnPhase = 'idle';
  const setTurnPhase = (value: CallTurnPhase) => { turnPhase = value; publish(); };
  let isEnding: boolean = false;
  const setIsEnding = (value: boolean) => { isEnding = value; publish(); };
  let shouldExit: boolean = false;
  const setShouldExit = (value: boolean) => { shouldExit = value; if (value) textDraft = ''; publish(); };
  let elapsedSeconds: number = 0;
  const setElapsedSeconds = (value: number) => { elapsedSeconds = value; publish(); };
  let isLoading: boolean = true;
  const setIsLoading = (value: boolean) => { isLoading = value; publish(); };
  let errorMessage: string | null = null;
  const setErrorMessage = (value: string | null) => { errorMessage = value; publish(); };



  let snapshotInFlight: boolean = false;
  let realtimeSpeechSession: RealtimeSpeechToTextSession | null = null;
  let realtimeAudioSession: RealtimeSpeechAudioSourceSession | null = null;
  let realtimeSpeechAbortController: AbortController | null = null;
  let realtimeSpeechRunId: number = 0;
  let speechDuplexGuard: CallSpeechDuplexGuard = new CallSpeechDuplexGuard();


  let refreshVersion = 0;
  let cameraVersion = 0;
  let requestedCamera = false;
  let speechStart: Promise<void> | null = null;

  const refresh = async () => {
      const version = ++refreshVersion;
      const nextCall = await getCallSession(callId);
      if (isEnding || stopped || version !== refreshVersion) {
        return;
      }
      const previousCall = call;
      if (
        nextCall
        && previousCall
        && isCallTerminalState(nextCall.state)
        && !isCallTerminalState(previousCall.state)
      ) {
        setCall(nextCall);
        setShouldExit(true);
        setIsLoading(false);
        return;
      }
      setCall(nextCall);
      setElapsedSeconds(computeCallDurationSeconds(nextCall));
      if (nextCall) {
        const nextEvents = await listCallEvents({ callId: nextCall.id, limit: 200 });
        if (stopped || version !== refreshVersion) return;
        setEvents(nextEvents);
        if (nextEvents.some(event => event.kind === 'userSpeechText' && event.text?.trim() === pendingUserSpeechText)) setPendingUserSpeechText(null);
      } else {
        setEvents([]);
      }
      setIsLoading(false);
    };

  const accept = async () => {
      if (!call) {
        return;
      }

      setErrorMessage(null);
      try {
        const result = await acceptCall(call.id);
        setCall(result.call);
        await refresh();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '接听失败');
      }
    };

  const reject = async () => {
      const currentCall = call;
      if (!currentCall || isEnding) {
        return false;
      }
      setIsEnding(true);
      setErrorMessage(null);
      try {
        const result = await rejectCall(currentCall.id, 'userRejected');
        call = result.call;
        return true;
      } catch (error) {
        setIsEnding(false);
        setErrorMessage(error instanceof Error ? error.message : '拒绝失败');
        return false;
      }
    };

  const cycleAudioRoute = async () => {
      const state = audioRouteState;
      if (!state || state.availableRoutes.length < 2 || state.pendingRoute || isRequestingAudioRoute) return;
      const index = state.route === null ? -1 : state.availableRoutes.indexOf(state.route);
      const next = state.availableRoutes[(index + 1) % state.availableRoutes.length];
      setIsRequestingAudioRoute(true);
      setErrorMessage(null);
      try {
        await getCallRuntimeDependencies().native.audioPlayback.selectRoute(callId, next);
      } catch (error) {
        if (!stopped) setErrorMessage(error instanceof Error ? error.message : '切换通话音频设备失败');
      } finally {
        isRequestingAudioRoute = false;
        if (!stopped) setIsRequestingAudioRoute(false);
      }
    };

  const interruptAISpeechPlaybackForUserSpeech = () => {
      const currentCall = call;
      if (!currentCall) {
        return;
      }

      void callTTSPlaybackQueue.interruptForUserSpeech(currentCall.id).then((interrupted) => {
        if (interrupted) {
          void refresh();
        }
      }).catch((error) => {
        console.warn('[CallMediaRuntime] 用户语音打断 AI 播放失败', error);
      });
    };

  const toggleCamera = async () => {
    const version = ++cameraVersion;
    const next = !requestedCamera;
    requestedCamera = next;
    if (next) {
      const permission = await getCallRuntimeDependencies().native.requestCallCameraPermission();
      if (version !== cameraVersion || stopped) return;
      if (!permission.granted) { requestedCamera = false; setErrorMessage('相机权限未开启'); return; }
    }
    setIsCameraReady(false);
    // 先挂载预览和启动提示，再等待原生绑定，避免 surface 晚于相机创建。
    setCameraEnabled(next);
    try {
      await getCallRuntimeDependencies().native.execution.setCamera(callId, next, cameraFacing);
      if (isEnding || stopped || version !== cameraVersion) return;
      setIsCameraReady(next);
      if (call?.state === 'active') await appendCallCameraStateEvent({ callId, enabled: next, facing: cameraFacing, reason: next ? 'enabled' : 'disabled' });
      await refresh();
    } catch (error) {
      if (version !== cameraVersion || stopped) return;
      requestedCamera = false; setCameraEnabled(false);
      setErrorMessage(error instanceof Error ? error.message : '摄像头启动失败');
    }
  };

  const switchCameraFacing = async () => {
    if (!cameraEnabled || isEnding) return;
    const next = cameraFacing === 'front' ? 'back' : 'front';
    const version = ++cameraVersion;
    setIsCameraReady(false);
    try {
      await getCallRuntimeDependencies().native.execution.setCamera(callId, true, next);
      if (isEnding || stopped || version !== cameraVersion) return;
      setCameraFacing(next); setIsCameraReady(true);
      await appendCallCameraStateEvent({ callId, enabled: true, facing: next, reason: 'facingChanged' });
      await refresh();
    } catch (error) {
      if (version !== cameraVersion || stopped) return;
      requestedCamera = false; setCameraEnabled(false);
      setErrorMessage(error instanceof Error ? error.message : '切换摄像头失败');
    }
  };

  const captureSnapshot = async (reason: CallSnapshotRequestReason): Promise<CallSnapshotProviderResult> => {
    const current = call;
    if (!current || current.state !== 'active' || !cameraEnabled) return { status: 'camera_disabled', message: '摄像头未开启' };
    if (!isCameraReady) return { status: 'camera_not_ready', message: '摄像头正在启动' };
    if (snapshotInFlight) return { status: 'busy', message: '摄像头正在截取上一帧' };
    snapshotInFlight = true;
    const native = getCallRuntimeDependencies().native.execution;
    let picture: { uri: string; width: number; height: number } | null = null;
    try {
      const facing = cameraFacing;
      picture = await native.capture(callId);
      if (isEnding || !cameraEnabled) return { status: 'camera_disabled', message: '通话已停止使用摄像头' };
      const result = await attachCallSnapshot({ callId, sourceUri: picture.uri, mimeType: 'image/jpeg', width: picture.width, height: picture.height, cameraFacing: facing, reason });
      await refresh();
      return { status: 'captured', result };
    } catch (error) {
      const message = error instanceof Error ? error.message : '截取通话画面失败';
      setErrorMessage(message);
      return { status: 'failed', message };
    } finally {
      snapshotInFlight = false;
      if (picture) await native.deleteSnapshot(picture.uri);
    }
  };

  const pendingInputs = new Set<Promise<void>>();
  const sendCallText = (text: string, audio?: Promise<CallInputAudio | null>, onUserTextCommitted?: () => void): Promise<void> => {
    const operation = processCallText(text, audio, onUserTextCommitted).finally(async () => {
      const segment = await audio;
      if (segment) await temporarySpeechAudioStore.deleteIfExists(segment.uri);
    });
    pendingInputs.add(operation);
    void operation.then(() => pendingInputs.delete(operation), () => pendingInputs.delete(operation));
    return operation;
  };
  const processCallText = async (text: string, audio?: Promise<CallInputAudio | null>, onUserTextCommitted?: () => void) => {
      const normalizedText = text.trim();
      const currentCall = call;
      if (
        !normalizedText
        || !currentCall
        || currentCall.state !== 'active'
        || isEnding
        || !aiProfile
      ) {
        return;
      }

      setIsSendingText(true);
      setErrorMessage(null);
      setInterimSpeechText(null);
      setPendingUserSpeechText(normalizedText);
      const duplexGuard = speechDuplexGuard;
      try {
        // 统一用户输入入口：文字与 ASR 稳态文本同权，按相位打断（idle/generating/speaking）。
        const result = await submitCallUserInput({
          callId: currentCall.id,
          userText: normalizedText,
          userAudio: audio,
          onUserTextCommitted,
          aiConfig: {
            id: aiProfile.id,
            agentId: aiProfile.agentId,
            name: aiProfile.name,
            avatar: aiProfile.avatar || null,
            model: aiProfile.model,
            apiKey: aiProfile.apiKey || '',
            apiBaseUrl: aiProfile.apiBaseUrl || '',
            temperature: aiProfile.temperature,
            topP: aiProfile.topP,
            disableThinking: aiProfile.disableThinking,
            reasoningEffort: aiProfile.reasoningEffort,
            maxTokens: aiProfile.maxTokens,
            privateContextPrimaryLimit: aiProfile.privateContextPrimaryLimit,
            privateContextSecondaryLimit: aiProfile.privateContextSecondaryLimit,
            groupContextPrimaryLimit: aiProfile.groupContextPrimaryLimit,
            groupContextSecondaryLimit: aiProfile.groupContextSecondaryLimit,
            systemPrompt: aiProfile.systemPrompt || undefined,
            enableTools: aiProfile.enableTools,
            allowMultipleBubbles: false,
            isHostAI: aiProfile.isHostAI,
            isBlocked: aiProfile.isBlocked,
          },
          onPlaybackStarted: () => duplexGuard.beginAIOutput(),
          onPlaybackEnded: () => duplexGuard.endAIOutput(),
        });

        if (result.status === 'failed') {
          if (!stopped) {
            setPendingUserSpeechText(null);
            setErrorMessage(result.errorMessage);
          }
        } else if (result.status === 'completed' && result.endedCall) {
          call = result.endedCall;
          if (!stopped) {
            setShouldExit(true);
          }
          return;
        }
        if (!stopped && result.status !== 'cancelled') {
          await refresh();
        }
      } catch (error) {
        if (!stopped) {
          setPendingUserSpeechText(null);
          setErrorMessage(error instanceof Error ? error.message : '通话回复失败');
        }
      } finally {
        if (!stopped) {
          setIsSendingText(false);
        }
      }
    };

  const stopRealtimeSpeech = async () => {
      realtimeSpeechRunId += 1;
      realtimeSpeechAbortController?.abort();
      realtimeSpeechAbortController = null;
      speechDuplexGuard.setEchoCancellationEnabled(false);
      const audioSession = realtimeAudioSession;
      realtimeAudioSession = null;
      const speechSession = realtimeSpeechSession;
      realtimeSpeechSession = null;
      try {
        if (audioSession) await audioSession.stop();
      } finally {
        if (speechSession) {
          speechSession.finish();
          speechSession.close();
        }
        // 录音 start 的原生回执可能晚到；先等它按 runId 收口，才能结束宿主执行期。
        await speechStart;
        setIsListening(false);
        setInterimSpeechText(null);
        if (await getCallRuntimeDependencies().native.execution.isAlive(callId)) await getCallRuntimeDependencies().native.execution.setMicrophone(callId, false);
      }
    };

  const hangUp = async () => {
      const currentCall = call;
      if (!currentCall || isEnding) {
        return false;
      }
      setIsEnding(true);
      setErrorMessage(null);
      try {
        const reason = resolveUserHangUpReason(currentCall);
        const result = reason === 'userRejected'
          ? await rejectCall(currentCall.id, reason)
          : await endCall(currentCall.id, reason);
        setCall(result.call);
        return true;
      } catch (error) {
        setIsEnding(false);
        setErrorMessage(error instanceof Error ? error.message : '挂断失败');
        await refresh();
        return false;
      }
    };

  const appendRealtimeSpeechError = async (message: string, source: string) => {
      const currentCall = call;
      if (!currentCall) {
        return;
      }

      await appendCallErrorEvent({
        callId: currentCall.id,
        text: message,
        payload: {
          type: 'realtimeSpeechError',
          source,
        },
      });
    };

  const beginRealtimeSpeech = async () => {
      const currentCall = call;
      if (!currentCall || currentCall.state !== 'active' || !aiProfile) {
        return;
      }
      if (realtimeSpeechSession || realtimeAudioSession) {
        return;
      }

      const runId = realtimeSpeechRunId + 1;
      realtimeSpeechRunId = runId;
      const isCurrentRun = () => (
        realtimeSpeechRunId === runId &&
        call?.id === currentCall.id &&
        call.state === 'active'
      );

      setErrorMessage(null);
      setInterimSpeechText(null);
      speechDuplexGuard.setEchoCancellationEnabled(false);

      try {
        const microphonePermission = await getCallRuntimeDependencies().native.requestMicrophonePermission();
        if (!isCurrentRun()) {
          return;
        }
        if (!microphonePermission.granted) {
          const message = '麦克风权限未开启，无法使用实时语音识别';
          setErrorMessage(message);
          await appendRealtimeSpeechError(message, 'microphonePermission');
          return;
        }
      } catch (error) {
        if (!isCurrentRun()) {
          return;
        }
        const message = error instanceof Error ? error.message : '请求麦克风权限失败';
        setErrorMessage(message);
        await appendRealtimeSpeechError(message, 'microphonePermission');
        return;
      }

      await getCallRuntimeDependencies().native.execution.setMicrophone(callId, true);
      if (!isCurrentRun()) return;
      const abortController = new AbortController();
      realtimeSpeechAbortController = abortController;
      const receiveLiveTranscript = (result: { index: number; text: string }) => {
        if (!isCurrentRun() || speechDuplexGuard.shouldIgnoreTranscriptSegment(result.index, false)) return;
        // 声学人声只是候选；实际识别出内容后才停播，避免呼吸/回声只触发 VAD 就掐断 AI。
        if (result.text.trim()) interruptAISpeechPlaybackForUserSpeech();
        setInterimSpeechText(result.text || null);
      };
      const speechResult = await startRealtimeSpeechToText({
        assistantId: aiProfile.id,
        consumer: 'call',
        signal: abortController.signal,
        onSpeechStart: receiveLiveTranscript,
        onInterimTranscript: receiveLiveTranscript,
        onFinalTranscript: (result) => {
          if (!isCurrentRun()) {
            return;
          }
          if (speechDuplexGuard.shouldIgnoreTranscriptSegment(result.index, true)) {
            setInterimSpeechText(null);
            return;
          }
          const finalText = result.text.trim();
          setInterimSpeechText(null);
          if (!finalText) {
            return;
          }

          // 与文字同权：直接进统一输入入口，由相位机决定打断/新回合；
          // 不得在此串行排队，否则新语音会等上一回合 TTS 全部播完才生效。
          // 原生 start 回执可能晚于第一条识别结果；导出只等待本次采集就绪。
          const exporting = realtimeAudioSession
            ? realtimeAudioSession.exportSegment(result.startTime, result.endTime)
            : speechStart!.then(() => {
              if (!realtimeAudioSession) throw new Error('语音采集已停止，无法导出录音');
              return realtimeAudioSession.exportSegment(result.startTime, result.endTime);
            });
          const audio = exporting
            .catch(async error => {
              await appendRealtimeSpeechError(`通话录音保存失败：${error instanceof Error ? error.message : String(error)}`, 'audioArchive');
              return null;
            });
          // 先提交文本并取得回合所有权；导出失败也不能丢掉已识别的用户发言。
          void sendCallText(finalText, audio).catch((error) => {
            const message = error instanceof Error ? error.message : '语音回复处理失败';
            setErrorMessage(message);
          });
        },
        onError: (errorInfo) => {
          if (!isCurrentRun()) {
            return;
          }
          const message = `${errorInfo.title}（STT）：${errorInfo.message}`;
          setErrorMessage(message);
          void appendRealtimeSpeechError(message, 'realtimeAsr');
        },
      });

      if (speechResult.success === false) {
        if (realtimeSpeechAbortController === abortController) {
          realtimeSpeechAbortController = null;
        }
        if (!isCurrentRun()) {
          return;
        }
        const message = `${speechResult.errorInfo.title}（STT）：${speechResult.errorInfo.message}`;
        setErrorMessage(message);
        await appendRealtimeSpeechError(message, 'realtimeAsr');
        return;
      }
      if (!isCurrentRun()) {
        speechResult.session.close();
        if (realtimeSpeechAbortController === abortController) {
          realtimeSpeechAbortController = null;
        }
        return;
      }

      realtimeSpeechSession = speechResult.session;
      try {
        const audioSession = await realtimeSpeechAudioSource.start({
          archiveSegments: true,
          onAudioChunk: (chunk) => {
            if (!isCurrentRun()) {
              return;
            }
            const guardedChunk = speechDuplexGuard.audioChunkForASR(chunk);
            realtimeSpeechSession?.sendAudioChunk(guardedChunk);
          },
          onSpeechDetected: () => {
            if (!isCurrentRun()) {
              return;
            }
            speechDuplexGuard.observeSpeechActivityDuringAIOutput();
          },
          onError: (error) => {
            if (!isCurrentRun()) {
              return;
            }
            const message = error.message || '实时语音采集失败';
            setErrorMessage(message);
            void appendRealtimeSpeechError(message, 'audioSource');
          },
        });
        if (!isCurrentRun()) {
          await audioSession.stop();
          speechResult.session.close();
          if (realtimeSpeechAbortController === abortController) {
            realtimeSpeechAbortController = null;
          }
          if (realtimeSpeechSession === speechResult.session) {
            realtimeSpeechSession = null;
          }
          return;
        }
        realtimeAudioSession = audioSession;
        speechDuplexGuard.setEchoCancellationEnabled(
          audioSession.echoCancellationEnabled
        );
        setIsListening(true);
      } catch (error) {
        speechResult.session.close();
        if (realtimeSpeechAbortController === abortController) {
          realtimeSpeechAbortController = null;
        }
        if (realtimeSpeechSession === speechResult.session) {
          realtimeSpeechSession = null;
        }
        if (!isCurrentRun()) {
          return;
        }
        const message = error instanceof Error ? error.message : '实时语音采集失败';
        setErrorMessage(message);
        await appendRealtimeSpeechError(message, 'audioSource');
      }
    };

  const startRealtimeSpeech = (): Promise<void> => {
    if (speechStart) return speechStart;
    const version = realtimeSpeechRunId + 1;
    const operation = beginRealtimeSpeech().catch(async (error: unknown) => {
      if (stopped || call?.state !== 'active' || version !== realtimeSpeechRunId) return;
      const message = error instanceof Error ? error.message : '实时语音启动失败';
      setErrorMessage(message);
      await appendRealtimeSpeechError(message, 'executionHost');
    }).finally(() => { if (speechStart === operation) speechStart = null; });
    speechStart = operation;
    return operation;
  };

  const toggleRealtimeSpeech = async () => {
      if (isListening || realtimeSpeechSession || realtimeAudioSession) {
        await stopRealtimeSpeech();
        return;
      }

      await startRealtimeSpeech();
    };
  const submitTextDraft = (text: string) => {
    const expectedRevision = textDraftRevision;
    return sendCallText(text, undefined, () => {
      // 语音输入不消费文字草稿；旧提交不能清掉用户继续输入的新文字。
      if (textDraftRevision === expectedRevision && !shouldExit) changeTextDraft('');
    });
  };
  function buildView(): CallRuntimeView {
    return { call, events, aiProfile, userProfile, backgroundUri, cameraEnabled, cameraFacing, isCameraReady, isListening, interimSpeechText, pendingUserSpeechText, isSendingText, turnPhase, isEnding, shouldExit, elapsedSeconds, isLoading, refresh, accept, reject, cycleAudioRoute, toggleCamera, switchCameraFacing, sendCallText: submitTextDraft, textDraft, changeTextDraft, stopRealtimeSpeech, hangUp, startRealtimeSpeech, toggleRealtimeSpeech,
      audioRoute: audioRouteState?.route ?? null,
      availableAudioRoutes: audioRouteState?.availableRoutes ?? [],
      isAudioRouteSwitching: isRequestingAudioRoute || audioRouteState?.pendingRoute != null,
      errorMessage: audioRouteState?.errorMessage ?? errorMessage,
    };
  }
  snapshot = buildView();
  const cleanups: (() => void)[] = [];
  let terminalResolved: () => void = () => undefined;
  const terminal = new Promise<void>(resolve => { terminalResolved = resolve; });
  let stopped = false;
  let aiAppearanceRevision = 0;
  let userAppearanceRevision = 0;
  let backgroundRevision = 0;
  let stopPromise: Promise<void> | null = null;
  const stopMedia = (terminalCall?: CallSession): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = releaseMedia(terminalCall);
    return stopPromise;
  };
  const releaseMedia = async (terminalCall?: CallSession) => {
    stopped = true;
    refreshVersion++;
    cameraVersion++;
    requestedCamera = false;
    if (terminalCall) setCall(terminalCall);
    setCameraEnabled(false); setIsCameraReady(false);
    try {
      await stopRealtimeSpeech();
    } finally {
      try {
        if (await getCallRuntimeDependencies().native.execution.isAlive(callId)) await getCallRuntimeDependencies().native.execution.setCamera(callId, false, cameraFacing);
      } finally {
        for (const cleanup of cleanups) cleanup();
        speechDuplexGuard.reset();
        setShouldExit(true);
      }
    }
  };
  const initialize = async () => {
    cleanups.push(registerCallMediaOwner(callId, stopMedia));
    cleanups.push(subscribeAIAssistantUpdated(assistant => {
      if (stopped || assistant.id !== call?.aiAssistantId) return;
      aiAppearanceRevision++;
      setAIProfile(assistant);
    }));
    cleanups.push(subscribeUserProfileUpdated(profile => {
      if (stopped) return;
      userAppearanceRevision++;
      setUserProfile({ name: profile.name, avatar: profile.avatar });
    }));
    cleanups.push(subscribeCallBackgroundChanged(assistantId => {
      if (stopped || assistantId !== call?.aiAssistantId) return;
      const revision = ++backgroundRevision;
      void loadCallBackgroundUri(assistantId).then(uri => {
        if (!stopped && revision === backgroundRevision) setBackgroundUri(uri);
      }).catch(error => console.warn('[Calls] 已提交的背景暂时无法展示：', error));
    }));
    cleanups.push(subscribeCallTranscriptFacts(event => {
      if (stopped || event.callId !== callId) return;
      // 晚到的查询不能覆盖刚收到的 commit；事件身份用于与历史读取去重。
      refreshVersion++;
      if (event.kind === 'error') errorMessage = event.text;
      if (event.kind === 'userSpeechText' && event.text === pendingUserSpeechText) pendingUserSpeechText = null;
      if (!events.some(current => current.id === event.id)) events = [...events, event].slice(-200);
      publish();
    }));
    cleanups.push(registerCallSnapshotProvider(callId, captureSnapshot));
    const audio = getCallRuntimeDependencies().native.audioPlayback;
    const receive = (value: CallAudioRouteState | null) => {
      if (stopped || !value || value.callId !== callId || (audioRouteState && value.revision <= audioRouteState.revision)) return;
      audioRouteState = value; setAudioRouteState(value);
    };
    cleanups.push(audio.subscribeRoute(receive));
    setTurnPhase(getCallReplyRunPhase(callId));
    cleanups.push(subscribeCallReplyRunPhase(callId, setTurnPhase));
    cleanups.push(subscribeCallSentencePlayback(event => {
      if (event.callId !== callId) return;
      if (event.type === 'started') speechDuplexGuard.beginAIOutput();
      else speechDuplexGuard.endAIOutput();
    }));
    await refresh();
    if (!call || isCallTerminalState(call.state)) {
      if (call) await stopMedia(call);
      throw new Error('通话在媒体初始化前已经结束');
    }
    const initialAIRevision = aiAppearanceRevision;
    const initialUserRevision = userAppearanceRevision;
    const initialBackgroundRevision = backgroundRevision;
    const [assistants, user, storedBackground, route] = await Promise.all([
      listAIAssistants(), getCurrentUserProfile(),
      call ? loadCallBackgroundUri(call.aiAssistantId) : Promise.resolve(null), audio.getRouteState(),
    ]);
    if (stopped) return;
    // 初次读取不能覆盖期间收到的已提交设置；各事实分别维护读取版本。
    if (initialAIRevision === aiAppearanceRevision) setAIProfile(assistants.find(assistant => assistant.id === call?.aiAssistantId) || null);
    if (initialUserRevision === userAppearanceRevision) setUserProfile(user ? { name: user.name, avatar: user.avatar } : null);
    if (initialBackgroundRevision === backgroundRevision) setBackgroundUri(storedBackground);
    receive(route);
  };
  // 在结束入口外等待输入退场，AI 自己挂断时不会等待当前调用自身。
  const drain = async () => { await Promise.all(pendingInputs); };
  return { initialize, terminal, stopMedia, drain, complete: () => terminalResolved(), getSnapshot: () => snapshot, subscribe: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  } };
}
export type CallMediaRuntime = ReturnType<typeof createCallMediaRuntime>;
