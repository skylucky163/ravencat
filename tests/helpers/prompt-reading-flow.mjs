/** 行为验证读取生产顺序定义，不复制第二份测试排序表。 */
import fs from 'node:fs';
import ts from 'typescript';
const output = ts.transpileModule(fs.readFileSync(new URL('../../src/shared/prompt/readingFlow.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const exports = {};
new Function('exports', output.outputText)(exports);
export const { CHAT_PROMPT_READING_FLOW } = exports;
