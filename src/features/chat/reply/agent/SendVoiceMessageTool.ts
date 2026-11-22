/** AI 只负责请求“发送一条语音”；媒体事实由 Chat T3 在回合 fence 内提交。 */
import { MEDIA_ASSET_STORAGE_BACKEND, prepareMediaAssetBatch } from '@features/media';
import { synthesizeTextToSpeech, resolveTextToSpeechModel, readSpeechMetadata, getSpeechParameters, getSpeechTextGuidance, prepareSpeechText, type ResolvedSpeechModel, type SpeechDelivery } from '@features/speech';
import { readLocalAudioMetadata, temporarySpeechAudioStore } from '@platform/device';
import { COMPLETION_INTENT_PARAMETER } from '@shared/aiTools';
import type { AgentToolExecutionContext, AgentToolExecutionResult } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';

export const VOICE_MESSAGE_SEND_INTENT_DISCRIMINATOR = 'ravencat.chat.voice_message.send.v1' as const;

export interface VoiceMessageSendIntent {
  discriminator: typeof VOICE_MESSAGE_SEND_INTENT_DISCRIMINATOR;
  transcript: string;
  mimeType: string;
  durationMs: number;
  preparedMedia: Awaited<ReturnType<typeof prepareMediaAssetBatch>>;
}

export const sendVoiceMessageDefinition = {
  name: 'send_voice_message',
  description: [
    '把完整自然语言作为一条真实语音消息发送到当前单聊或群聊。一次调用只发送一条；需要连续多条时可多次调用。',
    '失败会返回错误供你处理。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 2000, description: '语音可自然使用语气词和标点停顿；不写动作、旁白或表演说明' },
      on_success: COMPLETION_INTENT_PARAMETER,
    },
    required: ['text', 'on_success'],
    additionalProperties: false,
  },
};

export async function sendVoiceMessage(
  input: { text?: string; on_success: 'finish' | 'continue' } & SpeechDelivery,
  context: AgentToolExecutionContext,
  modelSnapshot?: ResolvedSpeechModel | null,
): Promise<AgentToolExecutionResult<VoiceMessageSendIntent>> {
  const text = String(input.text || '').trim();
  if (!text) return toolFailure('VOICE_TEXT_EMPTY', '语音消息尚未发送：正文不能为空。');
  throwIfAbortSignalAborted(context.abortSignal);

  const speechModel = modelSnapshot === undefined
    ? await resolveTextToSpeechModel({ assistantId: context.task.assistantId, consumer: 'chatVoiceMessage' })
    : modelSnapshot;
  if (!speechModel) {
    return toolFailure('VOICE_TTS_NOT_CONFIGURED', '语音消息尚未发送：未配置可用的 TTS 模型。请告知用户在角色的「模型设置」中选择语音模型。');
  }

  const metadata = readSpeechMetadata(speechModel.metadataJson);
  let preparedText: ReturnType<typeof prepareSpeechText>;
  try {
    preparedText = prepareSpeechText(text, metadata.provider, speechModel.model);
  } catch (error) {
    return toolFailure('VOICE_TEXT_INVALID', `语音消息尚未发送：${(error as Error).message}`);
  }
  const { transcript, synthesisText } = preparedText;

  const synthesized = await synthesizeTextToSpeech({
    text: synthesisText,
    assistantId: context.task.assistantId,
    consumer: 'chatVoiceMessage',
    signal: context.abortSignal,
    delivery: { speed: input.speed, emotion: input.emotion, instructions: input.instructions, audioTag: input.audioTag },
    modelSnapshot: speechModel,
  });
  if (!synthesized.success || !synthesized.audioUri || !synthesized.mimeType) {
    const rawError = synthesized.rawError || '语音合成失败';
    return toolFailure(classifyTTSFailure(rawError), `语音消息尚未发送：${synthesized.errorInfo?.message || rawError}`);
  }

  try {
    throwIfAbortSignalAborted(context.abortSignal);
    const metadata = await readLocalAudioMetadata(synthesized.audioUri);
    if (metadata.durationMs <= 0) return toolFailure('VOICE_AUDIO_INVALID', '语音消息尚未发送：生成的音频无效。');
    const preparedMedia = await prepareMediaAssetBatch([{
      storageBackend: MEDIA_ASSET_STORAGE_BACKEND.persistentMedia,
      sourceUri: synthesized.audioUri,
      fileName: `ai-voice-${context.toolCallId}`,
      mimeType: synthesized.mimeType,
      width: null,
      height: null,
      durationMs: metadata.durationMs,
    }]);
    const intent: VoiceMessageSendIntent = {
      discriminator: VOICE_MESSAGE_SEND_INTENT_DISCRIMINATOR,
      transcript,
      mimeType: synthesized.mimeType,
      durationMs: metadata.durationMs,
      preparedMedia,
    };
    return {
      status: 'success',
      data: intent,
      metadata: { fulfillsUserVisibleOutput: true, completionIntent: input.on_success },
      modelContent: '语音消息已准备，等待与本轮 Chat 回复一起提交。不要重复输出相同正文。',
    };
  } catch (error) {
    if (context.abortSignal.aborted) throw error;
    return toolFailure(
      'VOICE_MEDIA_PREPARATION_FAILED',
      `语音消息尚未发送：${error instanceof Error ? error.message : '媒体准备失败'}`,
    );
  } finally {
    await temporarySpeechAudioStore.deleteIfExists(synthesized.audioUri);
  }
}

export const SendVoiceMessageTool = {
  name: sendVoiceMessageDefinition.name,
  definition: sendVoiceMessageDefinition,
  execute: sendVoiceMessage,
};

/** 每个 run 固定模型与工具能力；用户随后切换配置只影响下次 run。 */
export async function createConfiguredVoiceMessageTool(assistantId: string) {
  const modelSnapshot = await resolveTextToSpeechModel({ assistantId, consumer: 'chatVoiceMessage' });
  const properties: Record<string, import('@shared/aiTools').JsonSchema> = { ...sendVoiceMessageDefinition.parameters.properties };
  if (modelSnapshot) {
    const metadata = readSpeechMetadata(modelSnapshot.metadataJson);
    properties.text = {
      ...properties.text,
      description: [
        '本工具的 text 参数仅用于工具调用后的语音合成。未调用工具则不可用。',
        getSpeechTextGuidance(metadata.provider, modelSnapshot.model),
      ].join('\n'),
    };
    for (const field of getSpeechParameters(metadata.provider, modelSnapshot.model)) {
      if (!['speed', 'emotion', 'instructions', 'audioTag'].includes(field.key)) continue;
      // 未知兼容服务由用户填写连接参数，不能据接口名字承诺模型表达能力。
      if (metadata.provider === 'openaiCompatible') continue;
      properties[field.key] = field.type === 'number'
        ? { type: 'number', minimum: field.min, maximum: field.max, description: `这条语音的${field.label}，省略时使用配置默认值` }
        : field.type === 'select'
          ? { type: 'string', enum: field.options, description: `这条语音的${field.label}，省略时使用配置默认值` }
          : { type: 'string', maxLength: 500, description: '只描述这条语音的说话方式、情绪与语气，不包含需要朗读的正文' };
    }
  }
  const definition = { ...sendVoiceMessageDefinition,
    description: `${sendVoiceMessageDefinition.description}可根据当前情境主动使用本工具字段说明中支持的表达参数或句内标记，让工具调用产生的语音自然地表现情绪。`,
    parameters: { ...sendVoiceMessageDefinition.parameters, properties },
  };
  return { ...SendVoiceMessageTool, definition, execute: (input: { text?: string; on_success: 'finish' | 'continue' } & SpeechDelivery, context: AgentToolExecutionContext) => sendVoiceMessage(input, context, modelSnapshot) };
}

export function isVoiceMessageSendIntent(value: unknown): value is VoiceMessageSendIntent {
  if (!value || typeof value !== 'object') return false;
  const intent = value as Partial<VoiceMessageSendIntent>;
  return intent.discriminator === VOICE_MESSAGE_SEND_INTENT_DISCRIMINATOR
    && typeof intent.transcript === 'string'
    && typeof intent.mimeType === 'string'
    && typeof intent.durationMs === 'number'
    && Boolean(intent.preparedMedia);
}

function toolFailure(code: string, modelContent: string): AgentToolExecutionResult<VoiceMessageSendIntent> {
  const retryable = code === 'VOICE_TTS_RATE_LIMITED'
    || code === 'VOICE_TTS_NETWORK_FAILED'
    || code === 'VOICE_TTS_TIMEOUT'
    || code === 'VOICE_TTS_FAILED'
    || code === 'VOICE_MEDIA_PREPARATION_FAILED';
  return { status: 'error', code, retryable, modelContent };
}

function classifyTTSFailure(rawError: string): string {
  const value = rawError.toLowerCase();
  if (value.includes('timeout') || value.includes('超时')) return 'VOICE_TTS_TIMEOUT';
  if (value.includes('network') || value.includes('网络')) return 'VOICE_TTS_NETWORK_FAILED';
  if (value.includes('429') || value.includes('rate')) return 'VOICE_TTS_RATE_LIMITED';
  if (value.includes('quota') || value.includes('余额')) return 'VOICE_TTS_QUOTA_EXHAUSTED';
  if (value.includes('401') || value.includes('403') || value.includes('auth') || value.includes('鉴权')) {
    return 'VOICE_TTS_AUTH_FAILED';
  }
  if (value.includes('配置')) return 'VOICE_TTS_CONFIGURATION_INVALID';
  return 'VOICE_TTS_FAILED';
}
