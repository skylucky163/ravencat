import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-golden-'));

function compile(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
  });
  const outputPath = path.join(tempRoot, relativePath.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output.outputText, 'utf8');
  return outputPath;
}

for (const relativePath of [
  'src/features/calls/application/runtime/OutgoingCallDecisionParser.ts',
  'src/features/chat/group/application/GroupAdminReplyParser.ts',
  'src/features/chat/group/application/GroupMentionModelText.ts',
  'src/features/chat/messages/domain/ChatSticker.ts',
  'src/features/chat/messages/domain/SharedMoment.ts',
  'src/features/chat/messages/domain/SharedChatRecord.ts',
  'src/features/chat/messages/domain/chatMessageMetadata.ts',
  'src/features/chat/group/application/GroupTaskPromptBlocks.ts',
  'src/features/calls/application/CallPromptBlocks.ts',
  'src/features/companion/application/CompanionPromptBlocks.ts',
  'src/host/prompt/compiler/systemPromptPresets.ts',
]) {
  compile(relativePath);
}

const load = (relativePath) => require(path.join(tempRoot, relativePath.replace(/\.ts$/, '.js')));
const { parseOutgoingCallDecision } = load(
  'src/features/calls/application/runtime/OutgoingCallDecisionParser.ts'
);
const {
  buildGroupAdminInput,
  createGroupAdminMemberAliases,
  normalizeAdminSpeakerIds,
} = load(
  'src/features/chat/group/application/GroupAdminReplyParser.ts'
);
const { GROUP_ADMIN_OUTPUT_CONTRACT } = load(
  'src/features/chat/group/application/GroupTaskPromptBlocks.ts'
);
const { buildOutgoingCallDecisionBlocks } = load(
  'src/features/calls/application/CallPromptBlocks.ts'
);
const { getSystemPromptPreset } = load('src/host/prompt/compiler/systemPromptPresets.ts');

assert.deepEqual(
  parseOutgoingCallDecision('我来啦[[接听]]'),
  { decision: 'accept', spokenText: '我来啦' }
);
assert.deepEqual(
  parseOutgoingCallDecision('晚点[[拒绝接听]]打给你'),
  { decision: 'reject', rejectionReason: '晚点打给你' }
);

const members = Array.from({ length: 6 }, (_, index) => ({
  aiAssistantId: `ai-${index + 1}`,
  agentId: `agent-${index + 1}`,
  name: index < 2 ? '同名成员' : `成员${index + 1}`,
}));
const memberAliases = createGroupAdminMemberAliases(members);
assert.deepEqual(
  memberAliases.map(({ alias, member }) => [alias, member.aiAssistantId]),
  members.map((member, index) => [`member_${index + 1}`, member.aiAssistantId]),
  '本轮短别名必须按候选目录顺序稳定对应真实成员',
);
assert.deepEqual(
  normalizeAdminSpeakerIds(
    '["member_2","member_2","unknown","ai-3","member_3","member_4","member_5","member_6"]',
    memberAliases.slice(1),
  ),
  ['ai-2', 'ai-3', 'ai-4', 'ai-5'],
  '解析器只接受候选短别名，并保持顺序、去重和人数上限',
);
const adminInput = buildGroupAdminInput({
  groupName: '测试群',
  memberAliases,
  candidateAliases: memberAliases.slice(1),
  userMessages: [{ id: 3, text: '大家怎么看？' }],
  recentMessages: [
    { id: 1, isMe: false, agentId: 'agent-1', text: '先听听大家的。' },
    { id: 2, isMe: false, agentId: 'deleted-agent-id', text: '历史成员发言。' },
  ],
});
for (const internalId of members.flatMap((member) => [member.aiAssistantId, member.agentId])) {
  assert.ok(!adminInput.includes(internalId), `管理员输入不得包含真实身份：${internalId}`);
}
assert.ok(!adminInput.includes('deleted-agent-id'), '无法解析的历史身份也不得泄漏');
const attachmentAdminInput = buildGroupAdminInput({
  groupName: '附件群',
  memberAliases,
  candidateAliases: memberAliases,
  userMessages: [{
    id: 11,
    text: '这个你们怎么看？',
    isMe: true,
    metadataJson: JSON.stringify({
      kind: 'mixed',
      attachments: [{
        id: 'image-secret',
        type: 'image',
        source: 'gallery',
        localUri: 'file:///private/secret-image.png',
        fileName: 'secret-image.png',
        previewText: '图片内容秘密',
      }],
    }),
  }],
  recentMessages: [{
    id: 10,
    text: '',
    isMe: true,
    metadataJson: JSON.stringify({
      kind: 'file',
      attachments: [{
        id: 'file-secret',
        type: 'file',
        source: 'document',
        localUri: 'file:///private/secret-file.txt',
        fileName: 'secret-file.txt',
        parsedText: '文件正文秘密',
      }],
    }),
  }],
});
assert.match(attachmentAdminInput, /这个你们怎么看/);
for (const privateDetail of [
  'secret-image.png',
  'file:///private/secret-image.png',
  '图片内容秘密',
  'secret-file.txt',
  'file:///private/secret-file.txt',
  '文件正文秘密',
]) {
  assert.ok(!attachmentAdminInput.includes(privateDetail), `管理员不得看到附件详情：${privateDetail}`);
}
assert.throws(
  () => normalizeAdminSpeakerIds('{"speaker":"member_1"}', memberAliases),
  /JSON 字符串数组/
);
assert.match(GROUP_ADMIN_OUTPUT_CONTRACT, /member_1/);
assert.doesNotMatch(GROUP_ADMIN_OUTPUT_CONTRACT, /aiAssistantId|agentId/);

const outgoingBlocks = buildOutgoingCallDecisionBlocks();
assert.equal(outgoingBlocks[0].definitionId, 'scenario.call_outgoing_decision');
assert.equal(outgoingBlocks[1].definitionId, 'output.call_outgoing_decision_json');
// 去电决策走 resolved Chat Pack，persona 由聊天管线注入，Feature blocks 不得重复提供。
assert.ok(!outgoingBlocks.some((block) => block.definitionId === 'persona.assistant'));
const outgoingPresetIds = getSystemPromptPreset('call.outgoing_decision').items.map((item) => item.definitionId);
assert.ok(outgoingPresetIds.includes('persona.assistant'), '去电决策预设必须包含 persona');
assert.ok(outgoingPresetIds.includes('context.user_identity'), '去电决策预设必须包含用户身份');
assert.ok(outgoingPresetIds.includes('history.recent_chat'), '去电决策预设必须包含近期历史');

// 一起听邀请被拒跟进是无 Tool 的 standalone JSON 决策：只含人设、场景、契约与当前输入。
const declineFollowUpPresetIds = getSystemPromptPreset('together_listening.post_user_decline')
  .items.map((item) => item.definitionId);
assert.ok(declineFollowUpPresetIds.includes('persona.assistant'), '一起听拒绝跟进预设必须包含 persona');
assert.ok(declineFollowUpPresetIds.includes('scenario.together_listening_post_user_decline'));
assert.ok(declineFollowUpPresetIds.includes('output.together_listening_post_user_decline_json'));
assert.ok(declineFollowUpPresetIds.includes('input.current'));
assert.ok(
  !declineFollowUpPresetIds.some((id) => id.includes('tool') || id.includes('history')),
  '一起听拒绝跟进不得包含工具或历史定义',
);

const isolatedScenarioRequirements = new Map([
  ['chat.summary', [
    'internal.chat_summary',
    'persona.assistant',
    'input.current',
  ]],
  ['vision.ocr', [
    'internal.vision_ocr',
    'output.vision_ocr_plain_text',
    'input.current',
  ]],
]);
for (const [scenario, requiredDefinitionIds] of isolatedScenarioRequirements) {
  const definitionIds = new Set(
    getSystemPromptPreset(scenario).items.map((item) => item.definitionId),
  );
  for (const requiredDefinitionId of requiredDefinitionIds) {
    assert.ok(definitionIds.has(requiredDefinitionId), `${scenario} 缺少 ${requiredDefinitionId}`);
  }
  // 摘要是当前 AI 对共同经历的回顾；OCR 仍保持无角色的识别任务。
  assert.equal(
    definitionIds.has('persona.assistant'),
    scenario === 'chat.summary',
    `${scenario} 的人设归属应符合任务契约`,
  );
  assert.ok(!definitionIds.has('history.recent_chat'), '内部任务不额外装载聊天原文');
  if (scenario === 'vision.ocr') {
    assert.ok(!definitionIds.has('context.tools_description'), 'OCR 不继承聊天工具说明');
  } else {
    assert.ok(definitionIds.has('context.tools_description'), '当前 AI 摘要沿用聊天稳定前缀，工具说明按本轮授权装载');
  }
}

console.log('Prompt contract cases 通过（结构化解析、persona 传递与内部场景隔离）。');
fs.rmSync(tempRoot, { recursive: true, force: true });
