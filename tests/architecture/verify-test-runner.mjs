/** 验证全量执行的覆盖、去重、失败隔离与日志，不绑定执行器源码形状。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVerificationPlan, runVerificationPlan } from '../run-all.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ravencat-test-runner-'));
try {
  fs.writeFileSync(path.join(directory, 'fail.cjs'), "console.error('expected failure details'); process.exitCode = 1;");
  fs.writeFileSync(path.join(directory, 'tail.cjs'), "require('node:fs').appendFileSync('tail.txt', '1');");
  fs.writeFileSync(path.join(directory, 'after.cjs'), "require('node:fs').writeFileSync('after.txt', 'continued');");
  fs.writeFileSync(path.join(directory, 'mode.cjs'), "require('node:fs').writeFileSync(process.argv[2] + '.txt', 'checked');");
  fs.writeFileSync(path.join(directory, 'excluded.cjs'), "require('node:fs').writeFileSync('excluded.txt', 'unexpected');");
  const scripts = {
    'verify:mixed': 'node fail.cjs && npm run verify:tail && node after.cjs',
    'verify:tail': 'node --no-warnings tail.cjs',
    'verify:duplicate': 'node tail.cjs',
    'verify:modes': 'node mode.cjs locale && node mode.cjs chat-envelope',
    'verify:gallery-writer': 'node excluded.cjs',
    'verify:gradle': 'cd android && gradlew.bat testDebugUnitTest',
    'architecture:snapshot': 'node excluded.cjs',
    'architecture:cycles:report': 'node excluded.cjs',
    'architecture:long-files': 'node excluded.cjs',
    'verify:all': 'node excluded.cjs',
    'verify:registration': 'node excluded.cjs',
  };
  const jobs = createVerificationPlan(scripts);
  const failures = runVerificationPlan(jobs, {
    cwd: directory, logDirectory: path.join(directory, 'logs'), log() {},
  });
  assert.equal(failures.length, 1);
  assert.match(fs.readFileSync(failures[0].filename, 'utf8'), /expected failure details/);
  assert.equal(fs.readFileSync(path.join(directory, 'tail.txt'), 'utf8'), '1', '混合聚合中的成员执行一次');
  assert.equal(fs.readFileSync(path.join(directory, 'after.txt'), 'utf8'), 'continued', '前项失败后仍执行后项');
  assert.equal(fs.readFileSync(path.join(directory, 'locale.txt'), 'utf8'), 'checked');
  assert.equal(fs.readFileSync(path.join(directory, 'chat-envelope.txt'), 'utf8'), 'checked', '同一文件的不同模式都执行');
  assert.equal(fs.existsSync(path.join(directory, 'excluded.txt')), false, '生成、报告、自引用和原生任务不进入默认执行');
  assert.equal(createVerificationPlan(scripts, { only: 'verify:mixed' }).length, 3, '筛选聚合入口时包含引用的成员');
  const native = createVerificationPlan(scripts, { withNative: true });
  assert.ok(native.some(job => job.command === scripts['verify:gallery-writer']));
  assert.ok(native.some(job => job.command === scripts['verify:gradle']), 'cd 与 Gradle 保持同一个 shell');
  assert.ok(!native.some(job => job.name === 'architecture:snapshot'));
  console.log('全量执行器行为验证通过');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
