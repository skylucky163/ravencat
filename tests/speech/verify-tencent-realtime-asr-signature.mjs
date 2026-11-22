import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const signerPath = resolve('src/features/speech/infrastructure/tencentRealtimeASRSignature.ts');
const source = readFileSync(signerPath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const runtimeModule = { exports: {} };
runInNewContext(compiled, {
  module: runtimeModule,
  exports: runtimeModule.exports,
  TextEncoder,
  encodeURIComponent,
  Math,
  Date,
  Error,
});

const { createTencentRealtimeASRSignedUrl } = runtimeModule.exports;
const signedUrl = createTencentRealtimeASRSignedUrl({
  baseURL: 'wss://asr.cloud.tencent.com/asr/v2',
  appId: '1259220000',
  secretId: 'AKIDEXAMPLE',
  secretKey: 'SECRET_KEY_EXAMPLE',
  engineModelType: '16k_zh',
  voiceId: 'kimi_signature_contract',
  voiceFormat: 1,
  needVad: 1,
  filterEmptyResult: 1,
  timestamp: 1673408372,
  expired: 1673411972,
  nonce: 8743357,
});

const signatureMarker = '&signature=';
const signatureIndex = signedUrl.lastIndexOf(signatureMarker);
assert.ok(signatureIndex > 0, '签名 URL 必须包含 signature 参数');

const signatureSource = signedUrl.slice('wss://'.length, signatureIndex);
assert.equal(
  signatureSource,
  'asr.cloud.tencent.com/asr/v2/1259220000?engine_model_type=16k_zh&expired=1673411972&filter_empty_result=1&needvad=1&nonce=8743357&secretid=AKIDEXAMPLE&timestamp=1673408372&voice_format=1&voice_id=kimi_signature_contract',
  '腾讯实时 ASR 签名原文必须按参数名排序'
);

const actualSignature = decodeURIComponent(signedUrl.slice(signatureIndex + signatureMarker.length));
const expectedSignature = createHmac('sha1', 'SECRET_KEY_EXAMPLE')
  .update(signatureSource)
  .digest('base64');
assert.equal(actualSignature, expectedSignature, '设备端 HMAC-SHA1 结果必须与 Node 标准库一致');

const clientPath = resolve('src/features/speech/infrastructure/TencentRealtimeASRClient.ts');
const clientSource = readFileSync(clientPath, 'utf8');
const clientCompiled = ts.transpileModule(clientSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;

const sockets = [];
class FakeWebSocket {
  static OPEN = 1;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    sockets.push(this);
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = 3;
  }

  emitMessage(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  emitError() {
    this.onerror?.({ message: 'HTTP 401: authorization failed' });
  }

  emitClose() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const clientRuntimeModule = { exports: {} };
runInNewContext(clientCompiled, {
  module: clientRuntimeModule,
  exports: clientRuntimeModule.exports,
  WebSocket: FakeWebSocket,
  setTimeout, clearTimeout,
  Error,
  JSON,
  Number,
  String,
});
const { TencentRealtimeASRClient } = clientRuntimeModule.exports;

let intentionalCloseErrorCount = 0;
let intentionalCloseEventCount = 0;
const intentionalCloseClient = new TencentRealtimeASRClient({
  signedUrl: 'wss://example.test/intentional-close',
  handlers: {
    onError: () => {
      intentionalCloseErrorCount += 1;
    },
    onClosed: () => {
      intentionalCloseEventCount += 1;
    },
  },
});
const intentionalConnectionPromise = intentionalCloseClient.connect();
const intentionalSocket = sockets.at(-1);
intentionalSocket.emitMessage({ code: 0, voice_id: 'intentional-close' });
const intentionalConnection = await intentionalConnectionPromise;
intentionalConnection.close();
intentionalSocket.emitError();
intentionalSocket.emitClose();
assert.equal(intentionalCloseErrorCount, 0, '主动关闭后的 WebSocket 尾错误必须被忽略');
assert.equal(intentionalCloseEventCount, 1, '主动关闭仍需通知连接已经结束');

let unexpectedErrorCount = 0;
const failedClient = new TencentRealtimeASRClient({
  signedUrl: 'wss://example.test/unexpected-error',
  handlers: {
    onError: () => {
      unexpectedErrorCount += 1;
    },
  },
});
const failedConnectionPromise = failedClient.connect();
const failedSocket = sockets.at(-1);
failedSocket.emitError();
await assert.rejects(failedConnectionPromise, /WebSocket 网络失败.*HTTP 401.*authorization failed/);
assert.equal(unexpectedErrorCount, 1, '意外连接错误仍需上报');

let cancelledErrorCount = 0;
const cancelledClient = new TencentRealtimeASRClient({
  signedUrl: 'wss://example.test/cancelled',
  handlers: {
    onError: () => {
      cancelledErrorCount += 1;
    },
  },
});
const abortController = new AbortController();
const cancelledConnectionPromise = cancelledClient.connect(abortController.signal);
const cancelledSocket = sockets.at(-1);
abortController.abort();
cancelledSocket.emitError();
cancelledSocket.emitClose();
await assert.rejects(cancelledConnectionPromise, /connection cancelled/);
assert.equal(cancelledErrorCount, 0, '取消握手属于主动关停，不得上报连接错误');

console.log('腾讯实时 ASR 本地签名与主动关停契约检查通过。');
