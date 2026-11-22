/** 验证无关刷新不重新投影历史，真实消息、到达进度和 transient 更新仍及时显示。 */
import assert from 'node:assert/strict';
import { loadTypeScriptModule as load } from '../../helpers/load-typescript-module.mjs';

let cursor = 0;
const slots = [];
const react = {
  useMemo(factory, deps) {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
      slots[index] = { deps, value: factory() };
    }
    return slots[index].value;
  },
  useCallback: (callback, deps) => react.useMemo(() => callback, deps),
  useEffect() {},
  useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
};
const identity = load('src/features/chat/messages/domain/AgentTimelineIdentity.ts');
const timeline = load('src/features/chat/messages/application/AgentTransientTimeline.ts', {
  '../domain/AgentTimelineIdentity': identity,
});
const arrival = load('src/features/chat/reply/delivery/AssistantMessageArrival.ts', {
  '@shared/runtime/RuntimeSlot': load('src/shared/runtime/RuntimeSlot.ts'),
});
const transientHook = load('src/features/chat/presentation/messages/components/useAgentTransientTimeline.ts', {
  react,
  '@features/chat/messages/domain/ChatTimelineOrdering': load('src/features/chat/messages/domain/ChatTimelineOrdering.ts'),
  '@features/chat/messages/application/AgentTransientTimeline': timeline,
  '../../../reply/delivery/AssistantMessageArrival': arrival,
});
function render(sessionId, messages) {
  cursor = 0;
  const complete = transientHook.useAgentTransientTimeline(sessionId, messages);
  return {
    complete,
    visible: complete.messages,
  };
}
const messages = [{ id: 1, text: '已有消息', createdAt: '2026-10-05T08:00:00Z' }];
let result = render('session-a', messages);
const repeated = render('session-a', messages);
assert.equal(repeated.complete.messages, result.complete.messages, '无关刷新保持合并后的 timeline');
assert.equal(repeated.visible, result.visible, '无关刷新保持可见列表，不触发全量下游投影');

arrival.applyAssistantMessageArrivalSnapshot({ revision: 1, pendingMessageIds: [1], pendingSessionIds: ['session-a'] });
result = render('session-a', messages);
assert.equal(result.visible.length, 0, '到达进度变化立即隐藏待到达消息');
arrival.applyAssistantMessageArrivalSnapshot({ revision: 2, pendingMessageIds: [], pendingSessionIds: [] });
result = render('session-a', messages);
assert.equal(result.visible[0], messages[0], '到达后立即恢复显示');

const snapshot = {
  runId: 'run-a', sequence: 1, stepIndex: 1, kind: 'assistant', status: 'streaming',
  text: '新回复', clientMessageId: 'agent-timeline:run-a:1:0',
  createdAt: '2026-10-05T08:00:01Z', time: '16:00',
};
timeline.applyAgentTransientTimelineSnapshots({ sessionId: 'session-a', snapshots: [snapshot] });
result = render('session-a', messages);
assert.equal(result.visible.at(-1).text, '新回复', 'store revision 更新立即显示 transient');
assert.ok(result.complete.liveRunIds.has('run-a'));
assert.equal(render('session-a', messages).visible, result.visible, '活跃 run 也不因无关刷新重建');
timeline.applyAgentTransientTimelineSnapshots({ sessionId: 'session-a', snapshots: [{ ...snapshot, text: '回复继续' }] });
assert.equal(render('session-a', messages).visible.at(-1).text, '回复继续', '流式更新不能被缓存吞掉');
arrival.applyAssistantMessageArrivalSnapshot({ revision: 3, pendingMessageIds: [1], pendingSessionIds: ['session-a'] });
assert.equal(render('session-a', messages).visible.length, 1, '待到达的持久消息不影响已交付运行片段');
arrival.applyAssistantMessageArrivalSnapshot({ revision: 4, pendingMessageIds: [], pendingSessionIds: [] });

const olderPage = [{ id: 0, text: '更早消息', createdAt: '2026-10-05T07:59:00Z' }, ...messages];
assert.equal(render('session-a', olderPage).visible[0].text, '更早消息', '历史分页更新立即生效');
result = render('session-b', messages);
assert.equal(result.visible.length, 1, '切换会话不沿用旧 transient');
assert.equal(result.complete.liveRunIds.size, 0);
assert.equal(render('session-b', messages).visible, result.visible, '切换会话后无关刷新也保持稳定');
console.log('chat timeline render stability verification passed');
