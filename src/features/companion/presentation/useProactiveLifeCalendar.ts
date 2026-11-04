/** 日期切换拥有读取代次；迟到的查询不能覆盖新日期，也不能把旧分页追加到新窗口。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadCompanionProductState } from '../application/CompanionSettingsFacade';
import { listProactiveLifeDay, loadProactiveLifeCalendar } from '../application/ProactiveLifeReadQueries';
import type { ProactiveLifeCalendarCursor, ProactiveLifeCalendarItem, ProactiveLifeDayCount } from '../application/ProactiveLifeReadQueries';
import { calendarDayRange, calendarWindow } from './proactiveLifeCalendar';

interface CalendarSnapshot {
  day: number;
  ownerAIId: string | null;
  enabled: boolean;
  counts: ProactiveLifeDayCount[];
  items: ProactiveLifeCalendarItem[];
  cursor: ProactiveLifeCalendarCursor | null;
}

export default function useProactiveLifeCalendar(day: number, active: boolean) {
  const [snapshot, setSnapshot] = useState<CalendarSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const moreInFlight = useRef(false);
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    const current = ++generation.current;
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setLoadingMore(false);
    moreInFlight.current = false;
    setError(null);
    void (async () => {
      try {
        const product = await loadCompanionProductState();
        const ownerAIId = product.hostAI?.id ?? null;
        const result = ownerAIId ? await loadProactiveLifeCalendar({ ownerAIId, now: new Date().toISOString(), day: calendarDayRange(day), days: calendarWindow(day), limit: 25 }) : null;
        if (!cancelled && generation.current === current) {
          setSnapshot({ day, ownerAIId, enabled: product.state.desiredEnabled, counts: result?.counts ?? [], items: result?.page.items ?? [], cursor: result?.page.nextCursor ?? null });
        }
      } catch (failure) {
        if (!cancelled && generation.current === current) setError(failure instanceof Error ? failure.message : '无法读取当天日程。');
      } finally {
        if (!cancelled && generation.current === current) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [day, active, revision]);

  const runningCount = snapshot?.counts.reduce((total, entry) => total + entry.runningCount, 0) ?? 0;
  useEffect(() => {
    if (!active || runningCount === 0) return;
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [active, runningCount, refresh]);

  const loadMore = useCallback(async () => {
    if (!active || loading || moreInFlight.current || snapshot?.day !== day || !snapshot.ownerAIId || !snapshot.cursor) return;
    const current = generation.current;
    moreInFlight.current = true;
    setLoadingMore(true);
    try {
      const page = await listProactiveLifeDay({ ownerAIId: snapshot.ownerAIId, now: new Date().toISOString(), day: calendarDayRange(day), after: snapshot.cursor, limit: 25 });
      if (generation.current !== current) return;
      const items = new Map(snapshot.items.map(item => [item.item.sourceId, item]));
      page.items.forEach(item => items.set(item.item.sourceId, item));
      setSnapshot({ ...snapshot, items: [...items.values()], cursor: page.nextCursor });
    } catch (failure) {
      if (generation.current === current) setError(failure instanceof Error ? failure.message : '无法读取更多日程。');
    } finally {
      if (generation.current === current) { moreInFlight.current = false; setLoadingMore(false); }
    }
  }, [active, day, loading, snapshot]);

  return { snapshot: snapshot?.day === day ? snapshot : null, counts: snapshot?.counts ?? [], loading, loadingMore, error, refresh, loadMore };
}
