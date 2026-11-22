import { repoRoot } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';


const sourcePath = 'src/features/chat/messages/application/CanonicalChatSourceQueries.ts';
const compiled = ts.transpileModule(fs.readFileSync(path.join(repoRoot, sourcePath), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: sourcePath,
  reportDiagnostics: true,
});
assert.deepEqual(
  (compiled.diagnostics ?? []).filter(({ category }) => category === ts.DiagnosticCategory.Error),
  [],
);

const base = {
  sessionId: 'session-a', text: '正文', isRead: true, agentId: null,
  apiMessageId: null, clientMessageId: null, time: '08:00',
  createdAt: '2026-09-09T08:00:00.000Z', showTimeSeparatorBefore: false,
  status: 'sent', deliveryStatus: 'delivered', metadataJson: null,
};
const messages = new Map([
  [11, { ...base, id: 11, senderType: 'user', isMe: true, text: '用户原文' }],
  [12, { ...base, id: 12, senderType: 'assistant', isMe: false, text: 'AI 回复' }],
  [13, { ...base, id: 13, senderType: 'reasoning', isMe: false }],
  [14, { ...base, id: 14, senderType: 'system', isMe: false }],
  [15, { ...base, id: 15, senderType: 'user', isMe: true, sessionId: 'session-b' }],
  [16, { ...base, id: 16, senderType: 'assistant', isMe: false, status: 'failed' }],
  [17, { ...base, id: 17, senderType: 'assistant', isMe: false, deliveryStatus: 'cancelled' }],
  [18, { ...base, id: 18, senderType: 'user', isMe: true, metadataJson: JSON.stringify({ type: 'callStatus' }) }],
  [19, { ...base, id: 19, senderType: 'assistant', isMe: false, metadataJson: JSON.stringify({ type: 'togetherListening' }) }],
]);

const module = { exports: {} };
new Function('exports', 'require', 'module', compiled.outputText)(
  module.exports,
  (specifier) => {
    if (specifier === './ChatMessageRuntime') {
      return { getChatMessageRuntimeDependencies: () => ({ messages: {
        getMessageById: async (id) => messages.get(id) ?? null,
        getMessages: async () => ({ messages: [], hasMore: false, nextCursor: null }),
      } }) };
    }
    if (specifier === '../domain') {
      return {
        parseMessageMetadata: (message) => message.metadataJson ? JSON.parse(message.metadataJson) : null,
        isCallStatusMessageMetadata: (metadata) => metadata?.type === 'callStatus',
        isTogetherListeningMessageMetadata: (metadata) => metadata?.type === 'togetherListening',
        sortChatTimelineMessages: (items) => [...items].sort((left, right) => left.id - right.id),
      };
    }
    throw new Error(`未声明的运行时依赖：${specifier}`);
  },
  module,
);

const resolve = module.exports.resolveCanonicalChatSourceMessages;
const valid = await resolve({ conversationId: 'session-a', messageIds: ['12', '11'] });
assert.equal(valid.status, 'resolved');
assert.deepEqual(valid.messages.map(({ messageId, role, text }) => ({ messageId, role, text })), [
  { messageId: '11', role: 'user', text: '用户原文' },
  { messageId: '12', role: 'assistant', text: 'AI 回复' },
]);
for (const messageId of ['13', '14', '15', '16', '17', '18', '19', '999', '01', 'x']) {
  assert.deepEqual(
    await resolve({ conversationId: 'session-a', messageIds: [messageId] }),
    { status: 'invalid_source' },
  );
}
assert.deepEqual(
  await resolve({ conversationId: 'session-a', messageIds: ['11', '11'] }),
  { status: 'invalid_source' },
);
assert.deepEqual(
  await resolve({
    conversationId: 'session-a',
    messageIds: Array.from({ length: 13 }, (_, index) => String(index + 1)),
  }),
  { status: 'invalid_source' },
);

console.log('Chat canonical source message 公共读取契约检查通过。');
