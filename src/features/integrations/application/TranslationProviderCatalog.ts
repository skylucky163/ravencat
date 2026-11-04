import type { TranslationProviderMeta } from '../domain/TranslationModel';

export const TENCENT_TRANSLATION_PROVIDER = {
  provider: 'tencentCloudTmt',
  label: '腾讯云机器翻译',
  optionFields: [
    {
      key: 'region',
      label: '地域',
      placeholder: 'ap-guangzhou',
      advanced: true,
    },
    {
      key: 'source',
      label: '源语言',
      placeholder: 'auto',
      hint: 'auto 表示自动识别原文语言',
    },
    {
      key: 'target',
      label: '目标语言',
      placeholder: 'zh',
      hint: '默认 zh（中文），使用腾讯云支持的语言代码',
    },
    {
      key: 'projectId',
      label: '项目 ID',
      placeholder: '0',
      advanced: true,
    },
  ],
} satisfies TranslationProviderMeta;

export const AI_TRANSLATION_PROVIDER = {
  provider: 'aiModel',
  label: 'AI 模型',
  optionFields: [
    { key: 'source', label: '源语言', placeholder: 'auto', hint: 'auto 表示自动识别原文语言' },
    { key: 'target', label: '目标语言', placeholder: 'zh', hint: '默认 zh（中文），支持语言代码或名称' },
  ],
} satisfies TranslationProviderMeta;

export const TRANSLATION_PROVIDERS: TranslationProviderMeta[] = [
  AI_TRANSLATION_PROVIDER,
  TENCENT_TRANSLATION_PROVIDER,
];
