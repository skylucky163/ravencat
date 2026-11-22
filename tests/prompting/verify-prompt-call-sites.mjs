import { repoRoot } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import path from 'node:path';


const sourceRoot = path.join(repoRoot, 'src');

const EXPECTED_CALL_SITES = new Map([
  ['features/calls/application/runtime/OutgoingCallDecision.ts', /assembleChatPromptPack/],
  ['features/calls/application/runtime/PostUserHangUpFollowUp.ts', /scenarioId: 'call\.post_user_hangup'/],
  ['features/togetherListening/application/PostUserDeclineFollowUp.ts', /scenarioId: 'together_listening\.post_user_decline'/],
  ['features/chat/group/application/GroupSpeakerPlanning.ts', /assembleStandalone/],
  ['features/chat/reply/application/ResolveChatImageModelInput.ts', /scenarioId: 'vision\.ocr'/],
  ['platform/agentRuntime/BaseAIClientAgentModelGateway.ts', /buildAgentModelMessages/],
  // 两级摘要的固定来源与稳定前缀由 verify-memory-v3-prompt 行为验证，不锁定某个组装 helper。
  ['host/composition/configureChatSummaryRuntime.ts', null],
  // 退出群历史转换由 Host 拥有模型调用与记忆提交，来源隔离与保存契约见 Memory README。
  ['host/application/ConvertExitedGroupHistoryToMemory.ts', null],
  // Sticker 语义标注是 Feature 自有的辅助模型调用（sticker recognition）：识别 prompt 与
  // JSON 契约都由 Sticker 拥有，不进入统一 Chat Prompt Pack，也不继承 persona / 聊天历史 /
  // RavenCat foundation。这里的证据就是它自己那份识别 prompt，而不是路径白名单。
  ['host/composition/StickerAnnotationModelGateway.ts', /你是表情包语义标注模型/],
  // Moment image analysis 是 Moments-owned narrow auxiliary visual task；不继承角色 Prompt Pack。
  ['host/composition/MomentImageAnalysisModelGateway.ts', /你是时刻图片理解助手/],
  // 翻译归属见 Integrations README；输入隔离与输出契约由 verify-translation-settings 行为验证，
  // 不用提示词源码字符串冻结翻译实现。
  ['features/integrations/TranslateMessageText.ts', null],
]);

function listSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(absolutePath);
    return /\.tsx?$/.test(entry.name) ? [absolutePath] : [];
  });
}

const actualCallSites = new Set();
for (const absolutePath of listSourceFiles(sourceRoot)) {
  const source = fs.readFileSync(absolutePath, 'utf8');
  const ast = ts.createSourceFile(absolutePath, source, ts.ScriptTarget.Latest, true);
  let callsModel = false;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      const name = node.expression.name.text;
      if (['chat', 'chatStream'].includes(name) && (
        receiver.getText(ast) === 'client' || receiver.getText(ast) === 'params.client'
        || (ts.isCallExpression(receiver) && receiver.expression.getText(ast) === 'createAIClient')
      )) callsModel = true;
      if (name === 'complete' && ['provider', 'this.gateway'].includes(receiver.getText(ast))) callsModel = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (callsModel) {
    actualCallSites.add(path.relative(sourceRoot, absolutePath).replaceAll('\\', '/'));
  }
}

assert.deepEqual(
  [...actualCallSites].sort(),
  [...EXPECTED_CALL_SITES.keys()].sort(),
  '真实模型调用点发生变化；请先登记该调用点的 Prompt / 契约归属与文档，再更新审计清单'
);
// marker 只证明「该调用点自己拥有 Prompt 或明确的调用边界」，不要求它是 Prompt Pack：
// 统一 Prompt Pack、specialized task、feature-owned auxiliary model call 三类都登记在这里。
for (const [relativePath, registrationMarker] of EXPECTED_CALL_SITES) {
  if (registrationMarker === null) continue;
  const source = fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8');
  assert.match(source, registrationMarker, `${relativePath} 缺少已登记的 Prompt / 调用边界证据`);
}

console.log(`提示词调用点检查通过（${actualCallSites.size} 个模型调用文件均已登记）。`);
