/**
 * 会话列表首屏结果信号的最小行为测试。
 *
 * 验证：
 * 1. 等待中的调用只在 ready 后完成；
 * 2. ready 先发生时，后续等待立即完成；
 * 3. failed 会把原始错误交给等待方；
 * 4. 首个终态不可被后续信号覆盖。
 */

import { repoRoot as ROOT } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';


const signalPath = path.join(
  ROOT,
  'src/shared/runtime/ConversationListReadySignal.ts'
);
const signalSource = fs.readFileSync(signalPath, 'utf8');
const transpiled = ts.transpileModule(signalSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`;
const {
  markConversationListFailed,
  markConversationListReady,
  resetConversationListReady,
  waitForConversationListReady,
} = await import(moduleUrl);

// 测试 1：等待中的调用只在 ready 后完成，且共享同一个 pending Promise。
{
  resetConversationListReady();
  let settled = false;
  const firstWait = waitForConversationListReady();
  const secondWait = waitForConversationListReady();
  void firstWait.then(() => { settled = true; });

  assert.equal(firstWait, secondWait, 'pending 阶段应复用同一个 Promise');
  await Promise.resolve();
  assert.equal(settled, false, 'ready 前等待不得提前完成');

  markConversationListReady();
  await firstWait;
  assert.equal(settled, true, 'ready 后等待应完成');
}

// 测试 2：ready 先发生时，后续等待立即完成；后续 failed 不得反写。
{
  resetConversationListReady();
  markConversationListReady();
  markConversationListFailed(new Error('late failure'));

  await waitForConversationListReady();
}

// 测试 3：failed 会把原始 Error 交给已存在和后续等待方。
{
  resetConversationListReady();
  const expected = new Error('conversation query failed');
  const pendingWait = waitForConversationListReady();
  markConversationListFailed(expected);

  await assert.rejects(pendingWait, (error) => error === expected);
  await assert.rejects(
    waitForConversationListReady(),
    (error) => error === expected
  );
}

// 测试 4：failed 先发生时会标准化非 Error，后续 ready 不得覆盖。
{
  resetConversationListReady();
  markConversationListFailed('group query failed');
  markConversationListReady();

  await assert.rejects(
    waitForConversationListReady(),
    (error) => error instanceof Error && error.message === 'group query failed'
  );
}

console.log('会话列表首屏结果信号行为测试通过');
