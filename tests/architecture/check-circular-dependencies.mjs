import { repoRoot as ROOT } from '../helpers/repo-root.mjs';
import path from 'node:path';
import process from 'node:process';
import madge from 'madge';


const graph = await madge(path.join(ROOT, 'src'), {
  baseDir: ROOT,
  detectiveOptions: {
    ts: { skipTypeImports: true },
    tsx: { skipTypeImports: true },
  },
  fileExtensions: ['js', 'jsx', 'ts', 'tsx'],
  tsConfig: path.join(ROOT, 'tsconfig.json'),
});
const currentCycles = graph.circular();

if (currentCycles.length > 0) {
  console.error(`Found ${currentCycles.length} circular dependency cycle(s):`);
  for (const cycle of currentCycles) {
    console.error(`- ${cycle.join(' -> ')} -> ${cycle[0]}`);
  }
  process.exitCode = 1;
} else {
  console.log('Circular dependency guard passed: 0 cycles.');
}
