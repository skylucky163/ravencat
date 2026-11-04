/**
 * @fileoverview 历史记账的时间范围与日期展示工具
 *
 * 时间范围的字段、顺序与标签在这里生成；卡片与详情只消费。
 */

import type { ViewType, TimeRange, DayInfo, WeekInfo, MonthInfo } from '../historyTypes';

/**
 * 生成时间范围唯一 key
 */
export function getTimeRangeKey(range: Pick<TimeRange, 'startDate' | 'endDate'>): string {
  return `${range.startDate}_${range.endDate}`;
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 从今天向前展开到 cursor 所在周期，最新的在前。
 * 分页时用更早的 cursor 重新展开，尚未加载的尾部就是新一页，不必另写一套切分。
 */
export function buildHistoryRanges(view: ViewType, cursor: Date): TimeRange[] {
  switch (view) {
    case 'week': {
      const ranges: DayInfo[] = [];
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const target = new Date(cursor);
      target.setHours(0, 0, 0, 0);

      let weekCursor = new Date(today);
      while (getMonday(weekCursor).getTime() >= getMonday(target).getTime()) {
        ranges.push(...getWeekDays(weekCursor));
        weekCursor = addDays(getMonday(weekCursor), -1);
        weekCursor.setHours(0, 0, 0, 0);
      }

      return ranges;
    }
    case 'month': {
      const ranges: WeekInfo[] = [];
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const target = new Date(cursor);
      target.setHours(0, 0, 0, 0);

      let monthCursor = new Date(today.getFullYear(), today.getMonth(), 1);
      const targetMonthStart = new Date(target.getFullYear(), target.getMonth(), 1);

      while (monthCursor.getTime() >= targetMonthStart.getTime()) {
        ranges.push(...getMonthWeeks(monthCursor.getFullYear(), monthCursor.getMonth() + 1));
        monthCursor = addMonths(monthCursor, -1);
        monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
      }

      return ranges;
    }
    case 'year':
      return getYearMonths(cursor.getFullYear());
  }
}

/** 游标向前移动一个周期；单位必须与 buildHistoryRanges 的展开单位一致。 */
export function previousHistoryCursor(view: ViewType, cursor: Date): Date {
  switch (view) {
    case 'week': {
      const previousSunday = addDays(getMonday(cursor), -1);
      previousSunday.setHours(0, 0, 0, 0);
      return previousSunday;
    }
    case 'month':
      return new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1);
    case 'year':
      return addYears(cursor, -1);
  }
}

/** 卡片的标题与副标题由范围类型决定；日卡在“今天”时不重复显示“今天”。 */
export function describeHistoryRange(
  range: TimeRange,
  view: ViewType
): { title: string; subtitle: string } {
  switch (view) {
    case 'week': {
      const day = range as DayInfo;
      if (!day.isToday) return { title: day.weekday, subtitle: day.label };
      const weekday = WEEKDAY_NAMES[new Date(day.startDate).getDay()];
      return { title: `${weekday} (今天)`, subtitle: day.label };
    }
    case 'month': {
      const week = range as WeekInfo;
      return { title: `第${week.weekNum}周`, subtitle: week.label };
    }
    case 'year': {
      const month = range as MonthInfo;
      return {
        title: month.monthName,
        subtitle: month.isYearSummary ? '全年' : `${month.year}年`,
      };
    }
  }
}

/**
 * 格式化日期为 YYYY-MM-DD
 */
export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 账单行内的短日期，如 10/9。 */
export function formatMonthDay(dateStr: string): string {
  const date = new Date(dateStr);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/**
 * 获取相对星期描述
 * @param date 目标日期
 * @param baseDate 基准日期（默认今天）
 * @returns '今天', '昨天', '周一' 等
 */
export function getWeekdayLabel(date: Date, baseDate: Date = new Date()): string {
  const base = new Date(baseDate);
  base.setHours(0, 0, 0, 0);
  
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  
  const diffDays = Math.floor((base.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays === 2) return '前天';
  
  return WEEKDAY_NAMES[target.getDay()];
}

/**
 * 获取本周已过去的天数（从今天到周一），倒序排列
 * @param date 基准日期（默认今天）
 * @returns DayInfo[] 从今天到本周一的倒序数组
 */
export function getWeekDays(date: Date = new Date()): DayInfo[] {
  const result: DayInfo[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const base = new Date(date);
  base.setHours(0, 0, 0, 0);
  
  // 使用今天作为结束点（不超过基准日期所在的那一天）
  const endDate = base < today ? base : today;
  const dayOfWeek = endDate.getDay(); // 0=周日, 1=周一...
  
  // 计算本周一
  const monday = new Date(endDate);
  monday.setDate(endDate.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  
  // 从今天倒序到周一
  for (let i = 0; i < 7; i++) {
    const current = new Date(endDate);
    current.setDate(endDate.getDate() - i);
    
    // 如果已经早于周一，停止
    if (current < monday) {
      break;
    }
    
    const isToday = current.getTime() === today.getTime();
    
    result.push({
      startDate: formatDate(current),
      endDate: formatDate(current),
      label: `${current.getMonth() + 1}月${current.getDate()}日`,
      year: current.getFullYear(),
      month: current.getMonth() + 1,
      weekday: getWeekdayLabel(current),
      isToday,
    });
  }
  
  return result;
}

/**
 * 获取指定年月的周列表（倒序，只显示到当前周）
 * @param year 年份
 * @param month 月份（1-12）
 * @returns WeekInfo[] 从当前周到本月第一周的倒序数组，weekNum 表示这是本月第几周
 */
export function getMonthWeeks(year: number, month: number): WeekInfo[] {
  const result: WeekInfo[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  // 获取该月第一天和最后一天
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  
  // 判断是否为当前月份
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month - 1;
  
  // 结束日期：如果是当前月，用今天；否则用该月最后一天
  const visibleEnd = isCurrentMonth ? today : lastDay;
  
  // 先计算该月的所有周（正序），以便正确计算周数
  const firstDayOfWeek = firstDay.getDay();
  const firstMonday = new Date(firstDay);
  if (firstDayOfWeek !== 1) {
    const daysToSubtract = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1;
    firstMonday.setDate(firstDay.getDate() - daysToSubtract);
  }
  
  // 生成该月所有周的正序列表（从第一周到包含 visibleEnd 的那一周）
  const allWeeks: {
    weekStart: Date;
    weekEnd: Date;
    actualStart: Date;
    actualEnd: Date;
    weekIndex: number;
  }[] = [];
  
  let currentWeekStart = new Date(firstMonday);
  let weekIndex = 1;
  
  while (currentWeekStart <= visibleEnd) {
    const weekEnd = new Date(currentWeekStart);
    weekEnd.setDate(currentWeekStart.getDate() + 6);
    
    // 月视图的第一周允许从“本月1日所在周的周一”开始，
    // 因此起点不裁切到本月1日；但末周不能超过本月最后一天/今天。
    const actualStart = new Date(currentWeekStart);
    const actualEnd = weekEnd > visibleEnd ? visibleEnd : weekEnd;
    
    allWeeks.push({
      weekStart: new Date(currentWeekStart),
      weekEnd: new Date(weekEnd),
      actualStart: new Date(actualStart),
      actualEnd: new Date(actualEnd),
      weekIndex,
    });
    
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    weekIndex++;
  }
  
  // 倒序生成结果（最新的周在前面）
  for (let i = allWeeks.length - 1; i >= 0; i--) {
    const week = allWeeks[i];
    const startMonth = week.actualStart.getMonth() + 1;
    const startDate = week.actualStart.getDate();
    const endMonth = week.actualEnd.getMonth() + 1;
    const endDateNum = week.actualEnd.getDate();
    
    let label: string;
    if (startMonth === endMonth) {
      label = `${startMonth}月${startDate}日-${endDateNum}日`;
    } else {
      label = `${startMonth}月${startDate}日-${endMonth}月${endDateNum}日`;
    }
    
    result.push({
      startDate: formatDate(week.actualStart),
      endDate: formatDate(week.actualEnd),
      label,
      year,
      month,
      weekNum: week.weekIndex, // 这是本月第几周
    });
  }
  
  return result;
}

/**
 * 获取年视图列表：
 * - 今年：按月份倒序显示到当前月
 * - 往年：按整年汇总显示（逐年倒序）
 * @param year 游标年份；用于决定要额外显示到哪一个往年
 */
export function getYearMonths(year: number): MonthInfo[] {
  const result: MonthInfo[] = [];
  const today = new Date();
  const currentYear = today.getFullYear();
  
  // 今年始终按月份展示，只显示到当前月
  const endMonth = today.getMonth() + 1;
  
  // 从当前月倒序到1月
  for (let month = endMonth; month >= 1; month--) {
    const firstDay = new Date(currentYear, month - 1, 1);
    const lastDay = new Date(currentYear, month, 0);
    
    // 当前月结束日期设为今天
    const actualEndDate = month === endMonth
      ? today
      : lastDay;
    
    result.push({
      startDate: formatDate(firstDay),
      endDate: formatDate(actualEndDate),
      label: `${month}月`,
      year: currentYear,
      month,
      monthName: `${month}月`,
      isYearSummary: false,
    });
  }

  // 往年按整年汇总显示，直到游标年份。
  // 当游标仍在今年时，不额外显示往年；向后翻一年后，才出现上一年的整年汇总。
  if (year < currentYear) {
    for (let pastYear = currentYear - 1; pastYear >= year; pastYear--) {
      const firstDay = new Date(pastYear, 0, 1);
      const lastDay = new Date(pastYear, 11, 31);

      result.push({
        startDate: formatDate(firstDay),
        endDate: formatDate(lastDay),
        label: `${pastYear}年`,
        year: pastYear,
        month: 0,
        monthName: `${pastYear}年`,
        isYearSummary: true,
      });
    }
  }
  
  return result;
}

/**
 * 计算日期加减
 * @param date 基准日期
 * @param days 天数（正数为未来，负数为过去）
 * @returns 新日期
 */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * 计算月份加减
 * @param date 基准日期
 * @param months 月数
 * @returns 新日期
 */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const originalDay = result.getDate();

  // 先跳到目标月的1号，再回填日期，避免 3/30 -> 2/30 被 JS 自动滚到 3 月
  result.setDate(1);
  result.setMonth(result.getMonth() + months);

  const lastDayOfTargetMonth = new Date(
    result.getFullYear(),
    result.getMonth() + 1,
    0
  ).getDate();

  result.setDate(Math.min(originalDay, lastDayOfTargetMonth));
  return result;
}

/**
 * 计算年份加减
 * @param date 基准日期
 * @param years 年数
 * @returns 新日期
 */
export function addYears(date: Date, years: number): Date {
  const result = new Date(date);
  const originalMonth = result.getMonth();
  const originalDay = result.getDate();

  // 先定位到目标年的当月1号，再回填日期，避免闰年等导致的月份串位
  result.setDate(1);
  result.setFullYear(result.getFullYear() + years);
  result.setMonth(originalMonth);

  const lastDayOfTargetMonth = new Date(
    result.getFullYear(),
    result.getMonth() + 1,
    0
  ).getDate();

  result.setDate(Math.min(originalDay, lastDayOfTargetMonth));
  return result;
}

/**
 * 获取指定日期所在周的周一
 */
export function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}

