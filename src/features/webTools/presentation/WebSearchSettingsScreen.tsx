import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import { ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import { Button, ConfiguredModelPicker, InputField, KeyboardAvoidingContainer, ListItem, ToggleField, showAppDialog } from '@shared/ui';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { SEARCH_SOURCES } from '../domain/SearchSettings';
import {
  readSearchConfiguration, readSearchSelection, selectSearchSource, subscribeSearchConfigurationChanged,
  updateSearchConfiguration, testAndSaveSearchKey,
} from '../application/SearchConfiguration';
import { createSearchSettingsStyles } from './searchSettingsStyles';

type Configuration = Awaited<ReturnType<typeof readSearchConfiguration>>;

/** 生效来源复用辅助模型中心的选择器；下方列表只编辑配置，不隐式切换当前选择。 */
export default function WebSearchSettingsScreen({ onBack, refreshRevision = 0 }: { onBack: () => void; refreshRevision?: number }) {
  const theme = useTheme();
  const styles = useThemedStyles(createSearchSettingsStyles);
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [expanded, setExpanded] = useState<'tavily' | 'brave' | null>(null);
  const [keys, setKeys] = useState({ tavily: '', brave: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const mounted = useRef(false);
  const pending = useRef(false);
  const draftsLoaded = useRef(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    controller.current = new AbortController();
    return () => { mounted.current = false; controller.current!.abort(); };
  }, []);
  useEffect(() => {
    let active = true;
    let revision = 0;
    async function reload() {
      const current = ++revision;
      try {
        const value = await readSearchConfiguration();
        if (!active || current !== revision) return;
        setConfiguration(value); setError(null);
        if (!draftsLoaded.current) {
          setKeys({ tavily: value.sources.find(source => source.engine === 'tavily')!.apiKey,
            brave: value.sources.find(source => source.engine === 'brave')!.apiKey });
          draftsLoaded.current = true;
        }
      } catch {
        if (active && current === revision) setError('无法读取搜索配置，请返回后重试');
      }
    }
    void reload();
    const unsubscribe = subscribeSearchConfigurationChanged(() => { void reload(); });
    return () => { active = false; unsubscribe(); };
  }, [refreshRevision]);

  async function perform(action: () => Promise<unknown>, message = '') {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setStatus('');
    try {
      await action();
      if (mounted.current) { setError(null); setStatus(message); }
    } catch (failure) {
      if (mounted.current) showAppDialog({ title: '操作未完成', message: failure instanceof Error ? failure.message : '搜索配置操作失败', tone: 'error' });
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
    <NavigationHeader title="联网搜索" onGoBack={onBack} help={{ sections: [
      { title: '搜索来源', body: '在顶部选择生效的默认来源。Bing、DuckDuckGo 无需配置；点击 Tavily、Brave Search 展开密钥配置，测试成功后即可选择。AI 也可按需使用其他已配置来源。' },
      { title: '密钥与连接测试', body: 'API Key 保存在本机安全存储中。连接测试使用输入框中的密钥，消耗一次基础搜索额度。首次成功配置自有服务后会自动选为默认，后续配置保留已有选择。' },
      { title: 'Tavily 深度搜索', body: '允许后，AI 可以按需使用深度搜索，它比基础搜索消耗更多额度。默认关闭。' },
      { title: '系统代理', body: '关闭时不使用系统代理，打开时遵守手机的代理及排除规则。VPN/TUN 是否接管由手机系统决定。此设置适用于联网搜索、网页读取和图片／文件下载，从下一次请求生效。' },
      { title: '网络与调用权限', body: '搜索依赖上游和手机网络，可能遇到验证码或限流。查询会发送给所选提供方，费用与额度由该账号承担。各 AI 的工具权限沿用提示词中心的现有设置。' },
    ] }} />
    <KeyboardAvoidingContainer style={styles.screen}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <ConfiguredModelPicker key={refreshRevision} title="搜索来源" unconfiguredLabel="未选择搜索来源"
          getSettings={readSearchSelection} onSelect={selectSearchSource} subscribeChanged={subscribeSearchConfigurationChanged} disabled={busy} />
        {configuration && <>
          <ThemedSurface variant="card" style={styles.card}>
            <ToggleField label="系统代理" layout="inline" style={styles.proxyToggle} value={configuration.connectionMode === 'system'} disabled={busy}
              onValueChange={enabled => { void perform(() => updateSearchConfiguration({ kind: 'connection', mode: enabled ? 'system' : 'direct' })); }} />
          </ThemedSurface>
          {status ? <Text accessibilityLiveRegion="polite" style={styles.status}>{status}</Text> : null}
          <ThemedSurface variant="card" style={styles.card}>
            {SEARCH_SOURCES.map(({ engine, name }, index) => {
              const source = configuration.sources.find(item => item.engine === engine)!;
              const apiEngine = engine === 'tavily' || engine === 'brave' ? engine : null;
              const isExpanded = apiEngine !== null && expanded === apiEngine;
              return <React.Fragment key={engine}>
                <ListItem title={name} subtitle={apiEngine ? (source.configured ? '已配置' : '未配置') : undefined}
                  onPress={apiEngine && !busy ? () => { setExpanded(isExpanded ? null : apiEngine); setStatus(''); } : undefined}
                  activeOpacity={apiEngine ? 0.7 : 1}
                  rightContent={apiEngine ? (isExpanded ? <ChevronDown size={20} color={theme.colors.text.tertiary} /> : <ChevronRight size={20} color={theme.colors.text.tertiary} />) : undefined}
                  style={index === SEARCH_SOURCES.length - 1 && !isExpanded ? styles.lastItem : undefined} />
                {apiEngine && isExpanded && <View style={styles.body}>
                  <InputField label={`${name} API Key`} value={keys[apiEngine]} autoGrow editable={!busy} autoCapitalize="none" autoCorrect={false} maxLength={512}
                    placeholder="填写 API Key" onChangeText={value => setKeys(previous => ({ ...previous, [apiEngine]: value }))} />
                  <Button title={keys[apiEngine].trim() !== source.apiKey ? '测试并保存' : '测试连接'} variant="text" disabled={busy || !keys[apiEngine].trim()}
                    onPress={() => { void perform(() => testAndSaveSearchKey(apiEngine, keys[apiEngine], controller.current!.signal), `${name} 连接正常`); }} />
                  {apiEngine === 'tavily' && <ToggleField label="允许深度搜索" accessibilityLabel="允许 Tavily 深度搜索" layout="inline"
                    value={configuration.allowAdvanced} disabled={busy}
                    onValueChange={allowed => { void perform(() => updateSearchConfiguration({ kind: 'advanced', allowed })); }} />}
                </View>}
              </React.Fragment>;
            })}
          </ThemedSurface>
        </>}
        {error && <Text accessibilityRole="alert" style={[styles.hint, styles.danger]}>{error}</Text>}
        {busy && <ActivityIndicator color={theme.colors.brand.primary} />}
        {!configuration && !error && <ActivityIndicator color={theme.colors.brand.primary} />}
      </ScrollView>
    </KeyboardAvoidingContainer>
  </SafeAreaView>;
}
