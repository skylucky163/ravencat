/** 聊天相册、拍照与文件选图共享限额，按实际文件大小检查。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { repoRoot } from '../../helpers/repo-root.mjs';

const selectionRoot = path.join(repoRoot, 'src/platform/device/chat');
const cacheUri = 'file:///image-picker-cache/screenshot.jpg';
const pickedAsset = { uri: cacheUri, fileName: 'screenshot.jpg', mimeType: 'image/jpeg', fileSize: 345664, width: 1080, height: 5100 };
const state = {
  selections: [],
  size: 346230,
  sizes: new Map(),
  result: { canceled: false, assets: [pickedAsset] },
  error: null,
  fileError: null,
  cameraGranted: true,
  document: null,
};
const dependencies = {
  'expo-image-picker': {
    async launchImageLibraryAsync(options) {
      state.selections.push(options);
      if (state.error) throw state.error;
      return state.result;
    },
    async requestCameraPermissionsAsync() { return { granted: state.cameraGranted }; },
    async launchCameraAsync(options) {
      assert.equal(options.quality, 1, '拍照保留原图');
      return state.result;
    },
  },
  'expo-document-picker': { getDocumentAsync: async () => state.document },
  'expo-file-system': {
    File: class {
      constructor(uri) { this.uri = uri; }
      get name() { return 'screenshot.jpg'; }
      get size() {
        if (state.fileError) throw state.fileError;
        return state.sizes.get(this.uri) ?? state.size;
      }
    },
  },
};
function load(name) {
  const filename = path.resolve(selectionRoot, `${name}.ts`);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext(`(function(require, module, exports) { ${code}\n})`, { filename })(
    specifier => {
      if (specifier.startsWith('./')) return load(specifier);
      if (!(specifier in dependencies)) throw new Error(`未预期的外部依赖：${specifier}`);
      return dependencies[specifier];
    }, module, module.exports,
  );
  return module.exports;
}
const { selectChatImages } = load('selectChatImages');
const { selectChatDocument } = load('selectChatDocument');
const { captureChatPhoto } = load('captureChatPhoto');

const [image] = await selectChatImages(9);
assert.deepEqual(state.selections[0], { mediaTypes: ['images'], allowsEditing: false, allowsMultipleSelection: true, selectionLimit: 9, quality: 1 });
assert.deepEqual(image, { uri: cacheUri, fileName: 'screenshot.jpg', mimeType: 'image/jpeg', fileSize: 346230, width: 1080, height: 5100, source: 'gallery' });

const assets = Array.from({ length: 9 }, (_, index) => ({ ...pickedAsset, uri: `file:///image-${index}.jpg`, fileName: `${index}.jpg` }));
state.result = { canceled: false, assets };
assert.deepEqual((await selectChatImages(9)).map(item => item.uri), assets.map(item => item.uri), '九张图片全部返回并保持选择器顺序');
state.sizes.set(assets[8].uri, 50 * 1024 * 1024 + 1);
await assert.rejects(selectChatImages(9), /图片不能超过 50MB/, '逐张读取真实大小，不能只校验第一张');
state.sizes.clear();

state.result = { canceled: false, assets: [{ ...pickedAsset, fileName: null }] };
assert.equal((await selectChatImages(9))[0].fileName, 'screenshot.jpg', '提供器未返回名称时使用实际缓存文件名');

state.result = { canceled: true, assets: null };
assert.equal(await selectChatImages(9), null);
state.result = { canceled: false, assets: [{ ...pickedAsset, fileSize: 1 }] };
state.size = 50 * 1024 * 1024;
assert.equal((await selectChatImages(9))[0].fileSize, state.size, '允许恰好 50MB 的原图');
state.size += 1;
await assert.rejects(selectChatImages(9), /图片不能超过 50MB/);

state.size = 346230;
state.error = new Error('所选文件授权失败');
const before = state.selections.length;
await assert.rejects(selectChatImages(9), (error) => error === state.error);
assert.equal(state.selections.length, before + 1, '外部失败不得重试选择器');
state.error = null;
state.fileError = new Error('缓存文件读取失败');
await assert.rejects(selectChatImages(9), (error) => error === state.fileError);
state.fileError = null;

const documentAsset = { uri: cacheUri, name: 'photo.JPG', mimeType: 'application/octet-stream', size: 1 };
state.document = { canceled: false, assets: [documentAsset] };
state.size = 50 * 1024 * 1024;
assert.equal((await selectChatDocument()).type, 'image', '文件通道根据图片后缀使用图片限额');
assert.equal((await selectChatDocument()).fileSize, state.size, '不相信提供器报告的大小');
state.document.assets = [{ ...documentAsset, name: 'unnamed', mimeType: 'image/webp' }];
assert.equal((await selectChatDocument()).type, 'image', '没有图片后缀时仍按 MIME 识别图片');
state.size += 1;
await assert.rejects(selectChatDocument(), /图片不能超过 50MB/);
state.document.assets = [{ ...documentAsset, name: 'notes.txt', mimeType: 'text/plain' }];
state.size = 15 * 1024 * 1024;
assert.equal((await selectChatDocument()).type, 'file');
state.size += 1;
await assert.rejects(selectChatDocument(), /文件不能超过 15MB/, '普通文件仍保持原有限额');
state.document = { canceled: true, assets: null };
assert.equal(await selectChatDocument(), null);

state.result = { canceled: false, assets: [pickedAsset] };
state.size = 50 * 1024 * 1024;
assert.equal((await captureChatPhoto()).fileSize, state.size);
state.size += 1;
await assert.rejects(captureChatPhoto(), /图片不能超过 50MB/);
state.result = { canceled: true, assets: null };
assert.equal(await captureChatPhoto(), null);
state.cameraGranted = false;
await assert.rejects(captureChatPhoto(), /未获得相机权限/);
console.log('聊天三个选图入口回归通过：原图配置、真实大小、50MB 图片、15MB 文件、取消与外部错误；原生显示仍需真机验证');
