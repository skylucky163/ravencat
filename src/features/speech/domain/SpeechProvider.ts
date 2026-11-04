/** 提供方协议由 Speech 持有；表单、资产可用性和模型工具共用同一份参数契约。 */
export type SpeechProviderId =
  | 'tencentRealtimeAsr'
  | 'dashscopeRealtimeAsr'
  | 'volcengineRealtimeAsr'
  | 'stepfunRealtimeAsr'
  | 'openai'
  | 'openaiCompatible'
  | 'openrouter'
  | 'minimaxT2aV2'
  | 'elevenlabs'
  | 'fishAudio';
export type SpeechKind = 'stt' | 'tts';
export type SpeechOptionValue = string | number | boolean | null;
export interface SpeechMetadata {
  provider: SpeechProviderId;
  [key: string]: SpeechOptionValue | undefined;
}
export interface SpeechConnectionConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  metadataJson: string | null;
}
export interface SpeechParameter {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'boolean';
  required?: boolean;
  min?: number;
  exclusiveMin?: boolean;
  max?: number;
  integer?: boolean;
  options?: readonly string[];
  hint?: string;
  defaultValue?: SpeechOptionValue;
  advanced?: boolean;
}
export interface SpeechProviderDefinition {
  id: SpeechProviderId;
  label: string;
  kind: SpeechKind;
  baseURL: string;
  models: readonly string[];
  modelLabels?: Readonly<Record<string, string>>;
  defaultModel: string;
  credentialLabel: string;
}
export interface SpeechDelivery {
  speed?: number;
  emotion?: string;
  instructions?: string;
  audioTag?: string;
}
export type SpeechAudioFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
export interface SpeechSynthesisRequest {
  text: string;
  voice?: string | null;
  responseFormat?: SpeechAudioFormat | null;
  speed?: number | null;
  instructions?: string | null;
  emotion?: string | null;
  signal?: AbortSignal;
}
export interface SpeechSynthesisResponse {
  success: boolean;
  audioBase64: string;
  mimeType: string;
  error: string | null;
  model: string | null;
}
export interface RealtimeTranscript {
  index: number;
  text: string;
  startTime: number;
  endTime: number;
}
export interface RealtimeRecognitionHandlers {
  onSpeechStart?: (result: RealtimeTranscript) => void;
  onInterimTranscript?: (result: RealtimeTranscript) => void;
  onFinalTranscript?: (result: RealtimeTranscript) => void;
  onFinished?: () => void;
  onError?: (error: Error) => void;
}
export interface RealtimeRecognitionConnection {
  sendAudioChunk(chunk: ArrayBuffer): void;
  finish(): void;
  close(): void;
}
