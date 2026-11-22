/** 群消息提交与模型请求分离：文字和各类附件不会建立延迟召唤。 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { loadTypeScriptModule } from '../../helpers/load-typescript-module.mjs';

const committed = [], changed = [], aborted = [], used = [];
const { sendGroupUserMessage } = loadTypeScriptModule('src/features/chat/group/application/GroupUserMessaging.ts', {
  './GroupMessageCommit': { commitGroupUserMessage: async input => {
    committed.push(input);
    return { message: { id: committed.length }, rotation: input.groupId === 'active'
      ? { kind: 'superseded', previousPlanId: 'old' } : { kind: 'no_active_plan' } };
  } },
  './GroupSpeechExecutionAbort': { abortGroupSpeechPlanExecution: id => aborted.push(id) },
  '../../messages/events/ChatEvents': { emitChatGroupSpeechPlanChanged: id => changed.push(id) },
  '@features/stickers': { recordUserStickerUse: async id => used.push(id) },
});
mock.timers.enable({ apis: ['setTimeout'] });
try {
  for (const input of [
    { text: '第一句' }, { text: '第二句' },
    { text: '', attachments: [{ type: 'image', mediaAssetId: 'image' }] },
    { text: '', attachments: [{ type: 'file', mediaAssetId: 'file' }] },
    { text: '', sticker: { stickerId: 'sticker' } },
  ]) {
    const sent = await sendGroupUserMessage({ groupId: 'group', ...input });
    assert.equal(sent.id, committed.length);
  }
  mock.timers.tick(120_000);
  assert.equal(committed.length, 5, '过了原来的30秒窗口，仍只有用户主动提交的消息');
  assert.deepEqual(changed, Array(5).fill('group'));
  assert.deepEqual(used, ['sticker']);
  await sendGroupUserMessage({ groupId: 'active', text: '先等我发完' });
  assert.deepEqual(aborted, ['old'], '新消息仍在持久换代后中止旧请求');
} finally { mock.timers.reset(); }
console.log('群聊文字、图片、文件和表情包只提交消息，等待显式召唤。');
