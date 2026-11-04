import type { ErrorDisplayInfo } from '@platform/ai';
import { createRandomUUID } from '@platform/device';
import type { RealtimeRecognitionConnection, RealtimeRecognitionHandlers, RealtimeTranscript, SpeechConnectionConfig, SpeechMetadata } from './domain/SpeechProvider';
import { readSpeechMetadata } from './application/SpeechProviderCatalog';
import { getSpeechRecognitionErrorInfo } from './application/SpeechRecognitionErrors';
import { resolveSpeechToTextModel, type SpeechModelConsumer } from './application/ResolveSpeechModel';
import { connectDashScopeRealtimeASR } from './infrastructure/DashScopeRealtimeASRClient';
import { createTencentRealtimeASRClient } from './infrastructure/TencentRealtimeASRClient';
import { createTencentRealtimeASRSignedUrl } from './infrastructure/tencentRealtimeASRSignature';
import { connectVolcengineRealtimeASR } from './infrastructure/VolcengineRealtimeASRClient';
import { connectStepfunRealtimeASR } from './infrastructure/StepfunRealtimeASRClient';

export interface RealtimeSpeechToTextSession extends RealtimeRecognitionConnection {
  modelConfigId: string;
  modelConfigName: string;
}
export interface StartRealtimeSpeechToTextParams {
  assistantId?: string | null;
  consumer?: SpeechModelConsumer;
  /** 设置测试只使用经过表单校验的快照，不改变用户或角色的模型选择。 */
  configuration?: SpeechConnectionConfig;
  signal?: AbortSignal;
  onSpeechStart?: (result: RealtimeTranscript) => void;
  onInterimTranscript?: (result: RealtimeTranscript) => void;
  onFinalTranscript?: (result: RealtimeTranscript) => void;
  onFinished?: () => void;
  onError?: (errorInfo: ErrorDisplayInfo) => void;
}
export type StartRealtimeSpeechToTextResult = { success: true; session: RealtimeSpeechToTextSession } | { success: false; rawError: string; errorInfo: ErrorDisplayInfo };
export async function startRealtimeSpeechToText(params: StartRealtimeSpeechToTextParams): Promise<StartRealtimeSpeechToTextResult> {
  try {
    const selected = params.configuration ? null : await resolveSpeechToTextModel(params);
    const model = params.configuration ?? selected;
    const handlers: RealtimeRecognitionHandlers = { ...params, onError: (error) => params.onError?.(getSpeechRecognitionErrorInfo(error.message)) };
    if (!model) {
      const rawError = '未配置可用的实时 STT 模型，请在辅助模型中心配置并选择 STT 模型';
      return { success: false, rawError, errorInfo: getSpeechRecognitionErrorInfo(rawError) };
    }
    const metadata = readSpeechMetadata(model.metadataJson);
    const connection = await connectRealtimeRecognition(model, metadata, handlers, params.consumer === 'call', params.signal);
    return { success: true, session: { ...connection, modelConfigId: selected?.modelConfigId ?? 'preview', modelConfigName: selected?.modelConfigName ?? model.model } };
  } catch (error) {
    const rawError = error instanceof Error ? error.message : '实时语音识别启动失败';
    return { success: false, rawError, errorInfo: getSpeechRecognitionErrorInfo(rawError) };
  }
}
function connectRealtimeRecognition(config: SpeechConnectionConfig, metadata: SpeechMetadata, handlers: RealtimeRecognitionHandlers, continuous: boolean, signal?: AbortSignal): Promise<RealtimeRecognitionConnection> {
  switch (metadata.provider) {
    case 'volcengineRealtimeAsr': return connectVolcengineRealtimeASR(config, metadata, handlers, signal);
    case 'stepfunRealtimeAsr': return connectStepfunRealtimeASR(config, metadata, handlers, continuous, signal);
    case 'dashscopeRealtimeAsr': return connectDashScopeRealtimeASR(config, metadata, handlers, signal);
    case 'tencentRealtimeAsr': return createTencentRealtimeASRClient({
      signedUrl: createTencentRealtimeASRSignedUrl({ baseURL: config.baseURL, appId: metadata.appId as string, secretId: metadata.secretId as string, secretKey: config.apiKey, engineModelType: config.model, voiceId: createRandomUUID(), voiceFormat: 1, needVad: 1, filterEmptyResult: 1, vadSilenceTime: metadata.vadSilenceTime as number | null, hotwordId: metadata.hotwordId as string | null, hotwordList: metadata.hotwordList as string | null }),
      handlers: { onSpeechStart: handlers.onSpeechStart, onInterimResult: handlers.onInterimTranscript, onFinalResult: handlers.onFinalTranscript, onFinished: handlers.onFinished, onError: handlers.onError },
    }).connect(signal);
    default: throw new Error('当前提供方不支持实时语音识别');
  }
}
