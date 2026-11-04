import { sharedMomentIntent, chatSharingDependencies } from './helpers/chat-sharing-fixture.mjs';
/**
 * Chat 语音消息链路行为验证（lifecycle / 失败清理 / provider 契约 / 播放状态）。
 *
 * 这里只覆盖能被 Node 确定性复现的部分：TS lifecycle 用 fake port 驱动，
 * Kotlin 用源码契约断言。真机专属场景在文件末尾显式列出。
 *
 * 依赖仓库统一的 Node 22.13+ 运行时。
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { act, create } from 'react-test-renderer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/** 以 CommonJS 方式编译单个 TS 模块，并按显式 mock 表解析依赖。 */
function loadTypeScriptModule(relativePath, mocks = {}) {
  const absolutePath = path.join(repoRoot, relativePath);
  const compiled = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
    },
    fileName: absolutePath,
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(errors, [], `${relativePath} 无法编译`);

  const module = { exports: {} };
  const requireMock = (specifier) => {
    assert.ok(
      Object.hasOwn(mocks, specifier),
      `${relativePath} 存在未声明的运行时依赖：${specifier}`,
    );
    return mocks[specifier];
  };
  const executeModule = new Function(
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    compiled.outputText,
  );
  executeModule(module.exports, requireMock, module, absolutePath, path.dirname(absolutePath));
  return module.exports;
}

/** 收集 console.warn / console.info，避免测试输出噪声并断言“只报告不抛出”。 */
function captureConsole() {
  const originals = { warn: console.warn, info: console.info };
  const warned = [];
  console.warn = (...args) => warned.push(args.join(' '));
  console.info = () => undefined;
  return {
    warned,
    restore() {
      console.warn = originals.warn;
      console.info = originals.info;
    },
  };
}

let passed = 0;
const failures = [];
async function scenario(name, fn) {
  const consoleCapture = captureConsole();
  try {
    await fn();
    passed += 1;
    console.error(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  ✗ ${name}`);
    console.error('    ' + (error instanceof Error ? (error.stack||error.message) : String(error)));
  } finally {
    consoleCapture.restore();
  }
}

// ============================================================================
// fake ports：录音 / transcription / media / voice metadata / chat commit
// ============================================================================

/** 可手动推进的 deferred，用于精确制造 pending start 竞态。 */
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFakeVoiceMetadataModule() {
  return {
    buildChatVoiceMessageMetadata: (voice) => ({ kind: 'voice', voice }),
  };
}

function createFakeChatMessageModule() {
  return {};
}

function createFakeReplyTypesModule() {
  return {};
}

function createMediaMock({
  failPrepare = false,
  failFinalize = false,
  // catalog 复用既有 asset 时，commitInTransaction 返回的是历史 catalog row 的
  // metadata，可能与本次业务链路测得的时长不同。默认与业务时长一致（1200），
  // 只有专门验证「复用 asset metadata 不得覆盖业务 duration」的场景才传不同值。
  committedAssetDurationMs = 1200,
} = {}) {
  const created = [];
  const discardAfterRollbackCalls = [];
  const finalizeAfterCommitCalls = [];
  const commitInTransactionCalls = [];
  // 每次 prepareMediaAssetBatch 返回独立 batch 实例，才能准确统计每个场景的调用次数。
  function createBatch(inputs) {
    const batch = {
      state: 'open',
      async commitInTransaction() {
        if (this.state !== 'open') {
          throw new Error('PreparedMediaAssetBatch 只能从 open 提交一次');
        }
        commitInTransactionCalls.push(true);
        this.state = 'staged';
        return {
          assets: [{
            id: `asset-${media.__batches.indexOf(this) + 1}`,
            mimeType: 'audio/wav',
            durationMs: committedAssetDurationMs,
          }],
        };
      },
      async finalizeAfterCommit() {
        if (this.state === 'finalized') return;
        if (this.state !== 'staged' && this.state !== 'committed') {
          throw new Error('PreparedMediaAssetBatch 只能从 staged/committed finalize');
        }
        finalizeAfterCommitCalls.push(true);
        this.state = 'committed';
        if (failFinalize) throw new Error('finalize cleanup boom');
        this.state = 'finalized';
      },
      async discardAfterRollback() {
        if (this.state === 'discarded') return;
        if (this.state === 'committed' || this.state === 'finalized') {
          throw new Error('已提交 batch 不能按 rollback discard');
        }
        discardAfterRollbackCalls.push(true);
        this.state = 'discarded';
      },
      __inputs: inputs,
    };
    return batch;
  }
  const media = {
    MEDIA_ASSET_STORAGE_BACKEND: { persistentMedia: 'persistent-media' },
    async prepareMediaAssetBatch(inputs) {
      if (failPrepare) throw new Error('media prepare boom');
      created.push(...inputs);
      const batch = createBatch(inputs);
      media.__batches.push(batch);
      return batch;
    },
    __created: created,
    __batches: [],
    __discardAfterRollbackCalls: discardAfterRollbackCalls,
    __finalizeAfterCommitCalls: finalizeAfterCommitCalls,
    __commitInTransactionCalls: commitInTransactionCalls,
  };
  return media;
}

function createSpeechMock({
  transcriptionResult = { success: true, text: '识别出的文本' },
  failStart = false,
  startFailure = null,
} = {}) {
  const calls = { cancel: 0, finish: 0, accept: 0, start: 0 };
  const speech = {
    async startVoiceMessageTranscription() {
      calls.start += 1;
      if (startFailure) return startFailure;
      if (failStart) {
        return {
          success: false,
          code: 'VOICE_STT_NOT_CONFIGURED',
          rawError: '未配置',
          errorInfo: { message: '未配置可用的语音识别模型' },
          retryable: false,
        };
      }
      return {
        acceptAudioChunk: () => { calls.accept += 1; },
        async finish() {
          calls.finish += 1;
          return transcriptionResult;
        },
        async cancel() {
          calls.cancel += 1;
        },
      };
    },
    __calls: calls,
  };
  return speech;
}

function createDeviceMock({
  stopRejects = false,
  cancelThrows = false,
  permissionDenied = false,
} = {}) {
  const calls = {
    recordingStart: 0,
    recordingStop: 0,
    recordingCancel: 0,
    permissionRequests: 0,
    deletedUris: [],
  };
  const device = {
    createRandomUUID: () => 'uuid-fixed',
    async temporarySpeechAudioStore() {},
    voiceRecordingPort: {},
    // 与真实 platform/device 同形的权限 preflight：preflight 与 start 共用同一个判定。
    async requestMicrophonePermission() {
      calls.permissionRequests += 1;
      return !permissionDenied;
    },
    __calls: calls,
    __stopRejects: stopRejects,
    __cancelThrows: cancelThrows,
    __permissionDenied: permissionDenied,
  };
  device.temporarySpeechAudioStore = {
    async deleteIfExists(uri) { calls.deletedUris.push(uri); },
  };
  device.voiceRecordingPort = {
    async start() {
      // 真实 port 先确认权限，权限被拒时根本不会创建 native recorder。
      if (device.__permissionDenied) {
        throw Object.assign(new Error('需要麦克风权限才能录制语音消息'), {
          name: 'VoiceRecordingError',
          code: 'VOICE_MICROPHONE_PERMISSION_DENIED',
        });
      }
      calls.recordingStart += 1;
      return {
        sessionId: 'rec-1',
        async stop() {
          calls.recordingStop += 1;
          if (device.__stopRejects) throw new Error('native stop boom');
          return { uri: 'file:///tmp/rec-1.wav', mimeType: 'audio/wav', durationMs: 1200 };
        },
        async cancel() {
          calls.recordingCancel += 1;
          if (device.__cancelThrows) throw new Error('native cancel boom');
        },
      };
    },
  };
  return device;
}

/** 真实 platform port 的边界替身：权限结果与 native stop 完成时机由测试推进。 */
function loadNativeVoiceModule() {
  const fixture = {
    permission: 'granted',
    nativeStarts: 0,
    listeners: new Map(),
    removed: [],
    stopResult: createDeferred(),
  };
  fixture.module = loadTypeScriptModule('src/platform/device/VoiceRecording.ts', {
    'react-native': {
      PermissionsAndroid: {
        PERMISSIONS: { RECORD_AUDIO: 'android.permission.RECORD_AUDIO' },
        RESULTS: { GRANTED: 'granted' },
        request: async () => fixture.permission,
      },
    },
    '../../../modules/voice-message-audio': {
      addVoiceAudioListener: (event, listener) => {
        fixture.listeners.set(event, listener);
        return {
          remove: () => {
            fixture.removed.push(event);
            fixture.listeners.delete(event);
          },
        };
      },
      startVoiceRecording: async () => { fixture.nativeStarts += 1; },
      stopVoiceRecording: () => fixture.stopResult.promise,
      cancelVoiceRecording: async () => undefined,
      clearVoiceMessageAudioForFactoryReset: async () => undefined,
    },
    './randomUUID': { createRandomUUID: () => 'rec-native' },
  });
  return fixture;
}

function createCommitMock({ mode = 'success', modes = null } = {}) {
  const calls = { count: 0 };
  return {
    __calls: calls,
    __mode: mode,
    async commitAndDispatchCanonicalUserMessage(params) {
      calls.count += 1;
      const currentMode = modes?.[calls.count - 1] ?? mode;
      if (currentMode === 'throw') throw new Error('canonical transaction boom');
      // 真实 T1 会在事务内调用 materializeMessageInTransaction（其中提交 MediaAsset batch）。
      const materialized = params.materializeMessageInTransaction
        ? await params.materializeMessageInTransaction({}, params.message)
        : params.message;
      if (currentMode === 'throwAfterMaterialize') {
        throw new Error('canonical transaction rollback boom');
      }
      if (currentMode === 'rollback') {
        return { userMessage: null, success: false, error: '事务回滚' };
      }
      return {
        userMessage: {
          id: 42,
          sessionId: 'session-1',
          text: materialized.text,
          metadataJson: materialized.metadataJson,
        },
        success: currentMode !== 'postCommitFailure',
        error: currentMode === 'postCommitFailure' ? 'commit 后 dispatch 失败' : null,
      };
    },
  };
}

function loadUserVoiceModule({
  device,
  media,
  speech,
  commit,
} = {}) {
  const deviceMock = device ?? createDeviceMock();
  const mediaMock = media ?? createMediaMock();
  const speechMock = speech ?? createSpeechMock();
  const commitMock = commit ?? createCommitMock();
  const module = loadTypeScriptModule(
    'src/features/chat/messages/application/UserVoiceMessageRecording.ts',
    {
      '@features/media': mediaMock,
      '@features/speech': speechMock,
      '@platform/device': deviceMock,
      '../../reply/application/ChatReplyTypes': createFakeReplyTypesModule(),
      '../domain/ChatMessage': createFakeChatMessageModule(),
      '../domain/chatMessageMetadata': createFakeVoiceMetadataModule(),
      './CommitAndDispatchCanonicalUserMessage': commitMock,
    },
  );
  return { module, deviceMock, mediaMock, speechMock, commitMock };
}

const baseParams = {
  sessionId: 'session-1',
  assistantId: 'assistant-1',
  aiConfig: { id: 'ai-1' },
};

/** chatMessageMetadata 的解析/预览是纯函数，除 ChatSticker 外无运行时依赖。 */
function loadChatMessageMetadataModule() {
  return loadTypeScriptModule(
    'src/features/chat/messages/domain/chatMessageMetadata.ts',
    { './ChatSticker': { buildStickerMessagePreviewText: () => '[表情包]' },
      ...chatSharingDependencies },
  );
}

// ============================================================================
// 1) 用户录音失败路径清理
// ============================================================================

await scenario('start 失败（STT 未配置）时不启动录音、无任何资源泄漏', async () => {
  const { module, deviceMock } = loadUserVoiceModule({
    speech: createSpeechMock({ failStart: true }),
  });
  const result = await module.startUserVoiceMessageRecording(baseParams);
  assert.equal(result.success, false);
  assert.equal(result.code, 'VOICE_STT_NOT_CONFIGURED');
  assert.equal(deviceMock.__calls.recordingStart, 0, 'STT 未配置时不得开始录音');
});

await scenario('native stop reject 时：transcription 被 cancel、临时文件被清理、返回录音失败码', async () => {
  const deviceMock = createDeviceMock({ stopRejects: true });
  const speechMock = createSpeechMock();
  const { module, mediaMock } = loadUserVoiceModule({ device: deviceMock, speech: speechMock });
  const session = await module.startUserVoiceMessageRecording(baseParams);
  assert.ok(!('success' in session), 'start 应成功返回 session');

  const result = await session.finish();
  assert.equal(result.success, false);
  assert.equal(result.code, 'VOICE_RECORDING_FAILED');
  assert.equal(speechMock.__calls.cancel >= 1, true, 'stop 失败必须关闭 transcription session');
  assert.equal(
    mediaMock.__created.length, 0, 'stop 失败不得进入 media 准备',
  );
});

await scenario('STT 失败时不创建 Chat message / MediaAsset', async () => {
  const speechMock = createSpeechMock({
    transcriptionResult: {
      success: false,
      code: 'VOICE_STT_EMPTY_TRANSCRIPT',
      rawError: '空',
      errorInfo: { message: '没有识别到可发送的语音内容' },
      retryable: false,
    },
  });
  const commitMock = createCommitMock();
  const mediaMock = createMediaMock();
  const { module } = loadUserVoiceModule({ speech: speechMock, commit: commitMock, media: mediaMock });

  const session = await module.startUserVoiceMessageRecording(baseParams);
  const result = await session.finish();

  assert.equal(result.success, false);
  assert.equal(result.code, 'VOICE_STT_EMPTY_TRANSCRIPT');
  assert.equal(commitMock.__calls.count, 0, 'STT 失败不得提交 Chat message');
  assert.equal(mediaMock.__created.length, 0, 'STT 失败不得准备 MediaAsset');
});

await scenario('MediaAsset prepare 失败时不创建 message、保留 source temp，draft 仍可重试', async () => {
  const mediaMock = createMediaMock({ failPrepare: true });
  const commitMock = createCommitMock();
  const deviceMock = createDeviceMock();
  const { module } = loadUserVoiceModule({ media: mediaMock, commit: commitMock, device: deviceMock });

  const session = await module.startUserVoiceMessageRecording(baseParams);
  const finished = await session.finish();
  assert.equal(finished.success, true, 'prepare 已移入 commit，finish 必须正常进入 reviewing');
  const result = await finished.draft.commit('识别出的文本');

  assert.equal(result.success, false);
  assert.equal(result.code, 'VOICE_MEDIA_PREPARATION_FAILED');
  assert.equal(commitMock.__calls.count, 0, 'prepare 失败不得提交 message');
  assert.deepEqual(deviceMock.__calls.deletedUris, [], 'prepare 失败必须保留 source temp 供 retry');
});

await scenario('canonical commit 返回未提交时按回滚清理 prepared backing', async () => {
  const mediaMock = createMediaMock();
  const commitMock = createCommitMock({ mode: 'rollback' });
  const { module } = loadUserVoiceModule({ media: mediaMock, commit: commitMock });

  const session = await module.startUserVoiceMessageRecording(baseParams);
  const finished = await session.finish();
  assert.equal(finished.success, true, 'STT 成功必须进入 reviewing（返回 draft）');
  const result = await finished.draft.commit('识别出的文本');

  assert.equal(result.success, false);
  assert.equal(result.code, 'VOICE_MESSAGE_COMMIT_FAILED');
  assert.equal(
    mediaMock.__discardAfterRollbackCalls.length, 1,
    '事务未提交时必须清理本次 attempt 的 prepared backing',
  );
  assert.equal(
    mediaMock.__finalizeAfterCommitCalls.length, 0,
    '未提交时不得按提交后清理',
  );
});

await scenario('canonical commit 抛异常时也必须按回滚清理 prepared backing（不留孤儿文件）', async () => {
  const mediaMock = createMediaMock();
  const commitMock = createCommitMock({ mode: 'throw' });
  const { module } = loadUserVoiceModule({ media: mediaMock, commit: commitMock });

  const session = await module.startUserVoiceMessageRecording(baseParams);
  const finished = await session.finish();
  const result = await finished.draft.commit('识别出的文本');

  assert.equal(result.success, false);
  assert.equal(result.code, 'VOICE_MESSAGE_COMMIT_FAILED');
  assert.equal(
    mediaMock.__discardAfterRollbackCalls.length, 1,
    'commit 抛异常时必须清理本次 attempt；draft 只保留 source temp',
  );
});

await scenario('commit 成功时 finalize backing，且不误删已接管文件', async () => {
  const mediaMock = createMediaMock();
  const commitMock = createCommitMock({ mode: 'success' });
  const { module } = loadUserVoiceModule({ media: mediaMock, commit: commitMock });

  const session = await module.startUserVoiceMessageRecording(baseParams);
  const finished = await session.finish();
  assert.equal(finished.success, true);
  const result = await finished.draft.commit('识别出的文本');

  assert.equal(result.success, true);
  assert.equal(mediaMock.__commitInTransactionCalls.length, 1);
  assert.equal(mediaMock.__finalizeAfterCommitCalls.length, 1, '提交成功必须 finalize exactly once');
  assert.equal(
    mediaMock.__discardAfterRollbackCalls.length, 0,
    '提交成功后绝不能按回滚删除 backing',
  );
});

// 回归：MediaAssetCatalog.selectOrCreateInTransaction 可以复用同 hash/byteSize/mimeType
// 的既有 catalog row。复用行的 durationMs 只是资产 metadata，不能反向覆盖本次语音消息
// 已经确定的业务 duration。
await scenario('复用 asset 的历史 duration 不得覆盖本次用户语音的业务 duration', async () => {
  const mediaMock = createMediaMock({ committedAssetDurationMs: 999 });
  const commitMock = createCommitMock({ mode: 'success' });
  const { module } = loadUserVoiceModule({ media: mediaMock, commit: commitMock });

  const session = await module.startUserVoiceMessageRecording(baseParams);
  const finished = await session.finish();
  assert.equal(finished.draft.durationMs, 1200, '本次录音测得时长为 1200');

  const result = await finished.draft.commit('识别出的文本');
  assert.equal(result.success, true);

  const persisted = JSON.parse(result.message.metadataJson);
  assert.equal(
    persisted.voice.durationMs, 1200,
    '复用 asset 的 durationMs=999 只是资产 metadata，消息 duration 必须取本次业务事实 1200',
  );
});

await scenario('commit 成功后删除源临时录音', async () => {
  const deviceMock = createDeviceMock();
  const { module } = loadUserVoiceModule({ device: deviceMock });
  const session = await module.startUserVoiceMessageRecording(baseParams);
  const finished = await session.finish();
  assert.deepEqual(
    deviceMock.__calls.deletedUris, [],
    'reviewing 阶段源录音还在 draft 手里：用户可能取消或重试，不能提前删除',
  );
  await finished.draft.commit('识别出的文本');
  assert.deepEqual(
    deviceMock.__calls.deletedUris,
    ['file:///tmp/rec-1.wav'],
    '成功路径必须在 commit 后删除 source temp',
  );
  await finished.draft.discard();
  assert.deepEqual(deviceMock.__calls.deletedUris, ['file:///tmp/rec-1.wav'], '终态后不得重复删除 source temp');
});

await scenario('真实 batch 生命周期拒绝重复提交同一个 staged batch', async () => {
  const mediaMock = createMediaMock();
  const batch = await mediaMock.prepareMediaAssetBatch([{ sourceUri: 'file:///tmp/source.wav' }]);
  await batch.commitInTransaction({});
  await assert.rejects(
    batch.commitInTransaction({}),
    /只能从 open 提交一次/,
  );
  await batch.discardAfterRollback();
});

await scenario('第一次 rollback 后保留 source temp，第二次 retry 使用全新 open batch 并成功', async () => {
  const mediaMock = createMediaMock();
  const deviceMock = createDeviceMock();
  const commitMock = createCommitMock({ modes: ['rollback', 'success'] });
  const { module } = loadUserVoiceModule({ media: mediaMock, device: deviceMock, commit: commitMock });
  const session = await module.startUserVoiceMessageRecording(baseParams);
  const finished = await session.finish();

  const first = await finished.draft.commit('第一次文本');
  assert.equal(first.success, false);
  assert.equal(mediaMock.__batches.length, 1);
  assert.equal(mediaMock.__batches[0].state, 'discarded', '首个 staged batch 必须 rollback cleanup');
  assert.deepEqual(deviceMock.__calls.deletedUris, [], 'rollback 后 source temp 必须保留');

  const second = await finished.draft.commit('第二次修改后的文本');
  assert.equal(second.success, true);
  assert.equal(mediaMock.__batches.length, 2, 'retry 必须 prepare 新 batch');
  assert.notEqual(mediaMock.__batches[0], mediaMock.__batches[1]);
  assert.equal(mediaMock.__batches[1].state, 'finalized');
  assert.equal(second.message.text, '第二次修改后的文本', 'retry 必须使用最新 transcript');
});

await scenario('rollback cleanup exactly once，且绝不 finalize', async () => {
  const mediaMock = createMediaMock();
  const { module } = loadUserVoiceModule({ media: mediaMock, commit: createCommitMock({ mode: 'rollback' }) });
  const session = await module.startUserVoiceMessageRecording(baseParams);
  const finished = await session.finish();
  await finished.draft.commit('识别出的文本');

  assert.equal(mediaMock.__discardAfterRollbackCalls.length, 1);
  assert.equal(mediaMock.__finalizeAfterCommitCalls.length, 0);
});

await scenario('事务 materialize 后抛异常：staged batch rollback cleanup，draft 可用新 batch retry', async () => {
  const mediaMock = createMediaMock();
  const commitMock = createCommitMock({ modes: ['throwAfterMaterialize', 'success'] });
  const { module } = loadUserVoiceModule({ media: mediaMock, commit: commitMock });
  const session = await module.startUserVoiceMessageRecording(baseParams);
  const finished = await session.finish();

  const first = await finished.draft.commit('第一次');
  assert.equal(first.success, false);
  assert.equal(mediaMock.__batches[0].state, 'discarded');
  const retry = await finished.draft.commit('重试后的最新文字');
  assert.equal(retry.success, true);
  assert.equal(mediaMock.__batches.length, 2);
});

await scenario('commit failure 后 source temp 不删除且 draft non-terminal', async () => {
  const mediaMock = createMediaMock();
  const deviceMock = createDeviceMock();
  const commitMock = createCommitMock({ modes: ['rollback', 'success'] });
  const { module } = loadUserVoiceModule({ media: mediaMock, device: deviceMock, commit: commitMock });
  const session = await module.startUserVoiceMessageRecording(baseParams);
  const finished = await session.finish();

  assert.equal((await finished.draft.commit('第一次')).success, false);
  assert.deepEqual(deviceMock.__calls.deletedUris, []);
  assert.equal((await finished.draft.commit('第二次')).success, true, '失败后 draft 必须仍是 non-terminal');
});

await scenario('canonical 已提交但 post-commit dispatch 失败时仍 finalize，绝不 rollback', async () => {
  const mediaMock = createMediaMock();
  const { module } = loadUserVoiceModule({
    media: mediaMock,
    commit: createCommitMock({ mode: 'postCommitFailure' }),
  });
  const session = await module.startUserVoiceMessageRecording(baseParams);
  const finished = await session.finish();
  const result = await finished.draft.commit('识别出的文本');

  assert.equal(result.success, true, 'userMessage 非空说明事务已经提交');
  assert.equal(mediaMock.__finalizeAfterCommitCalls.length, 1);
  assert.equal(mediaMock.__discardAfterRollbackCalls.length, 0);
});

await scenario('draft.discard 遇到 in-flight commit 时等待 attempt，绝不并发清理 source/backing', async () => {
  const transactionResult = createDeferred();
  const materialized = createDeferred();
  const mediaMock = createMediaMock();
  const deviceMock = createDeviceMock();
  const commitMock = {
    async commitAndDispatchCanonicalUserMessage(params) {
      await params.materializeMessageInTransaction({}, params.message);
      materialized.resolve();
      return transactionResult.promise;
    },
  };
  const { module } = loadUserVoiceModule({ media: mediaMock, device: deviceMock, commit: commitMock });
  const session = await module.startUserVoiceMessageRecording(baseParams);
  const finished = await session.finish();

  const committing = finished.draft.commit('识别出的文本');
  await materialized.promise;
  const discarding = finished.draft.discard();
  await Promise.resolve();
  assert.equal(mediaMock.__batches[0].state, 'staged');
  assert.deepEqual(deviceMock.__calls.deletedUris, [], '事务结果未知时不得删除 source temp');

  transactionResult.resolve({ userMessage: null, success: false, error: '事务回滚' });
  await Promise.all([committing, discarding]);
  assert.equal(mediaMock.__batches[0].state, 'discarded');
  assert.deepEqual(deviceMock.__calls.deletedUris, ['file:///tmp/rec-1.wav']);
});

await scenario('reviewing draft 只持有 source temp，不提前创建 PreparedMediaAssetBatch', async () => {
  const mediaMock = createMediaMock();
  const deviceMock = createDeviceMock();
  const { module, commitMock } = loadUserVoiceModule({ media: mediaMock, device: deviceMock });
  const session = await module.startUserVoiceMessageRecording(baseParams);
  const finished = await session.finish();

  assert.equal(finished.success, true);
  assert.equal(mediaMock.__batches.length, 0, 'reviewing 前不得 prepare MediaAsset');
  assert.deepEqual(deviceMock.__calls.deletedUris, [], 'source temp 仍由 draft 持有');
  assert.equal(commitMock.__calls.count, 0, '录音结束只创建 draft，不提交消息或触发 AI 回复');
  assert.equal(finished.draft.originalTranscript, '识别出的文本');
  assert.equal(finished.draft.durationMs, 1200);
});

await scenario('同一 draft 的并发第二次 commit 不创建额外 batch', async () => {
  const transactionResult = createDeferred();
  const materialized = createDeferred();
  const mediaMock = createMediaMock();
  const commitMock = {
    async commitAndDispatchCanonicalUserMessage(params) {
      await params.materializeMessageInTransaction({}, params.message);
      materialized.resolve();
      return transactionResult.promise;
    },
  };
  const { module } = loadUserVoiceModule({ media: mediaMock, commit: commitMock });
  const session = await module.startUserVoiceMessageRecording(baseParams);
  const finished = await session.finish();

  const first = finished.draft.commit('第一次');
  await materialized.promise;
  const duplicate = await finished.draft.commit('第二次');
  assert.equal(duplicate.success, false);
  assert.equal(mediaMock.__batches.length, 1);
  transactionResult.resolve({ userMessage: null, success: false, error: '事务回滚' });
  await first;
});

await scenario('finalized batch 不能再走 discardAfterRollback', async () => {
  const mediaMock = createMediaMock();
  const batch = await mediaMock.prepareMediaAssetBatch([{ sourceUri: 'file:///tmp/source.wav' }]);
  await batch.commitInTransaction({});
  await batch.finalizeAfterCommit();
  await assert.rejects(batch.discardAfterRollback(), /已提交 batch 不能按 rollback discard/);
});

await scenario('finalize cleanup 失败不伪装成事务失败，source temp 仍只删除一次', async () => {
  const mediaMock = createMediaMock({ failFinalize: true });
  const deviceMock = createDeviceMock();
  const { module } = loadUserVoiceModule({ media: mediaMock, device: deviceMock });
  const session = await module.startUserVoiceMessageRecording(baseParams);
  const finished = await session.finish();
  const result = await finished.draft.commit('识别出的文本');

  assert.equal(result.success, true);
  assert.equal(mediaMock.__batches[0].state, 'committed');
  assert.equal(mediaMock.__discardAfterRollbackCalls.length, 0);
  assert.deepEqual(deviceMock.__calls.deletedUris, ['file:///tmp/rec-1.wav']);
});

await scenario('reviewing 直接 discard：不创建 batch，source temp exactly once 删除并终结 draft', async () => {
  const mediaMock = createMediaMock();
  const deviceMock = createDeviceMock();
  const { module } = loadUserVoiceModule({ media: mediaMock, device: deviceMock });
  const session = await module.startUserVoiceMessageRecording(baseParams);
  const finished = await session.finish();

  await finished.draft.discard();
  await finished.draft.discard();
  assert.equal(mediaMock.__batches.length, 0);
  assert.deepEqual(deviceMock.__calls.deletedUris, ['file:///tmp/rec-1.wav']);
  assert.equal((await finished.draft.commit('不能再发')).success, false);
});

// ============================================================================
// 2) pending recording start lifecycle / 跨会话竞态
//     直接驱动 useChatSendFlow 的状态机（用 React 的最小桩）
// ============================================================================

function createReactStub() {
  const refSlots = [];
  const stateSlots = [];
  const effectCleanups = [];
  // 单次 render 内按调用顺序分配 slot。每次 render（hook 调用）开始时游标归零，
  // 因此 ref/state 的“身份”跨 render 稳定，与真实 React 一致：
  // 同一个组件以不同 props（例如切换 sessionId）重新 render 时，ref 保持不变，
  // 而 state 仍是上一次写入的值。
  let refCursor = 0;
  let stateCursor = 0;
  let effectCursor = 0;

  const react = {
    /** 模拟一次新的 render：重置 slot 游标，保留已有 ref/state 的身份。 */
    __beginRender() {
      refCursor = 0;
      stateCursor = 0;
      effectCursor = 0;
    },
    useRef(initial) {
      const index = refCursor;
      refCursor += 1;
      if (refSlots[index] === undefined) refSlots[index] = { current: initial };
      return refSlots[index];
    },
    useState(initial) {
      const index = stateCursor;
      stateCursor += 1;
      if (stateSlots[index] === undefined) stateSlots[index] = { value: initial };
      const slot = stateSlots[index];
      const setter = (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next;
      };
      return [slot.value, setter];
    },
    useCallback(fn) { return fn; },
    useEffect(fn) {
      const index = effectCursor;
      effectCursor += 1;
      effectCleanups[index] = fn() ?? (() => undefined);
      return effectCleanups[index];
    },
    __unmount() { effectCleanups.forEach((cleanup) => cleanup()); },
    __effectCount: () => effectCleanups.length,
    __refSlots: refSlots,
    __stateSlots: stateSlots,
  };
  return react;
}

function loadUseChatSendFlow({ react, voiceModule, deps }) {
  return loadTypeScriptModule(
    'src/features/chat/presentation/messages/ChatDetail/useChatSendFlow.ts',
    {
      react,
      '@shared/ui': { showAppDialog() {} },
      './ChatAttachmentDraftFiles': { retainChatAttachmentDraftFiles: () => () => {} },
      '../../../messages/application/MessageTimeline': deps.messageTimeline,
      '../../../messages/application/SendUserMessage': deps.sendUserMessage,
      '../../../conversation/application/ChatCallGateway': deps.chatCallGateway,
      '../../../messages/domain/chatMessageMetadata': deps.chatMessageMetadata,
      '../../../messages/domain/ChatSticker': {},
      '../../../messages/domain/ChatAttachment': {},
      '../components/chatTypes': {},
      '../../../conversation/application/ChatTogetherListeningGateway': deps.togetherListening,
      '../../../messages/application/UserVoiceMessageRecording': voiceModule,
    },
  );
}

function createSendFlowDeps({ voiceModule }) {
  return {
    voiceModule,
    deps: {
      messageTimeline: {
        createOptimisticUserMessage: () => ({ id: 1, clientMessageId: 'c1' }),
        mergeMessages: (prev, next) => ({ changed: true, messages: [...prev, ...next], lastMessageId: 1 }),
      },
      sendUserMessage: async () => ({ success: true, userMessage: { id: 1 } }),
      chatCallGateway: {
        getActiveChatCall: () => null,
        startOutgoingChatCall: async () => ({ status: 'ok' }),
      },
      chatMessageMetadata: {
        getMessageAttachments: () => [],
        getMessageSticker: () => null,
      },
      togetherListening: {
        inviteTogetherListeningFromChat: async () => ({}),
        acceptChatTogetherListeningInvitation: async () => ({}),
        declineChatTogetherListeningInvitation: async () => ({}),
        leaveChatTogetherListening: async () => ({}),
      },
    },
  };
}

function createControllableVoiceModule({ entryReady = true, entryMessage = '需要麦克风权限才能录制语音消息' } = {}) {
  const deferreds = [];
  const cancelled = [];
  const discarded = [];
  const committed = [];
  const entryCalls = [];
  const drafts = [];
  const lifecycleEvents = [];
  let draftIndex = 0;

  /** 一个可用的 draft 替身，记录 commit / discard 的实际调用。 */
  function makeDraft(overrides = {}) {
    const index = draftIndex;
    draftIndex += 1;
    const draft = {
      index,
      originalTranscript: overrides.originalTranscript ?? '识别出的文本',
      durationMs: overrides.durationMs ?? 1200,
      async commit(transcript) {
        committed.push({ index, transcript });
        lifecycleEvents.push(`commit:start:${index}`);
        if (overrides.commit) {
          const result = await overrides.commit(transcript);
          lifecycleEvents.push(`commit:end:${index}`);
          return result;
        }
        lifecycleEvents.push(`commit:end:${index}`);
        if (overrides.commitResult) return overrides.commitResult;
        return { success: true, message: { id: 9, text: transcript } };
      },
      async discard() {
        discarded.push(index);
        lifecycleEvents.push(`discard:${index}`);
        if (overrides.discard) await overrides.discard();
      },
    };
    drafts.push(draft);
    return draft;
  }

  return {
    __deferreds: deferreds,
    __cancelled: cancelled,
    __discarded: discarded,
    __committed: committed,
    __entryCalls: entryCalls,
    __drafts: drafts,
    __lifecycleEvents: lifecycleEvents,
    async prepareUserVoiceMessageRecording() {
      entryCalls.push(true);
      return entryReady ? { ready: true } : { ready: false, code: 'VOICE_MICROPHONE_PERMISSION_DENIED', message: entryMessage };
    },
    async startUserVoiceMessageRecording() {
      const deferred = createDeferred();
      deferreds.push(deferred);
      return deferred.promise;
    },
    /** 供 stale-start 断言：一个完整可用的 recording session 替身。 */
    __makeRecording() {
      return {
        finish: async () => ({ success: true, draft: makeDraft() }),
        cancel: async () => { cancelled.push(true); },
      };
    },
    /** 一个可用的 draft 替身，记录 commit / discard 的实际调用。 */
    __makeDraft: makeDraft,
  };
}

/**
 * 读取 useChatSendFlow 暴露的语音状态机。
 *
 * react stub 的 useCallback 是恒等函数，因此 hook 闭包里的 state 永远是首帧值；
 * 断言必须直接读 stub 的 state slot。slot 0/1/2 对应 useChatSendFlow 的前三个
 * useState（voiceRecordingState / voiceRecordingError / voiceReviewDraft），
 * 顺序由 hook 顶层固定。
 */
function readHookVoiceState(react) {
  return {
    recordingState: react.__stateSlots[0].value,
    interactionError: react.__stateSlots[1].value,
    reviewDraft: react.__stateSlots[2].value,
  };
}

function buildSendFlowParams(overrides = {}) {
  return {
    sessionId: 's1',
    aiAssistant: { id: 'a1' },
    aiRequestConfig: { id: 'ai-1' },
    messages: [],
    setMessages: () => undefined,
    setError: () => undefined,
    setIsTyping: () => undefined,
    lastMessageIdRef: { current: null },
    ...overrides,
  };
}

await scenario('pending start 后切换 session / unmount：stale start 成功后立即 cancel，不污染新 session', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });

  const hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  // 启动进行中，用户切换 session / unmount（generation 自增）
  react.__unmount();

  const recording = {
    finish: async () => ({ success: true, message: { id: 2 } }),
    cancel: async () => { voiceModule.__cancelled.push(true); },
  };
  voiceModule.__deferreds[0].resolve(recording);

  const started = await pending;

  assert.equal(started, false, 'stale start 必须报告未成功');
  assert.equal(voiceModule.__cancelled.length, 1, 'stale start 成功后必须立即 self-cancel');
});

await scenario('未发生 session 变化时 start 正常成功，不误取消', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });

  const hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  const recording = {
    finish: async () => ({ success: true, message: { id: 2 } }),
    cancel: async () => { voiceModule.__cancelled.push(true); },
  };
  voiceModule.__deferreds[0].resolve(recording);

  const started = await pending;

  assert.equal(started, true, '非 stale start 必须成功');
  assert.equal(voiceModule.__cancelled.length, 0, '正常 start 不得 self-cancel');
});

await scenario('pending start 期间主动取消：stale start 不得写入 ref', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });

  const hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  const cancelPromise = hook.cancelVoiceRecording();

  const recording = {
    finish: async () => ({ success: true, message: { id: 2 } }),
    cancel: async () => { voiceModule.__cancelled.push(true); },
  };
  voiceModule.__deferreds[0].resolve(recording);

  const [started] = await Promise.all([pending, cancelPromise]);

  assert.equal(started, false, '显式取消后 pending start 必须失效');
  assert.equal(voiceModule.__cancelled.length, 1, 'stale start 必须 self-cancel');
});

// ---------------------------------------------------------------------------
// 2.1) 录音启动状态机：starting / 交互错误可见性 / preflight / pending start 竞态
// ---------------------------------------------------------------------------

await scenario('STT 未配置：start 失败 → 交互错误进入独立可见通道、state 回 idle、不启动 native recorder', async () => {
  const react = createReactStub();
  const { module: voiceModule, deviceMock } = loadUserVoiceModule({
    speech: createSpeechMock({ failStart: true }),
  });
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const historyErrorCalls = [];
  const hook = module.useChatSendFlow(buildSendFlowParams({
    // 已有聊天消息：语音错误必须仍然可见，不得依赖 messages.length === 0。
    messages: [{ id: 1, sessionId: 's1', text: '已有消息' }],
    setError: (value) => historyErrorCalls.push(value),
  }));

  const started = await hook.startVoiceRecording();
  const { recordingState, interactionError } = readHookVoiceState(react);

  assert.equal(started, false, 'STT 未配置时 start 必须返回失败');
  assert.equal(interactionError, '未配置可用的语音识别模型', '语音失败必须给出可见文案');
  assert.equal(recordingState, 'idle', '启动失败后必须回到 idle');
  assert.equal(deviceMock.__calls.recordingStart, 0, 'STT 未配置不得启动 native recorder');
  assert.deepEqual(
    historyErrorCalls, [],
    '语音错误不得复用只在 messages.length === 0 时渲染的历史加载 error 通道',
  );
});

await scenario('STT provider 不支持实时识别：明确失败、不启动 native recorder', async () => {
  const react = createReactStub();
  const speechMock = createSpeechMock({
    startFailure: {
      success: false,
      code: 'VOICE_STT_CONFIGURATION_INVALID',
      rawError: 'provider unsupported',
      errorInfo: { message: '当前 STT Provider 不支持语音消息录制' },
      retryable: false,
    },
  });
  const { module: voiceModule, deviceMock } = loadUserVoiceModule({ speech: speechMock });
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  // use case 层同样 fail closed，不允许隐式回退到文件型 STT。
  const direct = await voiceModule.startUserVoiceMessageRecording(baseParams);
  assert.equal(direct.success, false);
  assert.equal(direct.code, 'VOICE_STT_CONFIGURATION_INVALID');

  const started = await hook.startVoiceRecording();
  const { recordingState, interactionError } = readHookVoiceState(react);

  assert.equal(started, false);
  assert.equal(interactionError, '当前 STT Provider 不支持语音消息录制');
  assert.equal(recordingState, 'idle');
  assert.equal(deviceMock.__calls.recordingStart, 0, 'provider 不支持时不得启动 native recorder');
});

await scenario('麦克风权限被拒：明确错误、无 native recorder / transcription session 泄漏', async () => {
  const deviceMock = createDeviceMock({ permissionDenied: true });
  const speechMock = createSpeechMock();
  const { module } = loadUserVoiceModule({ device: deviceMock, speech: speechMock });

  const result = await module.startUserVoiceMessageRecording(baseParams);

  assert.equal(result.success, false);
  assert.equal(result.code, 'VOICE_MICROPHONE_PERMISSION_DENIED');
  assert.equal(result.message, '需要麦克风权限才能录制语音消息');
  assert.equal(deviceMock.__calls.recordingStart, 0, '权限被拒不得启动 native recorder');
  assert.equal(deviceMock.__calls.recordingStop, 0, '权限被拒不得留下 stop 调用');
  assert.equal(deviceMock.__calls.recordingCancel, 0, '权限被拒不得留下 cancel 调用');
  assert.equal(speechMock.__calls.cancel, 1, '权限失败必须关闭已建立的 transcription session');
});

await scenario('麦克风权限 preflight 被拒：进入语音模式前就给出可见错误，且不提前建立 STT session', async () => {
  const react = createReactStub();
  const { module: voiceModule, deviceMock, speechMock } = loadUserVoiceModule({
    device: createDeviceMock({ permissionDenied: true }),
  });
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  const ready = await hook.prepareVoiceRecordingEntry();
  const { recordingState, interactionError } = readHookVoiceState(react);

  assert.equal(ready, false, '权限被拒时不得进入语音模式');
  assert.equal(interactionError, '需要麦克风权限才能录制语音消息');
  assert.equal(recordingState, 'idle');
  assert.equal(deviceMock.__calls.permissionRequests, 1, 'preflight 必须询问一次权限');
  assert.equal(speechMock.__calls.start, 0, 'preflight 不得提前建立腾讯实时 ASR session');
  assert.equal(deviceMock.__calls.recordingStart, 0);
});

await scenario('麦克风权限 preflight 通过：允许进入语音模式，且不建立 STT session', async () => {
  const react = createReactStub();
  const { module: voiceModule, speechMock } = loadUserVoiceModule({
    device: createDeviceMock(),
  });
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  assert.equal(await hook.prepareVoiceRecordingEntry(), true);
  assert.equal(readHookVoiceState(react).interactionError, null);
  assert.equal(speechMock.__calls.start, 0, '进入语音模式不得建立 STT session');
});

await scenario('start pending：state 为 starting、重复 start 被拒绝，成功后进入 recording', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  assert.equal(
    readHookVoiceState(react).recordingState, 'starting',
    'press grant 后必须立刻进入 starting，不能停留在 idle',
  );

  const duplicate = await hook.startVoiceRecording();
  assert.equal(duplicate, false, 'starting 期间不得重复 start');
  assert.equal(voiceModule.__deferreds.length, 1, '重复 start 不得发起第二次启动');

  voiceModule.__deferreds[0].resolve(voiceModule.__makeRecording());
  assert.equal(await pending, true);
  assert.equal(
    readHookVoiceState(react).recordingState, 'recording',
    'native 录音真正开始后才进入 recording',
  );
});

await scenario('pending start 后松手：start 成功后交给 finish，processing → reviewing，不误 cancel', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  // 用户松手早于 start 完成：输入区会等 start resolve 后再 finish。
  voiceModule.__deferreds[0].resolve(voiceModule.__makeRecording());
  assert.equal(await pending, true);

  const finishing = hook.finishVoiceRecording();
  assert.equal(readHookVoiceState(react).recordingState, 'processing', 'finish 期间必须显示识别中');
  assert.equal(await finishing, true);
  assert.equal(
    readHookVoiceState(react).recordingState, 'reviewing',
    'STT 成功后进入 reviewing，而不是直接提交',
  );
  assert.equal(voiceModule.__cancelled.length, 0, '松手语义是发送，不得误 cancel');
});

await scenario('pending start 时退出语音模式：立刻回 idle、stale start self-cancel，随后可立即重新开始', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  const leaving = hook.startVoiceRecording();
  // ChatInputArea 退出语音模式：即使 start 仍 pending，也要作废本次启动。
  const cancelPromise = hook.cancelVoiceRecording();
  assert.equal(readHookVoiceState(react).recordingState, 'idle', '退出语音模式后必须立刻回 idle');

  const restarted = hook.startVoiceRecording();
  assert.equal(readHookVoiceState(react).recordingState, 'starting');
  assert.equal(voiceModule.__deferreds.length, 2, '作废一次启动后必须允许立即重新开始');

  voiceModule.__deferreds[0].resolve(voiceModule.__makeRecording());
  assert.equal(await leaving, false, 'stale start 必须报告未成功');
  await cancelPromise;

  voiceModule.__deferreds[1].resolve(voiceModule.__makeRecording());
  assert.equal(await restarted, true, '新一次 start 必须正常接管');
  assert.equal(readHookVoiceState(react).recordingState, 'recording');
  assert.equal(voiceModule.__cancelled.length, 1, '只有 stale 的那次被 self-cancel');
});

await scenario('pending start 时切 session：新 session 可立即重按，旧启动 self-cancel 且不误伤新录音', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  const staleStart = hook.startVoiceRecording();
  // 切 session 触发 generation fence（effect cleanup）。
  react.__unmount();

  const freshStart = hook.startVoiceRecording();
  assert.equal(
    voiceModule.__deferreds.length, 2,
    '新 session 必须能立刻重新开始，不被旧 in-flight 标记挡住',
  );
  assert.equal(readHookVoiceState(react).recordingState, 'starting');

  voiceModule.__deferreds[0].resolve(voiceModule.__makeRecording());
  assert.equal(await staleStart, false);
  assert.equal(voiceModule.__cancelled.length, 1, '旧 session 的启动必须 self-cancel');

  voiceModule.__deferreds[1].resolve(voiceModule.__makeRecording());
  assert.equal(await freshStart, true, '新 session 的启动必须被正常接管');
  assert.equal(readHookVoiceState(react).recordingState, 'recording');
  assert.equal(voiceModule.__cancelled.length, 1, '不得误伤新 session 的录音');
});

await scenario('finish：recording → processing → reviewing，并保存 original transcript', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  const finishDeferred = createDeferred();
  voiceModule.__deferreds[0].resolve({
    finish: () => finishDeferred.promise,
    cancel: async () => { voiceModule.__cancelled.push(true); },
  });
  assert.equal(await pending, true);
  assert.equal(readHookVoiceState(react).recordingState, 'recording');

  const finishing = hook.finishVoiceRecording();
  assert.equal(readHookVoiceState(react).recordingState, 'processing');

  finishDeferred.resolve({
    success: true,
    draft: voiceModule.__makeDraft({ originalTranscript: '原始识别文本', durationMs: 1500 }),
  });
  assert.equal(await finishing, true);
  assert.equal(readHookVoiceState(react).recordingState, 'reviewing');
  assert.equal(readHookVoiceState(react).interactionError, null);
  const draft = readHookVoiceState(react).reviewDraft;
  assert.equal(draft.originalTranscript, '原始识别文本', 'reviewing 必须保存 original transcript');
  assert.equal(draft.transcript, '原始识别文本', '编辑框初始值就是 STT 结果');
  assert.equal(draft.durationMs, 1500);
  // 关键约束：reviewing 阶段不能有任何 canonical message 提交。
  assert.equal(voiceModule.__committed.length, 0, 'reviewing 阶段不得提交任何 message');
  assert.equal(voiceModule.__discarded.length, 0, 'reviewing 阶段不得 discard');
});

await scenario('cancel：recording → idle，且真正 cancel native session', async () => {  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  voiceModule.__deferreds[0].resolve(voiceModule.__makeRecording());
  assert.equal(await pending, true);
  assert.equal(readHookVoiceState(react).recordingState, 'recording');

  await hook.cancelVoiceRecording();
  assert.equal(readHookVoiceState(react).recordingState, 'idle');
  assert.equal(voiceModule.__cancelled.length, 1, 'recording 期间的取消必须真正 cancel session');
});

await scenario('录音过短：有可见错误并回 idle', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  voiceModule.__deferreds[0].resolve({
    finish: async () => ({
      success: false,
      code: 'VOICE_RECORDING_TOO_SHORT',
      message: '录音时间太短，请重新录制',
    }),
    cancel: async () => { voiceModule.__cancelled.push(true); },
  });
  assert.equal(await pending, true);

  const finishing = hook.finishVoiceRecording();
  assert.equal(readHookVoiceState(react).recordingState, 'processing');
  assert.equal(await finishing, false);
  assert.equal(readHookVoiceState(react).interactionError, '录音时间太短，请重新录制');
  assert.equal(readHookVoiceState(react).recordingState, 'idle');
});

await scenario('语音交互错误的可见性由输入区承担，不依赖 messages.length === 0', () => {
  const inputArea = read('src/features/chat/presentation/messages/components/ChatInputArea.tsx');
  assert.ok(
    inputArea.includes('{voiceRecordingError}'),
    '输入区必须直接渲染 voiceRecordingError，才能在已有消息的会话里仍然可见',
  );
  assert.ok(
    inputArea.includes('onVoiceModeEnter'),
    '输入区必须在进入语音模式前调用权限 preflight',
  );

  const chatDetail = read('src/features/chat/presentation/messages/ChatDetail/index.tsx');
  assert.ok(
    chatDetail.includes('voiceRecordingError={voiceRecordingError}'),
    'ChatDetail 必须把语音交互错误接到输入区',
  );
  assert.ok(
    chatDetail.includes('onVoiceModeEnter={prepareVoiceRecordingEntry}'),
    'ChatDetail 必须把权限 preflight 接到输入区',
  );
  assert.ok(
    /if \(error && messages\.length === 0\)/.test(chatDetail),
    '历史加载 error 的渲染条件必须保持不变：语音错误不得挤进那个通道',
  );
});

await scenario('starting 期间输入区提供录音准备反馈', () => {
  const inputArea = read('src/features/chat/presentation/messages/components/ChatInputArea.tsx');
  assert.ok(inputArea.includes('正在准备录音'), 'starting 期间必须给用户明确反馈');
});

await scenario('真实 platform 录音入口按当前权限结果决定是否启动 native', async () => {
  const fixture = loadNativeVoiceModule();
  const params = { onAudioChunk: () => undefined, onError: () => undefined };
  fixture.permission = 'denied';
  assert.equal(await fixture.module.requestMicrophonePermission(), false);
  await assert.rejects(
    fixture.module.voiceRecordingPort.start(params),
    (error) => error.code === 'VOICE_MICROPHONE_PERMISSION_DENIED',
  );
  assert.equal(fixture.nativeStarts, 0);
  assert.equal(fixture.listeners.size, 0, '权限被拒时不得留下事件订阅');

  fixture.permission = 'granted';
  assert.equal(await fixture.module.requestMicrophonePermission(), true);
  const session = await fixture.module.voiceRecordingPort.start(params);
  assert.equal(fixture.nativeStarts, 1, '授权变化后允许启动录音，不缓存旧的拒绝结果');
  await session.cancel();
});

await scenario('录音反馈来自实际 PCM：静音继续计时，音量随输入变化且隔离其他 session', async () => {
  const fixture = loadNativeVoiceModule();
  const progress = [];
  const chunks = [];
  const session = await fixture.module.voiceRecordingPort.start({
    onAudioChunk: (chunk) => chunks.push(chunk),
    onError: () => undefined,
    onProgress: (value) => progress.push(value),
  });
  const emit = (sample, sessionId = session.sessionId) => {
    const pcm = Buffer.alloc(6400);
    for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(sample, offset);
    fixture.listeners.get('onRecordingChunk')({ sessionId, base64: pcm.toString('base64') });
  };
  emit(0);
  emit(128);
  emit(-16384);
  emit(32767);
  emit(0);
  emit(32767, 'other-recording');
  assert.deepEqual(progress.map((value) => value.durationMs), [200, 400, 600, 800, 1000]);
  assert.equal(progress[0].level, 0);
  assert.ok(progress[1].level > 0 && progress[1].level < progress[2].level);
  assert.ok(progress[2].level < progress[3].level && progress[3].level <= 1);
  assert.equal(progress[4].level, 0, '恢复静音后声波必须收回');
  assert.equal(chunks.length, 5, '计量必须复用交给转写的同一份音频，不改变 chunk 交付');
  await session.cancel();
  assert.equal(fixture.listeners.size, 0);
});

await scenario('application 透传同一录音的反馈，保留原有转写 consumer', async () => {
  const device = createDeviceMock();
  const start = device.voiceRecordingPort.start;
  let capture;
  device.voiceRecordingPort.start = async (params) => {
    capture = params;
    return start(params);
  };
  const { module, speechMock } = loadUserVoiceModule({ device });
  const progress = [];
  const session = await module.startUserVoiceMessageRecording({ ...baseParams, onProgress: (value) => progress.push(value) });
  const value = { durationMs: 200, level: 0.5 };
  capture.onProgress(value);
  capture.onAudioChunk(new ArrayBuffer(6400));
  assert.deepEqual(progress, [value]);
  assert.equal(speechMock.__calls.accept, 1);
  await session.cancel();
});

await scenario('取消后的录音反馈失去所有权，新录音从零开始', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const voiceModule = createControllableVoiceModule();
  const start = voiceModule.startUserVoiceMessageRecording;
  const starts = [];
  voiceModule.startUserVoiceMessageRecording = (params) => { starts.push(params); return start(params); };
  const module = loadUseChatSendFlow({ react: React, ...createSendFlowDeps({ voiceModule }) });
  let hook;
  function Harness({ sessionId }) {
    hook = module.useChatSendFlow(buildSendFlowParams({ sessionId }));
    return null;
  }
  let renderer;
  await act(async () => { renderer = create(React.createElement(Harness, { sessionId: 's1' })); });
  let starting;
  await act(async () => { starting = hook.startVoiceRecording(); });
  await act(async () => { voiceModule.__deferreds[0].resolve(voiceModule.__makeRecording()); await starting; });
  await act(async () => { starts[0].onProgress({ durationMs: 800, level: 0.6 }); });
  assert.deepEqual(hook.voiceRecordingProgress, { durationMs: 800, level: 0.6 });
  await act(async () => { await hook.cancelVoiceRecording(); });
  await act(async () => { starting = hook.startVoiceRecording(); });
  assert.deepEqual(hook.voiceRecordingProgress, { durationMs: 0, level: 0 });
  await act(async () => { starts[0].onProgress({ durationMs: 1000, level: 1 }); });
  assert.deepEqual(hook.voiceRecordingProgress, { durationMs: 0, level: 0 });
  await act(async () => { voiceModule.__deferreds[1].resolve(voiceModule.__makeRecording()); await starting; });
  await act(async () => { starts[1].onProgress({ durationMs: 200, level: 0.4 }); });
  assert.equal(hook.voiceRecordingProgress.durationMs, 200);
  await act(async () => { renderer.update(React.createElement(Harness, { sessionId: 's2' })); });
  await act(async () => { starts[1].onProgress({ durationMs: 400, level: 1 }); });
  assert.equal(hook.voiceRecordingState, 'idle');
  assert.equal(hook.voiceRecordingProgress.durationMs, 200, '旧会话不得再更新反馈');
  await act(async () => { renderer.unmount(); });
});

await scenario('长按录音显示反馈，滑出提示取消，移回后松开进入识别与校对', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const theme = { colors: { text: { primary: '#111' }, icon: { primary: '#111' } } };
  const { default: ChatInputArea } = loadTypeScriptModule('src/features/chat/presentation/messages/components/ChatInputArea.tsx', {
    react: { ...React, default: React },
    'react-native': { View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', Keyboard: { dismiss() {} } },
    '@shared/ui': { AppTextInput: 'AppTextInput', showAppDialog() {} },
    '@expo/vector-icons': { Ionicons: 'Ionicons' },
    'lucide-react-native': { BrainCircuit: 'BrainCircuit', Keyboard: 'Keyboard' },
    './ChatEmojiPanel': { default: 'ChatEmojiPanel' },
    './ChatToolPanel': { default: 'ChatToolPanel' },
    './ChatAttachmentComposerTray': { default: 'ChatAttachmentComposerTray' },
    './ChatVoiceReviewPanel': { ChatVoiceReviewPanel: 'ChatVoiceReviewPanel' },
    './ChatVoiceRecordingFeedback': { ChatVoiceRecordingFeedback: 'RecordingFeedback' },
    './chatInputStyles': { createInputAreaStyles: () => ({}) },
    '@shared/theme': { useTheme: () => theme, isMoonKimiTheme: () => false, ThemedSurface: 'ThemedSurface' },
    './MoonKimiComposer': { MoonKimiComposer: 'MoonKimiComposer' },
    './chatToolPanelCapability': { resolveTogetherListeningToolPanelHandler: () => undefined },
    './chatInputLimits': { CHAT_INPUT_MAX_LENGTH: 10000 },
  });
  let finishes = 0;
  let cancels = 0;
  const props = {
    value: '', onChangeText() {}, onSend() {}, activeSurface: 'none', onActiveSurfaceChange() {}, surfaceHeight: 200,
    voiceRecordingState: 'idle', voiceRecordingProgress: { durationMs: 2400, level: 0.6 },
    onVoiceRecordingStart: async () => true,
    onVoiceRecordingFinish: async () => { finishes += 1; return true; },
    onVoiceRecordingCancel: async () => { cancels += 1; },
  };
  let renderer;
  const render = async (patch) => {
    Object.assign(props, patch);
    await act(async () => { renderer.update(React.createElement(ChatInputArea, props)); });
  };
  const button = () => renderer.root.findAllByType('View').find((view) => view.props.onResponderGrant);
  const feedback = () => renderer.root.findByType('RecordingFeedback').props;
  const move = async (x) => {
    await act(async () => { button().props.onResponderMove({ nativeEvent: { locationX: x, locationY: 20 } }); });
  };
  await act(async () => { renderer = create(React.createElement(ChatInputArea, props)); });
  await act(async () => { await renderer.root.findAllByType('TouchableOpacity')[0].props.onPress(); });
  await act(async () => {
    button().props.onLayout({ nativeEvent: { layout: { width: 300, height: 44 } } });
    button().props.onResponderGrant();
  });
  await render({ voiceRecordingState: 'starting' });
  assert.equal(feedback().isPreparing, true, 'starting 期间必须立刻显示波形反馈，不能等到 recording');
  assert.equal(feedback().isProcessing, false);
  await render({ voiceRecordingState: 'recording' });
  assert.equal(feedback().isPreparing, false);
  assert.equal(feedback().level, 0.6);
  await move(-1);
  assert.equal(feedback().isCancelling, true);
  await move(100);
  assert.equal(feedback().isCancelling, false);
  await act(async () => { button().props.onResponderRelease(); });
  assert.equal(finishes, 1);
  assert.equal(cancels, 0);
  await render({ voiceRecordingState: 'processing' });
  assert.equal(feedback().isProcessing, true);
  assert.equal(feedback().isCancelling, false);
  await render({ voiceRecordingState: 'reviewing', voiceReviewDraft: { transcript: '校对', durationMs: 2400 } });
  assert.equal(renderer.root.findAllByType('RecordingFeedback').length, 0);
  assert.equal(renderer.root.findAllByType('ChatVoiceReviewPanel').length, 1);
  await render({ voiceRecordingState: 'idle', voiceReviewDraft: null });
  await act(async () => { button().props.onResponderGrant(); });
  await render({ voiceRecordingState: 'recording' });
  await move(301);
  await act(async () => { button().props.onResponderRelease(); });
  assert.equal(cancels, 1, '滑出松开必须丢弃录音');
  assert.equal(finishes, 1, '取消不得进入识别');
  await act(async () => { renderer.unmount(); });
});

// ============================================================================
// 3) STT 配置边界：正式调用与设置测试共享提供方契约
// ============================================================================

await scenario('实时 STT 配置拒绝缺失的腾讯凭证参数，允许明确清空 Key 保存不可用资产', () => {
  const catalog = loadTypeScriptModule('src/features/speech/application/SpeechProviderCatalog.ts');
  const draftModule = loadTypeScriptModule('src/features/assistants/presentation/auxiliaryModels/speechModelDraft.ts', { '@features/speech': catalog });
  const draft = draftModule.getSpeechModelDraft('stt', { name: 'STT', enabled: true, baseUrl: 'wss://asr.cloud.tencent.com/asr/v2', model: '16k_zh', apiKey: 'key', metadataJson: JSON.stringify({ provider: 'tencentRealtimeAsr', appId: '123', secretId: 'id' }) });
  for (const field of ['appId', 'secretId']) {
    const parsed = draftModule.parseSpeechModelDraft('stt', { ...draft, [field]: '' }, [field]);
    assert.ok(parsed.errors[field]);
    assert.equal(parsed.accepted.includes(field), false);
  }
  const cleared = draftModule.parseSpeechModelDraft('stt', { ...draft, apiKey: '' }, ['apiKey']);
  assert.equal(cleared.patch.apiKey, null);
  const configuration = draftModule.buildSpeechDraftConfiguration(draft);
  assert.deepEqual(catalog.validateSpeechConfiguration('stt', configuration), {});
  assert.equal(JSON.parse(configuration.metadataJson).appId, '123');
});

// ============================================================================
// 4) Android native 录音清理契约（源码级，真机行为另列）
// ============================================================================

await scenario('Android stopRecording：writeWav 失败时删除 PCM 与 partial WAV，并进入合法终态', () => {
  const source = read(
    'modules/voice-message-audio/android/src/main/java/expo/modules/voicemessageaudio/VoiceMessageAudioModule.kt',
  );
  assert.ok(
    /writeWav\(source, wavFile, recordingSampleRate, recordedBytes\)[\s\S]{0,400}catch/.test(source),
    'writeWav 必须被 try/catch 包裹',
  );
  assert.ok(source.includes('wavFile.delete()'), 'partial WAV 必须删除');
  assert.ok(
    /recordingSessionId = null/.test(source),
    'stopRecording 必须在清理前把 session state 收口',
  );
});

await scenario('Android stop barrier：先翻转 recording 标志并 join 线程，之后才 release recorder', () => {
  const source = read(
    'modules/voice-message-audio/android/src/main/java/expo/modules/voicemessageaudio/VoiceMessageAudioModule.kt',
  );
  const stopBody = source.slice(source.indexOf('private fun stopRecording'));
  const flagIndex = stopBody.indexOf('recording = false');
  const joinIndex = stopBody.indexOf('recordingThread?.join');
  const releaseIndex = stopBody.indexOf('activeRecorder?.release()');
  assert.ok(flagIndex >= 0 && joinIndex > flagIndex, '必须先翻转标志再 join 录音线程');
  assert.ok(releaseIndex > joinIndex, '必须 join 线程后才 release recorder');
});

await scenario('JS stop() 等待 native flush，保留最后的音频 chunk 后释放订阅', async () => {
  const fixture = loadNativeVoiceModule();
  const chunks = [];
  const session = await fixture.module.voiceRecordingPort.start({
    onAudioChunk: (chunk) => chunks.push([...new Uint8Array(chunk)]),
    onError: () => undefined,
  });
  const stopping = session.stop();
  assert.deepEqual(fixture.removed, [], 'native stop 尚未完成时必须保留订阅');
  fixture.listeners.get('onRecordingChunk')({ sessionId: session.sessionId, base64: 'AQI=' });
  assert.deepEqual(chunks, [[1, 2]], 'stop barrier 内的最后一个 chunk 仍必须交给转写 consumer');

  const result = { uri: 'file:///tmp/native.wav', mimeType: 'audio/wav', durationMs: 1200 };
  fixture.stopResult.resolve(result);
  assert.deepEqual(await stopping, result);
  assert.equal(fixture.listeners.size, 0);
});

await scenario('JS stop() 的 native 失败仍释放订阅并报告录音错误', async () => {
  const fixture = loadNativeVoiceModule();
  const session = await fixture.module.voiceRecordingPort.start({
    onAudioChunk: () => undefined,
    onError: () => undefined,
  });
  const stopping = session.stop();
  fixture.stopResult.reject(new Error('native stop failure'));
  await assert.rejects(stopping, (error) => error.code === 'VOICE_RECORDING_FAILED');
  assert.equal(fixture.listeners.size, 0);
});

// ============================================================================
// 5) 播放状态契约
// ============================================================================

function playbackDevice(player) {
  const { localAudioPlaybackCoordinator } = loadTypeScriptModule('src/platform/device/LocalAudioPlaybackCoordinator.ts', {
    './LocalAudioPlayback': { localAudioPlaybackPort: player },
  });
  return { localAudioPlaybackCoordinator };
}

await scenario('markVoiceMessagePlayed 幂等：已写入后不再重复更新', () => {
  const source = read(
    'src/features/chat/messages/application/MarkVoiceMessagePlayed.ts',
  );
  assert.ok(source.includes('if (message.voicePlayedAt)'), '必须短路已播放消息');
  assert.ok(
    source.includes("message.isMe || message.senderType !== 'assistant'"),
    '只允许 assistant 语音标记播放',
  );
});

await scenario('只有原生播放器确认开始后才标记原消息已播放', async () => {
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  const marked = [];
  const { voiceMessagePlaybackCoordinator: coordinator } = loadTypeScriptModule('src/features/chat/messages/application/VoiceMessagePlaybackCoordinator.ts', {
    '@features/media': { resolveMediaAsset: async () => ({ localUri: 'file:///audio.wav' }) },
    '@platform/device': playbackDevice({ play: () => pending }),
    './MarkVoiceMessagePlayed': { markVoiceMessagePlayed: async id => { marked.push(id); } },
  });
  const playback = coordinator.toggle({ kind: 'message', id: 42, isIncoming: true }, 'audio', 1000);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(marked, []);
  started({ subscribe: () => () => {}, stop: async () => {} });
  await playback;
  assert.deepEqual(marked, [42]);
  await coordinator.stop();
});

await scenario('引用语音使用独立播放身份，不改写原消息已播放状态', async () => {
  const marked = [], played = [];
  const { voiceMessagePlaybackCoordinator: coordinator, getVoicePlaybackKey } = loadTypeScriptModule('src/features/chat/messages/application/VoiceMessagePlaybackCoordinator.ts', {
    '@features/media': { resolveMediaAsset: async id => { assert.equal(id, 'quoted-audio'); return { localUri: 'file:///quoted.wav' }; } },
    '@platform/device': playbackDevice({ play: async uri => { played.push(uri); return { subscribe: () => () => {}, stop: async () => {} }; } }),
    './MarkVoiceMessagePlayed': { markVoiceMessagePlayed: async id => { marked.push(id); } },
  });
  const target = { kind: 'quote', id: '42' };
  assert.notEqual(getVoicePlaybackKey(target), getVoicePlaybackKey({ kind: 'message', id: 42, isIncoming: true }));
  assert.notEqual(getVoicePlaybackKey(target), getVoicePlaybackKey({ kind: 'favorite', id: '42' }));
  await coordinator.toggle(target, 'quoted-audio', 1000);
  assert.deepEqual(played, ['file:///quoted.wav']);
  assert.deepEqual(marked, []);
  await coordinator.stop();
});

await scenario('MarkVoiceMessagePlayed SQL 幂等：只在 voice_played_at IS NULL 时更新', () => {
  const source = read('src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts');
  assert.ok(
    /WHERE id = \? AND voice_played_at IS NULL/.test(source),
    'markVoiceMessagePlayed 必须是幂等 UPDATE',
  );
});

await scenario('媒体解析或播放失败时保持原消息未播放状态', async () => {
  for (const failResolve of [true, false]) {
    const marked = [], states = [];
    const { voiceMessagePlaybackCoordinator: coordinator } = loadTypeScriptModule('src/features/chat/messages/application/VoiceMessagePlaybackCoordinator.ts', {
      '@features/media': { resolveMediaAsset: async () => { if (failResolve) throw new Error('媒体缺失'); return { localUri: 'file:///audio.wav' }; } },
      '@platform/device': playbackDevice({ play: async () => { throw new Error('播放失败'); } }),
      './MarkVoiceMessagePlayed': { markVoiceMessagePlayed: async id => { marked.push(id); } },
    });
    const unsubscribe = coordinator.subscribe(42, 1000, state => states.push(state));
    await coordinator.toggle({ kind: 'message', id: 42, isIncoming: true }, 'audio', 1000);
    assert.deepEqual(marked, []);
    assert.equal(states.at(-1).state, 'error');
    unsubscribe(); await coordinator.stop();
  }
});

// ============================================================================
// 6) metadata / 预览 / 数据库兼容契约
// ============================================================================

await scenario('voice metadata 校验 fail closed：字段缺失或非法返回 null', () => {
  const metadataModule = loadChatMessageMetadataModule();
  assert.equal(
    metadataModule.parseMessageMetadata({ metadataJson: '{"kind":"voice","voice":{"schemaVersion":1}}' }),
    null,
    'malformed voice metadata 必须返回 null',
  );
  assert.equal(
    metadataModule.parseMessageMetadata({ metadataJson: 'not json' }),
    null,
    '非法 JSON 必须返回 null',
  );
  const valid = metadataModule.parseMessageMetadata({
    metadataJson: JSON.stringify({
      kind: 'voice',
      voice: {
        schemaVersion: 1,
        mediaAssetId: 'm1',
        mimeType: 'audio/wav',
        durationMs: 900,
        transcriptSource: 'user_stt',
      },
    }),
  });
  assert.ok(valid && valid.kind === 'voice', '合法 voice metadata 必须被接受');
});

await scenario('AI / 用户语音 preview 固定为 [语音消息]，不泄漏 transcript', () => {
  const metadataModule = loadChatMessageMetadataModule();
  for (const transcriptSource of ['user_stt', 'assistant_source_text']) {
    const preview = metadataModule.buildSessionPreviewTextFromMessage({
      text: '这段完整正文绝不能出现在 preview 里',
      metadataJson: JSON.stringify({
        kind: 'voice',
        voice: {
          schemaVersion: 1,
          mediaAssetId: 'm1',
          mimeType: 'audio/wav',
          durationMs: 900,
          transcriptSource,
        },
      }),
    });
    assert.equal(preview, '[语音消息]', `${transcriptSource} preview 必须是 [语音消息]`);
    assert.ok(
      !preview.includes('绝不能出现'),
      `${transcriptSource} preview 不得泄漏 transcript`,
    );
  }
});

await scenario('用户语音保留来源标签，AI 转写正文不携带系统说明', () => {
  const metadataModule = loadChatMessageMetadataModule();
  const build = (isMe) => metadataModule.buildVoiceMessageModelText({
    isMe,
    text: '转写正文',
    metadataJson: JSON.stringify({
      kind: 'voice',
      voice: {
        schemaVersion: 1,
        mediaAssetId: 'm1',
        mimeType: 'audio/wav',
        durationMs: 900,
        transcriptSource: isMe ? 'user_stt' : 'assistant_source_text',
      },
    }),
  });
  assert.equal(build(true), '[用户语音转写]\n转写正文');
  assert.equal(build(false), '转写正文', 'AI 发言只保留转写正文，来源与真实发送要求单独进入系统提示');
});

await scenario('普通文字中的语音标签不能充当已发送语音的事实', () => {
  const metadataModule = loadChatMessageMetadataModule();
  const fakeVoice = { isMe: false, text: '[AI语音消息转写]\n宝宝，我在呢。', metadataJson: null };
  assert.equal(metadataModule.buildVoiceMessageModelText(fakeVoice), null);
  assert.equal(metadataModule.getMessageVoice(fakeVoice), null);
});

await scenario('空 transcript 的语音消息必须抛错，不允许以空文本模拟语音', () => {
  const metadataModule = loadChatMessageMetadataModule();
  assert.throws(() => metadataModule.buildVoiceMessageModelText({
    isMe: true,
    text: '   ',
    metadataJson: JSON.stringify({
      kind: 'voice',
      voice: {
        schemaVersion: 1,
        mediaAssetId: 'm1',
        mimeType: 'audio/wav',
        durationMs: 900,
        transcriptSource: 'user_stt',
      },
    }),
  }));
});

await scenario('当前 schema 提供 voice_played_at', () => {
  assert.ok(
    read('src/platform/persistence/sqlite/schema.ts').includes('voice_played_at TEXT'),
    'fresh schema 必须有 voice_played_at',
  );

});

// ============================================================================
// 7) AI 语音 T3：timeline 顺序 / fence 失败 discard
// ============================================================================

/** ChatAgentTimeline 的运行时依赖较多，这里按真实契约提供最小实现。 */
function loadChatAgentTimelineModule() {
  const createdAssets = [];
  const voiceToolModule = {
    isVoiceMessageSendIntent: (value) => Boolean(
      value && value.discriminator === 'ravencat.chat.voice_message.send.v1',
    ),
    VOICE_MESSAGE_SEND_INTENT_DISCRIMINATOR: 'ravencat.chat.voice_message.send.v1',
  };
  const stickerModule = {
    isStickerSendIntent: () => false,
  };
  const metadataModule = loadChatMessageMetadataModule();
  const timeline = loadTypeScriptModule('src/features/chat/reply/agent/ChatAgentTimeline.ts', {
    '../application/AutonomousReplyContract': loadTypeScriptModule('src/features/chat/reply/application/AutonomousReplyContract.ts'),
    '@platform/ai': {},
    '@platform/agentRuntime': {},
    '@features/stickers': stickerModule,
    '../../messages/domain/ChatMessage': {},
    '../../messages/domain/AgentTimelineIdentity': {
      buildAgentTimelineClientMessageId: (runId, seq) => `${runId}:${seq}`,
      buildAgentTimelineIdentity: (runId, seq) => `${runId}#${seq}`,
    },
    '../application/ChatReplyTypes': {},
    '../application/ReplyPolicy': {},
    '../application/ChatReplyMetadata': {
      buildChatToolStatusMessageMetadata: () => ({}),
      buildMessageMetadata: () => ({}),
    },
    '../application/AssistantReplyPersistence': {
      normalizeAssistantResponseText: (text) => ({ text, segments: [] }),
    },
    '../application/AssistantReplySegmentation': loadTypeScriptModule('src/features/chat/reply/application/AssistantReplySegmentation.ts'),
    '../application/AssistantTurnCommit': { buildAssistantTurnItems: () => [] },
    '../application/ChatReplyUtils': { formatMessageTime: () => '12:00' },
    '../domain/ConversationTurn': {},
    './ChatAgentModelGateway': {},
    './ToolReplyPresentation': {
      buildToolStatusText: () => '',
      joinToolDisplayNames: () => '',
      resolveToolCallDisplayName: () => '',
    },
    './SendVoiceMessageTool': voiceToolModule,
    './SharedMomentSendIntent': sharedMomentIntent,
    './SendImageTool': { isImageSendIntent: () => false },
    '../../messages/domain/chatMessageMetadata': metadataModule,
  });
  return { timeline, createdAssets };
}

// committedAssetDurationMs 模拟 catalog 复用历史 asset 时返回的历史 metadata 时长；
// 默认与 intent duration 一致（500），只有验证「复用 asset 不得覆盖业务 duration」
// 的场景才传不同值。
function createPreparedMediaBatchStub(label, committedAssetDurationMs = 500) {
  return {
    label,
    state: 'open',
    async commitInTransaction() {
      this.state = 'staged';
      return {
        assets: [{
          id: `asset-${label}`,
          mimeType: 'audio/wav',
          durationMs: committedAssetDurationMs,
        }],
      };
    },
    async finalizeAfterCommit() { this.state = 'finalized'; },
    async discardAfterRollback() { this.state = 'discarded'; },
  };
}

function createVoiceOutcome(label, preparedMedia, durationMs = 500) {
  return {
    status: 'success',
    data: {
      discriminator: 'ravencat.chat.voice_message.send.v1',
      transcript: `语音-${label}`,
      mimeType: 'audio/wav',
      durationMs,
      preparedMedia,
    },
  };
}

await scenario('AI 语音：多个 send_voice_message 按模型 tool-call 顺序进入 T3 items', () => {
  const { timeline: timelineModule } = loadChatAgentTimelineModule();
  const timeline = new timelineModule.ChatAgentTimeline('run-1');

  timeline.startStep(0);
  timeline.reconcileModelTurn(0, {
    messageId: 'm0',
    reasoningText: '',
    assistantText: '',
    toolCalls: [
      { id: 't1', name: 'send_voice_message', arguments: '{}' },
      { id: 't2', name: 'send_voice_message', arguments: '{}' },
      { id: 't3', name: 'send_voice_message', arguments: '{}' },
    ],
    usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
  }, false);

  timeline.completeToolCall(0, 't1', createVoiceOutcome('a', createPreparedMediaBatchStub('a')));
  timeline.completeToolCall(0, 't2', createVoiceOutcome('b', createPreparedMediaBatchStub('b')));
  timeline.completeToolCall(0, 't3', createVoiceOutcome('c', createPreparedMediaBatchStub('c')));

  const params = {
    sessionId: 's1',
    policy: { bubbleDeliveryMode: 'immediate' },
    finalAssistantPolicy: 'commit_as_reply',
    finalStepIndex: 0,
  };
  const items = timeline.buildCommitItems(params);

  const transcripts = items
    .filter((item) => typeof item.materializeInTransaction === 'function')
    .map((item) => item.message.text);
  assert.deepEqual(
    transcripts, ['语音-a', '语音-b', '语音-c'],
    '多条 AI 语音必须按 tool-call 完成顺序排列',
  );
});

// 回归：同用户语音，AI 侧 intent duration 是本次 TTS 合成后测得的业务事实，
// catalog 复用 asset 的历史 durationMs 不得反向覆盖它。
await scenario('复用 asset 的历史 duration 不得覆盖本次 AI 语音的业务 duration', async () => {
  const { timeline: timelineModule } = loadChatAgentTimelineModule();
  const timeline = new timelineModule.ChatAgentTimeline('run-1');

  const batch = createPreparedMediaBatchStub('a', 999);
  timeline.startStep(0);
  timeline.reconcileModelTurn(0, {
    messageId: 'm0',
    reasoningText: '',
    assistantText: '',
    toolCalls: [{ id: 't1', name: 'send_voice_message', arguments: '{}' }],
    usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
  }, false);
  timeline.completeToolCall(0, 't1', createVoiceOutcome('a', batch, 1200));

  const params = {
    sessionId: 's1',
    policy: { bubbleDeliveryMode: 'immediate' },
    finalAssistantPolicy: 'commit_as_reply',
    finalStepIndex: 0,
  };
  const items = timeline.buildCommitItems(params);
  const voiceItem = items.find((item) => typeof item.materializeInTransaction === 'function');
  assert.ok(voiceItem, '必须产出 AI 语音 commit item');

  const materialized = await voiceItem.materializeInTransaction({}, voiceItem.message);
  const persisted = JSON.parse(materialized.metadataJson);
  assert.equal(
    persisted.voice.durationMs, 1200,
    '复用 asset 的 durationMs=999 只是资产 metadata，消息 duration 必须取本次 send intent 的 1200',
  );
  assert.equal(persisted.voice.transcriptSource, 'assistant_source_text', 'AI 语音保留模型正文来源');
});

await scenario('AI 语音 fence 失败 / rollback：discard 全部 prepared backing，零 voice message', async () => {
  const { timeline: timelineModule } = loadChatAgentTimelineModule();
  const timeline = new timelineModule.ChatAgentTimeline('run-1');

  const batchA = createPreparedMediaBatchStub('a');
  const batchB = createPreparedMediaBatchStub('b');
  timeline.startStep(0);
  timeline.reconcileModelTurn(0, {
    messageId: 'm0',
    reasoningText: '',
    assistantText: '',
    toolCalls: [
      { id: 't1', name: 'send_voice_message', arguments: '{}' },
      { id: 't2', name: 'send_voice_message', arguments: '{}' },
    ],
    usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
  }, false);
  timeline.completeToolCall(0, 't1', createVoiceOutcome('a', batchA));
  timeline.completeToolCall(0, 't2', createVoiceOutcome('b', batchB));

  const params = {
    sessionId: 's1',
    policy: { bubbleDeliveryMode: 'immediate' },
    finalAssistantPolicy: 'commit_as_reply',
    finalStepIndex: 0,
  };
  const items = timeline.buildCommitItems(params);
  const voiceItems = items.filter((item) => item.discardAfterRollback);

  for (const item of voiceItems) await item.discardAfterRollback();

  assert.equal(batchA.state, 'discarded', 'queue a backing 必须被清理');
  assert.equal(batchB.state, 'discarded', 'queue b backing 必须被清理');
  assert.equal(
    batchA.state === 'finalized' || batchB.state === 'finalized', false,
    '未提交 run 不得 finalize backing',
  );
});

await scenario('AI 语音 T3 成功：每个 voice item 暴露 finalize 与 rollback 两个显式出口', () => {
  const { timeline: timelineModule } = loadChatAgentTimelineModule();
  const timeline = new timelineModule.ChatAgentTimeline('run-1');
  timeline.startStep(0);
  timeline.reconcileModelTurn(0, {
    messageId: 'm0',
    reasoningText: '',
    assistantText: '',
    toolCalls: [{ id: 't1', name: 'send_voice_message', arguments: '{}' }],
    usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
  }, false);
  timeline.completeToolCall(0, 't1', createVoiceOutcome('a', createPreparedMediaBatchStub('a')));

  const items = timeline.buildCommitItems({
    sessionId: 's1',
    policy: { bubbleDeliveryMode: 'immediate' },
    finalAssistantPolicy: 'commit_as_reply',
    finalStepIndex: 0,
  });
  const voiceItem = items.find((item) => item.materializeInTransaction);
  assert.ok(voiceItem, 'AI 语音必须提供 materializeInTransaction');
  assert.equal(typeof voiceItem.finalizeAfterCommit, 'function', '必须提供 finalizeAfterCommit');
  assert.equal(typeof voiceItem.discardAfterRollback, 'function', '必须提供 discardAfterRollback');
});

await scenario('send_voice_message 空文本直接失败不合成 TTS', async () => {
  let ttsCalls = 0;
  const mediaMock = createMediaMock();
  const { SendVoiceMessageTool } = loadTypeScriptModule('src/features/chat/reply/agent/SendVoiceMessageTool.ts', {
    '@features/media': mediaMock,
    '@features/speech': {
      synthesizeTextToSpeech: async () => {
        ttsCalls += 1;
        return { success: false, rawError: '空文本不应触发 TTS' };
      },
    },
    '@platform/device': {},
    '@shared/aiTools': loadTypeScriptModule('src/shared/aiTools/ToolCompletionIntent.ts'),
    '@shared/runtime/abortSignal': { throwIfAbortSignalAborted: () => undefined },
  });
  for (const text of ['', ' \t\n ']) {
    const result = await SendVoiceMessageTool.execute({ text, on_success: 'finish' }, {
      task: { assistantId: 'assistant-1' },
      abortSignal: new AbortController().signal,
    });
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'VOICE_TEXT_EMPTY');
  }
  assert.equal(ttsCalls, 0, '空文本不得进行语音合成');
  assert.equal(mediaMock.__batches.length, 0, '空文本不得准备媒体资产');
});

await scenario('AI 语音成功转交 finish / continue 意图，合成失败不声明完成', async () => {
  let failTTS = false;
  const deletedAudio = [];
  const mediaMock = createMediaMock();
  const { createConfiguredVoiceMessageTool } = loadTypeScriptModule('src/features/chat/reply/agent/SendVoiceMessageTool.ts', {
    '@features/media': mediaMock,
    '@features/speech': {
      resolveTextToSpeechModel: async () => null,
      synthesizeTextToSpeech: async () => failTTS
        ? { success: false, rawError: '未配置语音模型' }
        : { success: true, audioUri: 'file://test-voice.wav', mimeType: 'audio/wav' },
    },
    '@platform/device': {
      readLocalAudioMetadata: async () => ({ durationMs: 1200 }),
      temporarySpeechAudioStore: { deleteIfExists: async (uri) => deletedAudio.push(uri) },
    },
    '@shared/aiTools': loadTypeScriptModule('src/shared/aiTools/ToolCompletionIntent.ts'),
    '@shared/runtime/abortSignal': loadTypeScriptModule('src/shared/runtime/abortSignal.ts'),
  });
  const tool = await createConfiguredVoiceMessageTool('assistant-1');
  assert.ok(tool.definition.parameters.required.includes('on_success'), '动态语音 schema 也必须要求明确意图');
  const context = {
    toolCallId: 'voice-test', task: { assistantId: 'assistant-1' },
    abortSignal: new AbortController().signal,
  };
  for (const on_success of ['finish', 'continue']) {
    const result = await tool.execute({ text: '我陪着你', on_success }, context);
    assert.equal(result.status, 'success');
    assert.equal(result.metadata.completionIntent, on_success);
    assert.equal(result.metadata.fulfillsUserVisibleOutput, true);
    assert.equal(result.data.transcript, '我陪着你');
    assert.equal(result.data.preparedMedia.state, 'open', '工具成功仍只准备媒体，不提前提交');
  }
  assert.equal(deletedAudio.length, 2, '两种成功意图都释放临时合成音频');
  failTTS = true;
  const failed = await tool.execute({ text: '我陪着你', on_success: 'finish' }, context);
  assert.equal(failed.status, 'error');
  assert.equal(failed.code, 'VOICE_TTS_NOT_CONFIGURED');
  assert.equal(failed.metadata, undefined, '失败不携带成功完成意图');
});

// ============================================================================
// 8) 语音消息长按 / 转文字
// ============================================================================

/** 读取 themeVariants 的 interaction profile（纯函数，无运行时依赖）。 */
function loadThemeVariantsModule() {
  return loadTypeScriptModule('src/shared/theme/themeVariants.ts', {});
}

const THEME_DEFAULT = { id: 'default' };
const THEME_MOON_KIMI = { id: 'moon-kimi' };
const THEME_PAPER_NOTE = { id: 'paper-note' };

await scenario('default theme：普通消息与语音消息都可以长按打开 action menu', () => {
  const variants = loadThemeVariantsModule();
  const profile = variants.getChatInteractionProfile(THEME_DEFAULT);
  assert.equal(profile.enableMessageLongPressMenu, true, 'default 普通消息长按必须开启');
  assert.equal(profile.enableVoiceMessageLongPressMenu, true, 'default 语音长按必须开启');
});

await scenario('Moon Kimi：保留内联操作，同时普通消息可长按收藏', () => {
  const variants = loadThemeVariantsModule();
  const profile = variants.getChatInteractionProfile(THEME_MOON_KIMI);
  assert.equal(
    profile.enableMessageLongPressMenu, true,
    '收藏和消息管理在 Moon Kimi 下同样可达',
  );
  assert.equal(profile.messageActionSurface, 'inline-assistant-actions');
  assert.equal(profile.showAssistantInlineActions, true);
});

await scenario('Moon Kimi：语音消息有独立可达的 transcript action capability', () => {
  const variants = loadThemeVariantsModule();
  const profile = variants.getChatInteractionProfile(THEME_MOON_KIMI);
  assert.equal(
    profile.enableVoiceMessageLongPressMenu, true,
    'Moon Kimi 下语音消息必须仍能长按展开 transcript，且不复用通用长按开关',
  );
  const paperNote = variants.getChatInteractionProfile(THEME_PAPER_NOTE);
  assert.equal(paperNote.enableVoiceMessageLongPressMenu, true, 'paper-note 语音长按同样可达');
});

await scenario('语音条长按只打开菜单，普通点击才播放，保留原始点击坐标', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let pressed = 0;
  const positions = [];
  const Bar = loadTypeScriptModule('src/shared/ui/AudioPlaybackBar.tsx', {
    react: { ...React, default: React },
    'react-native': { View: 'view', Text: 'text', Pressable: 'button', StyleSheet: { create: value => value } },
    'lucide-react-native': { AlertCircle: 'error', Pause: 'pause', Play: 'play' },
    '@shared/theme': { useTheme: () => ({ colors: { text: { primary: 'black' }, border: { default: 'grey' }, feedback: { error: 'red' } } }) },
  }).default;
  let renderer;
  try {
    await act(async () => { renderer = create(React.createElement(Bar, {
      playbackKey: 'voice', durationMs: 1000,
      coordinator: { subscribe: (_key, _duration, listener) => { listener({ state: 'idle', positionMs: 0, durationMs: 1000 }); return () => {}; } },
      onPress: () => { pressed++; }, onLongPress: position => positions.push(position),
    })); });
    const button = renderer.root.findByType('button');
    await act(async () => {
      button.props.onPressIn({ nativeEvent: { pageX: 24, pageY: 88 } });
      button.props.onLongPress(); button.props.onPress();
    });
    assert.deepEqual(positions, [{ x: 24, y: 88 }]);
    assert.equal(pressed, 0);
    await act(async () => { button.props.onPressIn({ nativeEvent: { pageX: 25, pageY: 89 } }); button.props.onPress(); });
    assert.equal(pressed, 1);
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
await scenario('TouchableMessageBubble 把语音长按走独立 capability 与回调，不复用通用长按判断', () => {
  const source = read(
    'src/features/chat/presentation/messages/components/ChatMessageListParts.tsx',
  );
  assert.ok(
    source.includes('interactionProfile.enableVoiceMessageLongPressMenu'),
    '语音长按必须读独立的 profile capability',
  );
  assert.ok(
    /shouldHandleVoiceLongPress[\s\S]{0,120}Boolean\(voice\)/.test(source),
    '语音长按必须以“这是一条语音消息”为前提',
  );
  assert.ok(
    source.includes('canLongPressVoice={shouldHandleVoiceLongPress}'),
    '语音长按 capability 必须显式传给 MessageBubble',
  );
  assert.ok(
    source.includes('onVoiceLongPress={handleVoiceLongPress}'),
    '语音长按回调必须显式传给 MessageBubble',
  );
  // 通用长按开关仍只控制普通文本路径。
  assert.ok(
    source.includes('const shouldHandleLongPress = interactionProfile.enableMessageLongPressMenu'),
    '普通消息长按判断必须保持原样',
  );
});

await scenario('转文字语义：只展开已持久化 transcript，不调用 STT / TTS', () => {
  const voiceCard = read(
    'src/features/chat/presentation/messages/MessageBubble/VoiceMessageCard.tsx',
  );
  assert.ok(
    voiceCard.includes('props.transcript') || voiceCard.includes('transcript'),
    '展开内容必须直接来自已持久化 transcript',
  );
  assert.ok(
    !voiceCard.includes('startVoiceMessageTranscription')
      && !voiceCard.includes('transcribeVoiceMessageRecording')
      && !voiceCard.includes('synthesizeTextToSpeech'),
    '转文字不得重新调用 STT 或 TTS',
  );

  const chatDetail = read('src/features/chat/presentation/messages/ChatDetail/index.tsx');
  assert.ok(
    chatDetail.includes('expandedVoiceTranscriptIds'),
    '展开状态必须是 presentation state',
  );
  assert.ok(
    !/expandedVoiceTranscriptIds[\s\S]{0,400}(SQLite|repository|persist)/i.test(chatDetail),
    '展开状态不得持久化到 SQLite',
  );
});

await scenario('长按菜单按展开状态显示“转文字 / 收起文字”', () => {
  const menu = read(
    'src/features/chat/presentation/messages/components/ChatMessageActionMenu.tsx',
  );
  assert.ok(
    menu.includes("isVoiceTranscriptExpanded ? '收起文字' : '转文字'"),
    '菜单必须根据展开状态切换文案',
  );
  const chatDetail = read('src/features/chat/presentation/messages/ChatDetail/index.tsx');
  assert.ok(
    chatDetail.includes('onToggleVoiceTranscript'),
    'ChatDetail 必须把 toggle 接到菜单',
  );
  assert.ok(
    chatDetail.includes('getMessageVoice(selectedMessage)'),
    '只有语音消息才提供转文字入口',
  );
});

// ============================================================================
// 9) 用户语音发送前校对（reviewing lifecycle）
// ============================================================================

await scenario('STT 成功后不立即 commit，也不创建任何 canonical message', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  const finishDeferred = createDeferred();
  voiceModule.__deferreds[0].resolve({
    finish: () => finishDeferred.promise,
    cancel: async () => { voiceModule.__cancelled.push(true); },
  });
  await pending;

  const finishing = hook.finishVoiceRecording();
  finishDeferred.resolve({
    success: true,
    draft: voiceModule.__makeDraft({ originalTranscript: '这是识别结果' }),
  });
  await finishing;

  assert.equal(readHookVoiceState(react).recordingState, 'reviewing');
  assert.equal(voiceModule.__committed.length, 0, 'STT 成功后绝不立即 commit');
  assert.equal(voiceModule.__discarded.length, 0, 'reviewing 不等于丢弃');
});

await scenario('reviewing 保存 original transcript，用户修改后 commit 使用修改后的文字', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  voiceModule.__deferreds[0].resolve({
    finish: async () => ({
      success: true,
      draft: voiceModule.__makeDraft({ originalTranscript: '原始文本' }),
    }),
    cancel: async () => { voiceModule.__cancelled.push(true); },
  });
  await pending;
  await hook.finishVoiceRecording();

  hook.updateVoiceReviewTranscript('修改后的文本');
  assert.equal(readHookVoiceState(react).reviewDraft.transcript, '修改后的文本');
  assert.equal(
    readHookVoiceState(react).reviewDraft.originalTranscript, '原始文本',
    'original transcript 必须保持不被覆盖，用于 corrected 判定',
  );

  const committed = await hook.commitVoiceReviewDraft();
  assert.equal(committed, true);
  assert.equal(voiceModule.__committed.length, 1);
  assert.equal(voiceModule.__committed[0].transcript, '修改后的文本', 'commit 必须用最终确认文本');
});

await scenario('commit 成功后回到 idle、清空 draft 并刷新 timeline', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const merged = [];
  const hook = module.useChatSendFlow(buildSendFlowParams({
    setMessages: (updater) => { merged.push(updater); },
  }));

  const pending = hook.startVoiceRecording();
  voiceModule.__deferreds[0].resolve(voiceModule.__makeRecording());
  await pending;
  await hook.finishVoiceRecording();

  assert.equal(await hook.commitVoiceReviewDraft(), true);
  assert.equal(readHookVoiceState(react).recordingState, 'idle');
  assert.equal(readHookVoiceState(react).reviewDraft, null, '发送成功后必须清空 draft');
  assert.ok(merged.length > 0, 'commit 成功后必须把 canonical message 合入 timeline');
});

await scenario('reviewing 取消：不创建 message，并清理临时录音', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  voiceModule.__deferreds[0].resolve(voiceModule.__makeRecording());
  await pending;
  await hook.finishVoiceRecording();

  await hook.discardVoiceReviewDraft();

  assert.equal(readHookVoiceState(react).recordingState, 'idle');
  assert.equal(readHookVoiceState(react).reviewDraft, null);
  assert.equal(voiceModule.__committed.length, 0, '取消绝不创建 message');
  assert.deepEqual(voiceModule.__discarded, [0], '取消必须 discard draft（清理临时录音）');
});

await scenario('reviewing 切 session：draft 被 discard，不带进新 session', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  let hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  voiceModule.__deferreds[0].resolve(voiceModule.__makeRecording());
  await pending;
  await hook.finishVoiceRecording();
  assert.equal(readHookVoiceState(react).recordingState, 'reviewing');

  // 切 session 的真实语义：旧 session 的 effect cleanup 先释放 draft，新 session 再挂载。
  // 用同一次 React stub 重新 render（ref/state 身份保持，props.sessionId 变化）。
  react.__unmount();
  react.__beginRender();
  hook = module.useChatSendFlow(buildSendFlowParams({ sessionId: 's2' }));

  assert.equal(readHookVoiceState(react).recordingState, 'idle', '切 session 返回 idle');
  assert.equal(readHookVoiceState(react).reviewDraft, null, '切 session 必须清空 draft');
  assert.deepEqual(voiceModule.__discarded, [0], '切 session 必须 discard 旧 session 的 draft');
  assert.equal(voiceModule.__committed.length, 0, '切 session 不得提交旧 session 的语音');

  // 新 session 必须能立刻重新长按录音（旧 in-flight 标记已被清除）。
  const restarted = hook.startVoiceRecording();
  assert.equal(readHookVoiceState(react).recordingState, 'starting');
  voiceModule.__deferreds[1].resolve(voiceModule.__makeRecording());
  assert.equal(await restarted, true, '新 session 必须能立即重新录音');
  assert.equal(readHookVoiceState(react).recordingState, 'recording');
});

await scenario('reviewing unmount：effect cleanup 丢弃 draft，不留下录音资源', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  voiceModule.__deferreds[0].resolve(voiceModule.__makeRecording());
  await pending;
  await hook.finishVoiceRecording();

  const before = readHookVoiceState(react).reviewDraft;
  assert.ok(before, 'unmount 前确实持有 draft');

  // unmount：effect cleanup 是唯一的释放入口。
  react.__unmount();
  await Promise.resolve();

  assert.deepEqual(
    voiceModule.__discarded, [0],
    'unmount 必须 discard reviewing 中的 draft（释放临时录音）',
  );
  assert.equal(voiceModule.__committed.length, 0, 'unmount 不得提交 message');
});

await scenario('processing 期间切 session：STT 结果不得生成 stale draft', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  const finishDeferred = createDeferred();
  voiceModule.__deferreds[0].resolve({
    finish: () => finishDeferred.promise,
    cancel: async () => { voiceModule.__cancelled.push(true); },
  });
  await pending;

  const finishing = hook.finishVoiceRecording();
  assert.equal(readHookVoiceState(react).recordingState, 'processing');

  // STT 尚未返回时切 session。
  react.__unmount();

  finishDeferred.resolve({ success: true, draft: voiceModule.__makeDraft() });
  assert.equal(await finishing, false, 'stale finish 必须报告未成功');
  assert.equal(readHookVoiceState(react).reviewDraft, null, '绝不生成 stale draft');
  assert.equal(voiceModule.__committed.length, 0);
  assert.deepEqual(voiceModule.__discarded, [0], 'stale STT 结果必须 self-discard');
});

await scenario('processing 期间取消：STT 返回后 self-discard，不生成 reviewing', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  const finishDeferred = createDeferred();
  voiceModule.__deferreds[0].resolve({
    finish: () => finishDeferred.promise,
    cancel: async () => { voiceModule.__cancelled.push(true); },
  });
  await pending;

  const finishing = hook.finishVoiceRecording();
  await hook.cancelVoiceRecording();

  finishDeferred.resolve({ success: true, draft: voiceModule.__makeDraft() });
  assert.equal(await finishing, false);
  assert.equal(readHookVoiceState(react).recordingState, 'idle');
  assert.equal(readHookVoiceState(react).reviewDraft, null);
  assert.deepEqual(voiceModule.__discarded, [0], '取消后完成的 STT 必须 self-discard');
});

await scenario('committing 时切 session：不并发 discard，成功后不污染新 session timeline', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const merged = [];
  let hook = module.useChatSendFlow(buildSendFlowParams({
    setMessages: (updater) => { merged.push(updater); },
  }));

  const pending = hook.startVoiceRecording();
  const commitDeferred = createDeferred();
  voiceModule.__deferreds[0].resolve({
    finish: async () => ({
      success: true,
      draft: voiceModule.__makeDraft({ commit: () => commitDeferred.promise }),
    }),
    cancel: async () => { voiceModule.__cancelled.push(true); },
  });
  await pending;
  await hook.finishVoiceRecording();
  const committing = hook.commitVoiceReviewDraft();

  react.__unmount();
  assert.deepEqual(voiceModule.__discarded, [], 'commit pending 时 cleanup 不得调用 draft.discard');
  react.__beginRender();
  hook = module.useChatSendFlow(buildSendFlowParams({ sessionId: 's2' }));
  commitDeferred.resolve({ success: true, message: { id: 9, sessionId: 's1', text: '旧会话语音' } });

  assert.equal(await committing, false, 'stale commit 不再拥有 presentation 成功结果');
  assert.deepEqual(voiceModule.__discarded, [], '成功 commit 已自行终结，不得 rollback discard');
  assert.deepEqual(merged, [], '旧 session message 不得 replace 到新 session');
  assert.equal(readHookVoiceState(react).recordingState, 'idle');
  assert.equal(readHookVoiceState(react).reviewDraft, null);
});

await scenario('committing 时 unmount：commit 自行成功，不触发并发 discard 或 UI 合入', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const merged = [];
  const hook = module.useChatSendFlow(buildSendFlowParams({
    setMessages: (updater) => { merged.push(updater); },
  }));

  const pending = hook.startVoiceRecording();
  const commitDeferred = createDeferred();
  voiceModule.__deferreds[0].resolve({
    finish: async () => ({
      success: true,
      draft: voiceModule.__makeDraft({ commit: () => commitDeferred.promise }),
    }),
    cancel: async () => { voiceModule.__cancelled.push(true); },
  });
  await pending;
  await hook.finishVoiceRecording();
  const committing = hook.commitVoiceReviewDraft();

  react.__unmount();
  assert.deepEqual(voiceModule.__discarded, []);
  commitDeferred.resolve({ success: true, message: { id: 9, sessionId: 's1', text: '旧会话语音' } });
  assert.equal(await committing, false);
  assert.deepEqual(voiceModule.__discarded, []);
  assert.deepEqual(merged, []);
});

await scenario('committing 时切 session 且 commit failure：attempt 结束后才 discard orphan draft', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const commitDeferred = createDeferred();
  let hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  voiceModule.__deferreds[0].resolve({
    finish: async () => ({
      success: true,
      draft: voiceModule.__makeDraft({ commit: () => commitDeferred.promise }),
    }),
    cancel: async () => { voiceModule.__cancelled.push(true); },
  });
  await pending;
  await hook.finishVoiceRecording();
  const committing = hook.commitVoiceReviewDraft();

  react.__unmount();
  assert.deepEqual(voiceModule.__discarded, [], '事务未结束前不能 discard');
  react.__beginRender();
  hook = module.useChatSendFlow(buildSendFlowParams({ sessionId: 's2' }));
  commitDeferred.resolve({ success: false, code: 'VOICE_MESSAGE_COMMIT_FAILED', message: '事务回滚' });

  assert.equal(await committing, false);
  assert.deepEqual(voiceModule.__discarded, [0], 'rollback 完成后必须删除 orphan draft');
  assert.deepEqual(
    voiceModule.__lifecycleEvents,
    ['commit:start:0', 'commit:end:0', 'discard:0'],
    'discard 必须严格发生在 commit attempt 终止之后',
  );
  assert.equal(readHookVoiceState(react).interactionError, null, '旧失败不得写入新 session 错误状态');
  assert.equal(readHookVoiceState(react).reviewDraft, null);
});

await scenario('reviewing 重复 commit 被拒绝：只允许提交一次', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  voiceModule.__deferreds[0].resolve(voiceModule.__makeRecording());
  await pending;
  await hook.finishVoiceRecording();

  const [first, second] = await Promise.all([
    hook.commitVoiceReviewDraft(),
    hook.commitVoiceReviewDraft(),
  ]);
  assert.equal(first, true, '第一次 commit 必须成功');
  assert.equal(second, false, '并发第二次 commit 必须被拒绝');
  assert.equal(voiceModule.__committed.length, 1, '只能向 draft 发起一次 commit');

  assert.equal(await hook.commitVoiceReviewDraft(), false, '终态后再次 commit 必须被拒绝');
  assert.equal(voiceModule.__committed.length, 1);
});

await scenario('reviewing 重复 discard 幂等：不重复清理，也不误删已接管 media', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  voiceModule.__deferreds[0].resolve(voiceModule.__makeRecording());
  await pending;
  await hook.finishVoiceRecording();

  await hook.discardVoiceReviewDraft();
  await hook.discardVoiceReviewDraft();
  await hook.cancelVoiceRecording();

  assert.deepEqual(voiceModule.__discarded, [0], '重复 discard 只能真正清理一次');
});

await scenario('commit 成功后 discard 不再是合法路径：commit 已经接管 media', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  voiceModule.__deferreds[0].resolve(voiceModule.__makeRecording());
  await pending;
  await hook.finishVoiceRecording();

  assert.equal(await hook.commitVoiceReviewDraft(), true);
  await hook.discardVoiceReviewDraft();
  await hook.cancelVoiceRecording();

  assert.deepEqual(voiceModule.__discarded, [], 'commit 成功后不得再 discard（会误删已接管 media）');
});

await scenario('commit 失败保留 draft 与 reviewing，允许用户重试', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  voiceModule.__deferreds[0].resolve({
    finish: async () => ({
      success: true,
      draft: voiceModule.__makeDraft({
        commitResult: { success: false, code: 'VOICE_MESSAGE_COMMIT_FAILED', message: '提交失败' },
      }),
    }),
    cancel: async () => { voiceModule.__cancelled.push(true); },
  });
  await pending;
  await hook.finishVoiceRecording();

  assert.equal(await hook.commitVoiceReviewDraft(), false);
  assert.equal(readHookVoiceState(react).recordingState, 'reviewing', '失败后必须留在 reviewing');
  assert.ok(readHookVoiceState(react).reviewDraft, '失败后必须保留 draft，不能丢音频');
  assert.equal(readHookVoiceState(react).interactionError, '提交失败');
  assert.deepEqual(voiceModule.__discarded, [], '提交失败不得 discard');
});

await scenario('空 transcript 不能发送，且不终结 draft（可继续编辑重试）', async () => {
  const { module, mediaMock, deviceMock, commitMock } = loadUserVoiceModule();
  const session = await module.startUserVoiceMessageRecording(baseParams);
  const finished = await session.finish();
  for (const transcript of ['', ' \t\n ']) {
    const result = await finished.draft.commit(transcript);
    assert.equal(result.success, false);
    assert.equal(result.code, 'VOICE_TEXT_EMPTY');
  }
  assert.equal(mediaMock.__batches.length, 0, '空文本不构成媒体准备或提交尝试');
  assert.equal(commitMock.__calls.count, 0);
  assert.deepEqual(deviceMock.__calls.deletedUris, [], '空文本拒绝不释放仍可编辑的 source temp');

  const result = await finished.draft.commit('修改后的文本');
  assert.equal(result.success, true, '拒绝空文本后仍能编辑并提交同一 draft');
  assert.equal(result.message.text, '修改后的文本');
  assert.equal(commitMock.__calls.count, 1);
  const metadata = JSON.parse(result.message.metadataJson);
  assert.equal(metadata.voice.transcriptSource, 'user_corrected');
  assert.equal(metadata.voice.mediaAssetId, 'asset-1');
  assert.equal(result.message.metadataJson.includes('file:///tmp/rec-1.wav'), false, '持久化 metadata 不泄漏录音临时 URI');
});

await scenario('reviewing 期间拒绝开始新录音，draft 生命周期不被覆盖', async () => {
  const react = createReactStub();
  const voiceModule = createControllableVoiceModule();
  const deps = createSendFlowDeps({ voiceModule });
  const module = loadUseChatSendFlow({ react, voiceModule, deps: deps.deps });
  const hook = module.useChatSendFlow(buildSendFlowParams());

  const pending = hook.startVoiceRecording();
  voiceModule.__deferreds[0].resolve(voiceModule.__makeRecording());
  await pending;
  await hook.finishVoiceRecording();

  const restarted = await hook.startVoiceRecording();
  assert.equal(restarted, false, 'reviewing 期间不得开始第二段录音');
  assert.equal(voiceModule.__deferreds.length, 1, '不得发起第二次 start');
});

await scenario('reviewing / committing 状态可由输入区切换为校对面板', () => {
  const inputArea = read('src/features/chat/presentation/messages/components/ChatInputArea.tsx');
  assert.ok(
    inputArea.includes('ChatVoiceReviewPanel'),
    '输入区必须渲染语音校对面板',
  );
  assert.ok(
    /voiceReviewDraft \? \(/.test(inputArea),
    '校对面板必须优先于录音条与普通输入渲染',
  );
  const chatDetail = read('src/features/chat/presentation/messages/ChatDetail/index.tsx');
  assert.ok(
    chatDetail.includes('voiceReviewDraft={voiceReviewDraft}'),
    'ChatDetail 必须把 draft 接到输入区',
  );
  assert.ok(
    chatDetail.includes('onVoiceReviewSend={handleVoiceReviewSend}'),
    'ChatDetail 必须把发送接到输入区',
  );
  assert.ok(
    chatDetail.includes('onVoiceReviewCancel={discardVoiceReviewDraft}'),
    'ChatDetail 必须把取消接到输入区',
  );
});

await scenario('校对面板展示识别结果、时长、取消与发送', () => {
  const panel = read(
    'src/features/chat/presentation/messages/components/ChatVoiceReviewPanel.tsx',
  );
  assert.ok(panel.includes('语音识别结果'), '必须提示“语音识别结果”');
  assert.ok(panel.includes('formatDuration'), '必须展示录音时长');
  assert.ok(panel.includes('取消'), '必须有取消');
  assert.ok(panel.includes('发送'), '必须有发送');
  assert.ok(panel.includes('TextInput'), '必须提供可编辑文本输入');
  assert.ok(
    panel.includes('draft.transcript.trim().length > 0'),
    '空文本不得可发送',
  );
});

await scenario('presentation 不接触 raw local URI / media backing', () => {
  const chatTypes = read('src/features/chat/presentation/messages/components/chatTypes.ts');
  assert.ok(
    /interface ChatVoiceMessageReviewDraft \{[\s\S]*?\}/.test(chatTypes),
    'reviewing 的 presentation 快照必须有显式类型',
  );
  const reviewDraftBody = chatTypes.slice(
    chatTypes.indexOf('interface ChatVoiceMessageReviewDraft'),
  ).slice(0, 400);
  assert.ok(
    !/localUri|storageKey|preparedMedia/i.test(reviewDraftBody),
    'presentation 快照不得包含 raw URI 或 media backing',
  );

  const sendFlow = read(
    'src/features/chat/presentation/messages/ChatDetail/useChatSendFlow.ts',
  );
  assert.ok(
    sendFlow.includes('voiceMessageDraftRef'),
    'draft 的所有权必须留在 application 层',
  );
});

await scenario('corrected 判定：仅空白差异不算修改', async () => {
  const { module } = loadUserVoiceModule();
  assert.equal(
    module.isCorrectedTranscript('识别出的文本', '识别出的文本'), false,
    '完全相同不算 corrected',
  );
  assert.equal(
    module.isCorrectedTranscript('  识别出的文本  ', '识别出的文本'), false,
    '仅首尾空白不算 corrected',
  );
  assert.equal(
    module.isCorrectedTranscript('识别出  的文本', '识别出 的文本'), false,
    '仅连续空白差异不算 corrected',
  );
  assert.equal(
    module.isCorrectedTranscript('识别错了', '识别出的文本'), true,
    '文本内容改变必须是 corrected',
  );
});

await scenario('metadata 支持 user_corrected，并保持旧数据兼容', () => {
  const metadataModule = loadChatMessageMetadataModule();
  for (const transcriptSource of ['user_stt', 'user_corrected', 'assistant_source_text']) {
    const parsed = metadataModule.parseMessageMetadata({
      metadataJson: JSON.stringify({
        kind: 'voice',
        voice: {
          schemaVersion: 1,
          mediaAssetId: 'm1',
          mimeType: 'audio/wav',
          durationMs: 900,
          transcriptSource,
        },
      }),
    });
    assert.ok(parsed && parsed.kind === 'voice', `${transcriptSource} 必须被接受`);
  }
  assert.equal(
    metadataModule.parseMessageMetadata({
      metadataJson: JSON.stringify({
        kind: 'voice',
        voice: {
          schemaVersion: 1,
          mediaAssetId: 'm1',
          mimeType: 'audio/wav',
          durationMs: 900,
          transcriptSource: 'user_typed',
        },
      }),
    }),
    null,
    '未知 transcriptSource 必须 fail closed',
  );
});

await scenario('corrected transcript 成为最终 ChatMessage.text，preview 仍是 [语音消息]', () => {
  const metadataModule = loadChatMessageMetadataModule();
  const corrected = {
    text: '用户改过的最终文本',
    metadataJson: JSON.stringify({
      kind: 'voice',
      voice: {
        schemaVersion: 1,
        mediaAssetId: 'm1',
        mimeType: 'audio/wav',
        durationMs: 900,
        transcriptSource: 'user_corrected',
      },
    }),
  };
  assert.equal(
    metadataModule.buildSessionPreviewTextFromMessage(corrected), '[语音消息]',
    'preview 不得泄漏 corrected transcript',
  );
  assert.equal(
    metadataModule.buildVoiceMessageModelText({ ...corrected, isMe: true }),
    '[用户语音转写]\n用户改过的最终文本',
    '模型上下文必须使用 corrected 后的最终文本',
  );
});

await scenario('语音 metadata 不新增数据库列：仍复用 metadataJson', () => {
  const schema = read('src/platform/persistence/sqlite/schema.ts');
  assert.ok(
    !/voice_transcript_source|voice_corrected/.test(schema),
    'corrected 语义不得新增数据库列',
  );
  const source = read('src/features/chat/messages/application/UserVoiceMessageRecording.ts');
  assert.ok(
    /metadataJson:\s*JSON\.stringify\(buildChatVoiceMessageMetadata/.test(source),
    'transcriptSource 必须继续写入现有 voice metadata',
  );
});

// ============================================================================
// 汇总
// ============================================================================

if (failures.length > 0) {
  console.error(`\n${failures.length} 个 voice 行为验证失败（通过 ${passed}）。`);
  process.exit(1);
}
console.error(`\nChat voice message 行为验证全部通过（${passed} 个场景）。`);
