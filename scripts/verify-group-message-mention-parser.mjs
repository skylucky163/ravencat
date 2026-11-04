import { sharedChatRecordModuleUrl, sharedMomentModuleUrl } from './helpers/chat-sharing-fixture.mjs';
/** 群 AI 自然 @ 解析与结构化 mention metadata 的行为验证。 */

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

const stickerModuleUrl = transpileToModuleUrl(`
  export function isStickerMessageMetadata(metadata) {
    return Boolean(metadata?.kind === 'sticker' && metadata.sticker);
  }
`);
const sharedRecordModuleUrl = sharedChatRecordModuleUrl;
const metadataModuleUrl = transpileToModuleUrl(
  read('src/features/chat/messages/domain/chatMessageMetadata.ts').replaceAll("from './SharedMoment'", `from '${sharedMomentModuleUrl}'`).replace(
    /from ['"]\.\/ChatSticker['"]/g,
    `from '${stickerModuleUrl}'`,
  ).replace(/from ['"]\.\/SharedChatRecord['"]/g, `from '${sharedRecordModuleUrl}'`),
);
const directoryModuleUrl = transpileToModuleUrl(
  read('src/features/chat/group/domain/GroupParticipantDirectory.ts'),
);
const parserSource = read('src/features/chat/group/application/GroupMessageMentionParser.ts')
  .replace(
    /from ['"]\.\.\/\.\.\/messages\/domain\/chatMessageMetadata['"]/g,
    `from '${metadataModuleUrl}'`,
  )
  .replace(
    /from ['"]\.\.\/domain\/GroupParticipantDirectory['"]/g,
    `from '${directoryModuleUrl}'`,
  );
const parserModule = await import(transpileToModuleUrl(parserSource));
const { parseGroupMessageMentions } = parserModule;

const directory = {
  groupId: 'group-1',
  currentUser: {
    targetType: 'user',
    userProfileId: 'user-1',
    displayName: '小雨',
    avatar: null,
  },
  assistants: [
    {
      targetType: 'assistant',
      assistantId: 'assistant-a',
      displayName: '甲',
      avatar: null,
    },
    {
      targetType: 'assistant',
      assistantId: 'assistant-b',
      displayName: '乙',
      avatar: null,
      isBlocked: true,
    },
    {
      targetType: 'assistant',
      assistantId: 'assistant-c',
      displayName: '丙',
      avatar: null,
    },
    {
      targetType: 'assistant',
      assistantId: 'assistant-en',
      displayName: 'Bob_2',
      avatar: null,
    },
  ],
};

const recursiveText = '甲说：@乙！@乙！@丙；@乙。@Bob_2!';
assert.deepEqual(
  parseGroupMessageMentions({
    text: recursiveText,
    directory,
    actorAssistantId: 'assistant-a',
  }),
  [
    {
      actorType: 'assistant',
      actorAssistantId: 'assistant-a',
      target: {
        targetType: 'assistant',
        assistantId: 'assistant-b',
        displayNameAtSend: '乙',
      },
    },
    {
      actorType: 'assistant',
      actorAssistantId: 'assistant-a',
      target: {
        targetType: 'assistant',
        assistantId: 'assistant-c',
        displayNameAtSend: '丙',
      },
    },
    {
      actorType: 'assistant',
      actorAssistantId: 'assistant-a',
      target: {
        targetType: 'assistant',
        assistantId: 'assistant-en',
        displayNameAtSend: 'Bob_2',
      },
    },
  ],
  'blocked 成员仍是可见目标；应按正文首次出现顺序解析并按目标去重，正文本身不属于 parser 输出',
);
assert.equal(recursiveText, '甲说：@乙！@乙！@丙；@乙。@Bob_2!');

assert.deepEqual(
  parseGroupMessageMentions({
    text: '@甲 @小雨',
    directory,
    actorAssistantId: 'assistant-a',
  }),
  [
    {
      actorType: 'assistant',
      actorAssistantId: 'assistant-a',
      target: {
        targetType: 'user',
        userProfileId: 'user-1',
        displayNameAtSend: '小雨',
      },
    },
  ],
  'assistant 自己不能成为目标，但当前用户可以成为结构化称呼目标',
);

assert.deepEqual(
  parseGroupMessageMentions({
    text: '@乙！和@乙明、@Bob_2x、@Bob_2！',
    directory,
    actorAssistantId: 'assistant-a',
  }).map((mention) => mention.target),
  [
    {
      targetType: 'assistant',
      assistantId: 'assistant-b',
      displayNameAtSend: '乙',
    },
    {
      targetType: 'assistant',
      assistantId: 'assistant-en',
      displayNameAtSend: 'Bob_2',
    },
  ],
  '中文、英文标点可结束名称；名称连续字符不能被截断匹配',
);

assert.deepEqual(
  parseGroupMessageMentions({
    text: '请@乙，来回答',
    directory,
    actorAssistantId: 'assistant-a',
  }).map((mention) => mention.target),
  [{
    targetType: 'assistant',
    assistantId: 'assistant-b',
    displayNameAtSend: '乙',
  }],
  '中文自然正文可以紧邻 @ 起始，目标名称之后仍必须具备 token 边界',
);

const ambiguousDirectory = {
  ...directory,
  currentUser: {
    ...directory.currentUser,
    displayName: '甲',
  },
};
assert.deepEqual(
  parseGroupMessageMentions({
    text: '@甲',
    directory: ambiguousDirectory,
    actorAssistantId: 'assistant-a',
  }),
  [],
  'actor 与另一个参与者重名时必须先消歧，不能猜测是 self',
);

assert.deepEqual(
  parseGroupMessageMentions({
    text: '@不存在 @系统成员',
    directory,
    actorAssistantId: 'assistant-a',
  }),
  [],
  'disabled、已删除或 system/admin 成员不会进入可见目录，因此不形成 mention',
);

const metadata = {
  groupChat: {
    kind: 'assistant_message',
    mentions: [
      {
        actorType: 'assistant',
        actorAssistantId: 'assistant-a',
        target: {
          targetType: 'user',
          userProfileId: 'user-1',
          displayNameAtSend: '小雨',
        },
      },
      {
        actorType: 'user',
        target: {
          targetType: 'assistant',
          assistantId: 'assistant-b',
          displayNameAtSend: '乙',
        },
      },
    ],
  },
};
const metadataModule = await import(metadataModuleUrl);
assert.deepEqual(
  metadataModule.getGroupChatMentions({ metadataJson: JSON.stringify(metadata) }),
  metadata.groupChat.mentions,
  'metadata helper 必须读取统一嵌套 mention shape',
);
assert.deepEqual(
  metadataModule.getGroupChatMentions({
    metadataJson: JSON.stringify({
      groupChat: { mentions: [{ aiAssistantId: 'legacy', displayNameAtSend: '旧格式' }] },
    }),
  }),
  [],
  'metadata helper 不再回退读取旧扁平 mention shape',
);

console.log('群 AI mention parser 与 metadata 行为验证通过。');
