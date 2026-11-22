import assert from 'node:assert/strict';
import { loadTypeScriptModule } from '../helpers/load-typescript-module.mjs';

// 这两个模块必须零运行时依赖，因此不传 mocks：任何 require 都会被 helper 拒绝。
const catalogModule = loadTypeScriptModule(
  'src/features/phoneTools/domain/PhoneToolCatalog.ts',
);
const directoryModule = loadTypeScriptModule(
  'src/features/miniPrograms/presentation/phoneTools/PhoneToolsDirectoryModel.ts',
);

const { PHONE_TOOL_CATALOG, PHONE_TOOL_CATEGORIES } = catalogModule;
const { buildPhoneToolsDirectory } = directoryModule;

const expectedAvailableNames = [
  'read_clipboard',
  'search_installed_apps',
  'get_foreground_app',
  'get_app_usage',
  'read_screen_accessibility',
  'read_screen_ocr',
  'open_app',
  'set_alarm',
  'show_alarms', 'dismiss_alarm', 'snooze_alarm', 'get_next_alarm',
  'soft_lock_app',
  'release_soft_lock',
];
const expectedPlannedNames = [];

for (const toolName of expectedAvailableNames) {
  const item = PHONE_TOOL_CATALOG.find((candidate) => candidate.toolName === toolName);
  assert.ok(item, `Phone catalog 必须包含 ${toolName}`);
  assert.equal(item.implementationStatus, 'available', `${toolName} 必须标记为 available`);
}

for (const toolName of expectedPlannedNames) {
  const item = PHONE_TOOL_CATALOG.find((candidate) => candidate.toolName === toolName);
  assert.ok(item, `Phone catalog 必须包含 ${toolName}`);
  assert.equal(item.implementationStatus, 'planned', `${toolName} 必须标记为 planned`);
}

const toolNames = PHONE_TOOL_CATALOG.map((item) => item.toolName);
assert.equal(new Set(toolNames).size, toolNames.length, 'Phone catalog 的 toolName 不得重复');

const categoryIds = new Set(PHONE_TOOL_CATEGORIES.map((category) => category.id));
assert.equal(categoryIds.has('integration'), false, '旧 integration category 必须退役');
assert.equal(toolNames.includes('play_music'), false, '旧 generic play_music 占位必须退役');
assert.equal(
  PHONE_TOOL_CATALOG.some((item) => item.id === 'musicPlayback'),
  false,
  '旧 musicPlayback 产品项必须退役',
);
for (const item of PHONE_TOOL_CATALOG) {
  assert.ok(categoryIds.has(item.category), `${item.toolName} 必须使用合法 category`);
  for (const runtimeField of ['owner', 'risk', 'hostOnly', 'idempotency', 'execution']) {
    assert.equal(
      Object.hasOwn(item, runtimeField),
      false,
      `Phone catalog 不得复制 Runtime metadata：${item.toolName}.${runtimeField}`,
    );
  }
}

const directory = buildPhoneToolsDirectory(PHONE_TOOL_CATALOG, PHONE_TOOL_CATEGORIES);
const directoryItems = directory.flatMap((section) => section.items);
assert.deepEqual(
  directoryItems.map((item) => item.toolName).sort(),
  [...toolNames].sort(),
  '手机工具页面目录必须完整来自 Phone catalog',
);

console.log('Phone Tools catalog contracts verified.');
