import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import ts from 'typescript';

export async function importTypeScriptModule(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
  return import(moduleUrl);
}
