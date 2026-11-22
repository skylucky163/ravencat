/** 验证脚本共用：读源码 → 转译 → 注入显式依赖 → 返回独立 exports。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { repoRoot } from './repo-root.mjs';

export function loadTypeScriptModule(relativePath, mocks = {}) {
  const absolutePath = path.join(repoRoot, relativePath);
  const compiled = ts.transpileModule(fs.readFileSync(absolutePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: absolutePath,
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(errors, [], `${relativePath} 无法编译`);

  const module = { exports: {} };
  const executeModule = new Function(
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    compiled.outputText,
  );
  executeModule(
    module.exports,
    (specifier) => {
      assert.ok(
        Object.hasOwn(mocks, specifier),
        `${relativePath} 存在未声明依赖：${specifier}`,
      );
      return mocks[specifier];
    },
    module,
    absolutePath,
    path.dirname(absolutePath),
  );
  return module.exports;
}

/** 供验证脚本读取仓库内生产源码做静态断言。 */
export function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}
