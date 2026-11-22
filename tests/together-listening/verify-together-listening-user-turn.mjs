/** LISTEN-4 用户邀请卡复用 canonical commit 与 Host execution callback 的回归。 */

import { repoRoot } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'together-listening-user-turn-'));

function compile(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  assert.equal(
    (output.diagnostics || []).filter((item) => item.category === ts.DiagnosticCategory.Error).length,
    0,
    `TypeScript 转译失败：${relativePath}`,
  );
  const outputPath = path.join(tempRoot, relativePath.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output.outputText, 'utf8');
}

function write(relativePath, source) {
  const outputPath = path.join(tempRoot, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, source, 'utf8');
}

let commitCount = 0;
let executionCount = 0;
let committedInput = null;
globalThis.__listenTurnFakes = {
  async commit(params) {
    commitCount += 1;
    committedInput = params.message;
    const message = { ...params.message, id: 41 };
    return { message, messages: [message], supersededRunId: 'old-run' };
  },
  runtime: {
    canonicalUserMessage: {
      async onCommitted(payload) {
        executionCount += 1;
        assert.equal(payload.message.id, 41);
        assert.equal(payload.supersededRunId, 'old-run');
        assert.equal(payload.executionMode, 'delegate_to_android_host');
      },
    },
  },
};

write('src/features/chat/messages/application/CommitCanonicalUserMessage.js', `
exports.commitCanonicalUserMessage = (...args) => globalThis.__listenTurnFakes.commit(...args);
`);
write('src/features/chat/messages/application/ChatMessageRuntime.js', `
exports.getChatMessageRuntimeDependencies = () => globalThis.__listenTurnFakes.runtime;
`);
write('src/features/chat/messages/events/ChatEvents.js', `
exports.emitChatMessagesUpdated = () => {};
`);
write('node_modules/@shared/diagnostics/TurnTimelineLog.js', `
exports.logTurnTimeline = () => {};
`);

compile('src/features/chat/messages/application/CommitAndDispatchCanonicalUserMessage.ts');
const command = require(path.join(
  tempRoot,
  'src/features/chat/messages/application/CommitAndDispatchCanonicalUserMessage.js',
));

const result = await command.commitAndDispatchCanonicalUserMessage({
  message: {
    sessionId: 'chat-1',
    text: '用户邀请你一起听网易云音乐。',
    isMe: true,
    senderType: 'user',
    clientMessageId: 'together-listening:activity-1',
    time: '08:00',
    createdAt: new Date(1).toISOString(),
    status: 'sent',
    metadataJson: JSON.stringify({
      type: 'togetherListening',
      activityId: 'activity-1',
      initiator: 'user',
      phase: 'pending_ai_response',
      endReason: null,
      source: 'togetherListening',
    }),
  },
  previewText: '[一起听邀请]',
  aiConfig: { id: 'host-1' },
});

assert.equal(result.success, true);
assert.equal(result.userMessage?.id, 41);
assert.equal(commitCount, 1);
assert.equal(executionCount, 1);
assert.equal(committedInput.clientMessageId, 'together-listening:activity-1');
assert.equal(committedInput.text, '用户邀请你一起听网易云音乐。');

// commit 后 execution scheduling 失败时仍保留 canonical message truth。
globalThis.__listenTurnFakes.runtime.canonicalUserMessage.onCommitted = async () => {
  executionCount += 1;
  throw new Error('schedule failed');
};
const schedulingFailure = await command.commitAndDispatchCanonicalUserMessage({
  message: { ...committedInput, clientMessageId: 'together-listening:activity-2' },
  previewText: '[一起听邀请]',
  aiConfig: { id: 'host-1' },
});
assert.equal(schedulingFailure.success, false);
assert.equal(schedulingFailure.userMessage?.id, 41);
assert.equal(commitCount, 2);
assert.equal(executionCount, 2);

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log('LISTEN-4 用户邀请 canonical card、单次 execution callback 与 commit truth 检查通过。');
