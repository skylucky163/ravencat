/** 验证真实接口边界、模型设置与图片识别界面保留失败原因，且凭据不离开边界。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
function load(file, dependencies = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(name => {
    assert.ok(Object.hasOwn(dependencies, name), `${file} 未装配依赖 ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const mapping = load('src/platform/ai/errorMapping.ts');
for (const httpStatus of [408, 504]) {
  assert.equal(mapping.getErrorDisplayInfo('', { httpStatus }).type, 'timeout', '无正文的超时状态也须保留分类');
}
const baseUrl = load('src/platform/ai/baseUrl.ts');
const { BaseAIClient } = load('src/platform/ai/BaseAIClient.ts', {
  './errorMapping': mapping, './baseUrl': baseUrl,
  './HttpExchangeCapture': { beginAIHttpCapture: async () => null },
});
const createAIClient = config => new BaseAIClient(config);
const connection = load('src/platform/ai/connectionTest.ts', { './OpenAIClient': { createAIClient } });
const discovery = load('src/platform/ai/modelDiscovery.ts', { './errorMapping': mapping, './baseUrl': baseUrl });
const platform = { ...mapping, ...connection, ...discovery, createAIClient };
const service = load('src/features/assistants/application/AIModelService.ts', { '@platform/ai': platform });
const { testAuxiliaryModelConnection } = load('src/features/assistants/TestAuxiliaryModelConnection.ts', { '@platform/ai': platform });
const apiKey = 'sk-private"/error-key';
const reason = 'unsupported multipart type for this model, only support text and audio';
const config = { apiBaseUrl: 'https://example.test/v1', apiKey, selectedModel: 'test-model' };
let status = 400, body = JSON.stringify({ error: { code: 'invalid_request_error', message: reason, echoedKey: apiKey } });
const original = { fetch: globalThis.fetch, warn: console.warn, log: console.log };
const assertSafe = text => {
  for (const secret of [apiKey, JSON.stringify(apiKey).slice(1, -1), encodeURIComponent(apiKey)]) {
    assert.ok(!text.includes(secret), '原文及转义凭据不能离开传输边界');
  }
};
try {
  console.warn = console.log = () => {};
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return new Response(body, { status }); };
  const failed = await service.runConnectionTestByConfig(config);
  assert.ok(failed.errorInfo.message.includes(reason));
  assert.ok(failed.rawError.includes('HTTP 400'));
  assertSafe(failed.errorInfo.message);
  for (const capabilityKind of ['summary', 'ocr', 'embedding']) {
    const result = await testAuxiliaryModelConnection({ baseUrl: config.apiBaseUrl, apiKey, model: config.selectedModel, capabilityKind });
    assert.ok(result.errorInfo.message.includes(reason));
    assertSafe(result.errorInfo.message);
  }
  assert.equal(requests, 4, '失败不得暗中重试或额外探测模型');

  for (const [httpStatus, responseBody, type] of [
    [429, JSON.stringify({ error: { code: 'quota_limit', message: 'rate limit exceeded for tenant demo' } }), 'service_busy'],
    [401, 'provider credential rejected', 'auth'],
    [400, `proxy rejected request: ${apiKey}`, 'request'],
  ]) {
    status = httpStatus; body = responseBody;
    const models = await service.fetchModelsWithConfig(config);
    assert.equal(models.errorInfo.type, type);
    assert.ok(models.errorInfo.message.includes(`HTTP ${status}`));
    assert.ok(models.errorInfo.message.includes(mapping.redactAIErrorMessage(body, apiKey)));
    assertSafe(models.errorInfo.message);
  }
  globalThis.fetch = async () => { throw new Error(`Network request failed: rejected ${encodeURIComponent(apiKey)}`); };
  const network = await service.fetchModelsWithConfig(config);
  assert.equal(network.errorInfo.type, 'network');
  assert.ok(network.errorInfo.message.includes('rejected [REDACTED]'));
  assertSafe(network.errorInfo.message);

  // 真实传输边界返回的超时交给 Chat 图片解析，主模型只收到分类后的说明。
  const { resolveChatImageModelInput } = load('src/features/chat/reply/application/ResolveChatImageModelInput.ts', {
    '@platform/ai': platform,
    '@shared/runtime/abortSignal': load('src/shared/runtime/abortSignal.ts'),
    './ReplyTaskPromptBlocks': { buildVisionOCRPromptBlocks: () => [] },
    './ChatReplyRuntimeDependencies': { getChatReplyRuntimeDependencies: () => ({
      media: { readVisionImage: async () => ({ base64: 'IMAGE', mimeType: 'image/png' }) },
      vision: { resolveOCRModel: async () => ({ status: 'active', model: {
        modelConfigId: 'vision', baseURL: config.apiBaseUrl, apiKey, model: 'vision',
      } }) },
      prompt: { resolveVisionOCRPrompt: async () => '读取图片', assembleStandalone: async () => ({ systemPrompt: '读取图片' }) },
    }) },
  });
  for (const failure of [
    { status: 408, body: '', timedOut: true },
    { status: 504, body: 'Gateway Timeout', timedOut: true },
    { status: 504, body: 'service unavailable', timedOut: true },
    { status: 400, body: 'image_url request timed out', timedOut: true },
    { status: 500, body: `图片识别超时，凭据 ${apiKey}`, timedOut: true },
    { error: new Error('Network request timed out'), timedOut: true },
    { status: 500, body: 'upstream service failed', timedOut: false },
    { status: 401, body: 'Unauthorized', timedOut: false },
  ]) {
    const before = requests;
    globalThis.fetch = async () => {
      requests++;
      if (failure.error) throw failure.error;
      return new Response(failure.body, { status: failure.status });
    };
    const result = await resolveChatImageModelInput({ assistantId: 'ai', mediaAssetId: 'image', contextText: '用户发送图片' });
    const modelText = result.parts.map(part => part.text).join('\n');
    assert.equal(result.ocrSucceeded, false);
    assert.ok(result.parts.every(part => part.type === 'text'), '识别失败不得改为向主模型传原图');
    assert.ok(modelText.includes(failure.timedOut ? 'OCR 超时' : 'OCR 失败'));
    assert.ok(modelText.includes('你没有收到图片内容'));
    assertSafe(modelText);
    assert.equal(modelText.includes('image_url request timed out'), false, '原始服务商报错不进入模型输入');
    assert.equal(requests, before + 1, '识别失败只分类，不额外重试');
  }

  status = 400; body = JSON.stringify({ error: { message: 'temperature must be 1; provider-specific detail' } });
  globalThis.fetch = async () => new Response(body, { status });
  let alert;
  const { default: renderConnectionTest } = load('src/features/assistants/presentation/management/AIModelSettings/useConnectionTest.ts', {
    react: { useState: value => [value, () => {}], useCallback: callback => callback },
    '../../../application/AIModelService': service,
    '../sharedModelConfig': service,
  });
  await renderConnectionTest({ ...config, getConnectionParams: () => ({}), onShowAlert: (...args) => { alert = args; } }).handleTestConnection();
  assert.ok(alert[1].includes('provider-specific detail'), '参数专用弹窗同样保留接口说明');

  const { MomentImageAnalysisError } = load('src/features/moments/domain/MomentImageAnalysis.ts');
  const { executeMomentImageAnalysis } = load('src/host/composition/MomentImageAnalysisModelGateway.ts', {
    'expo-file-system/legacy': {}, '@features/media': { resolveMediaAsset: async () => ({ localUri: 'file:///image.jpg', asset: { mimeType: 'image/jpeg' } }) },
    '@platform/ai': platform, '@platform/device': { persistentMediaStore: { readAsBase64: async () => 'IMAGE' } },
    '@features/moments': { MomentImageAnalysisError },
  });
  body = JSON.stringify({ error: { message: reason, echoedKey: apiKey } });
  await assert.rejects(executeMomentImageAnalysis({ mediaAssetId: 'image', model: { baseUrl: config.apiBaseUrl, apiKey, model: 'audio-only' } }), error => {
    assert.ok(error instanceof MomentImageAnalysisError);
    assert.equal(error.code, 'model_request_failed');
    assert.ok(error.message.includes(reason));
    assertSafe(error.message);
    return true;
  });

  const element = (type, props, ...children) => ({ type, props: { ...props, children: children.flat() } });
  const react = { default: { createElement: element }, useState: value => [value, () => {}],
    useEffect: () => {}, useMemo: callback => callback(), useRef: () => ({ current: null }) };
  const { default: Viewer } = load('src/features/moments/presentation/MomentMediaViewerModal.tsx', {
    react,
    'react-native': { ...Object.fromEntries(['ActivityIndicator', 'FlatList', 'Modal', 'Text', 'TextInput', 'TouchableOpacity', 'View'].map(name => [name, name])),
      StyleSheet: { create: styles => styles }, useWindowDimensions: () => ({ width: 400, height: 800 }) },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    'lucide-react-native': { X: 'X' }, '@shared/ui': { showAppDialog: value => { alert = value; } },
    '@features/media': { MediaAssetImage: 'Image' },
    '../presentationFacade': { retryMomentMediaAnalysis: async () => ({ success: false, errorMessage: reason }), saveMomentMediaAnalysis: async () => {} },
  });
  const tree = Viewer({ visible: true, media: [{ id: 'image', analysisStatus: 'failed', analysisErrorMessage: reason }], initialIndex: 0, canManage: true, onClose() {}, onUpdated() {} });
  function findAction(node, label) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'TouchableOpacity' && node.props.children.some(child => child?.props?.children?.includes(label))) return node;
    for (const child of node.props?.children ?? []) { const found = findAction(child, label); if (found) return found; }
  }
  findAction(tree, '失败原因').props.onPress();
  assert.equal(alert.message, reason, '重新打开图片可查看持久化原因');
  await findAction(tree, '重新识别').props.onPress();
  assert.ok(alert.message.includes(reason), '手动重试弹窗保留本次失败原因');
} finally {
  globalThis.fetch = original.fetch; console.warn = original.warn; console.log = original.log;
}
console.log('模型错误展示：模型列表、普通/辅助/向量连接测试、参数弹窗、时刻接口与页面、凭据脱敏通过。');
