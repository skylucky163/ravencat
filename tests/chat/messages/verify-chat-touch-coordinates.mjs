/** 使用真实 RN Pressability 验证滚动坐标错位造成的偶发短按与长按失效。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transformSync } from '@babel/core';
import { createRequire } from 'node:module';

const requireFromRepo = createRequire(import.meta.url);
const pressabilitySource = fs.readFileSync(requireFromRepo.resolve('react-native/Libraries/Pressability/Pressability.js'), 'utf8');
const pressabilityCode = transformSync(pressabilitySource, {
  filename: 'Pressability.js', configFile: false, babelrc: false,
  presets: ['module:@react-native/babel-preset'],
}).code;

function runPress(measuredY, move, hold) {
  const timers = new Map();
  let timerId = 0;
  const boundaries = {
    '../Components/Sound/SoundManager': { playTouchSound() {} },
    '../ReactNative/ReactNativeFeatureFlags': { shouldPressibilityUseW3CPointerEventsForHover: () => false },
    '../ReactNative/UIManager': {},
    '../StyleSheet/Rect': { normalizeRect: value => value },
    '../Utilities/Platform': { OS: 'android' },
    './HoverState': { isHoverEnabled: () => false },
    './PressabilityPerformanceEventEmitter.js': { emitEvent() {} },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', '__DEV__', pressabilityCode)(
    id => Object.hasOwn(boundaries, id) ? boundaries[id] : requireFromRepo(id), module, module.exports,
    callback => { timers.set(++timerId, callback); return timerId; }, id => timers.delete(id), false,
  );
  const calls = [];
  const pressability = new module.exports.default({
    minPressDuration: 0, delayLongPress: 350,
    onPress: () => calls.push('press'), onLongPress: () => calls.push('longPress'),
  });
  const host = { measure: callback => callback(0, 0, 170, 23.333, 70, measuredY) };
  const touchPoint = { pageX: 177, pageY: 703, timestamp: 1000 };
  const pressEvent = { persist() {}, currentTarget: host, nativeEvent: { ...touchPoint, touches: [touchPoint], changedTouches: [touchPoint] } };
  const handlers = pressability.getEventHandlers();
  handlers.onResponderGrant(pressEvent);
  if (move) handlers.onResponderMove(pressEvent);
  if (hold) for (const callback of [...timers.values()]) callback();
  handlers.onResponderRelease(pressEvent);
  pressability.reset();
  return calls;
}

assert.deepEqual(runPress(3275, false, false), ['press'], '没有 MOVE 时，错位测量仍可能短按成功');
assert.deepEqual(runPress(3275, true, false), [], '测量错位时，即使触点完全未移动，MOVE 也会取消短按');
assert.deepEqual(runPress(3275, true, true), [], '同一测量错位也会取消长按');
assert.deepEqual(runPress(693.667, true, false), ['press'], '扣除滚动偏移后，微小移动不取消有效短按');
assert.deepEqual(runPress(693.667, true, true), ['longPress'], '正确坐标下长按可达，且释放后不会再触发短按');
console.log('Chat touch coordinates verification passed.');
