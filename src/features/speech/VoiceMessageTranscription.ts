import type { ErrorDisplayInfo } from '@platform/ai';
import { getSpeechRecognitionErrorInfo } from './application/SpeechRecognitionErrors';

import { startRealtimeSpeechToText } from './StartRealtimeSpeechToText';

export type VoiceMessageSTTFailureCode =
  | 'VOICE_STT_NOT_CONFIGURED'
  | 'VOICE_STT_CONFIGURATION_INVALID'
  | 'VOICE_STT_AUTH_FAILED'
  | 'VOICE_STT_QUOTA_EXHAUSTED'
  | 'VOICE_STT_RATE_LIMITED'
  | 'VOICE_STT_NETWORK_FAILED'
  | 'VOICE_STT_TIMEOUT'
  | 'VOICE_STT_EMPTY_TRANSCRIPT'
  | 'VOICE_STT_FAILED';

export type VoiceMessageTranscriptionResult =
  | { success: true; text: string }
  | {
      success: false;
      code: VoiceMessageSTTFailureCode;
      rawError: string;
      errorInfo: ErrorDisplayInfo;
      retryable: boolean;
    };
type VoiceMessageTranscriptionFailure = Extract<VoiceMessageTranscriptionResult, { success: false }>;

export interface VoiceMessageTranscriptionSession {
  acceptAudioChunk(chunk: ArrayBuffer): void;
  finish(): Promise<VoiceMessageTranscriptionResult>;
  cancel(): Promise<void>;
}

export async function startVoiceMessageTranscription(params: {
  assistantId?: string | null;
  signal?: AbortSignal;
}): Promise<
  VoiceMessageTranscriptionSession
  | VoiceMessageTranscriptionFailure
> {
  const finalSegments = new Map<number, string>();
  let finishResolve: (() => void) | null = null;
  let finishReject: ((error: Error) => void) | null = null;
  const finishBarrier = new Promise<void>((resolve, reject) => {
    finishResolve = resolve;
    finishReject = reject;
  });
  void finishBarrier.catch(() => undefined);
  const started = await startRealtimeSpeechToText({
    assistantId: params.assistantId,
    consumer: 'chatVoiceMessage',
    signal: params.signal,
    onFinalTranscript: (result) => finalSegments.set(result.index, result.text),
    onFinished: () => finishResolve?.(),
    onError: (info) => finishReject?.(new Error(info.message)),
  });
  if (started.success === false) return classifyFailure(started.rawError);

  return {
    acceptAudioChunk: (chunk) => started.session.sendAudioChunk(chunk),
    finish: async () => {
      try {
        started.session.finish();
        await withTimeout(finishBarrier, 10_000);
      } catch (error) {
        started.session.close();
        return classifyFailure(error instanceof Error ? error.message : '语音识别结束失败');
      }
      started.session.close();
      const text = [...finalSegments.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, value]) => value)
        .join('')
        .trim();
      return text
        ? { success: true, text }
        : failure('VOICE_STT_EMPTY_TRANSCRIPT', '没有识别到可发送的语音内容');
    },
    cancel: async () => started.session.close(),
  };
}

function classifyFailure(rawError: string): VoiceMessageTranscriptionFailure {
  const value = rawError.toLowerCase();
  if (value.includes('未配置')) return failure('VOICE_STT_NOT_CONFIGURED', rawError);
  if (value.includes('timeout') || value.includes('超时')) return failure('VOICE_STT_TIMEOUT', rawError, true);
  if (value.includes('network') || value.includes('websocket') || value.includes('网络')) {
    return failure('VOICE_STT_NETWORK_FAILED', rawError, true);
  }
  if (value.includes('429') || value.includes('rate')) return failure('VOICE_STT_RATE_LIMITED', rawError, true);
  if (value.includes('quota') || value.includes('余额')) return failure('VOICE_STT_QUOTA_EXHAUSTED', rawError);
  if (value.includes('401') || value.includes('403') || value.includes('auth') || value.includes('鉴权')) {
    return failure('VOICE_STT_AUTH_FAILED', rawError);
  }
  if (value.includes('配置') || value.includes('appid') || value.includes('secret')) {
    return failure('VOICE_STT_CONFIGURATION_INVALID', rawError);
  }
  return failure('VOICE_STT_FAILED', rawError, true);
}

function failure(
  code: VoiceMessageSTTFailureCode,
  rawError: string,
  retryable = false,
): VoiceMessageTranscriptionFailure {
  return { success: false, code, rawError, errorInfo: getSpeechRecognitionErrorInfo(rawError), retryable };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('语音识别结束超时')), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
