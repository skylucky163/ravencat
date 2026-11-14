/** 只编译并验证相册模块，不组装 APK。 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.platform === 'win32' ? 'cmd.exe' : './gradlew',
  process.platform === 'win32' ? ['/d', '/c', 'gradlew.bat :gallery-writer:testDebugUnitTest'] : [':gallery-writer:testDebugUnitTest'],
  { cwd: path.join(root, 'android'), stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
