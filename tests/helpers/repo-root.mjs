/** 由自身位置向上查找 package.json 定位仓库根；测试文件移动目录不再依赖层级。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(start) {
  let current = start;
  for (;;) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`未找到仓库根 package.json：${start}`);
    current = parent;
  }
}

export const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
