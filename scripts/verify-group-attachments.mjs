import { sharedChatRecordModuleUrl, sharedMomentModuleUrl } from './helpers/chat-sharing-fixture.mjs';
/** 群聊附件行为：保护可解析文件边界、消息提交、管理员隔离与通用附件输入组装。 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function transpileToModuleUrl(sourceText) {
  const output = ts.transpileModule(sourceText, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
}

async function loadSendGroupUserMessage() {
  const mediaUrl = transpileToModuleUrl(`
    export const MEDIA_ASSET_STORAGE_BACKEND = { persistentMedia: 'persistent-media' };
    export async function prepareMediaAssetBatch(inputs) {
      return {
        commitInTransaction: async () => ({ assets: inputs.map(input => ({ id: 'media-' + input.fileName })) }),
        finalizeAfterCommit: async () => {}, discardAfterRollback: async () => {},
      };
    }
  `);
  const mimeUrl = transpileToModuleUrl(read('src/features/chat/messages/application/ChatAttachmentMime.ts'));
  const prepareUrl = transpileToModuleUrl(read('src/features/chat/messages/application/PrepareChatAttachments.ts')
    .replace(/from ['"]@features\/media['"]/g, `from '${mediaUrl}'`)
    .replace(/from ['"]\.\/ChatAttachmentMime['"]/g, `from '${mimeUrl}'`));
  const chatStickerUrl = transpileToModuleUrl(
    read('src/features/chat/messages/domain/ChatSticker.ts'),
  );
  const metadataUrl = transpileToModuleUrl(
    read('src/features/chat/messages/domain/chatMessageMetadata.ts').replaceAll("from './SharedMoment'", `from '${sharedMomentModuleUrl}'`)
      .replace(/from ['"]\.\/SharedChatRecord['"]/g,
        `from '${sharedChatRecordModuleUrl}'`)
      .replace(/from ['"]\.\/ChatSticker['"]/g, `from '${chatStickerUrl}'`),
  );
  // 事务协调器桩：本测试只关心消息事实与 metadata，事务直接透传。
  const persistenceUrl = transpileToModuleUrl(`
    export const databaseCoordinator = {
      transaction: async (_meta, task) => task({}),
    };
  `);
  const messageRuntimeUrl = transpileToModuleUrl(`
    export function getChatMessageRuntimeDependencies() {
      return globalThis.__GROUP_ATTACHMENT_MESSAGE_DEPS__;
    }
  `);
  const groupRuntimeUrl = transpileToModuleUrl(`
    export function getChatGroupRuntimeDependencies() {
      return globalThis.__GROUP_ATTACHMENT_GROUP_DEPS__;
    }
  `);
  const eventsUrl = transpileToModuleUrl(`
    export function emitChatMessagesUpdated(sessionId) {
      globalThis.__GROUP_ATTACHMENT_STATE__.updatedSessions.push(sessionId);
    }
    export function emitChatGroupSpeechPlanChanged(groupId) {
      globalThis.__GROUP_ATTACHMENT_STATE__.planChanges.push(groupId);
    }
  `);
  const commitSource = read('src/features/chat/group/application/GroupMessageCommit.ts')
    .replace(/from ['"]\.\.\/\.\.\/messages\/application\/PrepareChatAttachments['"]/g, `from '${prepareUrl}'`)
    .replace(/from ['"]\.\.\/\.\.\/messages\/application\/UserMessageSubmission['"]/g,
      `from '${transpileToModuleUrl(read('src/features/chat/messages/application/UserMessageSubmission.ts'))}'`)
    .replace(/from ['"]@platform\/persistence['"]/g, `from '${persistenceUrl}'`)
    .replace(
      /from ['"]\.\.\/\.\.\/messages\/domain\/chatMessageMetadata['"]/g,
      `from '${metadataUrl}'`,
    )
    .replace(
      /from ['"]\.\.\/\.\.\/messages\/domain\/ChatSticker['"]/g,
      `from '${chatStickerUrl}'`,
    )
    .replace(
      /from ['"]\.\.\/\.\.\/messages\/application\/ChatMessageRuntime['"]/g,
      `from '${messageRuntimeUrl}'`,
    )
    .replace(/from ['"]\.\/ChatGroupRuntime['"]/g, `from '${groupRuntimeUrl}'`)
    .replace(
      /from ['"]\.\.\/\.\.\/messages\/events\/ChatEvents['"]/g,
      `from '${eventsUrl}'`,
    );
  const commitUrl = transpileToModuleUrl(commitSource);
  const messagingUrl = transpileToModuleUrl(`
    export async function invokeGroupChat() {
      throw new Error('自动召唤不应在消息提交阶段立即执行');
    }
  `);
  const schedulerUrl = transpileToModuleUrl(`
    export function scheduleGroupAutoInvocation(params) {
      globalThis.__GROUP_ATTACHMENT_STATE__.scheduled.push({
        groupId: params.groupId,
        latestUserMessageId: params.latestUserMessageId,
      });
    }
  `);
  const abortUrl = transpileToModuleUrl(`
    export function abortGroupSpeechPlanExecution() {}
  `);
  const stickersUrl = transpileToModuleUrl(`
    export async function recordUserStickerUse() {}
  `);
  const source = read('src/features/chat/group/application/GroupUserMessaging.ts')
    .replace(/from ['"]@features\/stickers['"]/g, `from '${stickersUrl}'`)
    .replace(/from ['"]\.\/GroupMessageCommit['"]/g, `from '${commitUrl}'`)
    .replace(/from ['"]\.\/GroupChatMessaging['"]/g, `from '${messagingUrl}'`)
    .replace(/from ['"]\.\/GroupAutoInvocationScheduler['"]/g, `from '${schedulerUrl}'`)
    .replace(/from ['"]\.\/GroupSpeechExecutionAbort['"]/g, `from '${abortUrl}'`)
    .replace(
      /from ['"]\.\.\/\.\.\/messages\/events\/ChatEvents['"]/g,
      `from '${eventsUrl}'`,
    );
  return import(transpileToModuleUrl(source));
}

async function loadBuildChatBatchAIInput() {
  const chatStickerUrl = transpileToModuleUrl(
    read('src/features/chat/messages/domain/ChatSticker.ts'),
  );
  const metadataUrl = transpileToModuleUrl(
    read('src/features/chat/messages/domain/chatMessageMetadata.ts').replaceAll("from './SharedMoment'", `from '${sharedMomentModuleUrl}'`)
      .replace(/from ['"]\.\/SharedChatRecord['"]/g,
        `from '${sharedChatRecordModuleUrl}'`)
      .replace(/from ['"]\.\/ChatSticker['"]/g, `from '${chatStickerUrl}'`),
  );
  const imageInputUrl = transpileToModuleUrl(`
    export async function resolveChatImageModelInput(params) {
      globalThis.__GROUP_ATTACHMENT_STATE__.imageConsumers.push(params.assistantId);
      return {
        parts: [
          { type: 'text', text: '用户发送了一张图片' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + params.assistantId } },
        ],
      };
    }
  `);
  const source = read('src/features/chat/reply/application/BuildChatBatchAIInput.ts').replaceAll("from '../../messages/domain/SharedMoment'", `from '${sharedMomentModuleUrl}'`).replaceAll("from '../../messages/domain/chatMessageMetadata'", `from '${metadataUrl}'`)
    .replace(/from ['"]\.\/ChatReplyRuntimeDependencies['"]/g,
      `from '${transpileToModuleUrl('export function getChatReplyRuntimeDependencies() { return { prompt: { readImageGroundingReminder: async () => null } }; }')}'`)
    .replace(/from ['"]@features\/media['"]/g,
      `from '${transpileToModuleUrl('export function mediaImageFailure() { return null; }')}'`)
    .replace(/from ['"]\.\.\/\.\.\/messages\/domain\/SharedChatRecord['"]/g,
      `from '${sharedChatRecordModuleUrl}'`)
    .replace(
      /from ['"]@features\/chat\/messages\/domain['"]/g,
      `from '${metadataUrl}'`,
    )
    .replace(
      /from ['"]\.\.\/\.\.\/messages\/domain\/ChatSticker['"]/g,
      `from '${chatStickerUrl}'`,
    )
    .replace(
      /from ['"]\.\/ResolveChatImageModelInput['"]/g,
      `from '${imageInputUrl}'`,
    );
  return import(transpileToModuleUrl(source));
}

async function loadAttachmentParser() {
  const mediaUrl = transpileToModuleUrl(`
    export const persistentMediaStore = {
      async readAsText(uri) {
        return globalThis.__GROUP_ATTACHMENT_READ_TEXT__(uri);
      },
    };
  `);
  const source = read('src/features/chat/messages/application/AttachmentParser.ts')
    .replace(/from ['"]\.\.\/domain\/ChatAttachment['"]/g,
      `from '${transpileToModuleUrl(read('src/features/chat/messages/domain/ChatAttachment.ts'))}'`)
    .replace(/from ['"]@platform\/device['"]/g, `from '${mediaUrl}'`);
  return import(transpileToModuleUrl(source));
}

const state = {
  commitInputs: [],
  previews: [],
  updatedSessions: [],
  planChanges: [],
  imageConsumers: [],
  scheduled: [],
};
globalThis.__GROUP_ATTACHMENT_STATE__ = state;
globalThis.__GROUP_ATTACHMENT_MESSAGE_DEPS__ = {
  messages: {
    async commitMessageInTransaction(_transaction, input) {
      state.commitInputs.push(input);
      return {
        id: state.commitInputs.length,
        ...input.message,
      };
    },
  },
};
globalThis.__GROUP_ATTACHMENT_GROUP_DEPS__ = {
  currentUserDirectory: {
    async getCurrent() {
      return { id: 'self', name: '小雨', avatar: null };
    },
  },
  groups: {
    async updatePreview(groupId, text, time) {
      state.previews.push({ groupId, text, time });
      return true;
    },
    // 用户消息提交事务内的 preview 更新（3F 起移入事务），这里同样记录为 preview 事实。
    async updatePreviewInTransaction(_transaction, groupId, _messageId, text, time) {
      state.previews.push({ groupId, text, time });
      return true;
    },
    async rotateSpeechPlanForUserMessageInTransaction() {
      return { kind: 'no_active_plan' };
    },
  },
};

const { sendGroupUserMessage } = await loadSendGroupUserMessage();
const { buildChatBatchAIInput } = await loadBuildChatBatchAIInput();
const {
  attachmentParser,
  assertChatAttachmentFileSupported,
  isChatAttachmentFileSupported,
} = await loadAttachmentParser();

assert.equal(
  isChatAttachmentFileSupported({ fileName: 'notes.MD', mimeType: 'application/octet-stream' }),
  true,
  '是否可解析必须由统一文件契约决定，不能被不准确的 MIME 阻断',
);
assert.equal(
  isChatAttachmentFileSupported({ fileName: 'report.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
  false,
  '当前解析器不支持的文件不得成为可发送附件',
);
assert.throws(
  () => assertChatAttachmentFileSupported({ fileName: 'report.docx' }),
  /此文件无法解析，无法发送。当前支持 TXT 和 MD 文件/,
);

globalThis.__GROUP_ATTACHMENT_READ_TEXT__ = async () => '# 群聊附件\r\n正文';
const parsedMarkdown = await attachmentParser.parseFile({
  localUri: 'file:///private/notes.md',
  fileName: 'notes.md',
  mimeType: 'application/octet-stream',
});
assert.equal(parsedMarkdown.parseStatus, 'success');
assert.equal(parsedMarkdown.parsedText, '# 群聊附件\n正文');

globalThis.__GROUP_ATTACHMENT_READ_TEXT__ = async () => {
  throw new Error('read failed');
};
const unreadableMarkdown = await attachmentParser.parseFile({
  localUri: 'file:///private/broken.md',
  fileName: 'broken.md',
  mimeType: 'text/markdown',
});
assert.equal(unreadableMarkdown.parseStatus, 'failed');
assert.match(unreadableMarkdown.parseError, /read failed/);
const image = {
  id: 'img-1',
  type: 'image',
  source: 'gallery',
  localUri: 'file:///private/cat.png',
  fileName: 'cat.png',
  mimeType: 'image/png',
  parseStatus: 'skipped',
};
const file = {
  id: 'file-1',
  type: 'file',
  source: 'document',
  localUri: 'file:///private/secret.txt',
  fileName: 'secret.txt',
  mimeType: 'text/plain',
  parseStatus: 'success',
  parsedText: '文件内部正文',
};

const imageMessage = await sendGroupUserMessage({
  groupId: 'g1',
  text: '',
  attachments: [image],
});
const imageMetadata = JSON.parse(imageMessage.metadataJson);
assert.equal(imageMessage.text, '', '附件-only 群消息不应伪造文本正文');
const canonical = ({ localUri, thumbnailUri, ...attachment }) => ({ ...attachment, mediaAssetId: `media-${attachment.fileName}` });
assert.deepEqual(imageMetadata.attachments, [canonical(image)], '附件必须以稳定资产身份写入消息 metadata');
assert.deepEqual(imageMetadata.groupChat, {
  kind: 'user_message',
  groupId: 'g1',
  actorType: 'user',
  actorName: '小雨',
  triggerSource: 'group_chat',
  mentions: [],
});
assert.equal(state.commitInputs[0].previewText, '[图片]');
assert.equal(state.previews[0].text, '[图片]');

const fileMessage = await sendGroupUserMessage({
  groupId: 'g1',
  text: '帮我看看',
  attachments: [file],
  mentions: [
    {
      actorType: 'user',
      target: { targetType: 'assistant', assistantId: 'ai-B', displayNameAtSend: 'B' },
    },
    {
      actorType: 'user',
      target: { targetType: 'assistant', assistantId: 'ai-A', displayNameAtSend: 'A' },
    },
  ],
  replyToId: 7,
  replyToText: '上一条',
});
const fileMetadata = JSON.parse(fileMessage.metadataJson);
assert.deepEqual(fileMetadata.attachments, [canonical(file)]);
assert.deepEqual(fileMetadata.groupChat.mentions, [
  {
    actorType: 'user',
    target: { targetType: 'assistant', assistantId: 'ai-B', displayNameAtSend: 'B' },
  },
  {
    actorType: 'user',
    target: { targetType: 'assistant', assistantId: 'ai-A', displayNameAtSend: 'A' },
  },
], '提交层必须信任并原样持久化上游已经选好的结构化 @');
assert.equal(state.commitInputs[1].previewText, '[文件] secret.txt：帮我看看');
assert.equal(state.previews[1].text, '[文件] secret.txt：帮我看看');
assert.equal(fileMessage.replyToId, 7);
assert.equal(fileMessage.replyToText, '上一条');
assert.deepEqual(state.updatedSessions, ['g1', 'g1']);
assert.deepEqual(
  state.planChanges,
  ['g1', 'g1'],
  '每条用户消息 commit 后都必须发布 plan 事实变化',
);
assert.deepEqual(state.scheduled, [
  { groupId: 'g1', latestUserMessageId: 1 },
  { groupId: 'g1', latestUserMessageId: 2 },
], '成功提交的每条群用户消息都必须刷新该群的自动召唤计时');

const firstMemberInput = await buildChatBatchAIInput({
  messages: [imageMessage, fileMessage],
  assistantId: 'ai-1',
});
const secondMemberInput = await buildChatBatchAIInput({
  messages: [imageMessage, fileMessage],
  assistantId: 'ai-2',
});
assert.deepEqual(
  state.imageConsumers,
  ['ai-1', 'ai-2'],
  '同一批图片消息必须分别为每个被选成员组装视觉输入',
);
for (const [assistantId, input] of [
  ['ai-1', firstMemberInput],
  ['ai-2', secondMemberInput],
]) {
  assert.ok(Array.isArray(input.modelInput));
  assert.ok(
    input.modelInput.some((part) => (
      part.type === 'image_url' && part.image_url.url.endsWith(assistantId)
    )),
    `${assistantId} 必须获得图片输入`,
  );
  assert.ok(
    input.modelInput.some((part) => part.type === 'text' && part.text.includes('文件内部正文')),
    `${assistantId} 必须获得已解析的文件内容`,
  );
}

await assert.rejects(
  () => sendGroupUserMessage({ groupId: 'g1', text: '', attachments: [] }),
  /消息不能为空/,
);
assert.equal(state.commitInputs.length, 2, '空文本且无附件不得提交');

console.log('群聊附件提交行为验证通过。');
