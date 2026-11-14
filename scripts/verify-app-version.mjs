/** 验证版本统一来源、构建编号递增，以及个人页显示安装包的真实版本。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
globalThis.__DEV__ = false;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versionSource = fs.readFileSync(path.join(root, 'scripts/app-version.cjs'), 'utf8');
function versionAt(version, time) {
  const module = { exports: {} };
  vm.runInNewContext(versionSource, {
    module, require: () => ({ version }), Date: { now: () => time },
  });
  return module.exports;
}
const first = versionAt('2.0.0', Date.parse('2026-10-08T00:00:00Z'));
const next = versionAt('2.0.0', Date.parse('2026-10-08T00:00:01Z'));
assert.equal(next.version, first.version);
assert.equal(next.versionCode, first.versionCode + 1);
const major = versionAt('3.0.0', Date.parse('2026-10-09T00:00:00Z'));
assert.equal(major.version, '3.0.0');
assert.ok(major.versionCode > next.versionCode, '主版本变化不重置构建编号');
assert.ok(first.versionCode > 2 && major.versionCode < 2100000000);
const config = require('../app.config.js')({ config: {} });
assert.equal(config.version, require('../package.json').version);
assert.equal(config.android.versionCode, require('./app-version.cjs').versionCode);

let installedInfo;
const compiled = ts.transpileModule(fs.readFileSync(path.join(root, 'src/features/profile/presentation/ProfileContent.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const mocks = {
  react: { useMemo: (factory) => factory() },
  'react/jsx-runtime': require('react/jsx-runtime'),
  'react-native': { Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View' },
  'lucide-react-native': { Database: 'Database', UserRound: 'UserRound' },
  '@shared/ui': { UserAvatar: 'UserAvatar' },
  '@shared/theme': { ThemedSurface: 'ThemedSurface', useTheme: () => ({}) },
  '@platform/device/DeviceStatus': { getInstalledApplicationInfo: () => installedInfo },
  '../../../../package.json': { version: '2.1.2' },
  './ProfileTab.styles': { createProfileStyles: () => ({}) },
};
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)((name) => {
  assert.ok(Object.hasOwn(mocks, name), `缺少依赖 ${name}`);
  return mocks[name];
}, module, module.exports);
function texts(element) {
  if (element == null) return [];
  if (Array.isArray(element)) return element.flatMap(texts);
  if (typeof element !== 'object') return [];
  if (element.type === 'Text') return [[].concat(element.props.children).join('')];
  return texts(element.props.children);
}
for (const info of [
  { name: 'RavenCat', version: '2.0.0', buildNumber: String(first.versionCode) },
  { name: 'RavenCat', version: '3.0.0', buildNumber: String(major.versionCode) },
  { name: 'KimiPhone', version: '3.0.0', buildNumber: String(major.versionCode) },
]) {
  installedInfo = info;
  const tree = module.exports.ProfileContent({ profile: { name: '枫渡' }, hasLoadedProfile: true });
  assert.ok(texts(tree).includes(`${info.name} v${info.version} (${info.buildNumber})`));
  assert.ok(texts(tree).every((text) => !text.includes('开发源码')), '预览版不展示开发源码版本');
}
globalThis.__DEV__ = true;
installedInfo = { name: 'KimiPhone', version: '2.1.1', buildNumber: '214100154' };
const developmentTree = module.exports.ProfileContent({ profile: { name: '枫渡' }, hasLoadedProfile: true });
assert.ok(texts(developmentTree).includes('KimiPhone · 开发源码 v2.1.2'));
assert.ok(texts(developmentTree).includes('安装包 v2.1.1 (214100154)'), '开发源码更新后仍保留安装包的真实版本');
console.log('应用版本验证通过：统一主版本、构建编号递增、开发源码与安装包版本分开显示。');
