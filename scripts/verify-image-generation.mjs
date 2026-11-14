/** 生图协议、两条落盘链路、选择快照与真实 SQLite 提交资格回归。 */
import assert from 'node:assert/strict';
import { Blob, Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadTypeScriptModule as load } from './helpers/load-typescript-module.mjs';
import { bootstrapSqlite, createSqliteExecutor } from './helpers/sqlite-bootstrap-fixture.mjs';
import { createCoordinatedSqliteFixture, databaseErrors } from './helpers/coordinated-sqlite-fixture.mjs';

const abort = load('src/shared/runtime/abortSignal.ts');
const slot = load('src/shared/runtime/RuntimeSlot.ts');
const mapping = load('src/platform/ai/errorMapping.ts');
const imageConfigDomain = load('src/platform/ai/imageGenerationConfig.ts');
const referenceInfo = { mimeType: 'image/png', width: 1024, height: 1024, byteSize: 100 };
for (const [provider, patch, valid] of [
  ['minimax', { byteSize: 9_999_999 }, true], ['minimax', { byteSize: 10_000_000 }, false], ['minimax', { mimeType: 'image/webp' }, false],
  ['qwen', { byteSize: 10_000_000 }, true], ['qwen', { byteSize: 10_000_001 }, false],
  ['qwen', { width: 8000 }, true], ['qwen', { width: 8001 }, false], ['qwen', { width: 5000, height: 500 }, true], ['qwen', { width: 5001, height: 500 }, false],
  ['seedream', { byteSize: 30_000_000 }, true], ['seedream', { byteSize: 30_000_001 }, false],
  ['seedream', { width: 14 }, false], ['seedream', { width: 15, height: 15 }, true],
  ['seedream', { width: 6000, height: 6000 }, true], ['seedream', { width: 6001, height: 6000 }, false],
  ['seedream', { width: 8000, height: 500 }, true], ['seedream', { width: 8001, height: 500 }, false],
  ['openai', { byteSize: 49_999_999 }, true], ['openai', { byteSize: 50_000_000 }, false],
]) assert.equal(imageConfigDomain.validateImageGenerationReference({ provider }, { ...referenceInfo, ...patch }) === null, valid, `${provider}: ${JSON.stringify(patch)}`);
for (const provider of imageConfigDomain.IMAGE_GENERATION_PROVIDERS) {
  assert.equal(imageConfigDomain.validateImageGenerationReference({ provider: provider.id }, referenceInfo), null);
  assert.notEqual(imageConfigDomain.validateImageGenerationReference({ provider: provider.id }, { ...referenceInfo, mimeType: 'image/gif' }), null);
}
const imageRequest = load('src/platform/ai/ImageGenerationRequest.ts', {
  './baseUrl': load('src/platform/ai/baseUrl.ts'), './imageGenerationConfig': imageConfigDomain,
  'expo-file-system': { File: class extends Blob { constructor() { super(['reference'], { type: 'image/png' }); } } },
});
const imageStream = load('src/platform/ai/ImageGenerationStream.ts', { '@shared/runtime/abortSignal': abort });
const draft = load('src/features/assistants/presentation/auxiliaryModels/auxiliaryModelDraft.ts', {
  '@shared/ui/draftValidation': load('src/shared/ui/draftValidation.ts'),
  '@platform/ai/imageGenerationConfig': imageConfigDomain,
});
const imageDraft = { ...draft.getAuxiliaryModelDraft(null), imageProvider: 'siliconflow', name: '生图', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'key', model: 'Tongyi-MAI/Z-Image', tempInput: '1', topPInput: '0.9', maxTokens: '100' };
const parsedDraft = draft.parseAuxiliaryModelDraft('image_generation', imageDraft, Object.keys(imageDraft));
assert.deepEqual(parsedDraft.errors, {});
assert.equal(parsedDraft.patch.temperature, null);
assert.equal(parsedDraft.patch.topP, null);
assert.equal(parsedDraft.patch.maxTokens, null);
const captures = [];
const client = load('src/platform/ai/ImageGenerationClient.ts', {
  './baseUrl': load('src/platform/ai/baseUrl.ts'), './errorMapping': mapping,
  '@shared/runtime/abortSignal': abort,
  'expo/fetch': { fetch: (...args) => globalThis.fetch(...args) },
  './ImageGenerationRequest': imageRequest, './ImageGenerationStream': imageStream,
  './HttpExchangeCapture': { beginAIHttpCapture: async request => ({
    setResponse: (status, body) => captures.push({ ...request, status, body }), finish: async () => {},
  }) },
});
const config = { baseURL: 'https://api.openai.com/v1/', apiKey: 'secret-key', model: 'gpt-image-2', profile: { provider: 'openai' } };
const originalFetch = globalThis.fetch;
try {
  const signal = new AbortController().signal;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/images/generations');
    assert.equal(init.headers.Authorization, 'Bearer secret-key');
    assert.deepEqual(JSON.parse(init.body), { model: config.model, prompt: '画只猫', n: 1 });
    return new Response(JSON.stringify({ data: [{ b64_json: 'AQID', url: 'https://images.example/signed?sig=private' }] }));
  };
  assert.deepEqual(await client.generateImage(config, '画只猫', signal), { success: true, image: { kind: 'base64', base64: 'AQID' } });
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(captures).includes('private') && !JSON.stringify(captures).includes('AQID'));
  const reference = { uri: 'file:///reference.png', mimeType: 'image/png', base64: 'REF' };
  const siliconflow = { ...config, baseURL: 'https://api.siliconflow.cn/v1', model: 'Tongyi-MAI/Z-Image', profile: { provider: 'siliconflow' } };
  calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.siliconflow.cn/v1/images/generations');
    assert.deepEqual(JSON.parse(init.body), { model: 'Tongyi-MAI/Z-Image', prompt: '请画16:9的猫', image_size: '864x1152' });
    return new Response(JSON.stringify({ images: [{ url: 'https://images.example/z-image' }], seed: 1 }));
  };
  assert.equal((await client.generateImage(siliconflow, '请画16:9的猫', signal, { parameters: { aspectRatio: '3:4' } })).image.url, 'https://images.example/z-image');
  assert.equal(calls, 1, '硅基流动只发一次原生文生图请求');
  assert.deepEqual(JSON.parse(imageRequest.buildImageGenerationRequest(siliconflow, '猫', {}, undefined, true).body),
    { model: 'Tongyi-MAI/Z-Image', prompt: '猫', image_size: '1024x1024' });
  const zCapabilities = imageConfigDomain.getImageGenerationCapabilities(siliconflow.profile, siliconflow.model);
  assert.equal(zCapabilities.references, false);
  assert.equal(zCapabilities.preview, false);
  assert.deepEqual(zCapabilities.resolutions, []);
  const imageModels = imageConfigDomain.IMAGE_GENERATION_PROVIDERS.find(provider => provider.id === 'siliconflow').models;
  assert.ok(imageModels.includes('Qwen/Qwen-Image') && imageModels.includes('Qwen/Qwen-Image-Edit-2509') && imageModels.includes('Kwai-Kolors/Kolors'));
  const qwenImage = { ...siliconflow, model: 'Qwen/Qwen-Image' };
  const qwenImageRequest = imageRequest.buildImageGenerationRequest(qwenImage, '画一张中文海报', { aspectRatio: '16:9' }, undefined, true);
  assert.deepEqual(JSON.parse(qwenImageRequest.body), { model: qwenImage.model, prompt: '画一张中文海报', image_size: '1664x928', num_inference_steps: 50, cfg: 4 });
  assert.equal(qwenImageRequest.stream, false);
  for (const model of ['Qwen/Qwen-Image-Edit', 'Qwen/Qwen-Image-Edit-2509']) {
    const editing = { ...siliconflow, model };
    const capabilities = imageConfigDomain.getImageGenerationCapabilities(editing.profile, model);
    assert.equal(capabilities.referenceRequired, true);
    assert.deepEqual(capabilities.aspectRatios, []);
    assert.match(imageConfigDomain.validateImageGenerationParameters(capabilities, {}, false), /参考图/);
    assert.match(imageConfigDomain.validateImageGenerationParameters(capabilities, { aspectRatio: '3:4' }, true), /比例/);
    assert.equal(imageConfigDomain.validateImageGenerationParameters(capabilities, {}, true), null);
    const request = imageRequest.buildImageGenerationRequest(editing, '保持人物，换成水彩', {}, reference, false);
    assert.equal(request.url, 'https://api.siliconflow.cn/v1/images/generations');
    assert.equal(request.json, true);
    assert.deepEqual(JSON.parse(request.body), { model, prompt: '保持人物，换成水彩', image: 'data:image/png;base64,REF' });
  }
  const kolors = { ...siliconflow, model: 'Kwai-Kolors/Kolors' };
  const kolorsCapabilities = imageConfigDomain.getImageGenerationCapabilities(kolors.profile, kolors.model);
  assert.equal(kolorsCapabilities.references, true);
  assert.equal(kolorsCapabilities.referenceRequired, false);
  assert.deepEqual(kolorsCapabilities.aspectRatios, ['1:1', '3:4', '9:16']);
  assert.match(imageConfigDomain.validateImageGenerationParameters(kolorsCapabilities, { aspectRatio: '16:9' }, false), /比例/);
  assert.equal(imageConfigDomain.validateImageGenerationParameters(kolorsCapabilities, {}, false), null);
  assert.deepEqual(JSON.parse(imageRequest.buildImageGenerationRequest(kolors, '油画', { aspectRatio: '3:4' }, reference, false).body),
    { model: kolors.model, prompt: '油画', image_size: '960x1280', image: 'data:image/png;base64,REF' });
  for (const result of [{ images: [] }, { images: [{ url: 'https://images.example/1' }, { url: 'https://images.example/2' }] },
    { images: [{ url: 'http://images.example/unsafe' }] }, { data: [{ url: 'https://images.example/wrong-shape' }] }]) {
    globalThis.fetch = async () => new Response(JSON.stringify(result));
    assert.equal((await client.generateImage(siliconflow, '猫', signal)).code, 'IMAGE_GENERATION_INVALID_RESPONSE');
  }
  const minimax = { ...config, baseURL: 'https://api.minimax.cn/v1', model: 'image-01', profile: { provider: 'minimax' } };
  calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(url, 'https://api.minimax.cn/v1/image_generation');
    assert.equal(init.redirect, 'error', '计费请求不得携带 Key 跟随重定向');
    assert.deepEqual(JSON.parse(init.body), { model: 'image-01', prompt: '参考人物', n: 1, aspect_ratio: '16:9',
      subject_reference: [{ type: 'character', image_file: 'data:image/png;base64,REF' }] });
    return new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { image_urls: ['https://images.example/one'] } }));
  };
  assert.equal((await client.generateImage(minimax, '参考人物', signal, { parameters: { aspectRatio: '16:9' }, reference })).image.kind, 'url');
  assert.equal(calls, 1);
  globalThis.fetch = async () => new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { image_base64: ['AQID'] } }));
  assert.equal((await client.generateImage(minimax, '参考人物', signal)).image.base64, 'AQID');
  globalThis.fetch = async () => new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { image_base64: ['AQID','BAUG'], image_urls: ['https://images.example/one'] } }));
  assert.equal((await client.generateImage(minimax, '图片', signal)).code, 'IMAGE_GENERATION_INVALID_RESPONSE');
  const mini2k = imageRequest.buildImageGenerationRequest(minimax, '画面', { aspectRatio: '16:9', resolution: '2K' }, undefined, false);
  assert.deepEqual(JSON.parse(mini2k.body), { model: 'image-01', prompt: '画面', n: 1, width: 2048, height: 1152 });
  assert.deepEqual(imageConfigDomain.getImageGenerationCapabilities(minimax.profile, 'image-01-live').resolutions, []);
  globalThis.fetch = async () => new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'unauthorized secret-key' } }));
  const miniError = await client.generateImage(minimax, '参考人物', signal);
  assert.equal(miniError.code, 'IMAGE_GENERATION_AUTH'); assert.ok(!miniError.error.includes('secret-key'));
  const seedream = { ...config, baseURL: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-4-5-251128', profile: { provider: 'seedream' } };
  const seedRequest = imageRequest.buildImageGenerationRequest(seedream, '风景', { aspectRatio: '9:16', resolution: '4K' }, reference, true);
  assert.equal(seedRequest.url, 'https://ark.cn-beijing.volces.com/api/v3/images/generations');
  assert.deepEqual(JSON.parse(seedRequest.body), { model: seedream.model, prompt: '风景', size: '3040x5504', sequential_image_generation: 'disabled', image: 'data:image/png;base64,REF' });
  assert.equal(seedRequest.stream, false, '逐图完成事件不能冒充绘制预览');
  assert.deepEqual(imageConfigDomain.getImageGenerationCapabilities(seedream.profile, 'doubao-seedream-5-0-flash-260915').resolutions, ['1K','1.5K','2K']);
  const qwen = { ...config, baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-image-2.1-pro', profile: { provider: 'qwen' } };
  const qwenURL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
  assert.equal(imageConfigDomain.getImageGenerationConfigurationError(qwen.profile, qwen.baseURL, qwen.model), null, '已有百炼连接无需迁移即可使用原生图片协议');
  const qwenRequest = imageRequest.buildImageGenerationRequest(qwen, '人物', { aspectRatio: '16:9', resolution: '1K' }, reference, true);
  assert.equal(qwenRequest.url, qwenURL);
  assert.equal(qwenRequest.json, true);
  assert.equal(qwenRequest.stream, false);
  assert.deepEqual(JSON.parse(qwenRequest.body), { model: qwen.model,
    input: { messages: [{ role: 'user', content: [{ image: 'data:image/png;base64,REF' }, { text: '人物' }] }] },
    parameters: { n: 1, size: '1280*720' } });
  assert.ok(!qwenRequest.diagnosticBody.includes('人物') && !qwenRequest.diagnosticBody.includes('REF'), '嵌套输入的提示词与参考图也必须从诊断中省略');
  const qwenOutput = content => ({ output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }, request_id: 'qwen-request' });
  for (const model of imageConfigDomain.IMAGE_GENERATION_PROVIDERS.find(provider => provider.id === 'qwen').models) {
    for (const hasReference of [false, true]) {
      calls = 0;
      globalThis.fetch = async (url, init) => {
        calls++;
        assert.equal(url, qwenURL);
        assert.equal(init.headers.Authorization, 'Bearer secret-key');
        assert.equal(init.headers['Content-Type'], 'application/json');
        assert.equal(init.redirect, 'error');
        assert.equal(init.credentials, 'omit');
        assert.deepEqual(JSON.parse(init.body), { model, input: { messages: [{ role: 'user', content: [
          ...(hasReference ? [{ image: 'data:image/png;base64,REF' }] : []), { text: '人物' },
        ] }] }, parameters: { n: 1 } });
        return new Response(JSON.stringify(qwenOutput([{ image: 'https://images.example/qwen?sig=private' }])));
      };
      assert.deepEqual(await client.generateImage({ ...qwen, model }, '人物', signal, { reference: hasReference ? reference : undefined }),
        { success: true, image: { kind: 'url', url: 'https://images.example/qwen?sig=private' } });
      assert.equal(calls, 1, '文生图与参考图都只发送一次原生同步请求');
      assert.equal(captures.at(-1).url, qwenURL);
      assert.ok(!JSON.stringify(captures.at(-1)).includes('private') && !captures.at(-1).requestBody.includes('人物') && !captures.at(-1).requestBody.includes('REF'));
    }
  }
  for (const body of [null, {}, { output: null }, { output: { choices: [] } }, { output: { choices: [null] } },
    { output: { choices: [{ message: null }] } }, { output: { choices: [{ message: { content: null } }] } },
    qwenOutput([]), qwenOutput([{ text: '无图片' }]), qwenOutput([{ image: 'http://images.example/unsafe' }]),
    qwenOutput([{ image: null }]), qwenOutput([{ image: 'broken' }]),
    qwenOutput([{ image: 'https://images.example/one' }, { image: 'https://images.example/two' }]),
    { output: { choices: [...qwenOutput([{ image: 'https://images.example/one' }]).output.choices, ...qwenOutput([]).output.choices] } },
    { data: [{ url: 'https://images.example/wrong-protocol' }] }]) {
    globalThis.fetch = async () => new Response(JSON.stringify(body));
    assert.equal((await client.generateImage(qwen, '人物', signal)).code, 'IMAGE_GENERATION_INVALID_RESPONSE');
  }
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ code: 'InvalidParameter', message: 'input image rejected secret-key', request_id: 'qwen-request-404' }), { status: 400 });
  };
  const qwenError = await client.generateImage(qwen, '人物', signal, { reference });
  assert.equal(qwenError.code, 'IMAGE_GENERATION_REQUEST');
  assert.equal(qwenError.httpStatus, 400);
  assert.equal(qwenError.retryable, false);
  assert.match(qwenError.error, /InvalidParameter/);
  assert.match(qwenError.error, /qwen-request-404/);
  assert.ok(!qwenError.error.includes('secret-key'));
  assert.equal(calls, 1, '百炼拒绝时保留具体错误，不回退兼容接口或重放计费请求');
  const openai = { ...config, profile: { provider: 'openai' } };
  const edit = imageRequest.buildImageGenerationRequest(openai, '人像', { quality: 'high', outputFormat: 'jpeg', outputCompression: 80 }, reference, true);
  assert.equal(edit.url, 'https://api.openai.com/v1/images/edits');
  assert.equal(edit.json, false); assert.equal(edit.body.get('quality'), 'high');
  assert.equal(edit.body.get('stream'), 'true'); assert.equal(edit.body.get('output_compression'), '80');
  assert.equal(edit.body.get('image[]').name, 'reference.png');
  const frames = [];
  const sse = [{ type: 'image_generation.partial_image', b64_json: 'PREVIEW', output_format: 'png', partial_image_index: 0 },
    { type: 'image_generation.completed', b64_json: 'FINAL' }].map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(init.body).partial_images, 2);
    const bytes = new TextEncoder().encode(sse);
    return new Response(new ReadableStream({ start(controller) { for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const streamed = await client.generateImage(openai, '画面', signal, { onPreview: frame => frames.push(frame) });
  assert.equal(streamed.image.base64, 'FINAL');
  assert.deepEqual(frames, [{ base64: 'PREVIEW', mimeType: 'image/png', index: 0 }]);
  for (const model of imageConfigDomain.IMAGE_GENERATION_PROVIDERS.find(provider => provider.id === 'openai').models) {
    for (const format of ['png', 'jpeg', 'webp']) {
      const frames = [];
      const editSSE = [
        { type: 'image_edit.partial_image', b64_json: 'EDIT_PREVIEW', output_format: format, partial_image_index: 0 },
        { type: 'image_edit.completed', b64_json: 'EDIT_FINAL' },
      ].map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('');
      globalThis.fetch = async (url, init) => {
        assert.equal(url, 'https://api.openai.com/v1/images/edits');
        assert.equal(init.body.get('model'), model);
        assert.equal(init.body.get('output_format'), format);
        assert.equal(init.body.get('stream'), 'true');
        assert.equal(init.body.get('partial_images'), '2');
        assert.equal(init.headers['Content-Type'], undefined, 'multipart 边界由传输层填写');
        const bytes = new TextEncoder().encode(editSSE);
        return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }));
      };
      const result = await client.generateImage({ ...openai, model }, '编辑人像', signal, { reference, parameters: { outputFormat: format }, onPreview: frame => frames.push(frame) });
      assert.deepEqual(result, { success: true, image: { kind: 'base64', base64: 'EDIT_FINAL' } });
      assert.deepEqual(frames, [{ base64: 'EDIT_PREVIEW', mimeType: `image/${format}`, index: 0 }]);
    }
  }
  globalThis.fetch = async () => new Response(sse);
  assert.equal((await client.generateImage(openai, '编辑人像', signal, { reference, onPreview() {} })).code, 'IMAGE_GENERATION_INVALID_RESPONSE', '生成事件不能冒充编辑接口的最终结果');
  const editPartial = 'data: {"type":"image_edit.partial_image","b64_json":"EDIT_PREVIEW","output_format":"png","partial_image_index":0}\n\n';
  globalThis.fetch = async () => new Response(editPartial);
  assert.equal((await client.generateImage(openai, '编辑人像', signal, { reference, onPreview() {} })).code, 'IMAGE_GENERATION_INVALID_RESPONSE');
  const cancelEdit = new AbortController();
  await assert.rejects(client.generateImage(openai, '编辑人像', cancelEdit.signal, { reference, onPreview() { cancelEdit.abort(new Error('编辑预览时取消')); } }), /编辑预览时取消/);
  globalThis.fetch = async () => new Response('data: {"type":"image_generation.partial_image","b64_json":"PREVIEW","output_format":"png","partial_image_index":0}\n\n');
  assert.equal((await client.generateImage(openai, '画面', signal, { onPreview() {} })).code, 'IMAGE_GENERATION_INVALID_RESPONSE', '只有预览的中断流不能作为成功结果落盘');
  globalThis.fetch = async () => new Response('data: {"type":"error","error":{"message":"insufficient_quota secret-key"}}\n\n');
  const streamError = await client.generateImage(openai, '画面', signal, { onPreview() {} });
  assert.equal(streamError.code, 'IMAGE_GENERATION_QUOTA'); assert.ok(!streamError.error.includes('secret-key'));
  const cancelPreview = new AbortController();
  globalThis.fetch = async () => new Response(sse);
  await assert.rejects(client.generateImage(openai, '画面', cancelPreview.signal, { onPreview() { cancelPreview.abort(new Error('预览时取消')); } }), /预览时取消/);
  let parameterCombinations = 0;
  const coveredModels = new Set();
  for (const provider of imageConfigDomain.IMAGE_GENERATION_PROVIDERS) {
    for (const model of provider.models) {
      const connection = { ...config, model, baseURL: provider.baseURL, profile: { provider: provider.id } };
      const capabilities = imageConfigDomain.getImageGenerationCapabilities(connection.profile, model);
      const parameters = [{}, ...capabilities.aspectRatios.map(aspectRatio => ({ aspectRatio })),
        ...capabilities.resolutions.map(resolution => ({ resolution })),
        ...capabilities.aspectRatios.flatMap(aspectRatio => capabilities.resolutions.map(resolution => ({ aspectRatio, resolution })))];
      if (capabilities.quality) parameters.push(...['low', 'medium', 'high'].map(quality => ({ quality })));
      if (capabilities.outputFormat) parameters.push({ outputFormat: 'png' }, ...['jpeg', 'webp'].flatMap(outputFormat => [0, 60, 80, 100].map(outputCompression => ({ outputFormat, outputCompression }))));
      const references = capabilities.referenceRequired ? [reference] : capabilities.references ? [undefined, reference] : [undefined];
      for (const input of parameters) for (const ref of references) {
        const label = `${provider.id}/${model}: ${JSON.stringify(input)}, reference=${!!ref}`;
        assert.equal(imageConfigDomain.validateImageGenerationParameters(capabilities, input, !!ref), null, label);
        const request = imageRequest.buildImageGenerationRequest(connection, '契约验证', input, ref, false);
        const body = request.json ? JSON.parse(request.body) : Object.fromEntries(request.body.entries());
        assert.equal(body.model, model, label);
        const expectedURL = provider.id === 'qwen' ? qwenURL : `${provider.baseURL}/${provider.id === 'minimax' ? 'image_generation' : ref && provider.id === 'openai' ? 'images/edits' : 'images/generations'}`;
        assert.equal(request.url, expectedURL, label);
        const size = provider.id === 'qwen' ? body.parameters.size?.replace('*', 'x') : body.size;
        if (size) {
          const [width, height] = size.split('x').map(Number);
          const pixels = width * height;
          if (provider.id === 'seedream') {
            const flash = model === 'doubao-seedream-5-0-flash-260915';
            assert.ok(pixels >= (flash ? 921600 : 3686400) && pixels <= (flash ? 4624220 : 16777216), label);
            assert.ok(width / height >= 1 / 16 && width / height <= 16, label);
          } else if (provider.id === 'openai') {
            assert.ok(width % 16 === 0 && height % 16 === 0 && Math.max(width, height) <= 3840, label);
            assert.ok(pixels >= 655360 && pixels <= 8294400 && width / height >= 1 / 3 && width / height <= 3, label);
          } else if (provider.id === 'qwen') assert.ok(pixels >= 512 * 512 && pixels <= 2048 * 2048 && width / height >= 1 / 8 && width / height <= 8, label);
        }
        if (provider.id === 'minimax') {
          assert.equal(body.n, 1, label);
          if (body.width !== undefined) {
            assert.equal(model, 'image-01', label);
            for (const dimension of [body.width, body.height]) assert.ok(dimension >= 512 && dimension <= 2048 && dimension % 8 === 0, label);
            assert.equal(body.aspect_ratio, undefined, label);
          }
          if (model === 'image-01-live') assert.notEqual(body.aspect_ratio, '21:9', label);
        }
        if (provider.id === 'seedream') assert.equal(body.sequential_image_generation, model === 'doubao-seedream-4-5-251128' ? 'disabled' : undefined, label);
        if (provider.id === 'siliconflow') assert.equal(body.image_size === undefined, model === 'Qwen/Qwen-Image-Edit' || model === 'Qwen/Qwen-Image-Edit-2509', label);
        assert.equal(request.stream, false, label);
        assert.ok(!request.diagnosticBody.includes('契约验证') && !request.diagnosticBody.includes('REF'), label);
        parameterCombinations++;
      }
      for (const ref of references) {
        calls = 0;
        globalThis.fetch = async () => {
          calls++;
          const image = { url: 'https://images.example/validated' };
          const body = provider.id === 'siliconflow' ? { images: [image] } : provider.id === 'minimax'
            ? { base_resp: { status_code: 0 }, data: { image_urls: [image.url] } } : provider.id === 'qwen'
              ? qwenOutput([{ image: image.url }]) : provider.id === 'openai' ? { data: [{ b64_json: 'FINAL' }] } : { data: [image] };
          return new Response(JSON.stringify(body));
        };
        const result = await client.generateImage(connection, '契约验证', signal, { reference: ref });
        assert.equal(result.success, true, model);
        assert.equal(result.image.kind, provider.id === 'openai' ? 'base64' : 'url', model);
        assert.equal(calls, 1, model);
      }
      coveredModels.add(model);
    }
  }
  console.log(`供应商协议矩阵验证通过：${coveredModels.size} 个模型，${parameterCombinations} 组参数／参考图组合。`);
  for (const [body, expected] of [
    [{ data: [{ url: 'https://images.example/result' }] }, true],
    [{ data: [] }, false], [{ data: [{}, {}] }, false], [{ data: [null] }, false],
    [{ data: [{ b64_json: ' ', url: 'http://images.example/result' }] }, false],
    [{ data: [{ url: 'broken' }] }, false], [{}, false], [null, false],
  ]) {
    globalThis.fetch = async () => new Response(JSON.stringify(body));
    const result = await client.generateImage(config, '画只猫', signal);
    assert.equal(result.success, expected);
    if (!expected) assert.equal(result.code, 'IMAGE_GENERATION_INVALID_RESPONSE');
  }
  globalThis.fetch = async () => new Response('{invalid json');
  assert.equal((await client.generateImage(config, '画只猫', signal)).code, 'IMAGE_GENERATION_INVALID_RESPONSE');
  for (const [status, code, retryable] of [[401, 'AUTH', false], [403, 'PERMISSION', false], [402, 'QUOTA', false],
    [429, 'SERVICE_BUSY', true], [504, 'SERVER_TIMEOUT', true], [500, 'REQUEST', true]]) {
    calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('secret-key refused', { status }); };
    const result = await client.generateImage(config, '画只猫', signal);
    assert.equal(result.code, `IMAGE_GENERATION_${code}`);
    assert.equal(result.retryable, retryable);
    assert.ok(!result.error.includes('secret-key'));
    assert.equal(calls, 1, '失败不能自动重放计费请求');
  }
  const controller = new AbortController();
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
    controller.abort(new Error('用户取消'));
  });
  await assert.rejects(client.generateImage(config, '画只猫', controller.signal), /用户取消/);
  const realTimeout = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  try {
    globalThis.setTimeout = callback => { queueMicrotask(callback); return 0; };
    globalThis.clearTimeout = () => {};
    globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')));
    });
    const result = await client.generateImage(config, '画只猫', signal);
    assert.equal(result.code, 'IMAGE_GENERATION_LOCAL_TIMEOUT');
    assert.equal(result.retryable, true);
  } finally { globalThis.setTimeout = realTimeout; globalThis.clearTimeout = realClear; }
} finally { globalThis.fetch = originalFetch; }

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
const raw = createSqliteExecutor(db);
await bootstrapSqlite(raw);
const executor = createCoordinatedSqliteFixture(raw).executor;
const persistence = { ...databaseErrors, databaseCoordinator: { openTaskExecutor: () => executor } };
const settings = new (load('src/features/media/infrastructure/SQLiteImageGenerationSettingsRepository.ts', { '@platform/persistence': persistence }).SQLiteImageGenerationSettingsRepository)();
const selectionDomain = load('src/features/media/domain/ImageGenerationConfig.ts');
const models = load('src/features/media/application/ImageGenerationModels.ts', {
  '@shared/runtime/RuntimeSlot': slot, '../domain/ImageGenerationConfig': selectionDomain,
  '@platform/ai/imageGenerationConfig': imageConfigDomain,
});
const assets = new Map();
const imageConfig = { id: 'image-model-1', name: '生图模型', capabilityKind: 'image_generation', baseUrl: config.baseURL, apiKey: config.apiKey, model: config.model, metadataJson: JSON.stringify(config.profile) };
models.configureImageGenerationModels({ repository: settings, getModel: async id => assets.get(id) ?? null, listModels: async () => [...assets.values()] });
assets.set(imageConfig.id, imageConfig);
assert.equal((await models.getImageGenerationModelSettings()).status, 'unconfigured', '首个资产不自动选中');
await assert.rejects(models.resolveImageGenerationModel(), error => error.code === 'IMAGE_GENERATION_UNCONFIGURED');
await models.selectImageGenerationModel(imageConfig.id);

assert.equal(imageConfigDomain.readImageGenerationProfile(null), null);
assert.equal(imageConfigDomain.readImageGenerationProfile('{"provider":"openaiCompatible","compatibleGPTImage":true}'), null);
assert.throws(() => imageConfigDomain.readImageGenerationProfile('{"provider":"unknown"}'), /配置无效/);
assert.deepEqual(JSON.parse(parsedDraft.patch.metadataJson), { provider: 'siliconflow' });
assert.equal((await models.getImageGenerationModelSettings()).status, 'active');
const snapshot = await models.resolveImageGenerationModel();
assets.set(imageConfig.id, { ...imageConfig, model: 'gpt-image-2.5-flare' });
assert.equal(snapshot.model, config.model);
assert.equal((await models.resolveImageGenerationModel()).model, 'gpt-image-2.5-flare');
for (const replacement of [{ ...imageConfig, metadataJson: null },
  { ...imageConfig, metadataJson: '{"provider":"openaiCompatible","compatibleGPTImage":true}' },
  { ...imageConfig, model: 'unsupported-image-model' }, { ...imageConfig, baseUrl: 'https://api.siliconflow.cn/v1' }]) {
  assets.set(imageConfig.id, replacement);
  const unavailable = await models.getImageGenerationModelSettings();
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.capabilities, null);
  assert.equal(await settings.getModelId(), imageConfig.id, '失效配置保留原选择供用户修复');
  await assert.rejects(models.resolveImageGenerationModel(), error => error.code === 'IMAGE_GENERATION_MODEL_UNAVAILABLE');
  await assert.rejects(models.selectImageGenerationModel(imageConfig.id));
}
for (const [replacement, status] of [[null, 'deleted'], [{ ...imageConfig, apiKey: '' }, 'incomplete'], [{ ...imageConfig, capabilityKind: 'ocr' }, 'capability_mismatch']]) {
  if (replacement) assets.set(imageConfig.id, replacement); else assets.delete(imageConfig.id);
  assert.equal(selectionDomain.evaluateImageGenerationModelSelection(imageConfig.id, replacement).status, status);
  assert.equal((await models.getImageGenerationModelSettings()).status, 'unavailable');
  assert.equal(await settings.getModelId(), imageConfig.id);
  await assert.rejects(models.resolveImageGenerationModel(), error => error.code === 'IMAGE_GENERATION_MODEL_UNAVAILABLE');
}
await models.selectImageGenerationModel(null);
assets.set('another', { ...imageConfig, id: 'another' });
assert.equal(await settings.getModelId(), null, '取消后新增资产不能回填');
assets.set(imageConfig.id, imageConfig);
await models.selectImageGenerationModel(imageConfig.id);

let nextId = 0;
const files = new Map();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7ioAAAAASUVORK5CYII=', 'base64');
class File {
  constructor(...parts) { this.uri = parts.join('/'); }
  get exists() { return files.has(this.uri); }
  get size() { return files.get(this.uri).length; }
  async bytes() { return files.get(this.uri); }
  async base64() { return files.get(this.uri).toString('base64'); }
  write(value) { files.set(this.uri, Buffer.from(value, 'base64')); }
  delete() { files.delete(this.uri); }
}
const fileSystem = { File, Paths: { cache: 'file:///cache' } };
const inspector = load('src/platform/device/InspectLocalImage.ts', {
  'expo-file-system': fileSystem, 'react-native': { Image: { getSize: async () => ({ width: 1, height: 1 }) } },
  './ImageAnimation': load('src/platform/device/ImageAnimation.ts', { 'expo-file-system': fileSystem }),
});
let generationCalls = 0;
let preparedRequest;
let onGeneration = async () => {};
let imageResponse = { kind: 'base64', base64: png.toString('base64') };
let downloaded = 0;
const prepare = load('src/features/media/application/PrepareGeneratedImage.ts', {
  'expo-file-system': fileSystem, '@platform/device': { ...inspector, createRandomUUID: () => `id-${++nextId}` },
  '@platform/ai': { generateImage: async (connection, prompt, _signal, options) => {
    generationCalls++; preparedRequest = imageRequest.buildImageGenerationRequest(connection, prompt, options.parameters ?? {}, options.reference, false);
    await onGeneration(); return { success: true, image: imageResponse };
  } },
  '@platform/web': { downloadWebImage: async (_url, _name, signal) => {
    abort.throwIfAbortSignalAborted(signal); downloaded++;
    const uri = `file:///cache/download-${nextId++}`; files.set(uri, png); return { ok: true, data: { uri } };
  } },
  '@shared/runtime/abortSignal': abort, './ImageGenerationModels': models,
  '@platform/ai/imageGenerationConfig': imageConfigDomain,
});
imageResponse = { kind: 'base64', base64: 'unreadable' };
await assert.rejects(prepare.prepareGeneratedImage('图片', new AbortController().signal), inspector.ImageFileReadError);
assert.equal(files.size, 0, '无效图片清理暂存');
imageResponse = { kind: 'url', url: 'https://images.example/signed' };
const urlImage = await prepare.prepareGeneratedImage('图片', new AbortController().signal);
assert.equal(downloaded, 1);
assert.match(urlImage.fileName, /\.png$/);
urlImage.cleanup();
imageResponse = { kind: 'base64', base64: png.toString('base64') };
await assert.rejects(prepare.prepareGeneratedImage('  ', new AbortController().signal), error => error.code === 'IMAGE_GENERATION_PROMPT_REQUIRED');
const beforeUnsupported = generationCalls;
await assert.rejects(prepare.prepareGeneratedImage('图片', new AbortController().signal, undefined, { parameters: { resolution: '4K' } }), error => error.code === 'IMAGE_GENERATION_PARAMETERS_UNSUPPORTED');
assert.equal(generationCalls, beforeUnsupported, '不支持的参数在计费请求之前明确拒绝');
for (const [id, patch, reason] of [
  ['minimax', { byteSize: 10_000_000 }, /10 MB/], ['minimax', { mimeType: 'image/webp' }, /JPEG/],
  ['qwen', { byteSize: 10_000_001 }, /10 MB/], ['qwen', { width: 8001 }, /8000/], ['qwen', { width: 8000, height: 500 }, /10:1/],
  ['seedream', { byteSize: 30_000_001 }, /30 MB/], ['seedream', { width: 6001, height: 6000 }, /3600/],
  ['openai', { byteSize: 50_000_000 }, /50 MB/],
]) {
  const provider = imageConfigDomain.IMAGE_GENERATION_PROVIDERS.find(provider => provider.id === id);
  assets.set(imageConfig.id, { ...imageConfig, baseUrl: provider.baseURL, model: provider.models[0], metadataJson: JSON.stringify({ provider: id }) });
  await assert.rejects(prepare.prepareGeneratedImage('参考图边界', new AbortController().signal, undefined,
    { reference: { uri: 'file:///not-read.png', ...referenceInfo, ...patch } }), error => error instanceof inspector.ImageFileReadError && reason.test(error.message));
  assert.equal(generationCalls, beforeUnsupported, '供应商上传限制在文件读取和计费之前拒绝');
}
assets.set(imageConfig.id, { ...imageConfig, baseUrl: 'https://api.siliconflow.cn/v1', model: 'Tongyi-MAI/Z-Image', metadataJson: '{"provider":"siliconflow"}' });
await assert.rejects(prepare.prepareGeneratedImage('参考人像', new AbortController().signal, undefined,
  { reference: { uri: 'file:///reference.png', mimeType: 'image/png', width: 1024, height: 1024, byteSize: 100 } }), error => error.code === 'IMAGE_GENERATION_PARAMETERS_UNSUPPORTED');
assert.equal(generationCalls, beforeUnsupported, 'Z-Image 参考图在文件读取和计费前拒绝，不切换到 edits');
for (const model of ['Qwen/Qwen-Image-Edit', 'Qwen/Qwen-Image-Edit-2509']) {
  assets.set(imageConfig.id, { ...imageConfig, baseUrl: 'https://api.siliconflow.cn/v1', model, metadataJson: '{"provider":"siliconflow"}' });
  await assert.rejects(prepare.prepareGeneratedImage('换成油画', new AbortController().signal), error => error.code === 'IMAGE_GENERATION_PARAMETERS_UNSUPPORTED' && /参考图/.test(error.message));
  assert.equal(generationCalls, beforeUnsupported, '编辑模型缺少参考图时不能发起计费请求');
}
assets.set(imageConfig.id, { ...imageConfig, metadataJson: '{"provider":"openaiCompatible","compatibleGPTImage":true}' });
await assert.rejects(prepare.prepareGeneratedImage('旧配置', new AbortController().signal), error => error.code === 'IMAGE_GENERATION_MODEL_UNAVAILABLE');
assert.equal(generationCalls, beforeUnsupported, '旧自定义高级配置不能继续发请求');
const referenceUri = 'file:///reference.png';
files.set(referenceUri, png);
for (const model of ['Qwen/Qwen-Image-Edit', 'Qwen/Qwen-Image-Edit-2509', 'Kwai-Kolors/Kolors']) {
  assets.set(imageConfig.id, { ...imageConfig, baseUrl: 'https://api.siliconflow.cn/v1', model, metadataJson: '{"provider":"siliconflow"}' });
  const image = await prepare.prepareGeneratedImage('换成油画', new AbortController().signal, undefined, { reference: { uri: referenceUri, mimeType: 'image/png', width: 1, height: 1, byteSize: png.length } });
  const payload = JSON.parse(preparedRequest.body);
  assert.equal(payload.model, model);
  assert.equal(payload.image, `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(preparedRequest.url, 'https://api.siliconflow.cn/v1/images/generations');
  assert.equal(payload.image_size, model === 'Kwai-Kolors/Kolors' ? '1024x1024' : undefined);
  image.cleanup();
  assert.ok(files.has(referenceUri), '生成结果清理不接管调用方的参考图生命周期');
}
files.delete(referenceUri);
assets.set(imageConfig.id, imageConfig);

const backing = load('src/features/media/application/MediaAssetBacking.ts');
const { SQLiteMediaAssetRepository } = load('src/features/media/infrastructure/SQLiteMediaAssetRepository.ts');
const media = new SQLiteMediaAssetRepository(executor);
const catalog = new (load('src/features/media/application/MediaAssetCatalog.ts', { './MediaAssetBacking': backing }).MediaAssetCatalog)(media);
let afterPrepare = () => {};
const writer = {
  storageBackend: 'persistent-media',
  async prepare({ assetId, sourceUri }) {
    const storageKey = `catalog/${assetId}.png`; const localUri = `file:///persistent/${storageKey}`;
    files.set(localUri, files.get(sourceUri)); afterPrepare(); return { storageBackend: this.storageBackend, storageKey, localUri };
  },
  commitPrepared() {}, async delete(key) { files.delete(`file:///persistent/${key}`); },
  async resolve(key) { return { localUri: `file:///persistent/${key}` }; },
};
const creator = new (load('src/features/media/application/CreateMediaAsset.ts').CreateMediaAsset)({
  database: executor, catalog, backings: new backing.MediaAssetBackingRegistry({ writers: [writer] }),
  contentInspector: { inspect: async uri => ({ byteSize: files.get(uri).length, contentHash: createHash('sha256').update(files.get(uri)).digest('hex') }) },
  generateId: () => `media-${++nextId}`, now: () => new Date().toISOString(), reportPostCommitCleanupFailure: error => { throw error; },
});
const mediaRuntime = load('src/features/media/application/MediaAssetRuntime.ts', { '@shared/runtime/RuntimeSlot': slot });
mediaRuntime.configureMediaAssetRuntime({ creator });
const aiRuntime = load('src/features/media/application/AIImageRuntime.ts', { '@shared/runtime/RuntimeSlot': slot });
const generated = new (load('src/features/media/infrastructure/SQLiteAIGeneratedImageRepository.ts', { '@platform/device': { createRandomUUID: () => `generated-${++nextId}` } }).SQLiteAIGeneratedImageRepository)();
const turns = new (load('src/features/chat/reply/infrastructure/SQLiteConversationTurnRepository.ts', {
  './ChatReplyVersionSql': load('src/features/chat/reply/infrastructure/ChatReplyVersionSql.ts'),
  '@platform/persistence': {}, '../../messages/infrastructure/ChatMessageMutationSql': {},
  './ChatTurnPresentationSql': load('src/features/chat/reply/infrastructure/ChatTurnPresentationSql.ts', {
    '../../messages/infrastructure/SQLiteMessageRepository': {}, '../../messages/domain/chatMessageMetadata': {},
  }),
  '../../messages/infrastructure/SQLiteMessageRepository': {}, '../domain/ConversationTurn': {}, '../../messages/domain': {},
}).ConversationTurnRepository)();
const groups = new (load('src/features/chat/group/infrastructure/SQLiteGroupChatRepository.ts', {
  '@platform/persistence': {}, '@features/media': {}, '@features/profile': {}, '@features/assistants': {},
}).GroupChatRepository)();
const fence = load('src/host/composition/agent/assertImageToolRunCurrent.ts', {
  '@platform/agentRuntime': load('src/platform/agentRuntime/AgentRunState.ts'), '@shared/runtime/abortSignal': abort,
  '@features/chat': { isChatReplyRunCurrentInTransaction: (tx, id) => turns.isRunCurrentInTransaction(tx, id),
    isGroupSpeechTaskRunCurrentInTransaction: (tx, id) => groups.isSpeechTaskRunCurrentInTransaction(tx, id) },
});
aiRuntime.configureAIImageRuntime({ generated, assertCurrent: fence.assertImageToolRunCurrent });
const { GenerateImageTool } = load('src/features/media/application/GenerateImageTool.ts', {
  '@shared/runtime/abortSignal': abort, './AIImageRuntime': aiRuntime, './ImageGenerationModels': models,
  './PrepareGeneratedImage': prepare, './MediaAssetRuntime': mediaRuntime, './MediaAssetBacking': backing,
  './MediaImageToolResult': { mediaImageFailure: () => null },
  '@platform/ai/imageGenerationConfig': imageConfigDomain, '@platform/device': inspector,
});
const now = new Date().toISOString();
for (const id of ['one', 'two']) db.prepare('INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, id, id, 'model', now, now);
const actor = (assistantId = 'one', signal = new AbortController().signal) => ({ task: { assistantId, source: 'manual' }, abortSignal: signal, runId: 'run', toolCallId: 'generate' });
const first = await GenerateImageTool.execute({ prompt: '图片' }, actor());
const second = await GenerateImageTool.execute({ prompt: '图片' }, actor('two'));
assert.equal(first.status, 'success');
assert.equal(first.metadata, undefined, '生成不冒充可见消息');
assert.equal(first.data.mediaAssetId, second.data.mediaAssetId, '相同内容复用身份');
assert.equal(db.prepare('SELECT count(*) n FROM ai_generated_images').get().n, 2, '复用身份仍创建角色自己的引用');
assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n, 0);
assert.equal(files.size, 1, '只保留最终持久 backing');
const send = load('src/features/chat/reply/agent/SendImageTool.ts', {
  '@features/media': { resolveMediaAsset: async id => ({ asset: await media.getById(id) }), mediaImageFailure: () => null },
  '@shared/aiTools': load('src/shared/aiTools/ToolCompletionIntent.ts'), '@shared/runtime/abortSignal': abort,
});
const sent = await send.SendImageTool.execute({ media_asset_id: first.data.mediaAssetId, on_success: 'finish' }, actor());
assert.equal(sent.data.attachment.mediaAssetId, first.data.mediaAssetId);
assert.equal(sent.data.attachment.type, 'image');
const cancelled = new AbortController();
afterPrepare = () => cancelled.abort(new Error('已取消'));
await assert.rejects(GenerateImageTool.execute({ prompt: '图片' }, actor('one', cancelled.signal)), /已取消/);
afterPrepare = () => {};
assert.equal(files.size, 1, '取消清理未提交 backing 与暂存');
db.exec(`INSERT INTO chat_conversations(id,kind) VALUES('chat','direct');
  INSERT INTO conversation_turn_runs(run_id,session_id,kind,reply_cursor_at_claim,input_high_watermark,revision_at_claim,status,created_at)
  VALUES('run','chat','user_reply',0,1,1,'active','${now}');
  INSERT INTO conversation_turn_state(session_id,revision,active_run_id,updated_at) VALUES('chat',1,'run','${now}');`);
onGeneration = () => turns.supersedeActiveRunInTransaction(raw, 'chat', now);
await assert.rejects(GenerateImageTool.execute({ prompt: '图片' }, { ...actor(), task: { assistantId: 'one', source: 'chat' } }), error => error.cause?.code === 'SUPERSEDED');
db.exec(`INSERT INTO chat_conversations(id,kind) VALUES('group','group');
  INSERT INTO group_chats(id,name,created_at,updated_at) VALUES('group','群','${now}','${now}');
  INSERT INTO group_speech_plans(id,group_id,status,created_at,updated_at) VALUES('plan','group','running','${now}','${now}');
  INSERT INTO group_speech_tasks(id,plan_id,group_id,ai_assistant_id,agent_id,sequence_order,source,status,created_at,updated_at)
  VALUES('task','plan','group','one','one',1,'admin','running','${now}','${now}');`);
onGeneration = async () => db.exec("UPDATE group_speech_plans SET status='terminated' WHERE id='plan'");
await assert.rejects(GenerateImageTool.execute({ prompt: '图片' }, { ...actor(), runId: 'task', task: { assistantId: 'one', source: 'chat', type: 'group_chat_reply' } }), error => error.cause?.code === 'SUPERSEDED');
onGeneration = async () => {};
db.exec("CREATE TRIGGER fail_generated BEFORE INSERT ON ai_generated_images BEGIN SELECT RAISE(ABORT,'generated commit failed'); END");
await assert.rejects(GenerateImageTool.execute({ prompt: '图片' }, actor()), /generated commit failed/);
db.exec('DROP TRIGGER fail_generated');
assert.equal(db.prepare('SELECT count(*) n FROM ai_generated_images').get().n, 2);
assert.equal(files.size, 1);
await models.selectImageGenerationModel(null);
const callsBefore = generationCalls;
assert.equal((await GenerateImageTool.execute({ prompt: '图片' }, actor())).code, 'IMAGE_GENERATION_UNCONFIGURED');
assert.equal(generationCalls, callsBefore);
await models.selectImageGenerationModel(imageConfig.id);

let saves = 0;
let failSave = true;
const user = load('src/features/media/application/GenerateImageForUser.ts', {
  './PrepareGeneratedImage': prepare, '@shared/runtime/abortSignal': abort,
  '@platform/device': { saveImageToGallery: async () => { saves++; if (failSave) throw new Error('存储空间不足'); return { uri: 'content://media/1' }; } },
});
const pending = await user.generateImageForUser('图片', new AbortController().signal);
assert.equal(pending.status, 'save_failed');
assert.equal(files.size, 2, '保存失败保留用户暂存');
const beforeRetry = generationCalls;
failSave = false;
assert.equal((await user.saveUserGeneratedImage(pending.image, new AbortController().signal)).status, 'saved');
assert.equal(generationCalls, beforeRetry, '重试保存不能重新生成');
assert.equal(files.size, 1);
assert.equal(saves, 2);
assert.equal(db.prepare('SELECT count(*) n FROM ai_generated_images').get().n, 2, '用户生图不进入生成业务表');
assert.equal((await media.auditDatabase()).references.filter(r => r.kind === 'ai_generated_image').length, 2);
assert.equal((await executor.withExclusiveTransactionAsync(tx => media.releaseUnreferencedAssetsInTransaction(tx, [first.data.mediaAssetId]))).length, 0);
assert.ok((await media.listAssistantMediaAssetIds('two', raw)).includes(first.data.mediaAssetId));
db.prepare('DELETE FROM ai_assistants WHERE id=?').run('two');
assert.equal(db.prepare('SELECT count(*) n FROM ai_generated_images').get().n, 1);
assert.equal((await executor.withExclusiveTransactionAsync(tx => media.releaseUnreferencedAssetsInTransaction(tx, [first.data.mediaAssetId]))).length, 0);
db.prepare('INSERT INTO messages(session_id,text,is_me,sender_type,created_at,metadata_json) VALUES(?,?,?,?,?,?)')
  .run('group', '', 0, 'assistant', now, JSON.stringify({ kind: 'image', attachments: [{ id: 'sent', type: 'image', source: 'media_library', fileName: 'image.png', mediaAssetId: first.data.mediaAssetId }] }));
db.prepare('DELETE FROM ai_assistants WHERE id=?').run('one');
assert.equal(db.prepare('SELECT count(*) n FROM ai_generated_images').get().n, 0);
assert.equal((await executor.withExclusiveTransactionAsync(tx => media.releaseUnreferencedAssetsInTransaction(tx, [first.data.mediaAssetId]))).length, 0, '角色删除后群消息仍持有图片');
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
db.close();
console.log('生图行为验证通过：协议/脱敏/超时、选择快照、用户相册/私有引用分离、取消/双 fence、内容复用与保存重试。');

await import('./verify-image-generation-presentation.mjs');
