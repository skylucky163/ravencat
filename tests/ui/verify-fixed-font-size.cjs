/** 验证真实 RN 文本入口输出的原生缩放属性，覆盖普通文字、可点击文字与输入框。 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { transformFileSync } = require('@babel/core');
const React = require('react');
const { create, act } = require('react-test-renderer');

const ancestor = React.createContext(false);
const styleSheet = { create: (styles) => styles };
const platform = { OS: 'android', select: (values) => values.android ?? values.default };
const flattenStyle = (style) => Array.isArray(style) ? Object.assign({}, ...style) : style;
const noop = () => {};

/** 向上查找 package.json 定位仓库根；脚本搬家后不再依赖自身层级。 */
function findRepoRoot(start) {
  let current = start;
  for (;;) {
    if (require('node:fs').existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`未找到仓库根 package.json：${start}`);
    current = parent;
  }
}
const repoRoot = findRepoRoot(__dirname);

function loadNativeComponent(relativeFile) {
  const filename = path.join(repoRoot, 'node_modules/react-native', relativeFile);
  const { code } = transformFileSync(filename, {
    babelrc: false,
    configFile: false,
    presets: ['babel-preset-expo'],
    caller: { name: 'metro', platform: 'android', supportsStaticESM: false },
  });
  const module = { exports: {} };
  const requireMock = (specifier) => {
    if (specifier === 'react' || specifier.startsWith('react/') ||
        specifier.startsWith('@babel/') || specifier === 'invariant' || specifier === 'nullthrows') {
      return require(specifier);
    }
    switch (path.basename(specifier)) {
      case 'Platform': return platform;
      case 'StyleSheet': return styleSheet;
      case 'flattenStyle': return flattenStyle;
      case 'processColor': return (color) => color;
      case 'TextAncestorContext': return ancestor;
      case 'TextNativeComponent': return { NativeText: 'NativeText', NativeVirtualText: 'NativeVirtualText' };
      case 'PressabilityDebug': return { isEnabled: () => false };
      case 'usePressability': return () => ({});
      case 'useMergeRefs': return noop;
      case 'TextInputState': return { currentlyFocusedInput: noop, currentlyFocusedField: noop,
        focusTextInput: noop, blurTextInput: noop };
      case 'AndroidTextInputNativeComponent': return { default: 'NativeTextInput', Commands: {} };
      case 'Text': return () => null;
      default: throw new Error(`未预期的 RN 文本依赖：${specifier}`);
    }
  };
  new Function('require', 'module', 'exports', '__DEV__', code)(requireMock, module, module.exports, false);
  return module.exports.default;
}

async function main() {
  const Text = loadNativeComponent('Libraries/Text/Text.js');
  const TextInput = loadNativeComponent('Libraries/Components/TextInput/TextInput.js');
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  for (const allowFontScaling of [undefined, true, false]) {
    for (const onPress of [undefined, noop]) {
      let renderer;
      const style = { fontSize: 16, lineHeight: 30 };
      await act(async () => {
        renderer = create(React.createElement(Text, { allowFontScaling, onPress, style }, '枫渡'));
      });
      const native = renderer.root.findByType('NativeText');
      assert.equal(native.props.allowFontScaling, false, '所有 RN 文字均应禁用系统字体缩放');
      assert.deepEqual(native.props.style, style, '保留设计字号与行高');
      await act(async () => renderer.unmount());
    }
    const input = TextInput({ allowFontScaling, multiline: true, value: '枫渡',
      style: { fontSize: 16 }, placeholder: '输入消息' });
    assert.equal(input.props.allowFontScaling, false, '输入框须使用同一固定字号策略');
    assert.equal(input.props.value, '枫渡');
    assert.equal(input.props.multiline, true);
    assert.deepEqual(input.props.style, { fontSize: 16 });
  }
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  console.log('固定字号验证通过：普通文字、可点击文字和输入框均禁用系统缩放。');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
