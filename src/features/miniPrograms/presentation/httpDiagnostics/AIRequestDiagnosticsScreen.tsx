import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { aiHttpDiagnostics, type AIHttpExchange } from '@platform/ai';
import { copyTextToClipboard, TextSelectionScrollView } from '@platform/device';
import { useTheme, ThemedSurface } from '@shared/theme';
import { Button, EmptyState, ListItem, ModalSheet, ToggleField, showAppDialog } from '@shared/ui';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { createHttpDiagnosticsStyles } from './AIRequestDiagnosticsScreen.styles';

type DiagnosticsSnapshot = Awaited<ReturnType<typeof aiHttpDiagnostics.getSnapshot>>;
type DiagnosticsStyles = ReturnType<typeof createHttpDiagnosticsStyles>;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTime(time: string): string {
  return new Date(time).toLocaleString();
}

function describeStatus(record: AIHttpExchange): string {
  return record.status === null ? '未收到 HTTP 状态' : `HTTP ${record.status}`;
}

// 说明性文字的唯一定义处：导航头的问号说明与开启确认弹窗都从这里取，避免同一条事实被写两遍后走样。
const DIAGNOSTICS_COPY = {
  retention: '最近 10 条记录持久保存在本机，超出后删除最旧记录；重启、覆盖更新或清理缓存不会删除记录。',
  content: '记录可能包含私密聊天、提示词和工具内容；不记录鉴权头，也不会自动上传。',
  sharing: '分享前请先检查正文中的个人信息。',
  activation: '只记录开启后发出的请求，不补录历史；关闭开关只停止新增，已有记录保留，手动清空或恢复出厂时删除。',
  scope: '只原样保存请求与响应，不分析也不修改内容。',
} as const;

const HELP_SECTIONS = [
  { title: '保留范围', body: DIAGNOSTICS_COPY.retention },
  { title: '内容与隐私', body: `${DIAGNOSTICS_COPY.content}${DIAGNOSTICS_COPY.sharing}` },
  { title: '何时生效', body: DIAGNOSTICS_COPY.activation },
  { title: '不做的事', body: DIAGNOSTICS_COPY.scope },
];

const BODY_PAGE_SIZE = 4000;

function bodyPageOffset(body: string, offset: number): number {
  // 页边界不能拆开 emoji 等字符的 UTF-16 代理对；只检查边界，不遍历整份正文。
  const previous = body.charCodeAt(offset - 1);
  const current = body.charCodeAt(offset);
  return previous >= 0xD800 && previous <= 0xDBFF && current >= 0xDC00 && current <= 0xDFFF
    ? offset - 1 : offset;
}

function HttpBodySection({ title, body, styles }: {
  title: string;
  body: string;
  styles: DiagnosticsStyles;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(body.length / BODY_PAGE_SIZE));
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return <View>
    <TouchableOpacity accessibilityRole="button" accessibilityState={{ expanded }}
      accessibilityLabel={`${title}，${expanded ? '收起' : '展开'}`}
      style={styles.bodyHeader} onPress={() => setExpanded(value => !value)}>
      <Text style={[styles.heading, styles.bodyTitle]}>{title}</Text>
      <Text style={styles.hint}>{expanded ? '收起' : '展开'}</Text>
      <Chevron size={20} color={theme.colors.text.secondary} />
    </TouchableOpacity>
    {expanded ? body.length === 0 ? <Text style={styles.hint}>（空正文）</Text> : <>
      {pageCount > 1 ? <View style={styles.bodyPagination}>
        <Text style={styles.hint}>第 {page + 1} / {pageCount} 页 · 仅分页显示，复制仍为完整正文</Text>
        <View style={styles.actions}>
          <Button title="上一页" variant="text" disabled={page === 0} onPress={() => setPage(page - 1)} />
          <Button title="下一页" variant="text" disabled={page === pageCount - 1} onPress={() => setPage(page + 1)} />
        </View>
      </View> : null}
      {/* 每次只向原生排版提交一页；换页重建滚动区，使阅读和选择回到页首。 */}
      <ScrollView key={page} nestedScrollEnabled style={styles.bodyScroll}>
        <Text selectable style={styles.raw}>{body.slice(
          bodyPageOffset(body, page * BODY_PAGE_SIZE),
          bodyPageOffset(body, Math.min(body.length, (page + 1) * BODY_PAGE_SIZE)),
        )}</Text>
      </ScrollView>
    </> : null}
  </View>;
}

/** 记录详情独立成弹窗，避免详情内容与页面上的开关、列表叠在同一文档流里。 */
function ExchangeDetail({ record, styles }: { record: AIHttpExchange; styles: DiagnosticsStyles }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const copy = (label: string, body: string) => showAppDialog({
    title: `复制${label}`,
    message: `将复制完整${label}，可能包含私密聊天及工具内容。请先检查正文，再决定是否向他人分享。`,
    buttons: [
      { text: '取消', style: 'cancel' },
      { text: `复制${label}`, onPress: () => {
        setCopied(null);
        setCopyError(null);
        try {
          copyTextToClipboard(body);
          setCopied(label);
        } catch (cause) {
          setCopyError(`复制失败：${describeError(cause)}`);
        }
      } },
    ],
  });

  return <>
    <ScrollView style={styles.detailScroll} contentContainerStyle={styles.detailContent}>
      <Text selectable style={styles.text}>ID：{record.id}{'\n'}模型：{record.model}{'\n'}传输：{record.transport}{'\n'}
        开始：{formatTime(record.startedAt)}{'\n'}结束：{formatTime(record.completedAt)}{'\n'}
        {record.method} {record.url}{'\n'}{describeStatus(record)}{'\n'}错误：{record.error ?? '无'}</Text>
      <HttpBodySection title="请求正文（原文）" body={record.requestBody} styles={styles} />
      <HttpBodySection title="响应正文（原文）" body={record.responseBody} styles={styles} />
    </ScrollView>
    <View style={styles.detailActions}>
      {/* 弹窗遮住页面顶部的错误区，复制结果必须在这一层反馈。 */}
      {copied ? <Text style={styles.hint}>已复制完整{copied}</Text> : null}
      {copyError ? <Text selectable accessibilityRole="alert" style={styles.error}>{copyError}</Text> : null}
      <Button title="复制请求正文" variant="secondary" onPress={() => copy('请求正文', record.requestBody)} />
      <Button title="复制响应正文" variant="secondary" onPress={() => copy('响应正文', record.responseBody)} />
    </View>
  </>;
}

export function AIRequestDiagnosticsScreen({ onBack }: { onBack(): void }) {
  const theme = useTheme();
  const styles = useMemo(() => createHttpDiagnosticsStyles(theme), [theme]);
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AIHttpExchange | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const refreshVersion = useRef(0);
  // 点按即转一圈：本地快照读取通常瞬间返回，用 loading 驱动循环动画反而看不见。
  const refreshSpin = useRef(new Animated.Value(0)).current;
  const refreshRotate = useMemo(
    () => refreshSpin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }),
    [refreshSpin],
  );

  // 记录变化触发的自动刷新不进入加载态，避免图标和开关跟着闪；只有首次和手动刷新才显示读取中。
  const refresh = useCallback(async (showLoading = true) => {
    const version = ++refreshVersion.current;
    if (showLoading) setLoading(true);
    try {
      const next = await aiHttpDiagnostics.getSnapshot();
      if (version !== refreshVersion.current) return;
      setSnapshot(next);
      setError(null);
    } catch (cause) {
      if (version === refreshVersion.current) setError(`读取失败：${describeError(cause)}`);
    } finally {
      // 收尾不区分来源：落后的那次请求被新请求取代时不能清标志，最新一次必须清，否则会卡在读取中。
      if (version === refreshVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = aiHttpDiagnostics.subscribe(() => { void refresh(false); });
    void refresh();
    return () => {
      unsubscribe();
      refreshVersion.current += 1;
    };
  }, [refresh]);

  const refreshFromButton = () => {
    refreshSpin.setValue(0);
    Animated.timing(refreshSpin, {
      toValue: 1, duration: 600, easing: Easing.linear, useNativeDriver: true,
    }).start();
    void refresh();
  };

  const run = async (operation: () => Promise<void>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      // 平台操作无论成败都会发出通知，快照由订阅统一刷新。
      await operation();
    } catch (cause) {
      setError(`${failure}：${describeError(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const setRecording = (enabled: boolean) => {
    const save = () => run(() => aiHttpDiagnostics.setEnabled(enabled), '保存记录开关失败');
    if (!enabled) { void save(); return; }
    showAppDialog({
      title: '开启 HTTP 记录',
      message: `${DIAGNOSTICS_COPY.content}\n${DIAGNOSTICS_COPY.sharing}`,
      buttons: [
        { text: '取消', style: 'cancel' },
        { text: '开启记录', onPress: save },
      ],
    });
  };

  const clear = () => showAppDialog({
    title: '清空 HTTP 记录',
    message: '删除本机保存的全部 HTTP 诊断记录，记录开关保持当前状态。',
    buttons: [
      { text: '取消', style: 'cancel' },
      { text: '清空', style: 'destructive', onPress: () => run(() => aiHttpDiagnostics.clear(), '清空记录失败') },
    ],
  });

  return <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
    <NavigationHeader title="AI 请求诊断" onGoBack={onBack} help={{ sections: HELP_SECTIONS }} />
    <TextSelectionScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      {snapshot ? <ThemedSurface variant="card" style={styles.card}>
        <ToggleField label="记录后续 AI HTTP 请求" style={styles.row} value={snapshot.enabled}
          disabled={busy} onValueChange={setRecording} />
      </ThemedSurface> : null}
      {error ? <Text selectable accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {snapshot?.error ? <Text selectable accessibilityRole="alert" style={styles.error}>诊断存储错误：{snapshot.error}</Text> : null}
      <View style={styles.listHeader}>
        <View style={styles.listTitle}>
          <Text style={styles.heading}>最近记录</Text>
          {snapshot ? <Text style={styles.hint}>{snapshot.records.length} / 10</Text> : null}
        </View>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="刷新记录" activeOpacity={0.6}
          disabled={busy || loading} style={styles.refresh} onPress={refreshFromButton}>
          <Animated.View style={{ transform: [{ rotate: refreshRotate }] }}>
            <RefreshCw size={18} color={loading ? theme.colors.text.tertiary : theme.colors.text.secondary} />
          </Animated.View>
        </TouchableOpacity>
      </View>
      {snapshot?.records.length === 0 ? <EmptyState title="暂无记录"
        description={snapshot.enabled ? '现在发起一次 AI 请求，完成后会显示在这里。' : '开启记录后发起一次 AI 请求，再回来查看。'} /> : null}
      {snapshot && snapshot.records.length > 0 ? <ThemedSurface variant="card" style={styles.card}>
        {snapshot.records.map((record, index) => <ListItem key={record.id}
          onPress={() => { setDetail(record); setDetailVisible(true); }}
          titleContent={<View style={styles.recordMain}>
            <Text style={styles.recordTitle} numberOfLines={1}>{record.model} · {record.transport === 'stream' ? '流式' : '非流式'}</Text>
            <Text style={styles.recordMeta}>{formatTime(record.startedAt)} · {describeStatus(record)}{record.error ? ' · 有错误' : ''}</Text>
            <Text style={styles.recordMeta} numberOfLines={1}>{record.method} {record.url}</Text>
          </View>}
          rightContent={<ChevronRight size={18} color={theme.colors.text.tertiary} />}
          style={index === snapshot.records.length - 1 ? styles.lastItem : undefined} />)}
      </ThemedSurface> : null}
      {snapshot ? <Button title="清空记录" variant="text" style={styles.clear}
        textStyle={styles.clearText} disabled={busy || loading} onPress={clear} /> : null}
    </TextSelectionScrollView>
    {/* detail 在关闭动画期间保留，避免弹窗内容先变空。 */}
    {detail ? <ModalSheet visible={detailVisible} title="记录详情" onClose={() => setDetailVisible(false)}>
      <ExchangeDetail key={detail.id} record={detail} styles={styles} />
    </ModalSheet> : null}
  </SafeAreaView>;
}
