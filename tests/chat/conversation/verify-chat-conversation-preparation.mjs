/** 单聊路由只接受 AI 对应的 canonical conversation；sessionId 仅作 locator 校验。 */
import { repoRoot as ROOT } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';


const source = fs.readFileSync(path.join(
  ROOT,
  'src/features/chat/presentation/shell/ConversationPreparationController.ts',
), 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { createConversationPreparationController } = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`
);

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createHarness() {
  const ai = { id: 'ai-1', name: 'AI 1', canonicalConversationId: 'canonical-1' };
  const state = { requestId: 0 };
  const calls = { resolves: 0, entries: [] };
  let resolver = async () => ({ id: 'canonical-1', aiAssistantId: 'ai-1' });
  const snapshot = {
    currentAIId: null,
    currentSessionId: null,
    aiList: [ai],
    loadAIAssistants: async () => [ai],
    beginChatEntryRequest: () => ++state.requestId,
    enterConversation: async (targetAI, options) => {
      calls.entries.push({ targetAI, options });
      return options.requestId === state.requestId ? 'completed' : 'superseded';
    },
  };
  const controller = createConversationPreparationController({
    getSnapshot: () => snapshot,
    getCanonicalConversation: async (aiId) => {
      calls.resolves += 1;
      return resolver(aiId);
    },
  });
  return {
    calls,
    controller,
    setResolver: (next) => { resolver = next; },
  };
}

{
  const harness = createHarness();
  assert.equal(await harness.controller.ensureConversation('ai-1'), 'ready');
  assert.equal(harness.calls.resolves, 1);
  assert.equal(harness.calls.entries[0].options.preparedSession.id, 'canonical-1');
}

{
  const harness = createHarness();
  assert.equal(
    await harness.controller.ensureConversation('ai-1', 'legacy-alternate'),
    'session-not-found',
    'locator 不得把入口切换到 alternate direct session',
  );
  assert.equal(harness.calls.entries.length, 0);
}

{
  const harness = createHarness();
  const pending = deferred();
  harness.setResolver(() => pending.promise);
  const first = harness.controller.ensureConversation(' ai-1 ', ' canonical-1 ');
  const second = harness.controller.ensureConversation('ai-1', 'canonical-1');
  assert.equal(first, second, '同一 canonical 目标必须复用 in-flight preparation');
  pending.resolve({ id: 'canonical-1', aiAssistantId: 'ai-1' });
  assert.equal(await first, 'ready');
  assert.equal(harness.calls.resolves, 1);
}

console.log('单聊 canonical conversation 路由准备行为测试通过');
