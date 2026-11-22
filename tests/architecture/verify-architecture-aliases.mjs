import { repoRoot as ROOT } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const expoPackagePath = require.resolve('expo/package.json');
const cliPackagePath = require.resolve('@expo/cli/package.json', {
  paths: [path.dirname(expoPackagePath)],
});
const cliRoot = path.dirname(cliPackagePath);
const { loadTsConfigPathsAsync } = require(path.join(
  cliRoot,
  'build/src/utils/tsconfig/loadTsConfigPaths.js',
));
const { resolveWithTsConfigPaths } = require(path.join(
  cliRoot,
  'build/src/utils/tsconfig/resolveWithTsConfigPaths.js',
));

function resolveFile(candidate) {
  const candidates = [
    candidate,
    `${candidate}.js`,
    `${candidate}.jsx`,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    path.join(candidate, 'index.js'),
    path.join(candidate, 'index.jsx'),
    path.join(candidate, 'index.ts'),
    path.join(candidate, 'index.tsx'),
  ];
  const filePath = candidates.find((entry) => fs.existsSync(entry) && fs.statSync(entry).isFile());
  return filePath ? { filePath } : null;
}

const tsconfigPaths = await loadTsConfigPathsAsync(ROOT);
assert(tsconfigPaths?.paths, 'Expo CLI did not load compilerOptions.paths from tsconfig.json.');

// 未配置 baseUrl 时，Expo 会从项目根目录解析路径映射；这里复用同一规则。
const aliasBaseUrl = tsconfigPaths.baseUrl ?? ROOT;

const aliases = [
  '@host',
  '@features/calls',
  '@features/calls/composition',
  '@features/chat',
  '@features/chat/composition',
  '@features/mcpTools',
  '@features/memory',
  '@features/memory/composition',
  '@features/companion',
  '@features/companion/composition',
  '@features/screenCapture',
  '@features/wallet',
  '@platform',
  '@platform/device',
  '@platform/persistence',
  '@shared',
  '@shared/aiTools',
  '@shared/prompt',
  '@shared/theme',
  '@shared/ui',
];

for (const moduleName of aliases) {
  const result = resolveWithTsConfigPaths(
    {
      paths: tsconfigPaths.paths,
      baseUrl: aliasBaseUrl,
      hasBaseUrl: Boolean(tsconfigPaths.baseUrl),
    },
    {
      moduleName,
      originModulePath: path.join(ROOT, 'tests', 'architecture', 'verify-architecture-aliases.ts'),
    },
    resolveFile,
  );
  assert(result?.filePath, `Expo Metro resolver could not resolve ${moduleName}.`);
}

console.log(`Expo Metro resolver resolved ${aliases.length} architecture aliases.`);
