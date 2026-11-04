import type {
  SpeechConnectionConfig,
  SpeechKind,
  SpeechMetadata,
  SpeechParameter,
  SpeechProviderDefinition,
  SpeechProviderId,
} from '../domain/SpeechProvider';

export const SPEECH_PROVIDERS: readonly SpeechProviderDefinition[] = [
  {
    id: 'volcengineRealtimeAsr',
    label: '火山引擎（豆包）实时 ASR',
    kind: 'stt',
    baseURL: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
    models: ['volc.seedasr.sauc.duration', 'volc.seedasr.sauc.concurrent'],
    modelLabels: {
      'volc.seedasr.sauc.duration': '豆包实时识别 2.0 · 按时长',
      'volc.seedasr.sauc.concurrent': '豆包实时识别 2.0 · 按并发',
    },
    defaultModel: 'volc.seedasr.sauc.duration',
    credentialLabel: '语音服务 API Key',
  },
  {
    id: 'stepfunRealtimeAsr',
    label: '阶跃星辰实时 ASR',
    kind: 'stt',
    baseURL: 'wss://api.stepfun.com/v1/realtime/asr/stream',
    models: ['stepaudio-2.5-asr-stream'],
    modelLabels: { 'stepaudio-2.5-asr-stream': 'StepAudio 2.5 ASR（实时）' },
    defaultModel: 'stepaudio-2.5-asr-stream',
    credentialLabel: 'API Key',
  },
  {
    id: 'tencentRealtimeAsr',
    label: '腾讯云实时 ASR',
    kind: 'stt',
    baseURL: 'wss://asr.cloud.tencent.com/asr/v2',
    models: ['16k_zh', '16k_zh-PY', '16k_en', '16k_yue'],
    defaultModel: '16k_zh',
    credentialLabel: 'SecretKey',
  },
  {
    id: 'dashscopeRealtimeAsr',
    label: '阿里百炼实时 ASR',
    kind: 'stt',
    baseURL: '',
    models: ['fun-asr-realtime', 'fun-asr-realtime-2026-02-28', 'paraformer-realtime-v2'],
    defaultModel: 'fun-asr-realtime',
    credentialLabel: 'API Key',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'tts',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15', 'tts-1', 'tts-1-hd'],
    defaultModel: 'gpt-4o-mini-tts',
    credentialLabel: 'API Key',
  },
  {
    id: 'minimaxT2aV2',
    label: 'MiniMax',
    kind: 'tts',
    baseURL: 'https://api.minimax.cn/v1',
    models: [
      'speech-2.8-hd',
      'speech-2.8-turbo',
      'speech-2.6-hd',
      'speech-2.6-turbo',
      'speech-02-hd',
      'speech-02-turbo',
    ],
    defaultModel: 'speech-2.8-hd',
    credentialLabel: 'API Key',
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    kind: 'tts',
    baseURL: 'https://api.elevenlabs.io/v1',
    models: [
      'eleven_v4',
      'eleven_v4_turbo',
      'eleven_v3',
      'eleven_multilingual_v2',
      'eleven_flash_v2_5',
      'eleven_turbo_v2_5',
    ],
    defaultModel: 'eleven_v4',
    credentialLabel: 'API Key',
  },
  {
    id: 'fishAudio',
    label: 'Fish Audio',
    kind: 'tts',
    baseURL: 'https://api.fish.audio/v1',
    models: ['s2.1-pro', 's2.1-pro-free', 's2-pro', 's1', 'drama-3'],
    defaultModel: 's2.1-pro',
    credentialLabel: 'API Key',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'tts',
    baseURL: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-4o-mini-tts-2025-12-15', 'mistralai/voxtral-mini-tts-2603'],
    defaultModel: 'openai/gpt-4o-mini-tts-2025-12-15',
    credentialLabel: 'API Key',
  },
  {
    id: 'openaiCompatible',
    label: '自定义 OpenAI 兼容服务',
    kind: 'tts',
    baseURL: '',
    models: [],
    defaultModel: '',
    credentialLabel: 'API Key',
  },
];
export function getSpeechProvider(id: SpeechProviderId): SpeechProviderDefinition {
  const provider = SPEECH_PROVIDERS.find((entry) => entry.id === id);
  if (!provider) throw new Error(`不支持的语音提供方：${id}`);
  return provider;
}
export function readSpeechMetadata(raw: string | null): SpeechMetadata {
  const value = JSON.parse(raw ?? '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('语音配置格式无效');
  if (value.provider !== undefined && typeof value.provider !== 'string')
    throw new Error('语音提供方格式无效');
  // 旧 TTS 资产的空 metadata 明确表示 OpenAI 兼容协议，保留原地址与模型。
  return { ...value, provider: value.provider === undefined ? 'openaiCompatible' : value.provider };
}
export function speechEndpoint(provider: SpeechProviderId, metadata: SpeechMetadata): string {
  if (provider === 'minimaxT2aV2')
    return metadata.region === 'international'
      ? 'https://api.minimax.io/v1'
      : metadata.region === 'us'
        ? 'https://api-uw.minimax.io/v1'
        : 'https://api.minimax.cn/v1';
  if (provider === 'dashscopeRealtimeAsr')
    return `wss://${metadata.workspaceId}.${metadata.region === 'singapore' ? 'ap-southeast-1' : 'cn-beijing'}.maas.aliyuncs.com/api-ws/v1/inference`;
  return getSpeechProvider(provider).baseURL;
}
const minimaxLanguages = [
  'auto',
  'Chinese',
  'Chinese,Yue',
  'English',
  'Arabic',
  'Russian',
  'Spanish',
  'French',
  'Portuguese',
  'German',
  'Turkish',
  'Dutch',
  'Ukrainian',
  'Vietnamese',
  'Indonesian',
  'Japanese',
  'Italian',
  'Korean',
  'Thai',
  'Polish',
  'Romanian',
  'Greek',
  'Czech',
  'Finnish',
  'Hindi',
  'Bulgarian',
  'Danish',
  'Hebrew',
  'Malay',
  'Persian',
  'Slovak',
  'Swedish',
  'Croatian',
  'Filipino',
  'Hungarian',
  'Norwegian',
  'Slovenian',
  'Catalan',
  'Nynorsk',
  'Tamil',
  'Afrikaans',
];
const openAIVoices = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
];
const text = (key: string, label: string, extra: Partial<SpeechParameter> = {}): SpeechParameter => ({
  key,
  label,
  type: 'text',
  ...extra,
});
const number = (
  key: string,
  label: string,
  min: number,
  max: number,
  extra: Partial<SpeechParameter> = {},
): SpeechParameter => ({ key, label, type: 'number', min, max, ...extra });
const select = (
  key: string,
  label: string,
  options: readonly string[],
  defaultValue?: string,
): SpeechParameter => ({ key, label, type: 'select', options, defaultValue });
export function getSpeechParameters(provider: SpeechProviderId, model: string): SpeechParameter[] {
  switch (provider) {
    case 'volcengineRealtimeAsr':
      return [
        { key: 'enableNonstream', label: '句末二遍识别纠错', type: 'boolean', defaultValue: true, advanced: true },
      ];
    case 'stepfunRealtimeAsr':
      return [
        text('language', '识别语言', { defaultValue: 'zh', advanced: true, hint: '例如 zh（中文）、en（英文）' }),
        text('prompt', '识别提示', { advanced: true, hint: '可填写人名、专业术语等上下文' }),
        { key: 'fullRerunOnCommit', label: '句末二遍识别纠错', type: 'boolean', defaultValue: false, advanced: true },
      ];
    case 'tencentRealtimeAsr':
      return [
        text('appId', 'AppID', { required: true }),
        text('secretId', 'SecretID', { required: true }),
        text('hotwordId', '热词表 ID', { advanced: true }),
        text('hotwordList', '临时热词', { advanced: true, hint: '格式：枫渡|10,RavenCat|5' }),
        number('vadSilenceTime', '断句静音时间（毫秒）', 240, 2000, { integer: true, advanced: true }),
      ];
    case 'dashscopeRealtimeAsr':
      return [
        select('region', '地域', ['beijing', 'singapore'], 'beijing'),
        text('workspaceId', '业务空间 ID', { required: true }),
        text('vocabularyId', '热词表 ID', { advanced: true }),
        number('maxSentenceSilence', '断句静音时间（毫秒）', 200, 6000, { integer: true, advanced: true }),
      ];
    case 'minimaxT2aV2':
      return [
        select('region', '服务站点', ['china', 'international', 'us'], 'china'),
        text('voiceId', '音色 ID', { required: true, hint: '系统音色或你自己的复刻音色 ID' }),
        number('speed', '语速', 0.5, 2),
        number('vol', '音量', 0, 10, { exclusiveMin: true, hint: '大于 0、不超过 10；留空使用服务默认值' }),
        number('pitch', '音调', -12, 12, { integer: true }),
        select(
          'emotion',
          '默认情绪',
          [
            'auto',
            'happy',
            'sad',
            'angry',
            'fearful',
            'disgusted',
            'surprised',
            'calm',
            ...(model.startsWith('speech-2.6-') ? ['fluent', 'whisper'] : []),
          ],
          'auto',
        ),
        {
          ...select(
            'languageBoost',
            '语言增强',
            minimaxLanguages.filter(
              (language) =>
                !model.startsWith('speech-02-') || !['Persian', 'Filipino', 'Tamil'].includes(language),
            ),
          ),
          advanced: true,
        },
        { ...select('audioFormat', '音频格式', ['mp3', 'wav', 'flac'], 'mp3'), advanced: true },
        {
          ...select('sampleRate', '采样率', ['8000', '16000', '22050', '24000', '32000', '44100']),
          type: 'select',
          advanced: true,
        },
        { ...select('bitrate', 'MP3 码率', ['32000', '64000', '128000', '256000']), advanced: true },
      ];
    case 'fishAudio':
      return [
        text('voiceId', '音色 ID', { required: true, hint: '填写 Fish Audio 音色库或自建音色的 ID（reference_id）' }),
        number('speed', '语速', 0.5, 2),
        { ...select('audioFormat', '音频格式', ['mp3', 'wav'], 'mp3'), advanced: true },
        number('temperature', '采样温度', 0, 1, { advanced: true }),
        number('topP', 'Top P', 0, 1, { advanced: true }),
        { ...select('latency', '延迟模式', ['normal', 'balanced', 'low']), advanced: true },
        { key: 'normalize', label: '将数字、日期等转换为读法', type: 'boolean', defaultValue: true, advanced: true },
      ];
    case 'elevenlabs':
      return [
        text('voiceId', '音色 ID', { required: true, hint: '使用 ElevenLabs 音色库中的 voice_id' }),
        model === 'eleven_v3'
          ? select('stability', '稳定性', ['0', '0.5', '1'])
          : number('stability', '稳定性', 0, 1, { hint: '较低值允许更丰富的情绪变化' }),
        number('similarityBoost', '音色相似度', 0, 1),
        ...(model.startsWith('eleven_v4')
          ? []
          : [
              number('style', '风格强度', 0, 1),
              number('speed', '语速', 0.7, 1.2),
              { key: 'speakerBoost', label: '增强音色相似度', type: 'boolean' as const, defaultValue: true },
            ]),
        ...(['eleven_v3', 'eleven_v4', 'eleven_v4_turbo'].includes(model)
          ? [
              select(
                'audioTag',
                '默认表达',
                ['auto', 'whispers', 'excited', 'curious', 'sarcastic', 'crying', 'laughs', 'sighs'],
                'auto',
              ),
            ]
          : []),
        ...(model === 'eleven_multilingual_v2'
          ? []
          : [text('languageCode', '语言代码', { advanced: true, hint: '例如 en、zh；留空自动识别' })]),
        {
          ...select(
            'outputFormat',
            '音频质量',
            ['mp3_22050_32', 'mp3_44100_64', 'mp3_44100_128', 'mp3_44100_192'],
            'mp3_44100_128',
          ),
          advanced: true,
        },
      ];
    case 'openai':
    case 'openaiCompatible':
    case 'openrouter': {
      const openai = provider !== 'openrouter' || model.startsWith('openai/');
      const instructions = provider === 'openaiCompatible' || model.includes('gpt-4o-mini-tts');
      return [
        provider === 'openaiCompatible'
          ? text('voiceId', '音色 ID', { defaultValue: 'alloy' })
          : openai
            ? {
                ...select(
                  'voiceId',
                  '音色',
                  model.endsWith('tts-1') || model.endsWith('tts-1-hd')
                    ? openAIVoices.filter((voice) => !['ballad', 'verse', 'marin', 'cedar'].includes(voice))
                    : openAIVoices,
                  'alloy',
                ),
                required: true,
              }
            : text('voiceId', '音色 ID', {
                required: true,
                hint: '使用所选模型官方支持的音色，例如 en_paul_neutral',
              }),
        ...(openai ? [number('speed', '语速', 0.25, 4)] : []),
        ...(instructions
          ? [text('instructions', '默认说话风格', { hint: '例如：语气温柔、放慢一点，像在安慰身边的人。' })]
          : []),
      ];
    }
  }
}
export function validateSpeechConfiguration(
  kind: SpeechKind,
  config: SpeechConnectionConfig,
): Record<string, string> {
  const errors: Record<string, string> = {};
  let metadata: SpeechMetadata;
  try {
    metadata = readSpeechMetadata(config.metadataJson);
  } catch {
    return { provider: '语音配置格式无效' };
  }
  const provider = SPEECH_PROVIDERS.find((entry) => entry.id === metadata.provider && entry.kind === kind);
  if (!provider) return { provider: '语音提供方不支持此能力' };
  if (!config.model.trim()) errors.model = '请选择或填写模型';
  // Fish 会把未知模型静默替换为默认付费模型，在配置边界拒绝拼错或失效的模型名。
  if (provider.id === 'fishAudio' && !provider.models.includes(config.model))
    errors.model = '请选择支持的 Fish Audio 模型';
  if (provider.id === 'openaiCompatible') {
    try {
      const url = new URL(config.baseURL);
      if (!['http:', 'https:'].includes(url.protocol)) errors.baseUrl = '请填写有效的 HTTP API 地址';
    } catch {
      errors.baseUrl = '请填写有效的 HTTP API 地址';
    }
  }
  for (const field of getSpeechParameters(provider.id, config.model)) {
    const value = metadata[field.key];
    if (value == null || value === '') {
      if (field.required) errors[field.key] = `${field.label}不能为空`;
      continue;
    }
    if (
      field.type === 'number' &&
      (typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < field.min! ||
        (field.exclusiveMin && value === field.min) ||
        value > field.max! ||
        (field.integer && !Number.isInteger(value)))
    )
      errors[field.key] =
        `${field.label}需要${field.exclusiveMin ? `大于 ${field.min}，且不超过 ${field.max}` : `在 ${field.min}～${field.max} 之间`}${field.integer ? '，且为整数' : ''}`;
    if (field.type === 'select' && !field.options!.includes(String(value)))
      errors[field.key] = `请选择支持的${field.label}`;
    if (field.type === 'text' && typeof value !== 'string') errors[field.key] = `${field.label}格式无效`;
    if (field.type === 'boolean' && typeof value !== 'boolean') errors[field.key] = `${field.label}格式无效`;
  }
  if (provider.id === 'tencentRealtimeAsr' && !/^\d+$/.test(String(metadata.appId ?? '')))
    errors.appId = 'AppID 需要填写数字';
  if (provider.id === 'dashscopeRealtimeAsr' && !/^[a-zA-Z0-9_-]+$/.test(String(metadata.workspaceId ?? '')))
    errors.workspaceId = '业务空间 ID 格式无效';
  return errors;
}
