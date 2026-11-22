/** 复用真实 Chat 到达投影模块；测试只替换宿主原生端口。 */
import { repoRoot as root } from './repo-root.mjs';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';


const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64')}`;
const slotUrl = moduleUrl(read('src/shared/runtime/RuntimeSlot.ts'));
export const arrivalModuleUrl = moduleUrl(read('src/features/chat/reply/delivery/AssistantMessageArrival.ts')
  .replace("from '@shared/runtime/RuntimeSlot'", `from '${slotUrl}'`));
export const arrival = await import(arrivalModuleUrl);
