/** 隔离加载分享领域契约；行为验证仍使用生产格式化与 SQLite 边界校验。 */
import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import ts from 'typescript';
import { loadTypeScriptModule } from './load-typescript-module.mjs';

export const sharedMoment = loadTypeScriptModule('src/features/chat/messages/domain/SharedMoment.ts');
export const sharedChatRecord = loadTypeScriptModule('src/features/chat/messages/domain/SharedChatRecord.ts', { './SharedMoment': sharedMoment });
export const chatSharingDependencies = { './SharedMoment': sharedMoment, './SharedChatRecord': sharedChatRecord };
export const sharedMomentIntent = loadTypeScriptModule('src/features/chat/reply/agent/SharedMomentSendIntent.ts');

function moduleUrl(file, replacements = {}) {
  let source = fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  for (const [specifier, url] of Object.entries(replacements)) source = source.replaceAll(`from '${specifier}'`, `from '${url}'`);
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
}
export const sharedMomentModuleUrl = moduleUrl('src/features/chat/messages/domain/SharedMoment.ts');
export const sharedChatRecordModuleUrl = moduleUrl('src/features/chat/messages/domain/SharedChatRecord.ts', { './SharedMoment': sharedMomentModuleUrl });
