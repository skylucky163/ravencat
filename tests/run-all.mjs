/** 全量验证逐条执行命令；单项失败不阻止后续用例，原始输出保存在本地日志。 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './helpers/repo-root.mjs';

const EXCLUDED_ENTRIES = new Set([
  'verify:all', 'verify:registration',
  'architecture:snapshot', 'architecture:cycles:report', 'architecture:long-files',
]);
// Node 包装脚本内部启动 Gradle，不能只从 package 命令文本识别原生要求。
const NATIVE_ENTRIES = new Set(['verify:gallery-writer']);
const NATIVE_HINT = /gradlew|RealNetwork|--with-native/;
const testReferences = command => command.match(/tests\/[A-Za-z0-9._\-/]+/g) ?? [];

export function createVerificationPlan(scripts, { withNative = false, only = null } = {}) {
  const visited = new Set();
  const commands = new Map();
  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    if (EXCLUDED_ENTRIES.has(name) || !/^(verify:|architecture:|prompt:)/.test(name)) return;
    const command = scripts[name];
    const native = NATIVE_ENTRIES.has(name) || NATIVE_HINT.test(command);
    if (native && !withNative) return;
    // 原生条目的 cd 与 Gradle 属于同一 shell；JS 聚合中的每项则独立运行。
    for (const part of native ? [command] : command.split('&&').map(part => part.trim())) {
      const reference = /^npm run ([\w:-]+)$/.exec(part);
      if (reference) {
        visit(reference[1]);
      } else {
        // 警告显示方式不改变测试行为；模式参数和 self-test 必须保留为独立命令。
        const key = part.replace(/\s+--no-warnings\b/g, '');
        if (!commands.has(key)) commands.set(key, { name, command: part });
      }
    }
  }
  for (const name of Object.keys(scripts)) {
    if (!only || name.includes(only)) visit(name);
  }
  return [...commands.values()];
}

function collectTestFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTestFiles(full);
    return /^(verify-.*\.(mjs|cjs|ts)|check-.*\.mjs)$/.test(entry.name) ? [full] : [];
  });
}

function checkRegistration(scripts) {
  const referenced = new Set(Object.values(scripts).flatMap(testReferences));
  const executable = new Set(createVerificationPlan(scripts, { withNative: true }).flatMap(job => testReferences(job.command)));
  const files = collectTestFiles(path.join(repoRoot, 'tests')).map(file => path.relative(repoRoot, file).replaceAll('\\', '/'));
  const unregistered = files.filter(file => !referenced.has(file));
  const unreachable = files.filter(file => referenced.has(file) && !executable.has(file));
  const dangling = [...referenced].filter(file => !fs.existsSync(path.join(repoRoot, file)));
  console.log(`测试文件 ${files.length}，已注册 ${files.length - unregistered.length}，可执行 ${files.length - unregistered.length - unreachable.length}`);
  for (const [label, entries] of [['未注册入口的测试', unregistered], ['已注册但全量不可达的测试', unreachable], ['入口指向不存在的文件', dangling]]) {
    if (entries.length) console.error(`${label}（${entries.length}）：\n${entries.map(file => `  ${file}`).join('\n')}`);
  }
  return unregistered.length + unreachable.length + dangling.length === 0;
}

export function runVerificationPlan(jobs, { cwd = repoRoot, logDirectory, log = console.log } = {}) {
  fs.mkdirSync(logDirectory, { recursive: true });
  const env = { ...process.env, NO_COLOR: '1' };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
  env[pathKey] = `${path.join(cwd, 'node_modules', '.bin')}${path.delimiter}${env[pathKey]}`;
  const failures = [];
  const startedAt = Date.now();
  log(`执行 ${jobs.length} 个独立命令；日志：${logDirectory}\n`);
  for (const [index, job] of jobs.entries()) {
    const started = Date.now();
    const filename = path.join(logDirectory, `${String(index + 1).padStart(3, '0')}.log`);
    const fd = fs.openSync(filename, 'w');
    let result;
    try {
      result = spawnSync(job.command, {
        cwd, shell: true, stdio: ['ignore', fd, fd], timeout: 900_000, env,
      });
      if (result.error) fs.writeSync(fd, `\n${result.error.stack}\n`);
    } finally {
      fs.closeSync(fd);
    }
    const ok = result.status === 0;
    const reason = result.error ? result.error.message : `exit ${result.status}, signal ${result.signal}`;
    if (!ok) failures.push({ ...job, reason, filename });
    log(`${ok ? 'PASS' : 'FAIL'} ${job.name}: ${job.command} (${Date.now() - started}ms)${ok ? '' : `\n  ${reason}\n  ${filename}`}`);
  }
  log(`\n通过 ${jobs.length - failures.length}/${jobs.length}，耗时 ${((Date.now() - startedAt) / 60000).toFixed(1)} 分钟`);
  if (failures.length) {
    log('\n失败命令：');
    for (const failure of failures) log(`  ${failure.command}\n    ${failure.filename}`);
  }
  return failures;
}

function main() {
  const scripts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;
  if (!checkRegistration(scripts)) {
    process.exitCode = 1;
    return;
  }
  if (process.argv.includes('--check')) return;
  const onlyIndex = process.argv.indexOf('--only');
  const jobs = createVerificationPlan(scripts, {
    withNative: process.argv.includes('--with-native'),
    only: onlyIndex === -1 ? null : process.argv[onlyIndex + 1],
  });
  if (process.argv.includes('--list')) {
    for (const job of jobs) console.log(`${job.name}: ${job.command}`);
    return;
  }
  fs.mkdirSync(path.join(repoRoot, 'tmp'), { recursive: true });
  const logDirectory = fs.mkdtempSync(path.join(repoRoot, 'tmp', 'verification-'));
  process.exitCode = runVerificationPlan(jobs, { logDirectory }).length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
