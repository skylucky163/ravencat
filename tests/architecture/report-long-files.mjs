import { repoRoot as ROOT } from '../helpers/repo-root.mjs';
import fs from 'node:fs';
import path from 'node:path';


const SRC = path.join(ROOT, 'src');
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const REVIEW_THRESHOLD = 350;
const REVIEW_LIMIT = 50;

function collectFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(entryPath);
    }
    return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [entryPath] : [];
  });
}

const allEntries = collectFiles(SRC)
  .map((filePath) => ({
    filePath,
    lines: fs.readFileSync(filePath, 'utf8').split(/\r?\n/).length,
  }))
  .filter(({ lines }) => lines >= REVIEW_THRESHOLD)
  .sort((left, right) => right.lines - left.lines || left.filePath.localeCompare(right.filePath));
const report = allEntries.slice(0, REVIEW_LIMIT);

console.log(`Files with at least ${REVIEW_THRESHOLD} lines (top ${REVIEW_LIMIT}):`);
for (const entry of report) {
  const relativePath = path.relative(ROOT, entry.filePath).replaceAll('\\', '/');
  console.log(`${String(entry.lines).padStart(5)}  ${relativePath}`);
}
console.log(`${allEntries.length} file(s) require a responsibility review; line count alone does not require a split.`);
