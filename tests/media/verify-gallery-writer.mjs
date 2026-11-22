/** 只编译并验证相册模块，不组装 APK。 */
import { repoRoot as root } from '../helpers/repo-root.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const result = spawnSync(process.platform === 'win32' ? 'cmd.exe' : './gradlew',
  process.platform === 'win32' ? ['/d', '/c', 'gradlew.bat :gallery-writer:testDebugUnitTest'] : [':gallery-writer:testDebugUnitTest'],
  { cwd: path.join(root, 'android'), stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
