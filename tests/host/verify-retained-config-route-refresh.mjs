import assert from 'node:assert/strict';
import {
  INITIAL_RETAINED_ROUTE_REFRESH_STATE,
  reduceRetainedRouteFocus,
} from '../../src/host/navigation/retainedRouteRefreshContract.ts';
import { canCommitPresentationLoad } from '../../src/shared/utils/presentationLoadRevision.ts';

let state = INITIAL_RETAINED_ROUTE_REFRESH_STATE;
state = reduceRetainedRouteFocus(state);
assert.equal(state.revision, 0, '首次获得焦点不应重复触发初始加载');

state = reduceRetainedRouteFocus(state);
assert.equal(state.revision, 1, '父路由重新获得焦点时应触发一次静默刷新');

state = reduceRetainedRouteFocus(state);
assert.equal(state.revision, 2, '每次后续重新获得焦点都应推进刷新版本');

let presentationRows = ['旧配置'];
let latestLoadRevision = 1;
const initialLoadRevision = latestLoadRevision;
latestLoadRevision += 1;
const refocusLoadRevision = latestLoadRevision;

if (canCommitPresentationLoad(true, latestLoadRevision, refocusLoadRevision)) {
  presentationRows = ['新配置'];
}
if (canCommitPresentationLoad(true, latestLoadRevision, initialLoadRevision)) {
  presentationRows = ['旧配置'];
}
assert.deepEqual(presentationRows, ['新配置'], '旧请求晚返回时不得覆盖 refocus 读取的新配置');
assert.equal(
  canCommitPresentationLoad(false, latestLoadRevision, refocusLoadRevision),
  false,
  '页面卸载后不得提交异步读取结果',
);

console.log('Retained configuration route refresh contract verified.');
