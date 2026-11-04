/** 摘要新建与编辑路由。 */
import { Redirect, type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { ChatSummaryEditorRouteScreen } from '@features/chat';

export default function ChatSummaryEditorRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ aiId?: string | string[]; segmentId?: string | string[]; taskId?: string | string[]; view?: string | string[] }>();
  const aiId = Array.isArray(params.aiId) ? params.aiId[0] : params.aiId;
  const segmentId = Array.isArray(params.segmentId) ? params.segmentId[0] : params.segmentId;
  const taskId = Array.isArray(params.taskId) ? params.taskId[0] : params.taskId;
  const view = Array.isArray(params.view) ? params.view[0] : params.view;
  return aiId ? <ChatSummaryEditorRouteScreen key={aiId} aiId={aiId} onBack={() => router.back()} segmentId={segmentId} taskId={taskId} secondary={view === 'secondary'}
    onEditSecondary={() => router.push({ pathname: `/chat/${encodeURIComponent(aiId)}/summary/edit`, params: { view: 'secondary' } } as Href)}
    onSettings={() => router.push(`/chat/${encodeURIComponent(aiId)}/summary/settings` as Href)}
    onEditSource={(id) => router.push({ pathname: `/chat/${encodeURIComponent(aiId)}/summary/edit`, params: { segmentId: id } } as Href)} />
    : <Redirect href={'/conversations' as Href} />;
}
