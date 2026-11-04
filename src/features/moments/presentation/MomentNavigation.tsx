/** 朋友圈页面只表达打开原帖、AI 主页和分享的意图，路由与跨 Feature 装配由宿主持有。 */
import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
interface Navigation { openMoment(momentId: string): void; shareMoment(momentId: string): void; openAssistantProfile(assistantId: string): void }
const Context = createContext<Navigation | null>(null);
export function MomentNavigationProvider({ children, openMoment, shareMoment, openAssistantProfile }: Navigation & { children: ReactNode }) {
  const navigation = useMemo(() => ({ openMoment, shareMoment, openAssistantProfile }), [openMoment, shareMoment, openAssistantProfile]);
  return <Context.Provider value={navigation}>{children}</Context.Provider>;
}
export function useMomentNavigation() {
  const navigation = useContext(Context);
  if (!navigation) throw new Error('MomentNavigationProvider 未装配');
  return navigation;
}
