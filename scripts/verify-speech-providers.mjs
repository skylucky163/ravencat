/** 语音提供方协议、能力、配置提交和临时测试生命周期的行为验证。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { agentToolSchemaDependencies } from './helpers/agent-tool-schema-dependencies.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function load(file, dependencies = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.resolve(file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `${file} 缺少依赖 ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const speechRoot = 'src/features/speech/';
const catalog = load(`${speechRoot}application/SpeechProviderCatalog.ts`);
const speechText = load(`${speechRoot}application/SpeechText.ts`);
const callPrompts = load('src/features/calls/application/CallPromptBlocks.ts');
const callStreams = load('src/features/calls/application/runtime/CallSpeechSentenceStream.ts', {
  '@features/speech': { ...speechText, ...catalog }, '../CallPromptBlocks': callPrompts,
});
const draftModule = load('src/features/assistants/presentation/auxiliaryModels/speechModelDraft.ts', { '@features/speech': catalog });
const encoding = load(`${speechRoot}infrastructure/speechAudioEncoding.ts`);
const ai = { normalizeAIBaseURL: (url) => url.replace(/\/$/, ''), ...load('src/platform/ai/errorMapping.ts') };
const recognitionErrors = load(`${speechRoot}application/SpeechRecognitionErrors.ts`);
const httpErrors = load(`${speechRoot}infrastructure/SpeechHttpError.ts`);
const openai = load(`${speechRoot}infrastructure/OpenAISpeechClient.ts`, { '@platform/ai': ai, './speechAudioEncoding': encoding, './SpeechHttpError': httpErrors });
const minimax = load(`${speechRoot}infrastructure/MiniMaxSpeechClient.ts`, { '@platform/ai': ai, './SpeechHttpError': httpErrors });
const eleven = load(`${speechRoot}infrastructure/ElevenLabsSpeechClient.ts`, { './speechAudioEncoding': encoding, './SpeechHttpError': httpErrors });
const fish = load(`${speechRoot}infrastructure/FishAudioSpeechClient.ts`, { './speechAudioEncoding': encoding, './SpeechHttpError': httpErrors });
const gateway = load(`${speechRoot}infrastructure/SpeechSynthesisGateway.ts`, { './OpenAISpeechClient': openai, './MiniMaxSpeechClient': minimax, './ElevenLabsSpeechClient': eleven, './FishAudioSpeechClient': fish, '../application/SpeechProviderCatalog': catalog });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const requests = [];
const originalFetch = globalThis.fetch;
const originalSocket = globalThis.WebSocket;
try {
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) });
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, json: async () => ({ base_resp: { status_code: 0 }, data: { audio: '010203' } }) };
  };
  const synthesize = (provider, model, metadata, delivery = {}) => gateway.synthesizeSpeechAudio({ baseURL: catalog.getSpeechProvider(provider).baseURL, apiKey: 'test-key', model, metadataJson: null }, { provider, ...metadata }, '你好', delivery);
  assert.equal((await synthesize('openai', 'gpt-4o-mini-tts', { voiceId: 'coral', instructions: '温柔' }, { speed: 1.1 })).audioBase64, 'AQID');
  assert.equal(requests.at(-1).url, 'https://api.openai.com/v1/audio/speech');
  assert.equal(requests.at(-1).body.instructions, '温柔');
  await synthesize('openrouter', 'openai/gpt-4o-mini-tts-2025-12-15', { voiceId: 'coral' }, { instructions: '轻声', speed: 0.8 });
  assert.equal(requests.at(-1).url, 'https://openrouter.ai/api/v1/audio/speech');
  assert.equal(requests.at(-1).body.instructions, '轻声');
  assert.equal(requests.at(-1).body.provider, undefined);
  assert.equal(requests.at(-1).body.response_format, 'mp3');
  await synthesize('minimaxT2aV2', 'speech-2.8-hd', { voiceId: 'voice', emotion: 'happy', pitch: 0, speed: 1 }, { emotion: 'calm', speed: 0.8 });
  assert.equal(requests.at(-1).url, 'https://api.minimax.cn/v1/t2a_v2');
  assert.deepEqual(requests.at(-1).body.voice_setting, { voice_id: 'voice', speed: 0.8, pitch: 0, emotion: 'calm' });
  await synthesize('elevenlabs', 'eleven_v4', { voiceId: 'voice/id', stability: 0, similarityBoost: 0.5, speed: 1, style: 1, speakerBoost: true }, { audioTag: 'whispers' });
  assert.equal(requests.at(-1).headers['xi-api-key'], 'test-key');
  assert.ok(requests.at(-1).url.includes('voice%2Fid?output_format=mp3_44100_128'));
  assert.equal(requests.at(-1).body.text, '[whispers] 你好');
  assert.deepEqual(requests.at(-1).body.voice_settings, { stability: 0, similarity_boost: 0.5 });
  await synthesize('elevenlabs', 'eleven_multilingual_v2', { voiceId: 'voice', speakerBoost: false, speed: 1.2 });
  assert.deepEqual(requests.at(-1).body.voice_settings, { use_speaker_boost: false, speed: 1.2 });
  assert.ok(!catalog.getSpeechParameters('elevenlabs', 'eleven_v4').some((field) => field.key === 'speed'));
  assert.ok(!catalog.getSpeechParameters('openai', 'tts-1').some((field) => field.key === 'instructions'));
  assert.ok(!catalog.getSpeechParameters('minimaxT2aV2', 'speech-2.8-hd').find((field) => field.key === 'emotion').options.includes('whisper'));

  // Fish 使用原生请求头与单音色协议，零值、false 和单次语速覆盖不能在映射时丢失。
  const fishController = new AbortController();
  const fishConfig = { baseURL: 'https://api.fish.audio/v1/', apiKey: 'fish-key', model: 's2.1-pro', metadataJson: null };
  const fishAudio = await gateway.synthesizeSpeechAudio(fishConfig, {
    provider: 'fishAudio', voiceId: 'fish-voice', speed: 1.2, temperature: 0, topP: 0,
    normalize: false, latency: 'balanced', instructions: '不属于 Fish 参数',
  }, '你好，Fish。', { speed: 0.8 }, fishController.signal);
  assert.equal(fishAudio.audioBase64, 'AQID');
  assert.equal(fishAudio.mimeType, 'audio/mpeg');
  assert.equal(fishAudio.model, 's2.1-pro');
  assert.equal(requests.at(-1).url, 'https://api.fish.audio/v1/tts');
  assert.equal(requests.at(-1).method, 'POST');
  assert.deepEqual(requests.at(-1).headers, { 'Content-Type': 'application/json', Authorization: 'Bearer fish-key', model: 's2.1-pro' });
  assert.equal(requests.at(-1).signal, fishController.signal);
  assert.deepEqual(requests.at(-1).body, {
    text: '你好，Fish。', reference_id: 'fish-voice', format: 'mp3', prosody: { speed: 0.8 },
    temperature: 0, top_p: 0, normalize: false, latency: 'balanced',
  });
  assert.equal((await synthesize('fishAudio', 's2-pro', { voiceId: 'fish-voice', audioFormat: 'wav', speed: 1.1 })).mimeType, 'audio/wav');
  assert.deepEqual(requests.at(-1).body.prosody, { speed: 1.1 });
  await synthesize('fishAudio', 's1', { voiceId: 'fish-voice' });
  assert.deepEqual(requests.at(-1).body, { text: '你好', reference_id: 'fish-voice', format: 'mp3' });
  const beforeFishErrors = globalThis.fetch;
  try {
    for (const status of [401, 402, 429]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ status, message: 'Fish 请求失败' }), { status });
      await assert.rejects(synthesize('fishAudio', 's2-pro', { voiceId: 'fish-voice' }), new RegExp(`Fish Audio HTTP ${status}: Fish 请求失败`));
    }
    globalThis.fetch = async () => new Response('upstream unavailable', { status: 503, statusText: 'Service Unavailable' });
    await assert.rejects(synthesize('fishAudio', 's2-pro', { voiceId: 'fish-voice' }), /Fish Audio HTTP 503: Service Unavailable/);
    globalThis.fetch = async () => new Response(new Uint8Array());
    await assert.rejects(synthesize('fishAudio', 's2-pro', { voiceId: 'fish-voice' }), /空音频/);
    globalThis.fetch = async (_url, { signal }) => { signal.throwIfAborted(); assert.fail('已取消的请求不能完成'); };
    fishController.abort();
    await assert.rejects(gateway.synthesizeSpeechAudio(fishConfig, { provider: 'fishAudio', voiceId: 'fish-voice' }, '你好', {}, fishController.signal), { name: 'AbortError' });
  } finally { globalThis.fetch = beforeFishErrors; }

  // 两条实际合成链路均保留 404 原因、请求标识及非 JSON 正文；密钥不能随服务端回显离开边界。
  const diagnosticKey = 'secret"fish\\key';
  let diagnosticMessage;
  try {
    for (const provider of ['openaiCompatible', 'fishAudio', 'minimaxT2aV2', 'elevenlabs']) {
      const failWith = async (body, statusText = 'Not Found') => {
        const response = new Response(body, { status: 404, statusText });
        globalThis.fetch = async () => response;
        let error;
        try {
          const result = await gateway.synthesizeSpeechAudio({
            baseURL: 'https://example.invalid/v1', apiKey: diagnosticKey, model: 's2.1-pro-free', metadataJson: null,
          }, { provider, voiceId: 'missing-voice' }, '你好', {});
          assert.equal(result.success, false);
          error = result.error;
        } catch (cause) { error = cause.message; }
        assert.equal(response.bodyUsed, true);
        assert.match(error, /HTTP 404/);
        assert.ok(!error.includes(diagnosticKey));
        assert.ok(!error.includes(JSON.stringify(diagnosticKey).slice(1, -1)));
        assert.ok(!error.includes(encodeURIComponent(diagnosticKey)));
        return error;
      };
      const body = JSON.stringify({ status: 404, message: `Voice not found: ${diagnosticKey}`, reason: 'reference_id missing', request_id: 'fish-request-123' });
      diagnosticMessage = await failWith(body);
      assert.match(diagnosticMessage, /HTTP 404: Voice not found: \[REDACTED\]/);
      assert.match(diagnosticMessage, /响应正文：\n/);
      assert.match(diagnosticMessage, /reference_id missing/);
      assert.match(diagnosticMessage, /fish-request-123/);
      const nested = await failWith(JSON.stringify({ error: { message: 'Nested voice error' }, message: 'General error' }));
      assert.match(nested.split('\n')[0], /HTTP 404: Nested voice error/);
      const malformedNested = await failWith(JSON.stringify({ error: null, message: 'Top-level error' }));
      assert.match(malformedNested.split('\n')[0], /HTTP 404: Top-level error/);
      const plain = await failWith(`Proxy cannot find route; token=${encodeURIComponent(diagnosticKey)}`);
      assert.match(plain, /Proxy cannot find route; token=\[REDACTED\]/);
      const html = await failWith('<html><body>Unknown endpoint</body></html>');
      assert.match(html, /<html><body>Unknown endpoint<\/body><\/html>/);
      const empty = await failWith('', diagnosticKey);
      assert.match(empty, /HTTP 404: \[REDACTED\]$/);
      for (const value of ['null', '[]', '42', '{malformed'])
        assert.ok((await failWith(value)).includes(`响应正文：\n${value}`));
    }
  } finally { globalThis.fetch = beforeFishErrors; }

  // 支持的控制标记留在提供方输入，canonical 转写只包含正文。
  const textCases = [
    ['minimaxT2aV2', 'speech-2.8-hd', '嗯，(laughs)<#0.5#>我在听。', '嗯， 我在听。'],
    ['minimaxT2aV2', 'speech-2.6-turbo', 'Hello<#0.25#>world.', 'Hello world.'],
    ['minimaxT2aV2', 'speech-02-hd', '先说一句。<#99.99#>再说一句。', '先说一句。 再说一句。'],
    ['elevenlabs', 'eleven_v4', '[whispers] 嗯，我在。[short pause] 你说吧。[sighs]', '嗯，我在。 你说吧。'],
    ['elevenlabs', 'eleven_v4_turbo', '啊，[laughs] 原来这样。', '啊， 原来这样。'],
    ['elevenlabs', 'eleven_v3', '[curious] 真的吗？[long pause] 再说说。', '真的吗？ 再说说。'],
    ...['eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_turbo_v2_5'].map((model) =>
      ['elevenlabs', model, '嗯，<break time="0.5s" />我想想。', '嗯， 我想想。']),
    ['openai', 'gpt-4o-mini-tts', '嗯……啊，我知道了。', '嗯……啊，我知道了。'],
    ['openrouter', 'mistralai/voxtral-mini-tts-2603', '唔，等一下——好了。', '唔，等一下——好了。'],
    ['openaiCompatible', 'custom-model', '嗯，  我在。', '嗯，  我在。'],
    ['fishAudio', 's2.1-pro', '嗯……我在，你说吧。', '嗯……我在，你说吧。'],
  ];
  for (const [provider, model, text, transcript] of textCases) {
    assert.deepEqual(speechText.prepareSpeechText(text, provider, model), { synthesisText: text, transcript });
    await gateway.synthesizeSpeechAudio({ baseURL: catalog.getSpeechProvider(provider).baseURL || 'https://custom.example/v1', apiKey: 'test-key', model, metadataJson: null }, { provider, voiceId: 'voice' }, text, {});
    assert.equal(requests.at(-1).body.text ?? requests.at(-1).body.input, text);
  }
  // Audio Tags 的内容由 AI 自主选择；只验证语法，不把示例变成词汇白名单。
  const bracketModels = [
    ...['eleven_v3', 'eleven_v4', 'eleven_v4_turbo'].map((model) => ['elevenlabs', model]),
    ...['s2-pro', 's2.1-pro', 's2.1-pro-free', 'drama-3'].map((model) => ['fishAudio', model]),
  ];
  for (const [provider, model] of bracketModels) {
    const guidance = speechText.getSpeechTextGuidance(provider, model);
    assert.ok(guidance.includes('自主决定'));
    assert.ok(guidance.includes('只是示例'));
    assert.ok(!guidance.includes('只使用列出的标记'));
    for (const [open, close] of [['[', ']'], ['［', '］'], ['【', '】']]) {
      const prepared = speechText.prepareSpeechText(`  ${open}  speaking　very softly, with warmth  ${close}嗯……我在，别急！${open}轻声、温柔地说${close}继续吧。  `, provider, model);
      assert.deepEqual(prepared, {
        synthesisText: '[speaking very softly, with warmth]嗯……我在，别急！[轻声、温柔地说]继续吧。',
        transcript: '嗯……我在，别急！ 继续吧。',
      });
      await gateway.synthesizeSpeechAudio({ baseURL: catalog.getSpeechProvider(provider).baseURL, apiKey: 'key', model }, { provider, voiceId: 'voice' }, prepared.synthesisText, {});
      assert.equal(requests.at(-1).body.text, prepared.synthesisText);
      assert.throws(() => speechText.prepareSpeechText(`${open}laughs${close}`, provider, model), /不能只有/);
    }
    assert.equal(speechText.prepareSpeechText('[standing] 你好', provider, model).transcript, '你好');
    assert.equal(speechText.prepareSpeechText(`[${'a'.repeat(100)}]你好`, provider, model).transcript, '你好');
    assert.equal(speechText.prepareSpeechText(`[${'𠮷'.repeat(100)}]你好`, provider, model).transcript, '你好');
    assert.equal(speechText.prepareSpeechText('[soft-spoken, “café”! 很轻……]你好', provider, model).transcript, '你好');
    for (const tag of [
      '[]', '［　］', '【...】', `[${'a'.repeat(101)}]`,
      '[soft [laughs]]', '［soft【laughs】］', '【soft(laughs)】',
      '[soft］', '［soft】', '【soft]', '[soft', '［soft', '【soft', 'soft］', 'soft】',
      '[soft\nvoice]', '[soft\rvoice]', '[soft\tvoice]', '[\tsoft]', '[soft\u0000voice]', '[soft\u200Bvoice]',
      '[<break>]', '[soft/voice]', '[voice=soft]', '[soft🙂]', '[soft\\voice]',
    ]) assert.throws(() => speechText.prepareSpeechText(`${tag}你好`, provider, model), undefined, tag);
    if (provider === 'fishAudio') {
      assert.match(guidance, /\[whispering\]/);
      assert.match(guidance, /\[break\]/);
      assert.match(guidance, /\[long-break\]/);
      assert.deepEqual(speechText.prepareSpeechText('(happy)你好', provider, model), { synthesisText: '你好', transcript: '你好' });
      assert.deepEqual(speechText.prepareSpeechText('<whisper>你好</whisper>', provider, model), { synthesisText: '你好', transcript: '你好' });
    }
  }
  for (const [provider, model] of [
    ['elevenlabs', 'eleven_multilingual_v2'], ['elevenlabs', 'eleven_flash_v2_5'], ['elevenlabs', 'eleven_turbo_v2_5'],
    ['elevenlabs', 'future-model'], ['minimaxT2aV2', 'speech-2.8-hd'], ['openai', 'tts-1'], ['openaiCompatible', 'custom-model'],
    ['fishAudio', 's1'], ['fishAudio', 'future-model'], ['openaiCompatible', 'fish-audio/s2.1-pro-free'],
  ]) {
    for (const tag of ['[whispers]', '［whispers］', '【轻声】'])
      assert.deepEqual(speechText.prepareSpeechText(`${tag}你好`, provider, model), { synthesisText: '你好', transcript: '你好' });
    const text = '嗯……啊，唔！别急——我在。  Really? 好的；继续：听着、慢慢说。';
    assert.deepEqual(speechText.prepareSpeechText(text, provider, model), { synthesisText: text, transcript: text });
  }
  // 跨厂商或未知模型的完整标记只移除控制本身，正文仍进入真实合成请求。
  for (const [provider, model, text, plainText] of [
    ['minimaxT2aV2', 'speech-2.6-hd', '(laughs) 你好', '你好'],
    ['elevenlabs', 'eleven_v4', '你好<break time="0.5s" />呀', '你好 呀'],
    ['openrouter', 'mistralai/voxtral-mini-tts-2603', '你好<#0.5#>呀', '你好 呀'],
    ['openai', 'tts-1', '【轻声】你好，(laughs)我在。<break time="0.5s" />继续吧。', '你好， 我在。 继续吧。'],
    ['openaiCompatible', 'custom-model', '<speak><prosody rate="slow">Hello</prosody> [warmly]world!</speak>', 'Hello world!'],
    ['fishAudio', 's1', '［whispering］嗯，我在。(happy)你说吧。', '嗯，我在。 你说吧。'],
  ]) {
    const prepared = speechText.prepareSpeechText(text, provider, model);
    assert.deepEqual(prepared, { synthesisText: plainText, transcript: plainText });
    await gateway.synthesizeSpeechAudio({ baseURL: catalog.getSpeechProvider(provider).baseURL || 'https://custom.example/v1', apiKey: 'key', model }, { provider, voiceId: 'voice' }, prepared.synthesisText, {});
    assert.equal(requests.at(-1).body.text ?? requests.at(-1).body.input, plainText);
  }
  assert.deepEqual(speechText.prepareSpeechText('[whispers]你好(laughs)，我在。', 'elevenlabs', 'eleven_v4'), {
    synthesisText: '[whispers]你好，我在。', transcript: '你好，我在。',
  });
  assert.deepEqual(speechText.prepareSpeechText('[happy]你好(laughs)<#0.5#>呀', 'minimaxT2aV2', 'speech-2.8-hd'), {
    synthesisText: '你好(laughs)<#0.5#>呀', transcript: '你好 呀',
  });
  for (const [provider, model, text] of [
    ['minimaxT2aV2', 'speech-2.8-hd', '你好<#0#>呀'],
    ['minimaxT2aV2', 'speech-2.8-hd', '你好<#100#>呀'],
    ['minimaxT2aV2', 'speech-2.8-hd', '你好<#0.001#>呀'],
    ['minimaxT2aV2', 'speech-2.8-hd', '<#0.5#>你好'],
    ['minimaxT2aV2', 'speech-2.8-hd', '你好<#0.5#>'],
    ['minimaxT2aV2', 'speech-2.8-hd', '你好<#0.5#>(sighs)<#0.5#>呀'],
    ['elevenlabs', 'eleven_flash_v2_5', '你好<break time="3.1s" />呀'],
    ['minimaxT2aV2', 'speech-2.8-hd', '[happy]<#0.5#>你好'],
    ['minimaxT2aV2', 'speech-2.8-hd', '你好<#0.5#>[happy]'],
    ['openaiCompatible', 'custom-model', '[laughs]'],
    ['openai', 'tts-1', '<whisper></whisper>'],
    ['fishAudio', 's1', '(happy)'],
    ['openai', 'tts-1', '你好[whispers'],
    ['openai', 'tts-1', '(happy）你好'],
    ['openai', 'tts-1', '(soft[laughs])你好'],
    ['elevenlabs', 'eleven_v4', '[laughs]'],
    ['elevenlabs', 'eleven_v4', '你好[short pause'],
    ['minimaxT2aV2', 'speech-2.8-hd', '你好<#0.5'],
  ]) assert.throws(() => speechText.prepareSpeechText(text, provider, model));
  const elevenSpeed = catalog.getSpeechParameters('elevenlabs', 'eleven_multilingual_v2').find((field) => field.key === 'speed');
  assert.deepEqual([elevenSpeed.min, elevenSpeed.max], [0.7, 1.2]);

  // 切换提供方不继承旧密钥或参数；连接字段作为一个整体提交，名称独立保存。
  const initial = draftModule.getSpeechModelDraft('tts', { name: '原配置', enabled: true, baseUrl: 'https://custom.example/v1', apiKey: 'old', model: 'speech-2.8-hd', metadataJson: JSON.stringify({ provider: 'minimaxT2aV2', voiceId: 'old-voice' }) });
  const edited = { ...initial, speed: '0.8' };
  assert.equal(draftModule.buildSpeechDraftConfiguration(edited).baseURL, 'https://custom.example/v1');
  const changed = { ...edited, ...draftModule.switchSpeechProvider('elevenlabs') };
  assert.equal(changed.apiKey, '');
  const invalid = draftModule.parseSpeechModelDraft('tts', { ...changed, name: '新名称' }, ['provider', 'name']);
  assert.deepEqual(invalid.patch, { name: '新名称' });
  assert.ok(invalid.errors.voiceId);
  const pendingKey = draftModule.parseSpeechModelDraft('tts', { ...changed, apiKey: 'new-provider-key' }, ['provider', 'model', 'voiceId', 'apiKey']);
  assert.equal(pendingKey.patch.apiKey, undefined, '新提供方配置未完成时，不能把新密钥保存到旧连接');
  assert.equal(pendingKey.accepted.includes('apiKey'), false);
  changed.voiceId = 'new-voice';
  const parsed = draftModule.parseSpeechModelDraft('tts', changed, ['provider', 'model', 'voiceId', 'apiKey']);
  const saved = JSON.parse(parsed.patch.metadataJson);
  assert.equal(saved.provider, 'elevenlabs');
  assert.equal(saved.speed, undefined);
  assert.equal(parsed.patch.baseUrl, 'https://api.elevenlabs.io/v1');
  assert.equal(parsed.patch.apiKey, null);
  const completeSwitch = draftModule.parseSpeechModelDraft('tts', { ...changed, apiKey: 'new-provider-key' }, ['provider', 'model', 'voiceId', 'apiKey']);
  assert.equal(completeSwitch.patch.apiKey, 'new-provider-key');
  assert.equal(JSON.parse(completeSwitch.patch.metadataJson).provider, 'elevenlabs');
  assert.ok(draftModule.parseSpeechModelDraft('tts', { ...edited, speed: '错误' }, ['speed']).errors.speed);
  const fishDraft = { ...initial, ...draftModule.switchSpeechProvider('fishAudio'), apiKey: 'fish-key', voiceId: 'fish-voice', temperature: '0', topP: '0', normalize: false };
  const fishParsed = draftModule.parseSpeechModelDraft('tts', fishDraft, Object.keys(fishDraft));
  assert.deepEqual(fishParsed.errors, {});
  assert.equal(fishParsed.patch.baseUrl, 'https://api.fish.audio/v1');
  assert.equal(fishParsed.patch.apiKey, 'fish-key');
  assert.deepEqual(JSON.parse(fishParsed.patch.metadataJson), { provider: 'fishAudio', voiceId: 'fish-voice', audioFormat: 'mp3', temperature: 0, topP: 0, normalize: false });
  const fishReopened = draftModule.getSpeechModelDraft('tts', { ...fishParsed.patch, name: 'Fish', enabled: true });
  assert.equal(fishReopened.voiceId, 'fish-voice');
  assert.equal(fishReopened.temperature, '0');
  assert.equal(fishReopened.normalize, false);
  assert.deepEqual(draftModule.parseSpeechModelDraft('tts', fishReopened, Object.keys(fishReopened)).errors, {});
  for (const [key, value] of [['voiceId', ''], ['model', 'typo-model'], ['speed', '2.1'], ['temperature', '-0.1'], ['topP', '1.1'], ['audioFormat', 'pcm'], ['latency', 'unknown']])
    assert.ok(draftModule.parseSpeechModelDraft('tts', { ...fishDraft, [key]: value }, [key]).errors[key], `Fish ${key} 应在配置边界报错`);
  const damaged = draftModule.getSpeechModelDraft('tts', { name: '损坏配置', enabled: true, baseUrl: 'x', apiKey: '', model: '', metadataJson: '{broken' });
  assert.ok(draftModule.parseSpeechModelDraft('tts', damaged, ['provider']).errors.provider);
  const modelsById = new Map([
    ['eleven', { id: 'eleven', capabilityKind: 'tts', enabled: true, name: 'Eleven', baseUrl: 'https://api.elevenlabs.io/v1', apiKey: 'key', model: 'eleven_v4', metadataJson: '{"provider":"elevenlabs","voiceId":"voice"}' }],
    ['fish', { id: 'fish', capabilityKind: 'tts', ...fishParsed.patch }],
    ['ali', { id: 'ali', capabilityKind: 'stt', enabled: true, name: '阿里', baseUrl: 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference', apiKey: 'key', model: 'fun-asr-realtime', metadataJson: '{"provider":"dashscopeRealtimeAsr","workspaceId":"workspace","region":"beijing"}' }],
    ['invalid', { id: 'invalid', capabilityKind: 'stt', enabled: true, name: '错误', baseUrl: 'https://example/v1', apiKey: 'key', model: 'file-stt', metadataJson: '{"provider":"openaiCompatible"}' }],
  ]);
  const repository = { getModelConfigById: async (id) => modelsById.get(id), listModelConfigs: async () => [...modelsById.values()] };
  const availability = load('src/features/assistants/AuxiliaryModelAvailability.ts', {
    '@features/speech': catalog, '@features/integrations': load('src/features/integrations/domain/TranslationModel.ts'),
  });
  const assets = load('src/features/assistants/ResolveAuxiliaryModel.ts', {
    './infrastructure/SQLiteAuxiliaryModelRepository': { auxiliaryModelRepository: repository }, './AuxiliaryModelAvailability': availability,
  });
  assert.equal((await assets.resolveAuxiliaryModel({ modelConfigId: 'ali', capabilityKind: 'stt' })).modelConfigId, 'ali');
  assert.equal((await assets.resolveAuxiliaryModel({ modelConfigId: 'eleven', capabilityKind: 'tts' })).modelConfigId, 'eleven');
  assert.equal((await assets.resolveAuxiliaryModel({ modelConfigId: 'fish', capabilityKind: 'tts' })).modelConfigId, 'fish');
  assert.equal(await assets.resolveAuxiliaryModel({ modelConfigId: 'fish', capabilityKind: 'stt' }), null);
  assert.equal(await assets.resolveAuxiliaryModel({ modelConfigId: 'invalid', capabilityKind: 'stt' }), null);
  modelsById.get('eleven').apiKey = null;
  assert.equal((await assets.getAuxiliaryModelSelection({ modelConfigId: 'eleven', capabilityKind: 'tts' })).status, 'unavailable');

  // 官方目录使用各自的鉴权及分页，不把实时 STT 指向文件转写接口。
  const discovery = load(`${speechRoot}infrastructure/SpeechProviderOptions.ts`, { '../application/SpeechProviderCatalog': catalog });
  const directoryCalls = [];
  globalThis.fetch = async (url, options) => {
    directoryCalls.push({ url, options });
    const data = url.includes('openrouter') ? { data: [{ id: 'openai/gpt-4o-mini-tts-2025-12-15', name: 'OpenAI TTS' }] }
      : url.endsWith('/models') ? [{ model_id: 'eleven_v4', name: 'Eleven v4', supports_text_to_speech: true }, { model_id: 'sts', name: 'STS', supports_text_to_speech: false }]
        : url.includes('next_page_token') ? { voices: [{ voice_id: 'b', name: '第二音色' }], has_more: false }
          : { voices: [{ voice_id: 'a', name: '第一音色' }], has_more: true, next_page_token: 'page 2' };
    return { ok: true, json: async () => data };
  };
  const directoryConfig = { baseURL: 'https://api.elevenlabs.io/v1', apiKey: 'key', model: 'eleven_v4', metadataJson: '{"provider":"elevenlabs"}' };
  const directory = await discovery.listSpeechProviderOptions(directoryConfig);
  assert.deepEqual(directory.voices.map((voice) => voice.value), ['a', 'b']);
  assert.equal(directory.models.length, 1);
  assert.ok(directoryCalls.some(({ url }) => url.includes('/v2/voices?page_size=100&next_page_token=page%202')));
  assert.equal(directoryCalls[0].options.headers['xi-api-key'], 'key');
  await discovery.listSpeechProviderOptions({ ...directoryConfig, baseURL: 'https://openrouter.ai/api/v1', metadataJson: '{"provider":"openrouter"}' });
  assert.ok(directoryCalls.at(-1).url.endsWith('/models?output_modalities=speech'));
  assert.equal(directoryCalls.at(-1).options.headers.Authorization, 'Bearer key');
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });

  // 模型输出在 Runtime 按 schema 验证；工具持有能力与执行模型的同一个快照。
  let selectedVoice = { ...directoryConfig, modelConfigId: 'first', modelConfigName: '第一配置' };
  const synthesized = [];
  const voiceTool = load('src/features/chat/reply/agent/SendVoiceMessageTool.ts', {
    '@shared/aiTools': load('src/shared/aiTools/ToolCompletionIntent.ts'),
    '@features/speech': { ...catalog, ...speechText, resolveTextToSpeechModel: async () => selectedVoice, synthesizeTextToSpeech: async (params) => { synthesized.push(params); return { success: true, audioUri: 'temp://tool', mimeType: 'audio/mpeg' }; } },
    '@features/media': { MEDIA_ASSET_STORAGE_BACKEND: { persistentMedia: 'persistent' }, prepareMediaAssetBatch: async () => ({ ready: true }) },
    '@platform/device': { readLocalAudioMetadata: async () => ({ durationMs: 1000 }), temporarySpeechAudioStore: { deleteIfExists: async () => {} } },
    '@shared/runtime/abortSignal': { throwIfAbortSignalAborted: (signal) => { if (signal.aborted) throw new Error('已取消'); } },
  });
  const configuredTool = await voiceTool.createConfiguredVoiceMessageTool('assistant');
  assert.ok(configuredTool.definition.parameters.properties.audioTag.enum.includes('whispers'));
  assert.equal(configuredTool.definition.parameters.properties.speed, undefined);
  selectedVoice = { ...directoryConfig, model: 'eleven_multilingual_v2', modelConfigId: 'second' };
  const sent = await configuredTool.execute({ text: '你好', audioTag: 'whispers' }, { task: { assistantId: 'assistant' }, abortSignal: new AbortController().signal, toolCallId: 'test' });
  assert.equal(synthesized[0].modelSnapshot.modelConfigId, 'first');
  assert.equal(synthesized[0].delivery.audioTag, 'whispers');
  assert.equal(sent.data.transcript, '你好');
  const expressive = await configuredTool.execute({ text: '[whispers] 嗯，我在。[short pause] 你说吧。' }, { task: { assistantId: 'assistant' }, abortSignal: new AbortController().signal, toolCallId: 'expression' });
  assert.equal(expressive.data.transcript, '嗯，我在。 你说吧。');
  assert.equal(synthesized.at(-1).text, '[whispers] 嗯，我在。[short pause] 你说吧。');
  const normalizedVoice = await configuredTool.execute({ text: '【speaking softly】嗯，我在。［short pause］你说吧。' }, { task: { assistantId: 'assistant' }, abortSignal: new AbortController().signal, toolCallId: 'normalized-expression' });
  assert.equal(normalizedVoice.data.transcript, '嗯，我在。 你说吧。');
  assert.equal(synthesized.at(-1).text, '[speaking softly]嗯，我在。[short pause]你说吧。');
  const unsupportedTagVoice = await configuredTool.execute({ text: '你好<break time="0.5s" />呀' }, { task: { assistantId: 'assistant' }, abortSignal: new AbortController().signal, toolCallId: 'unsupported-tag' });
  assert.equal(unsupportedTagVoice.status, 'success');
  assert.equal(unsupportedTagVoice.data.transcript, '你好 呀');
  assert.equal(synthesized.at(-1).text, '你好 呀');
  const synthesisCount = synthesized.length;
  const invalidText = await configuredTool.execute({ text: '你好[whispers' }, { task: { assistantId: 'assistant' }, abortSignal: new AbortController().signal, toolCallId: 'invalid' });
  assert.equal(invalidText.code, 'VOICE_TEXT_INVALID');
  assert.equal(synthesized.length, synthesisCount);
  const tagOnlyVoice = await configuredTool.execute({ text: '【laughs】' }, { task: { assistantId: 'assistant' }, abortSignal: new AbortController().signal, toolCallId: 'tag-only' });
  assert.equal(tagOnlyVoice.code, 'VOICE_TEXT_INVALID');
  assert.equal(synthesized.length, synthesisCount);

  selectedVoice = { ...directoryConfig, model: 'tts-1', modelConfigId: 'plain-tool', metadataJson: '{"provider":"openai"}' };
  const plainTool = await voiceTool.createConfiguredVoiceMessageTool('assistant');
  const plainVoice = await plainTool.execute({ text: '【轻声】我在。(laughs)你说吧。' }, { task: { assistantId: 'assistant' }, abortSignal: new AbortController().signal, toolCallId: 'plain-voice' });
  assert.equal(plainVoice.status, 'success');
  assert.equal(plainVoice.data.transcript, '我在。 你说吧。');
  assert.equal(synthesized.at(-1).text, '我在。 你说吧。');
  assert.equal(synthesized.at(-1).modelSnapshot.modelConfigId, 'plain-tool');
  const beforeEmptyVoice = synthesized.length;
  const emptyPlainVoice = await plainTool.execute({ text: '[whispers](laughs)' }, { task: { assistantId: 'assistant' }, abortSignal: new AbortController().signal, toolCallId: 'empty-plain-voice' });
  assert.equal(emptyPlainVoice.code, 'VOICE_TEXT_INVALID');
  assert.equal(synthesized.length, beforeEmptyVoice);

  // 默认 Fish 配置向聊天 AI 声明自己的示例，合成保留标签，消息事实只保存可朗读正文。
  selectedVoice = { ...directoryConfig, model: 's2.1-pro-free', modelConfigId: 'fish-tool', metadataJson: '{"provider":"fishAudio","voiceId":"fish-voice"}' };
  const fishTool = await voiceTool.createConfiguredVoiceMessageTool('assistant');
  assert.match(fishTool.definition.parameters.properties.text.description, /\[whispering\]/);
  assert.match(fishTool.definition.parameters.properties.text.description, /\[break\]/);
  assert.equal(fishTool.definition.parameters.properties.speed.minimum, 0.5);
  const fishSent = await fishTool.execute({ text: '[warm and gentle]嗯，我在。[break]你慢慢说。' }, { task: { assistantId: 'assistant' }, abortSignal: new AbortController().signal, toolCallId: 'fish-expression' });
  assert.equal(fishSent.status, 'success');
  assert.equal(fishSent.data.transcript, '嗯，我在。 你慢慢说。');
  assert.equal(synthesized.at(-1).text, '[warm and gentle]嗯，我在。[break]你慢慢说。');
  assert.equal(synthesized.at(-1).modelSnapshot.modelConfigId, 'fish-tool');
  const fishCallBlocks = callPrompts.buildCallLivePromptBlocks(undefined, speechText.getSpeechTextGuidance('fishAudio', 's2.1-pro-free', false));
  assert.ok(fishCallBlocks.some((block) => block.content.includes('[whispering]') && block.content.includes('[break]')));

  // 通话标记可以跨任意 delta；句间停顿和两侧正文必须同次合成，结束标记不进入声音或字幕。
  const plainCallSentences = [];
  const plainCallStream = callStreams.createCallSpeechSentenceStream((sentence) => plainCallSentences.push(sentence), null);
  plainCallStream.push('嗯，🙂我在。你说吧。');
  plainCallStream.flush();
  assert.deepEqual(plainCallSentences, ['嗯，我在。', '你说吧。']);
  for (const text of ['【soft\nvoice】你好。', '［soft🙂］你好。', '【soft［voice］】你好。', '［soft】你好。', '【soft你好。', '【laughs】']) {
    const stream = callStreams.createCallSpeechSentenceStream(assert.fail, { ...directoryConfig, model: 'eleven_v4' });
    assert.throws(() => { for (const chunk of text) stream.push(chunk); stream.flush(); }, undefined, text);
  }
  // 相似或不完整的标记仍交给既有 Speech 语法边界报错，不能被修补成挂断。
  for (const text of ['晚安。[[END_CALL]', '晚安。[[END_CALLS]]', '晚安。[END_CALL]']) {
    const stream = callStreams.createCallSpeechSentenceStream(() => {}, null);
    assert.throws(() => { for (const chunk of text) stream.push(chunk); stream.flush(); });
    assert.equal(stream.shouldEndCall(), false);
  }
  // 不支持标签的通话模型在任意分片下都朗读正文，字幕与合成输入不泄漏控制标签。
  const plainSnapshot = { ...directoryConfig, model: 'tts-1', metadataJson: '{"provider":"openai"}' };
  const unsupportedCallText = '【轻声】我在。<#0.5#><whisper>你说吧。</whisper>晚安。[[END_CALL]]';
  const readPlainCall = (chunks) => {
    const spoken = [];
    const stream = callStreams.createCallSpeechSentenceStream((transcript, speech) => spoken.push({ transcript, text: speech.synthesisText }), plainSnapshot);
    for (const chunk of chunks) stream.push(chunk);
    stream.flush();
    assert.equal(stream.shouldEndCall(), true);
    assert.deepEqual(stream.getSentences(), spoken.map(({ transcript }) => transcript));
    return spoken;
  };
  const plainCallExpected = [{ transcript: '我在。 你说吧。', text: '我在。 你说吧。' }, { transcript: '晚安。', text: '晚安。' }];
  assert.deepEqual(readPlainCall([unsupportedCallText]), plainCallExpected);
  assert.deepEqual(readPlainCall([...unsupportedCallText]), plainCallExpected);
  for (let split = 1; split < unsupportedCallText.length; split++)
    assert.deepEqual(readPlainCall([unsupportedCallText.slice(0, split), unsupportedCallText.slice(split)]), plainCallExpected);
  const formattedCallSentences = [];
  const formattedCallStream = callStreams.createCallSpeechSentenceStream((transcript, speech) => formattedCallSentences.push({ transcript, text: speech.synthesisText }), { ...directoryConfig, model: 'eleven_v4' });
  formattedCallStream.push('【轻声】嗯，🙂我\n在。你说吧。');
  formattedCallStream.flush();
  assert.deepEqual(formattedCallSentences, [{ transcript: '嗯，我在。', text: '[轻声]嗯，我在。' }, { transcript: '你说吧。', text: '你说吧。' }]);
  for (const [provider, model, text] of [
    ['minimaxT2aV2', 'speech-2.8-hd', '[[END_CALL]]嗯，(laughs)我在。<#0.5#>你说吧。晚安。'],
    ['elevenlabs', 'eleven_v4', '[[END_CALL]][whispers]我在。[short pause]你说吧。晚安。'],
    ...['eleven_v3', 'eleven_v4', 'eleven_v4_turbo'].flatMap((model) => [
      ['elevenlabs', model, '[[END_CALL]]［softly, with warmth!］我在。［short pause］你说吧。晚安。'],
      ['elevenlabs', model, '[[END_CALL]]【轻声、温柔地说。】我在。【dramatic pause】你说吧。晚安。'],
    ]),
    ['elevenlabs', 'eleven_multilingual_v2', '[[END_CALL]]我在。<break time="0.5s" />你说吧。晚安。'],
    ...['s2-pro', 's2.1-pro', 's2.1-pro-free', 'drama-3'].flatMap((model) => [
      ['fishAudio', model, '[[END_CALL]][whispering]我在。[break]你说吧。晚安。'],
      ['fishAudio', model, '[[END_CALL]]【warm and gentle】我在。［long-break］你说吧。晚安。'],
    ]),
  ]) {
    const snapshot = { ...directoryConfig, model, metadataJson: JSON.stringify({ provider, voiceId: 'voice' }), modelConfigId: 'call-voice', modelConfigName: '通话声音' };
    const runStream = (chunks) => {
      const sentences = [];
      const stream = callStreams.createCallSpeechSentenceStream((transcript, speech) => sentences.push({ transcript, speech }), snapshot);
      for (const chunk of chunks) stream.push(chunk);
      stream.flush();
      assert.equal(stream.shouldEndCall(), true);
      assert.deepEqual(stream.getSentences(), sentences.map((sentence) => sentence.transcript));
      assert.equal(sentences.length, 2);
      assert.ok(sentences[0].speech.synthesisText.includes('你说吧。'));
      assert.equal(sentences[1].transcript, '晚安。');
      for (const sentence of sentences) {
        assert.equal(sentence.speech.modelSnapshot, snapshot);
        assert.doesNotMatch(sentence.transcript, /[<>\[\]()]/);
        assert.ok(!sentence.speech.synthesisText.includes('END_CALL'));
        assert.doesNotMatch(sentence.speech.synthesisText, /[［］【】]/);
      }
      return sentences;
    };
    const expected = runStream([text]);
    const spokenText = text.replace('[[END_CALL]]', '');
    for (const markedText of [text, spokenText + '[[END_CALL]]', spokenText.replace('晚安。', '[[END_CALL]]晚安。')]) {
      assert.deepEqual(runStream([markedText]), expected);
      assert.deepEqual(runStream([...markedText]), expected);
      for (let split = 1; split < markedText.length; split++)
        assert.deepEqual(runStream([markedText.slice(0, split), markedText.slice(split)]), expected);
    }
  }

  // 实际回复 owner 固定模型，并把干净正文提交；切换选择不会改变已经产出的 TTS 输入。
  const callEvents = [];
  const callAudio = [];
  const replySnapshot = { ...directoryConfig, modelConfigId: 'call-first', modelConfigName: '通话快照' };
  let currentCallVoice = replySnapshot;
  let observedBlocks;
  let observedCallConfig;
  const callModelRequests = [];
  const runtimeBoundaries = { ...agentToolSchemaDependencies };
  const runtimeCache = new Map();
  function loadRuntime(file) {
    if (runtimeCache.has(file)) return runtimeCache.get(file);
    const module = { exports: {} };
    runtimeCache.set(file, module.exports);
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function('require', 'module', 'exports', output)((name) => {
      if (Object.hasOwn(runtimeBoundaries, name)) return runtimeBoundaries[name];
      const base = path.resolve(path.dirname(file), name);
      for (const suffix of ['.ts', '/index.ts']) {
        if (name.startsWith('.') && fs.existsSync(base + suffix)) return loadRuntime(base + suffix);
      }
      assert.fail(`未装配的 Agent 边界：${name}`);
    }, module, module.exports);
    return module.exports;
  }
  runtimeBoundaries['@platform/ai'] = loadRuntime('src/platform/ai/agent/AgentModelGateway.ts');
  runtimeBoundaries['@shared/aiTools'] = { ...loadRuntime('src/shared/aiTools/AgentToolInputSchema.ts') };
  runtimeBoundaries['@shared/runtime/abortSignal'] = loadRuntime('src/shared/runtime/abortSignal.ts');
  runtimeBoundaries['@shared/diagnostics/TurnTimelineLog'] = { logTurnTimeline() {} };
  const agentRuntime = loadRuntime('src/platform/agentRuntime/index.ts');
  const registry = new agentRuntime.AgentToolRegistry();
  registry.register({ descriptor: { name: 'lookAtUser', description: '观察', owner: 'calls', source: 'local',
    risk: 'safe_read', idempotency: 'idempotent', inputSchema: { type: 'object' } },
    execute: async () => ({ status: 'success', modelContent: '未提供画面' }) });
  const callHistory = [{ role: 'assistant', content: '之前的回复', reasoning_content: '  已有思考\r\n' }];
  const replyToCall = async (method, options, tools = []) => {
    callModelRequests.push({ method, tools });
    currentCallVoice = { ...replySnapshot, model: 'eleven_multilingual_v2' };
    for (const chunk of ['【speaking ', 'softly】 我在。', '［short ', 'pause］ 你说吧。']) options.onDelta({ type: 'answer_delta', text: chunk });
    return { success: true, text: '【speaking softly】 我在。［short pause］ 你说吧。' };
  };
  const callState = { id: 'call', chatSessionId: 'chat', state: 'active' };
  const callReply = load('src/features/calls/application/runtime/ProcessCallAIReply.ts', {
    '@platform/agentRuntime': agentRuntime,
    '@features/speech': { ...catalog, ...speechText, resolveTextToSpeechModel: async () => currentCallVoice },
    '@platform/ai': { ...ai, createAIClient: () => ({
      chatStreamWithTools: async (_messages, tools, options) => replyToCall('tools', options, tools),
      chatStream: async (_messages, options) => replyToCall('plain', options),
    }) },
    '@shared/aiTools': { ToolContext: class {} },
    '@shared/prompt': { DEFAULT_PRIVATE_CONTEXT_PRIMARY_LIMIT: 40 },
    '../snapshots/CallSnapshotLifetime': {},
    '../../aiTools/LookAtUserTool': { LookAtUserTool: { name: 'lookAtUser', definition: {},
      execute: async () => ({ success: true, data: { status: 'unavailable' } }) } },
    '../events/AppendCallSystemEvent': { appendCallErrorEvent: assert.fail },
    '../events/AppendCallTranscriptEvent': {
      appendUserSpeechText: async ({ text }) => ({ id: 'user', text }),
      appendAISpeechText: async (event) => { callEvents.push(event); return { id: 'ai', ...event }; },
    },
    './CallRuntimeDependencies': { getCallRuntimeDependencies: () => ({
      agent: {
        prepareTools: async config => ({ allowedToolNames: config.enableTools ? ['lookAtUser'] : [],
          toolsDescription: '', mcpServices: [], additionalPromptBlocks: [] }),
        run: request => new agentRuntime.AgentRuntime({ registry, modelGateway: request.modelGateway }).run(request),
      },
      repositories: { calls: { getSessionById: async () => callState } }, assembleChatPromptPack: async (params) => {
      observedBlocks = params.additionalBlocks; observedCallConfig = params.aiConfig;
      return { systemPrompt: '', modelMessages: callHistory };
    } }) },
    './CallReplyRunState': { isCallReplyCancellationError: () => false },
    './CallSpeechSentenceStream': callStreams,
    '../CallPromptBlocks': callPrompts,
  });
  const callResult = await callReply.processCallAIReply({ callId: 'call', userText: '在吗', aiConfig: { id: 'assistant', enableTools: true }, signal: new AbortController().signal, onSpeechSentence: (transcript, speech) => callAudio.push({ transcript, speech }) });
  assert.equal(callResult.status, 'completed');
  assert.equal(callEvents[0].text, '我在。 你说吧。');
  assert.equal(callAudio[0].speech.synthesisText, '[speaking softly] 我在。[short pause] 你说吧。');
  assert.equal(callAudio[0].speech.modelSnapshot, replySnapshot);
  assert.ok(observedBlocks.find((block) => block.definitionId === 'output.call_plain_spoken_text').content.includes('[short pause]'));
  assert.equal(callModelRequests.at(-1).method, 'tools');
  assert.equal(callModelRequests.at(-1).tools.length, 1);
  currentCallVoice = replySnapshot;
  const disabledCallResult = await callReply.processCallAIReply({ callId: 'call', userText: '继续聊',
    aiConfig: { id: 'assistant', enableTools: false }, signal: new AbortController().signal });
  assert.equal(disabledCallResult.status, 'completed', '关闭工具不影响普通通话和语音合成');
  assert.equal(observedCallConfig.enableTools, false, '通话不覆盖角色工具总开关');
  assert.deepEqual(callModelRequests.at(-1), { method: 'plain', tools: [] }, '关闭后请求不携带工具');
  assert.doesNotMatch(observedBlocks.map((block) => block.content).join('\n'), /lookAtUser/,
    '通话事实不介绍工具；调用指导只随已授权 schema 暴露');

  // 真实 WS 协议只在官方 ready 后返回；中间结果与最终完成屏障保持独立。
  const sockets = [];
  class FakeSocket {
    constructor(url, protocols, options) { this.url = url; this.options = options; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(value); }
    close() { this.onclose?.(); }
    message(event, sentence) { this.onmessage?.({ data: JSON.stringify({ header: { task_id: 'task-id', event }, payload: { output: { sentence } } }) }); }
  }
  globalThis.WebSocket = FakeSocket;
  const device = { createRandomUUID: () => 'task-id' };
  const dashscope = load(`${speechRoot}infrastructure/DashScopeRealtimeASRClient.ts`, { '@platform/device': device });
  const tencent = load(`${speechRoot}infrastructure/TencentRealtimeASRClient.ts`);
  const signer = load(`${speechRoot}infrastructure/tencentRealtimeASRSignature.ts`);
  const resolver = load(`${speechRoot}application/ResolveSpeechModel.ts`);
  const recognitionSocket = load(`${speechRoot}infrastructure/RealtimeRecognitionSocket.ts`);
  const volcengine = load(`${speechRoot}infrastructure/VolcengineRealtimeASRClient.ts`, { '@platform/device': device, './RealtimeRecognitionSocket': recognitionSocket });
  const stepfun = load(`${speechRoot}infrastructure/StepfunRealtimeASRClient.ts`, { '@platform/device': device, './RealtimeRecognitionSocket': recognitionSocket, './speechAudioEncoding': encoding });
  const realtime = load(`${speechRoot}StartRealtimeSpeechToText.ts`, { '@platform/ai': ai, '@platform/device': device, './application/SpeechRecognitionErrors': recognitionErrors, './application/SpeechProviderCatalog': catalog, './application/ResolveSpeechModel': resolver, './infrastructure/DashScopeRealtimeASRClient': dashscope, './infrastructure/TencentRealtimeASRClient': tencent, './infrastructure/tencentRealtimeASRSignature': signer, './infrastructure/VolcengineRealtimeASRClient': volcengine, './infrastructure/StepfunRealtimeASRClient': stepfun });
  const configuration = { baseURL: 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference', apiKey: 'key', model: 'paraformer-realtime-v2', metadataJson: JSON.stringify({ provider: 'dashscopeRealtimeAsr', workspaceId: 'workspace', region: 'beijing' }) };
  let resolutionCount = 0;
  resolver.configureSpeechModelResolver(async () => { resolutionCount++; return { ...configuration, modelConfigId: 'selected', modelConfigName: '阿里' }; });
  const finals = []; let finished = false; let starts = 0;
  const connecting = realtime.startRealtimeSpeechToText({ configuration, onFinalTranscript: (result) => finals.push(result), onFinished: () => { finished = true; }, onSpeechStart: () => { starts++; } });
  const socket = sockets.at(-1);
  socket.onopen();
  assert.equal(JSON.parse(socket.sent[0]).payload.parameters.sample_rate, 16000);
  assert.equal(socket.options.headers.Authorization, 'Bearer key');
  assert.equal(resolutionCount, 0, '测试快照不读取或更改正式模型选择');
  socket.message('task-started');
  const connection = await connecting;
  connection.session.sendAudioChunk(new ArrayBuffer(2));
  socket.message('result-generated', { begin_time: 100, end_time: null, text: '你', sentence_end: false });
  socket.message('result-generated', { begin_time: 100, end_time: 200, text: '你好', sentence_end: true });
  assert.equal(starts, 1); assert.equal(finals[0].index, 100);
  connection.session.finish(); assert.equal(finished, false);
  assert.equal(JSON.parse(socket.sent.at(-1)).header.action, 'finish-task');
  socket.message('task-finished'); assert.equal(finished, true); connection.session.close();

  const voice = load(`${speechRoot}VoiceMessageTranscription.ts`, { '@platform/ai': ai, './application/SpeechRecognitionErrors': recognitionErrors, './StartRealtimeSpeechToText': realtime });
  // 未选择模型时明确提示配置，不建立识别连接。
  resolver.configureSpeechModelResolver(async () => null);
  const socketsBeforeMissingModel = sockets.length;
  for (const consumer of ['call', 'chatVoiceMessage']) {
    const missing = await realtime.startRealtimeSpeechToText({ consumer });
    assert.equal(missing.success, false);
    assert.match(missing.errorInfo.message, /未配置.*STT 模型/);
    assert.equal(missing.errorInfo.message, missing.rawError);
  }
  const missingVoice = await voice.startVoiceMessageTranscription({});
  assert.equal(missingVoice.code, 'VOICE_STT_NOT_CONFIGURED');
  assert.match(missingVoice.errorInfo.message, /辅助模型中心/);
  assert.equal(sockets.length, socketsBeforeMissingModel);

  const unavailableReason = '所选 STT 模型配置不可用，请检查配置或重新选择 STT 模型';
  resolver.configureSpeechModelResolver(async () => { throw new Error(unavailableReason); });
  const unavailable = await voice.startVoiceMessageTranscription({});
  assert.equal(unavailable.code, 'VOICE_STT_CONFIGURATION_INVALID');
  assert.equal(unavailable.errorInfo.message, unavailableReason);
  assert.equal(sockets.length, socketsBeforeMissingModel);

  resolver.configureSpeechModelResolver(async () => ({ ...configuration, modelConfigId: 'selected', modelConfigName: '阿里' }));
  const failedCloud = realtime.startRealtimeSpeechToText({});
  await Promise.resolve(); await Promise.resolve();
  sockets.at(-1).onclose({ code: 1006, reason: 'upstream closed' });
  const cloudFailure = await failedCloud;
  assert.equal(cloudFailure.success, false);
  assert.equal(cloudFailure.errorInfo.message, cloudFailure.rawError, '连接失败原因必须保留');
  assert.match(cloudFailure.errorInfo.message, /提前关闭/);

  const networkReason = '阿里百炼实时语音识别 WebSocket 网络失败：HTTP 429: STT concurrent limit';
  const failedVoiceStart = voice.startVoiceMessageTranscription({});
  await Promise.resolve(); await Promise.resolve();
  sockets.at(-1).onerror({ message: 'HTTP 429: STT concurrent limit' });
  const startFailure = await failedVoiceStart;
  assert.equal(startFailure.code, 'VOICE_STT_NETWORK_FAILED');
  assert.equal(startFailure.errorInfo.message, networkReason);

  const sessionErrors = [];
  const openingFailedSession = realtime.startRealtimeSpeechToText({ onError: (error) => sessionErrors.push(error.message) });
  await Promise.resolve(); await Promise.resolve();
  const failedSessionSocket = sockets.at(-1);
  failedSessionSocket.onopen(); failedSessionSocket.message('task-started');
  const failedSession = await openingFailedSession;
  failedSessionSocket.onerror({ message: 'HTTP 429: STT concurrent limit' });
  assert.deepEqual(sessionErrors, [networkReason], '会话错误不能被通用模型文案替换');
  failedSession.session.close();

  const openingFailedVoice = voice.startVoiceMessageTranscription({});
  await Promise.resolve(); await Promise.resolve();
  const failedVoiceSocket = sockets.at(-1);
  failedVoiceSocket.onopen(); failedVoiceSocket.message('task-started');
  const failedVoice = await openingFailedVoice;
  const finishingFailedVoice = failedVoice.finish();
  failedVoiceSocket.onerror({ message: 'HTTP 429: STT concurrent limit' });
  assert.equal((await finishingFailedVoice).errorInfo.message, networkReason, '结束录音后的失败结果仍保留具体原因');

  const openingVoice = voice.startVoiceMessageTranscription({});
  await Promise.resolve(); await Promise.resolve();
  const voiceSocket = sockets.at(-1); voiceSocket.onopen(); voiceSocket.message('task-started');
  const voiceSession = await openingVoice;
  voiceSocket.message('result-generated', { begin_time: 300, end_time: 400, text: '世界', sentence_end: true });
  const ending = voiceSession.finish();
  voiceSocket.message('result-generated', { begin_time: 100, end_time: 200, text: '你好', sentence_end: true });
  voiceSocket.message('task-finished'); assert.deepEqual(await ending, { success: true, text: '你好世界' });
  const interrupted = dashscope.connectDashScopeRealtimeASR(configuration, { provider: 'dashscopeRealtimeAsr' }, {});
  sockets.at(-1).onclose({ code: 1006, reason: 'upstream closed' }); await assert.rejects(interrupted, /提前关闭/);
  const failedTencent = new tencent.TencentRealtimeASRClient({ signedUrl: 'wss://test' }).connect();
  sockets.at(-1).onclose({ code: 1006, reason: 'upstream closed' }); await assert.rejects(failedTencent, /closed before final/);
  const badTencent = new tencent.TencentRealtimeASRClient({ signedUrl: 'wss://test' }).connect();
  sockets.at(-1).onmessage({ data: 'not json' }); await assert.rejects(badTencent);

  const tencentRefused = new tencent.TencentRealtimeASRClient({ signedUrl: 'wss://test' }).connect();
  sockets.at(-1).onmessage({ data: JSON.stringify({ code: 4001, message: '账户服务额度不足' }) });
  await assert.rejects(tencentRefused, /code=4001.*账户服务额度不足/);

  // 新提供方仍由同一配置草稿校验、保存与解析，官方地址无需用户输入。
  const newConfigurations = new Map();
  for (const provider of ['volcengineRealtimeAsr', 'stepfunRealtimeAsr']) {
    const draft = { ...draftModule.getSpeechModelDraft('stt', null), ...draftModule.switchSpeechProvider(provider), apiKey: 'speech-key' };
    const snapshot = draftModule.buildSpeechDraftConfiguration(draft);
    assert.deepEqual(catalog.validateSpeechConfiguration('stt', snapshot), {});
    assert.equal(snapshot.baseURL, catalog.getSpeechProvider(provider).baseURL);
    assert.equal(draftModule.getSpeechModelDraft('stt', { ...draft, baseUrl: snapshot.baseURL, metadataJson: snapshot.metadataJson }).preserveEndpoint, false);
    assert.equal(catalog.validateSpeechConfiguration('tts', snapshot).provider, '语音提供方不支持此能力');
    newConfigurations.set(provider, snapshot);
  }
  const stepConfig = newConfigurations.get('stepfunRealtimeAsr');
  const volcConfig = newConfigurations.get('volcengineRealtimeAsr');
  const stepEvent = (socket, type, fields = {}) => socket.onmessage({ data: JSON.stringify({ type, ...fields }) });
  const volcResponse = (socket, payload, { last = false, errorCode } = {}) => {
    const body = new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
    const frame = new Uint8Array(12 + body.byteLength);
    frame.set([0x11, errorCode ? 0xf0 : last ? 0x93 : 0x91, 0x10, 0]);
    const view = new DataView(frame.buffer);
    view.setInt32(4, errorCode ?? (last ? -3 : 1));
    view.setUint32(8, body.byteLength);
    frame.set(body, 12);
    socket.onmessage({ data: frame.buffer });
  };
  const volcFinals = []; const volcInterims = []; const volcStarts = []; let volcFinished = false;
  let volcReady = false;
  const openingVolc = realtime.startRealtimeSpeechToText({ configuration: volcConfig,
    onSpeechStart: result => volcStarts.push(result), onInterimTranscript: result => volcInterims.push(result),
    onFinalTranscript: result => volcFinals.push(result), onFinished: () => { volcFinished = true; } });
  void openingVolc.then(() => { volcReady = true; });
  const volcSocket = sockets.at(-1);
  volcSocket.onopen();
  await Promise.resolve();
  assert.equal(volcReady, false, 'WebSocket open 不等于服务端初始化成功');
  assert.deepEqual(volcSocket.options.headers, { 'X-Api-Key': 'speech-key', 'X-Api-Resource-Id': 'volc.seedasr.sauc.duration', 'X-Api-Request-Id': 'task-id' });
  const initialVolcFrame = new DataView(volcSocket.sent[0]);
  const initialVolcRequest = JSON.parse(new TextDecoder().decode(new Uint8Array(volcSocket.sent[0], 12)));
  assert.equal(initialVolcFrame.getUint8(0), 0x11);
  assert.equal(initialVolcFrame.getUint8(1), 0x11);
  assert.equal(initialVolcFrame.getUint8(2), 0x10, '协商无压缩 JSON');
  assert.equal(initialVolcFrame.getInt32(4), 1);
  assert.equal(initialVolcFrame.getUint32(8), volcSocket.sent[0].byteLength - 12);
  assert.deepEqual(initialVolcRequest.audio, { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 });
  assert.equal(initialVolcRequest.request.result_type, 'single');
  assert.equal(initialVolcRequest.request.show_utterances, true);
  volcResponse(volcSocket, {});
  const volcSession = (await openingVolc).session;
  const pcm = new Uint8Array([1, 2, 3, 4]);
  volcSession.sendAudioChunk(pcm.buffer);
  assert.equal(new DataView(volcSocket.sent.at(-1)).getInt32(4), 2);
  assert.deepEqual(new Uint8Array(volcSocket.sent.at(-1), 12), pcm);
  const utterance = (text, start_time, end_time, definite) => ({ text, start_time, end_time, definite });
  const firstVolcFinal = utterance('你好', 100, 400, true);
  volcResponse(volcSocket, { result: { utterances: [utterance('你', 100, 200, false)] } });
  volcResponse(volcSocket, { result: { utterances: [firstVolcFinal] } });
  volcResponse(volcSocket, { result: { utterances: [firstVolcFinal, utterance('世', 500, 600, false)] } });
  assert.equal(volcFinals.length, 1, '累计响应不重复提交已定稿语音');
  assert.equal(volcInterims.length, 2);
  assert.equal(volcStarts.length, 2);
  volcSession.finish(); volcSession.finish();
  assert.equal(new DataView(volcSocket.sent.at(-1)).getInt32(4), -3);
  assert.equal(new DataView(volcSocket.sent.at(-1)).getUint8(1), 0x23);
  assert.equal(volcFinished, false, '发出结束负包仍需等待尾部结果');
  volcResponse(volcSocket, { result: { utterances: [firstVolcFinal, utterance('世界', 500, 800, true)] } }, { last: true });
  assert.deepEqual(volcFinals.map(result => result.text), ['你好', '世界']);
  assert.equal(volcFinals[1].startTime, 500);
  assert.equal(volcFinals[1].endTime, 800);
  assert.equal(volcFinished, true);
  volcResponse(volcSocket, { result: { utterances: [utterance('迟到', 900, 1000, true)] } });
  assert.equal(volcFinals.length, 2, '结束后不再交付迟到结果');
  const invalidVolcStart = realtime.startRealtimeSpeechToText({ configuration: volcConfig });
  const invalidVolcSocket = sockets.at(-1); invalidVolcSocket.onopen();
  volcResponse(invalidVolcSocket, { result: { utterances: [utterance('无效', 200, 100, true)] } });
  assert.equal((await invalidVolcStart).success, false, '首包业务格式错误应作为启动失败返回');

  const stepInterims = []; const stepFinals = []; let stepFinished = false; let stepReady = false;
  const openingStep = realtime.startRealtimeSpeechToText({ configuration: stepConfig,
    onInterimTranscript: result => stepInterims.push(result), onFinalTranscript: result => stepFinals.push(result),
    onFinished: () => { stepFinished = true; } });
  void openingStep.then(() => { stepReady = true; });
  const stepSocket = sockets.at(-1);
  stepSocket.onopen();
  const stepInput = JSON.parse(stepSocket.sent[0]).session.audio.input;
  assert.equal(stepInput.transcription.model, 'stepaudio-2.5-asr-stream');
  assert.equal(stepInput.transcription.enable_timestamp_align, true);
  assert.equal(stepInput.turn_detection, undefined, '单段录音由结束操作提交完整音频');
  assert.equal(stepSocket.options.headers.Authorization, 'Bearer speech-key');
  stepEvent(stepSocket, 'session.created');
  await Promise.resolve(); assert.equal(stepReady, false);
  stepEvent(stepSocket, 'session.updated');
  const stepSession = (await openingStep).session;
  stepSession.sendAudioChunk(pcm.buffer);
  assert.deepEqual(JSON.parse(stepSocket.sent.at(-1)).audio, 'AQIDBA==');
  stepSession.finish(); stepSession.finish();
  assert.equal(stepSocket.sent.filter(value => JSON.parse(value).type === 'input_audio_buffer.commit').length, 1);
  assert.equal(stepFinished, false);
  stepEvent(stepSocket, 'conversation.item.created', { item: { id: 'input-item' } });
  stepEvent(stepSocket, 'input_audio_buffer.committed', { item_id: 'input-item' });
  stepEvent(stepSocket, 'conversation.item.created', { item: { id: 'step-item' } });
  stepEvent(stepSocket, 'conversation.item.input_audio_transcription.delta', { item_id: 'step-item', text: '你', stash: '号' });
  stepEvent(stepSocket, 'conversation.item.input_audio_transcription.delta', { item_id: 'step-item', text: '你好', stash: '' });
  assert.deepEqual(stepInterims.map(result => result.text), ['你号', '你好'], '实时全文替换，修订尾部不重复拼接');
  stepEvent(stepSocket, 'conversation.item.input_audio_transcription.completed', {
    item_id: 'step-item', transcript: '你好。', words: [{ word: '你好', start: 0.12, end: 0.82 }],
  });
  assert.deepEqual(stepFinals, [{ index: 0, text: '你好。', startTime: 120, endTime: 820 }]);
  assert.equal(stepFinished, true, '提交项与转写项 ID 不同，仍以实际转写完成结束录音');

  const continuousFinals = [];
  const openingCallStep = realtime.startRealtimeSpeechToText({ configuration: stepConfig, consumer: 'call', onFinalTranscript: result => continuousFinals.push(result) });
  const callStepSocket = sockets.at(-1); callStepSocket.onopen();
  assert.equal(JSON.parse(callStepSocket.sent[0]).session.audio.input.turn_detection.type, 'server_vad');
  stepEvent(callStepSocket, 'session.updated');
  const callStepSession = (await openingCallStep).session;
  for (const [id, start, end] of [['one', 1.2, 2], ['two', 3.4, 4.1]]) {
    stepEvent(callStepSocket, 'input_audio_buffer.speech_started', { item_id: id, audio_start_ms: start * 1000 });
    stepEvent(callStepSocket, 'input_audio_buffer.committed', { item_id: id });
    stepEvent(callStepSocket, 'conversation.item.input_audio_transcription.completed', { item_id: id, transcript: id, words: [{ start, end }] });
  }
  assert.deepEqual(continuousFinals.map(result => [result.index, result.startTime, result.endTime]), [[0, 1200, 2000], [1, 3400, 4100]]);
  callStepSession.close();

  // 外部鉴权、协议与连接错误保留原因；取消和主动关闭均不冒充服务端失败。
  for (const configuration of [volcConfig, stepConfig]) {
    const refused = realtime.startRealtimeSpeechToText({ configuration });
    const socket = sockets.at(-1); socket.onopen();
    if (configuration === volcConfig) volcResponse(socket, `无权限 speech-key`, { errorCode: 45000001 });
    else stepEvent(socket, 'error', { error: { code: 'invalid_api_key', message: '无权限 speech-key' } });
    const refusal = await refused;
    assert.equal(refusal.success, false);
    assert.match(refusal.rawError, /无权限 \[REDACTED\]/);
    assert.ok(!refusal.rawError.includes('speech-key'));
    const nativeRefused = realtime.startRealtimeSpeechToText({ configuration });
    const nativeRefusedSocket = sockets.at(-1);
    let refusedEarly = false;
    void nativeRefused.then(() => { refusedEarly = true; });
    nativeRefusedSocket.onerror({ type: 'error' });
    await Promise.resolve();
    assert.equal(refusedEarly, false, 'React Native 的无详情 error 不能提前吞掉握手失败原因');
    nativeRefusedSocket.onclose({ code: 1006, reason: "Expected HTTP 101 response but was '401 Unauthorized' speech-key" });
    const nativeRefusal = await nativeRefused;
    assert.equal(nativeRefusal.success, false);
    assert.match(nativeRefusal.rawError, /WebSocket 网络失败.*1006.*401 Unauthorized.*\[REDACTED\]/);
    const malformed = realtime.startRealtimeSpeechToText({ configuration });
    const malformedSocket = sockets.at(-1); malformedSocket.onopen();
    malformedSocket.onmessage({ data: configuration === volcConfig ? new ArrayBuffer(2) : 'not-json' });
    assert.equal((await malformed).success, false);
    const endedEarly = realtime.startRealtimeSpeechToText({ configuration });
    sockets.at(-1).onclose({ code: 1006, reason: 'upstream unavailable' });
    assert.match((await endedEarly).rawError, /1006.*upstream unavailable/);
    const abort = new AbortController();
    const cancelled = realtime.startRealtimeSpeechToText({ configuration, signal: abort.signal });
    abort.abort();
    assert.match((await cancelled).rawError, /已取消/);
  }

  for (const configuration of [volcConfig, stepConfig]) {
    resolver.configureSpeechModelResolver(async () => ({ ...configuration, modelConfigId: 'new-stt', modelConfigName: '新实时识别' }));
    const opening = voice.startVoiceMessageTranscription({});
    await new Promise(setImmediate);
    const socket = sockets.at(-1); socket.onopen();
    if (configuration === volcConfig) volcResponse(socket, {});
    else stepEvent(socket, 'session.updated');
    const session = await opening;
    session.acceptAudioChunk(pcm.buffer);
    const ending = session.finish();
    if (configuration === volcConfig) {
      volcResponse(socket, { result: { utterances: [utterance('录音识别成功', 0, 100, true)] } }, { last: true });
    } else {
      stepEvent(socket, 'conversation.item.created', { item: { id: 'input-recording' } });
      stepEvent(socket, 'input_audio_buffer.committed', { item_id: 'input-recording' });
      stepEvent(socket, 'conversation.item.input_audio_transcription.completed', { item_id: 'recording', transcript: '录音识别成功', words: [{ start: 0, end: 0.1 }] });
    }
    assert.deepEqual(await ending, { success: true, text: '录音识别成功' }, '新提供方通过正式选择和聊天录音会话交付文本，无文件转写路径');

    const errors = [];
    const openingFailed = realtime.startRealtimeSpeechToText({ configuration, onError: error => errors.push(error.message) });
    const failedSocket = sockets.at(-1); failedSocket.onopen();
    if (configuration === volcConfig) volcResponse(failedSocket, {});
    else stepEvent(failedSocket, 'session.updated');
    const failed = await openingFailed;
    failedSocket.onerror({ type: 'error' });
    assert.deepEqual(errors, [], 'React Native 的 error 不含原因，需消费紧接着的 close');
    failedSocket.onclose({ code: 1006, reason: 'Expected HTTP 101 response but was 429: rate limit' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /1006.*HTTP 101.*429: rate limit/);
    failed.session.close();
    assert.equal(errors.length, 1, '连接错误与随后 close 不能重复报告同一失败');
  }

  // 临时音频的取消结果由生成方清理，不交给已离开的页面。
  const deleted = [];
  const store = { writeBase64Audio: async () => ({ uri: 'temp://audio', mimeType: 'audio/mpeg' }), deleteIfExists: async (uri) => { deleted.push(uri); } };
  const configured = load(`${speechRoot}SynthesizeConfiguredSpeech.ts`, { '@platform/device': { temporarySpeechAudioStore: store }, './application/SpeechProviderCatalog': catalog, './infrastructure/SpeechSynthesisGateway': gateway });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(configured.synthesizeConfiguredSpeech({ configuration: { ...configuration, baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', metadataJson: '{"provider":"openai","voiceId":"coral"}' }, text: '你好', signal: controller.signal }), /已取消/);
  assert.deepEqual(deleted, ['temp://audio']);

  const synthesisOwner = load(`${speechRoot}SynthesizeTextToSpeech.ts`, {
    '@platform/ai': ai,
    './application/ResolveSpeechModel': resolver,
    './SynthesizeConfiguredSpeech': configured,
  });
  const beforeSynthesisErrors = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'tts_limit', message: '声音合成额度不足' } }), { status: 429 });
    const failedSynthesis = await synthesisOwner.synthesizeTextToSpeech({ text: '你好',
      modelSnapshot: { ...configuration, baseURL: 'https://api.openai.com/v1', model: 'tts-1',
        modelConfigId: 'tts-test', modelConfigName: '测试 TTS', metadataJson: '{"provider":"openai","voiceId":"coral"}' } });
    assert.equal(failedSynthesis.success, false);
    assert.match(failedSynthesis.errorInfo.message, /HTTP 429.*tts_limit.*声音合成额度不足/s);
    globalThis.fetch = async () => new Response(JSON.stringify({ base_resp: { status_code: 1008, status_msg: '合成服务繁忙' } }));
    const businessError = await gateway.synthesizeSpeechAudio({ baseURL: 'https://minimax.test', apiKey: 'key', model: 'speech-2.8-hd' },
      { provider: 'minimaxT2aV2', voiceId: 'voice' }, '你好', {});
    assert.equal(businessError.success, false);
    assert.match(businessError.error, /code=1008.*合成服务繁忙/);
  } finally { globalThis.fetch = beforeSynthesisErrors; }

  // 从真实配置页选择 Fish、校验、创建、重开编辑，测试读取草稿但不提交资产。
  const draftEditor = load('src/shared/ui/AutoSaveDraftEditor.ts');
  let focusedSpeechField = null;
  let blankDismissals = 0;
  const nativeForm = {
    View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'TouchableOpacity',
    Keyboard: { dismiss() {
      blankDismissals++;
      // 原生边界结束当前焦点并发出 blur；持久化仍走真实页面与草稿编辑器。
      const focused = focusedSpeechField;
      focusedSpeechField = null;
      if (focused) focused.props.onBlur();
    } },
    AppState: { addEventListener: () => ({ remove() {} }) },
    BackHandler: { addEventListener: () => ({ remove() {} }) },
  };
  const formHooks = load('src/shared/ui/useAutoSaveDraft.ts', {
    react: React, 'react-native': nativeForm, './AutoSaveDraftEditor': draftEditor,
    'expo-router': { useFocusEffect: (effect) => React.useEffect(effect, [effect]) },
  });
  const formFeedback = load('src/shared/ui/useAutoSaveFeedback.ts', { react: React, 'react-native': nativeForm });
  const formTheme = { spacing: { lg: 10, md: 8, sm: 4, xl: 16 }, colors: { background: { app: '#fff' }, text: { primary: '#000', secondary: '#555' }, feedback: { error: '#f00' } } };
  const formPage = load('src/features/assistants/presentation/auxiliaryModels/SpeechModelEditScreen.tsx', {
    react: React, 'react-native': nativeForm, 'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '@features/speech': { ...catalog, SpeechConfigurationTest: 'SpeechTest' },
    '@shared/ui': { KeyboardAvoidingContainer: 'KeyboardContainer', Button: 'Button', DropdownField: 'DropdownField', InputField: 'InputField', ToggleField: 'ToggleField', ModelPickerModal: 'ModelPickerModal', ListItem: 'ListItem', showAppDialog: assert.fail },
    '@shared/ui/NavigationHeader': 'Header', '@shared/theme': { useTheme: () => formTheme },
    '@shared/ui/useAutoSaveDraft': formHooks, '@shared/ui/useAutoSaveFeedback': formFeedback,
    '@shared/ui/AutoSaveErrors': { AutoSaveErrors: 'AutoSaveErrors' }, './speechModelDraft': draftModule, './ServiceConnectionPicker': 'ServicePicker',
  });
  const createdFish = []; const fishWrites = [];
  const formProps = { kind: 'tts', initialData: null, saving: false, onBack() {},
    onCreate: async (input) => { createdFish.push(input); }, onSave: async (patch) => { fishWrites.push(patch); } };
  let fishForm;
  await act(async () => { fishForm = TestRenderer.create(React.createElement(formPage.default, formProps), { createNodeMock: () => ({ scrollTo() {} }) }); });
  const formField = (type, label) => fishForm.root.findAllByType(type).find((node) => node.props.label === label);
  assert.ok(formField('DropdownField', '提供方').props.options.some((option) => option.value === 'fishAudio'));
  assert.equal(formField('DropdownField', '提供方').props.disabled, false, '新建配置允许选择提供方');
  assert.equal(formField('InputField', '配置名称').props.value, 'MiniMax');
  assert.equal(fishForm.root.findAllByType('ServicePicker').length, 0, '官方 TTS 不提供通用服务选择');
  for (const option of formField('DropdownField', '提供方').props.options) {
    await act(async () => { formField('DropdownField', '提供方').props.onChange(option.value); });
    assert.equal(formField('InputField', '配置名称').props.value, option.label, '默认名称应跟随提供方切换');
    assert.equal(fishForm.root.findAllByType('ServicePicker').length, option.value === 'openaiCompatible' ? 1 : 0, '只有自定义兼容 TTS 显示服务选择');
    if (option.value === 'openaiCompatible') {
      const items = fishForm.root.findAll(node => ['InputField', 'ServicePicker'].includes(node.type));
      const address = items.findIndex(node => node.type === 'InputField' && node.props.label === 'API 地址');
      const key = items.findIndex(node => node.type === 'InputField' && node.props.label === 'API Key');
      const service = items.findIndex(node => node.type === 'ServicePicker');
      assert.equal(key, address + 1); assert.equal(service, key + 1, '服务入口紧接地址和 Key');
    }
  }
  await act(async () => { formField('InputField', '配置名称').props.onChangeText('我的语音'); });
  await act(async () => { formField('DropdownField', '提供方').props.onChange('openai'); });
  assert.equal(formField('InputField', '配置名称').props.value, '我的语音', '切换提供方应保留自定义名称');
  await act(async () => { formField('InputField', '配置名称').props.onChangeText('   '); });
  await act(async () => { formField('DropdownField', '提供方').props.onChange('fishAudio'); });
  assert.equal(formField('InputField', '配置名称').props.value, 'Fish Audio', '空白名称应使用新提供方名称');
  await act(async () => { assert.equal(fishForm.root.findByType('SpeechTest').props.getConfiguration(), null); });
  assert.ok(formField('InputField', '音色 ID').props.error);
  await act(async () => {
    formField('InputField', '音色 ID').props.onChangeText('my-fish-voice');
    formField('InputField', 'API Key').props.onChangeText('my-fish-key');
    formField('InputField', '语速').props.onChangeText('1.1');
    fishForm.root.findByType('ModelPickerModal').props.onSelect('s2.1-pro-free');
  });
  let fishTestConfiguration;
  await act(async () => { fishTestConfiguration = fishForm.root.findByType('SpeechTest').props.getConfiguration(); });
  assert.equal(fishTestConfiguration.baseURL, 'https://api.fish.audio/v1');
  assert.equal(fishTestConfiguration.model, 's2.1-pro-free');
  assert.equal(JSON.parse(fishTestConfiguration.metadataJson).voiceId, 'my-fish-voice');
  assert.equal(JSON.parse(fishTestConfiguration.metadataJson).speed, 1.1);
  assert.deepEqual(createdFish, []);
  assert.deepEqual(fishWrites, []);
  await act(async () => { fishForm.root.findByType('Header').props.rightButton.props.onPress(); });
  assert.equal(createdFish.length, 1);
  assert.equal(createdFish[0].name, 'Fish Audio');
  assert.equal(createdFish[0].apiKey, 'my-fish-key');
  await act(async () => { fishForm.unmount(); });
  await act(async () => { fishForm = TestRenderer.create(React.createElement(formPage.default, { ...formProps, modelId: 'fish', initialData: createdFish[0] }), { createNodeMock: () => ({ scrollTo() {} }) }); });
  assert.equal(formField('DropdownField', '提供方').props.disabled, true, '已有 TTS 配置不允许修改提供方');
  assert.equal(formField('DropdownField', '提供方').props.value, 'fishAudio');
  assert.equal(formField('InputField', 'API Key').props.value, 'my-fish-key');
  assert.equal(formField('InputField', '音色 ID').props.value, 'my-fish-voice');
  await act(async () => { formField('InputField', '音色 ID').props.onChangeText('updated-fish-voice'); });
  assert.deepEqual(fishWrites, []);
  focusedSpeechField = formField('InputField', '音色 ID');
  const background = () => fishForm.root.findAllByType('View').find((node) => node.props.onTouchEnd);
  await act(async () => { background().props.onTouchEnd({ target: 'input', currentTarget: 'background' }); });
  assert.equal(blankDismissals, 0, '输入框的触摸冒泡不能让输入框失焦');
  assert.deepEqual(fishWrites, []);
  await act(async () => { background().props.onTouchEnd({ target: 'background', currentTarget: 'background' }); });
  assert.equal(focusedSpeechField, null, '点击空白结束输入焦点');
  assert.equal(blankDismissals, 1);
  assert.equal(JSON.parse(fishWrites.at(-1).metadataJson).voiceId, 'updated-fish-voice');
  for (const name of ['新的语音名称', '再次修改语音名称']) {
    const writesBeforeTyping = fishWrites.length;
    await act(async () => { formField('InputField', '配置名称').props.onChangeText(name); });
    assert.equal(fishWrites.length, writesBeforeTyping, '输入期间不保存');
    focusedSpeechField = formField('InputField', '配置名称');
    await act(async () => { background().props.onTouchEnd({ target: 'background', currentTarget: 'background' }); });
    assert.equal(fishWrites.at(-1).name, name, '每次修改后点击空白都提交最新输入');
  }
  await act(async () => { formField('InputField', '语速').props.onChangeText('错误'); });
  await act(async () => { formField('InputField', '语速').props.onBlur(); });
  assert.ok(formField('InputField', '语速').props.error);
  await act(async () => { fishForm.root.findByType('Header').props.onGoBack(); });
  assert.equal(fishForm.root.findByType('Header').props.rightButton, undefined, '已有语音配置不提供恢复入口');
  assert.equal(fishForm.root.findByType('AutoSaveErrors').props.restore, undefined);
  assert.equal(formField('InputField', '语速').props.value, '错误', '保留错误输入供用户修正');
  await act(async () => { formField('InputField', '语速').props.onChangeText('1.2'); });
  await act(async () => { formField('InputField', '语速').props.onBlur(); });
  assert.equal(JSON.parse(fishWrites.at(-1).metadataJson).speed, 1.2, '修正后失焦继续自动保存');
  assert.equal(formField('InputField', '语速').props.error, undefined);
  assert.equal(fishForm.root.findByType('AutoSaveErrors').props.blocked, false, '修正后清除未保存提示');
  assert.equal(formField('InputField', '音色 ID').props.value, 'updated-fish-voice');
  assert.equal(formField('InputField', 'API Key').props.value, 'my-fish-key');
  assert.equal(formField('DropdownField', '提供方').props.disabled, true);
  await act(async () => { fishForm.unmount(); });

  for (const providerId of ['volcengineRealtimeAsr', 'stepfunRealtimeAsr']) {
    const created = [];
    let form;
    await act(async () => { form = TestRenderer.create(React.createElement(formPage.default, {
      ...formProps, kind: 'stt', onCreate: async input => { created.push(input); },
    }), { createNodeMock: () => ({ scrollTo() {} }) }); });
    const field = (type, label) => form.root.findAllByType(type).find(node => node.props.label === label);
    await act(async () => { field('DropdownField', '提供方').props.onChange(providerId); });
    const provider = catalog.getSpeechProvider(providerId);
    assert.equal(form.root.findAllByType('ServicePicker').length, 0, '实时 STT 不参与通用服务配置');
    assert.equal(field('InputField', 'API 地址'), undefined, '官方实时识别无需填写 Endpoint 或 API 地址');
    assert.equal(form.root.findByType('ModelPickerModal').props.models[0].name, provider.modelLabels[provider.defaultModel]);
    await act(async () => { field('InputField', provider.credentialLabel).props.onChangeText('new-service-key'); });
    let testSnapshot;
    await act(async () => { testSnapshot = form.root.findByType('SpeechTest').props.getConfiguration(); });
    assert.equal(testSnapshot.baseURL, provider.baseURL);
    assert.equal(testSnapshot.apiKey, 'new-service-key');
    assert.deepEqual(created, [], '测试配置快照不创建正式资产');
    await act(async () => { form.root.findByType('Header').props.rightButton.props.onPress(); });
    assert.equal(created.length, 1);
    assert.equal(created[0].baseUrl, provider.baseURL);
    assert.equal(created[0].metadataJson, testSnapshot.metadataJson);
    await act(async () => { form.unmount(); });
  }

  // UI 测试通过真实 React 生命周期验证播放清理与迟到响应，不使用源码断言。
  const pending = deferred(); let stops = 0;
  const playback = { stop: async () => { stops++; }, pause: async () => {}, resume: async () => {}, subscribe: (listener) => { listener({ state: 'playing' }); return () => {}; } };
  const theme = { spacing: { lg: 10, md: 8, sm: 4 }, colors: { text: { primary: '#000' }, feedback: { error: '#f00' } } };
  let generation = 0;
  const preview = load(`${speechRoot}presentation/SpeechConfigurationTest.tsx`, {
    react: React, 'react-native': { View: 'View', Text: 'Text' }, '@shared/ui': { Button: 'Button', InputField: 'InputField' }, '@shared/theme': { useTheme: () => theme },
    '@platform/device': { temporarySpeechAudioStore: store, localAudioPlaybackPort: { play: async () => playback } },
    '../SynthesizeConfiguredSpeech': { synthesizeConfiguredSpeech: async () => { generation++; return generation === 1 ? pending.promise : { audioUri: 'temp://new', mimeType: 'audio/mpeg' }; } }, '../StartRealtimeSpeechToText': {},
  });
  let renderer;
  const props = { kind: 'tts', getConfiguration: () => configuration, configurationRevision: '1' };
  await act(async () => { renderer = TestRenderer.create(React.createElement(preview.SpeechConfigurationTest, props)); });
  let generating;
  await act(async () => { generating = renderer.root.findAllByType('Button')[0].props.onPress(); await Promise.resolve(); });
  await act(async () => { renderer.update(React.createElement(preview.SpeechConfigurationTest, { ...props, configurationRevision: '2' })); });
  await act(async () => { pending.resolve({ audioUri: 'temp://late', mimeType: 'audio/mpeg' }); await generating; });
  assert.ok(deleted.includes('temp://late'));
  assert.equal(renderer.root.findAllByType('Button').length, 1);
  await act(async () => { renderer.root.findAllByType('Button')[0].props.onPress(); });
  await act(async () => { renderer.root.findAllByType('Button')[1].props.onPress(); });
  await act(async () => { renderer.unmount(); });
  assert.equal(stops, 1); assert.ok(deleted.includes('temp://new'));

  // 测试页使用服务端诊断原文，并允许用户选择复制，不把具体原因替换为通用 404 文案。
  const failedPreview = load(`${speechRoot}presentation/SpeechConfigurationTest.tsx`, {
    react: React, 'react-native': { View: 'View', Text: 'Text' }, '@shared/ui': { Button: 'Button', InputField: 'InputField' }, '@shared/theme': { useTheme: () => theme },
    '@platform/device': { temporarySpeechAudioStore: store },
    '../SynthesizeConfiguredSpeech': { synthesizeConfiguredSpeech: async () => { throw new Error(diagnosticMessage); } }, '../StartRealtimeSpeechToText': {},
  });
  await act(async () => { renderer = TestRenderer.create(React.createElement(failedPreview.SpeechConfigurationTest, props)); });
  await act(async () => { renderer.root.findByType('Button').props.onPress(); });
  const shownError = renderer.root.findAllByType('Text').find((node) => node.props.accessibilityRole === 'alert');
  assert.equal(shownError.props.children, diagnosticMessage);
  assert.equal(shownError.props.selectable, true);
  await act(async () => { renderer.unmount(); });

  // STT 设置测试在停止麦克风后发送 finish，并显示屏障前到达的最后一句。
  let audioCallbacks; let recognitionCallbacks; let socketClosed = 0; const events = [];
  const sttPreview = load(`${speechRoot}presentation/SpeechConfigurationTest.tsx`, {
    react: React, 'react-native': { View: 'View', Text: 'Text' }, '@shared/ui': { Button: 'Button', InputField: 'InputField' }, '@shared/theme': { useTheme: () => theme },
    '@platform/device': { temporarySpeechAudioStore: store, requestMicrophonePermission: async () => true, realtimeSpeechAudioSource: { start: async (callbacks) => {
      audioCallbacks = callbacks; let stopped = false;
      return { stop: async () => { if (stopped) return; stopped = true; events.push('microphone-stop'); audioCallbacks.onAudioChunk(new ArrayBuffer(2)); } };
    } } }, '../SynthesizeConfiguredSpeech': {}, '../StartRealtimeSpeechToText': { startRealtimeSpeechToText: async (callbacks) => {
      recognitionCallbacks = callbacks;
      return { success: true, session: { sendAudioChunk: () => events.push('pcm'), finish: () => { events.push('finish'); callbacks.onFinalTranscript({ index: 1, text: '最后一句' }); callbacks.onFinished(); }, close: () => { socketClosed++; } } };
    } },
  });
  await act(async () => { renderer = TestRenderer.create(React.createElement(sttPreview.SpeechConfigurationTest, { ...props, kind: 'stt' })); });
  await act(async () => { renderer.root.findByType('Button').props.onPress(); });
  await act(async () => { recognitionCallbacks.onInterimTranscript({ text: '中间结果' }); });
  await act(async () => { renderer.root.findByType('Button').props.onPress(); });
  assert.deepEqual(events, ['microphone-stop', 'pcm', 'finish']);
  assert.ok(renderer.root.findAllByType('Text').some((node) => node.props.children === '最后一句'));
  assert.equal(socketClosed, 1);
  await act(async () => { renderer.unmount(); });

  // 原生停止期间保留 PCM 订阅，重复停止不会重复操作全局麦克风。
  let chunkListener; let removed = 0; let nativeStops = 0;
  const nativeStop = deferred();
  const source = load('src/platform/device/RealtimeSpeechAudioSource.ts', { '../../../modules/realtime-speech-audio-source': {
    addRealtimeSpeechAudioChunkListener: (callback) => { chunkListener = callback; return { remove: () => { removed++; } }; },
    addRealtimeSpeechAudioErrorListener: () => ({ remove: () => { removed++; } }), addRealtimeSpeechDetectedListener: () => ({ remove: () => { removed++; } }),
    startRealtimeSpeechAudioSource: async () => ({ echoCancellationEnabled: true }), stopRealtimeSpeechAudioSource: async () => { nativeStops++; await nativeStop.promise; },
  } });
  const chunks = [];
  const sourceSession = await source.realtimeSpeechAudioSource.start({ onAudioChunk: (chunk) => chunks.push(chunk), onError: assert.fail });
  const stopSource = sourceSession.stop(); const stopAgain = sourceSession.stop();
  chunkListener({ base64: 'AQI=' }); assert.equal(chunks.length, 1); assert.equal(removed, 0);
  nativeStop.resolve(); await Promise.all([stopSource, stopAgain]); assert.equal(nativeStops, 1); assert.equal(removed, 3);

  console.log('语音提供方协议、动态参数、配置提交、实时识别完成屏障及测试音频生命周期验证通过。');
} finally { globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket; }
