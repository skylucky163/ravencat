/** 验证无交互自动裁剪：居中裁剪矩形与比例、小图不放大、动态图单帧信息、失败清理与产物所有权。 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { loadTypeScriptModule as load } from './helpers/load-typescript-module.mjs';

// ---- 边界假实现：文件系统、尺寸读取、原生裁剪 ----
const files = new Map(); // uri -> Uint8Array
const dimensions = new Map(); // uri -> { width, height }
const deleted = [];
class FakeFile {
  constructor(uri) { this.uri = uri; }
  get exists() { return files.has(this.uri); }
  get size() { return files.get(this.uri)?.length ?? 0; }
  async bytes() {
    const bytes = files.get(this.uri);
    if (!bytes) throw new Error(`文件不存在：${this.uri}`);
    return bytes;
  }
  async base64() { return Buffer.from(await this.bytes()).toString('base64'); }
  delete() { files.delete(this.uri); deleted.push(this.uri); }
}
const fakeFileSystem = { File: FakeFile };
const fakeReactNative = {
  Image: {
    getSize: (uri) => new Promise((resolve, reject) => {
      const size = dimensions.get(uri);
      if (!size || !files.has(uri)) reject(new Error(`无法读取尺寸：${uri}`));
      else resolve(size);
    }),
  },
};

const JPEG = Uint8Array.from([255, 216, 255, 0, 0]);
const PNG = new Uint8Array(33);
PNG.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0, 0, 0, 0, 0]);
function seed(uri, bytes, width, height) {
  const encoded = Uint8Array.from(bytes);
  if (encoded[0] === 137) {
    const header = new DataView(encoded.buffer);
    header.setUint32(16, width); header.setUint32(20, height);
  }
  files.set(uri, encoded);
  dimensions.set(uri, { width, height });
}

// 原生裁剪假实现：记录 crop 矩形，按 crop 后的尺寸产出临时文件。
let manipulatorBehavior = {};
const crops = [];
const saves = [];
let tempCounter = 0;
let renderCalls = 0;
const fakeManipulator = {
  SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
  ImageManipulator: {
    manipulate: (uri) => {
      const actions = [];
      return {
        crop: (rect) => { actions.push(rect); crops.push({ uri, rect }); },
        renderAsync: async () => {
          renderCalls += 1;
          if (manipulatorBehavior.renderThrows?.(renderCalls)) throw new Error('原生渲染失败');
          const source = dimensions.get(uri);
          const rect = actions.at(-1) ?? { originX: 0, originY: 0, width: source.width, height: source.height };
          return {
            saveAsync: async ({ format }) => {
              if (manipulatorBehavior.saveThrows) throw new Error('原生保存失败');
              const output = `file:///cache/crop-${++tempCounter}.${format}`;
              files.set(output, Uint8Array.from([1, 2, 3]));
              dimensions.set(output, { width: rect.width, height: rect.height });
              saves.push({ uri, format, output });
              return { uri: output, width: rect.width, height: rect.height };
            },
          };
        },
      };
    },
  },
};

// ---- 加载真实模块，边界替换为假实现 ----
const imageAnimation = load('src/platform/device/ImageAnimation.ts', { 'expo-file-system': fakeFileSystem });
const inspect = load('src/platform/device/InspectLocalImage.ts', {
  'expo-file-system': fakeFileSystem,
  'react-native': fakeReactNative,
  './ImageAnimation': imageAnimation,
});
const prepareVision = load('src/platform/device/PrepareVisionImage.ts', {
  'expo-file-system': fakeFileSystem,
  './InspectLocalImage': inspect,
  'expo-image-manipulator': fakeManipulator,
});
const { cropImageToAspect } = load('src/platform/device/CropImageToAspect.ts', {
  './InspectLocalImage': inspect,
  './PrepareVisionImage': prepareVision,
  'expo-image-manipulator': fakeManipulator,
});

// ---- 横图裁竖图：2000x1000 → 3:4，居中裁两侧 ----
seed('file:///wide.jpg', JPEG, 2000, 1000);
let result = await cropImageToAspect({ sourceUri: 'file:///wide.jpg', aspect: [3, 4] });
assert.deepEqual(crops.at(-1).rect, { originX: 625, originY: 0, width: 750, height: 1000 });
assert.deepEqual(saves.at(-1).format, 'jpeg', 'JPEG 源保持 JPEG 输出');
assert.deepEqual(result, {
  uri: saves.at(-1).output, width: 750, height: 1000,
  mimeType: 'image/jpeg', isAnimated: false, sourceWasAnimated: false,
});
assert.ok(files.has(result.uri), '成功产物保留，交由调用方清理');
assert.ok(files.has('file:///wide.jpg'), '原图不改动');

// ---- 竖图裁横图：1000x2000 → 4:3，居中裁上下 ----
seed('file:///tall.png', PNG, 1000, 2000);
result = await cropImageToAspect({ sourceUri: 'file:///tall.png', aspect: [4, 3] });
assert.deepEqual(crops.at(-1).rect, { originX: 0, originY: 625, width: 1000, height: 750 });
assert.equal(result.mimeType, 'image/png');

// ---- 同宽高比：800x450 → 16:9，不执行 crop 动作，仅重编码出临时文件 ----
seed('file:///same.webp', WEBP, 800, 450);
const cropCount = crops.length;
result = await cropImageToAspect({ sourceUri: 'file:///same.webp', aspect: [16, 9] });
assert.equal(crops.length, cropCount, '比例已匹配时不下发 crop 动作');
assert.deepEqual([result.width, result.height], [800, 450]);
assert.equal(result.mimeType, 'image/webp', '静态 WebP 保持 WebP 输出');
assert.notEqual(result.uri, 'file:///same.webp', '产物是独立临时文件，不覆盖原图');

// ---- 小图裁大比例：100x100 → 16:9，只缩小不放大 ----
seed('file:///small.jpg', JPEG, 100, 100);
result = await cropImageToAspect({ sourceUri: 'file:///small.jpg', aspect: [16, 9] });
assert.deepEqual(crops.at(-1).rect, { originX: 0, originY: 22, width: 100, height: 56 });
assert.ok(result.width <= 100 && result.height <= 100, '小图不被放大');

// ---- 动态图：沿用静态帧契约，明确返回单帧信息；帧中间产物被清理 ----
seed('file:///animated.gif', GIF, 400, 400);
const beforeCrop = saves.length;
result = await cropImageToAspect({ sourceUri: 'file:///animated.gif', aspect: [1, 2] });
const frameSave = saves[beforeCrop]; // 静态帧 PNG
assert.equal(frameSave.format, 'png', '动态图先渲染为 PNG 静态帧');
assert.deepEqual(crops.at(-1), { uri: frameSave.output, rect: { originX: 100, originY: 0, width: 200, height: 400 } },
  '裁剪作用于静态帧而非原动态图');
assert.equal(result.mimeType, 'image/png');
assert.equal(result.isAnimated, false);
assert.equal(result.sourceWasAnimated, true, '明确告知来源是动态图');
assert.ok(deleted.includes(frameSave.output), '静态帧中间产物由函数清理');
assert.ok(files.has(result.uri), '成功产物保留给调用方');
assert.ok(files.has('file:///animated.gif'), '动态原图不改动');

// ---- 失败清理：动态图渲染失败时，静态帧中间产物仍被清理，错误包装为图片读取错误 ----
seed('file:///broken.gif', GIF, 300, 200);
// 第一次渲染（静态帧）成功，第二次渲染（裁剪帧）失败。
const renderBase = renderCalls;
manipulatorBehavior = { renderThrows: (call) => call === renderBase + 2 };
const beforeFailure = saves.length;
await assert.rejects(
  cropImageToAspect({ sourceUri: 'file:///broken.gif', aspect: [1, 1] }),
  (error) => error.name === 'ImageFileReadError',
);
const framePngs = saves.slice(beforeFailure).map((entry) => entry.output);
assert.ok(framePngs.length > 0 && framePngs.every((uri) => deleted.includes(uri)),
  '失败时清理了已产出的静态帧');
assert.ok(framePngs.every((uri) => !files.has(uri)), '失败后无本函数遗留的中间产物');

// ---- 静态图保存失败：不产出新文件，错误包装传播 ----
seed('file:///savefail.jpg', JPEG, 640, 480);
manipulatorBehavior = { saveThrows: true, renderThrows: () => false };
const cacheBefore = [...files.keys()].filter((uri) => uri.includes('/cache/crop-')).length;
await assert.rejects(
  cropImageToAspect({ sourceUri: 'file:///savefail.jpg', aspect: [4, 3] }),
  (error) => error.name === 'ImageFileReadError' && /裁剪失败/.test(error.message),
);
assert.equal([...files.keys()].filter((uri) => uri.includes('/cache/crop-')).length, cacheBefore,
  '保存失败不遗留输出文件');
manipulatorBehavior = {};

// ---- 输入边界：复用 inspectLocalImage 契约，不复制检查逻辑 ----
await assert.rejects(
  cropImageToAspect({ sourceUri: 'file:///missing.jpg', aspect: [1, 1] }),
  /找不到图片文件/,
);
seed('file:///oversize.jpg', JPEG, 9000, 100);
await assert.rejects(
  cropImageToAspect({ sourceUri: 'file:///oversize.jpg', aspect: [1, 1] }),
  /8192/,
);
await assert.rejects(
  cropImageToAspect({ sourceUri: 'file:///wide.jpg', aspect: [0, 1] }),
  /比例必须为正数/,
);
await assert.rejects(
  cropImageToAspect({ sourceUri: 'file:///wide.jpg', aspect: [Number.NaN, 1] }),
  /比例必须为正数/,
);

console.log('自动裁剪：横竖互换、同比例、小图不放大、动态图单帧、失败清理与输入边界验证通过。');
