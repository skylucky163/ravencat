import { repoRoot as ROOT } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';


const SRC = path.join(ROOT, 'src');
const STYLE_FILE_LINE_LIMIT = 300;
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);

function collectFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(entryPath);
    }
    return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [entryPath] : [];
  });
}

export function countSourceLines(sourceText) {
  if (sourceText.length === 0) {
    return 0;
  }

  const lineBreaks = sourceText.match(/\r\n|\r|\n/g)?.length ?? 0;
  return lineBreaks + (/\r\n$|\r$|\n$/.test(sourceText) ? 0 : 1);
}

function portableBaseName(filePath) {
  return filePath.replaceAll('\\', '/').split('/').at(-1) ?? filePath;
}

export function isStyleResponsibilityFile(filePath, sourceText) {
  const fileName = portableBaseName(filePath);
  const extension = path.extname(fileName).toLowerCase();
  if (!SOURCE_EXTENSIONS.has(extension)) {
    return false;
  }

  const stem = fileName.slice(0, -extension.length);
  if (/^styles$/i.test(stem) || /\.styles$/i.test(stem)) {
    return true;
  }

  return /styles?$/i.test(stem) && /\bStyleSheet\s*\.\s*create\s*\(/.test(sourceText);
}

export function toRelativeDisplayPath(rootPath, filePath) {
  const usesWindowsPath = rootPath.includes('\\') || filePath.includes('\\');
  const pathApi = usesWindowsPath ? path.win32 : path;
  return pathApi.relative(rootPath, filePath).replaceAll('\\', '/');
}

export function evaluateStyleFile(filePath, sourceText, rootPath = ROOT) {
  if (!isStyleResponsibilityFile(filePath, sourceText)) {
    return null;
  }

  const lines = countSourceLines(sourceText);
  if (lines <= STYLE_FILE_LINE_LIMIT) {
    return null;
  }

  return {
    filePath,
    relativePath: toRelativeDisplayPath(rootPath, filePath),
    lines,
  };
}

function makeStyleSource(lines) {
  assert.ok(lines >= 2);
  return [
    "import { StyleSheet } from 'react-native';",
    'export const styles = StyleSheet.create({});',
    ...Array.from({ length: lines - 2 }, (_, index) => `// 填充行 ${index + 1}`),
  ].join('\n');
}

function runSelfTest() {
  const windowsRoot = 'C:\\repo';
  const stylesPath = 'C:\\repo\\src\\feature\\styles.ts';

  assert.equal(evaluateStyleFile(stylesPath, makeStyleSource(299), windowsRoot), null);
  assert.equal(evaluateStyleFile(stylesPath, makeStyleSource(300), windowsRoot), null);
  assert.deepEqual(
    evaluateStyleFile(stylesPath, makeStyleSource(301), windowsRoot),
    {
      filePath: stylesPath,
      relativePath: 'src/feature/styles.ts',
      lines: 301,
    }
  );

  assert.equal(
    evaluateStyleFile(
      'C:\\repo\\src\\feature\\LongScreen.tsx',
      makeStyleSource(450),
      windowsRoot
    ),
    null
  );
  assert.equal(
    isStyleResponsibilityFile(
      'C:\\repo\\src\\feature\\chatInputStyles.ts',
      makeStyleSource(10)
    ),
    true
  );
  assert.equal(
    isStyleResponsibilityFile(
      'C:\\repo\\src\\feature\\MessageBubbleStyle.ts',
      makeStyleSource(10)
    ),
    true
  );
  assert.equal(
    isStyleResponsibilityFile(
      'C:\\repo\\src\\feature\\Lifestyle.ts',
      'export const value = 1;'
    ),
    false
  );

  console.log('样式文件行数守卫自测通过。');
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--self-test')) {
    runSelfTest();
    return;
  }

  const styleFiles = [];
  const violations = [];
  for (const filePath of collectFiles(SRC)) {
    const sourceText = fs.readFileSync(filePath, 'utf8');
    if (!isStyleResponsibilityFile(filePath, sourceText)) {
      continue;
    }

    styleFiles.push(filePath);
    const violation = evaluateStyleFile(filePath, sourceText);
    if (violation) {
      violations.push(violation);
    }
  }

  violations.sort((left, right) => (
    right.lines - left.lines || left.relativePath.localeCompare(right.relativePath)
  ));

  if (violations.length > 0) {
    console.error(`样式文件行数检查失败：单文件上限为 ${STYLE_FILE_LINE_LIMIT} 行。`);
    for (const violation of violations) {
      console.error(
        `- ${violation.relativePath}（${violation.lines} 行）：请按真实职责拆分或提取共享样式。`
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `样式文件行数检查通过：${styleFiles.length} 个样式职责文件均不超过 ${STYLE_FILE_LINE_LIMIT} 行。`
  );
}

main();
