/** 设置按会话保存，输入草稿与持久事实分离；无效阈值不阻止独立开关保存。 */
import React, { forwardRef, useImperativeHandle, useMemo } from 'react';
import { Text, View } from 'react-native';
import { AppTextInput, ToggleField, showAppDialog } from '@shared/ui';
import { AutoSaveErrors } from '@shared/ui/AutoSaveErrors';
import { useAutoSaveDraft } from '@shared/ui/useAutoSaveDraft';
import { ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import type { ChatSummarySettings, ChatSummarySettingsPatch } from '../domain/ChatSummaryRepository';
import { createChatSummaryStyles } from './chatSummaryStyles';

export interface ChatSummarySettingsEditor { flush(): Promise<boolean> }
export default forwardRef<ChatSummarySettingsEditor, {
  settings: ChatSummarySettings; pendingTokens: number; busy: boolean; group?: boolean;
  /** 单聊消息注入条数；留空跟随时的展示值，仅单聊设置页提供。 */
  followPrimaryLimit?: number | null;
  onSave(patch: ChatSummarySettingsPatch): Promise<void>;
}>(function ChatSummarySettingsPanel({ settings, pendingTokens, busy, onSave, group = false, followPrimaryLimit = null }, ref) {
  const theme = useTheme();
  const styles = useThemedStyles(createChatSummaryStyles);
  const initial = useMemo(() => ({ threshold: String(settings.secondaryTokenThreshold), timeout: String(settings.requestTimeoutSeconds),
    maxTokens: settings.maxOutputTokens === null ? '' : String(settings.maxOutputTokens), trigger: String(settings.groupTriggerCount),
    primaryLimit: settings.primaryLimit === null ? '' : String(settings.primaryLimit) }),
  [settings.secondaryTokenThreshold, settings.requestTimeoutSeconds, settings.maxOutputTokens, settings.groupTriggerCount, settings.primaryLimit]);
  const thresholdEditor = useAutoSaveDraft<typeof initial, ChatSummarySettingsPatch>({
    initial,
    parse(draft, changed) {
      const patch: ChatSummarySettingsPatch = {}, errors: Partial<Record<keyof typeof initial, string>> = {};
      const accepted: (keyof typeof initial)[] = [];
      for (const field of changed) {
        const text = draft[field], value = Number(text);
        if ((field === 'maxTokens' || field === 'primaryLimit') && text === '') {
          if (field === 'maxTokens') patch.maxOutputTokens = null; else patch.primaryLimit = null;
          accepted.push(field); continue;
        }
        if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value <= 0 || (field === 'timeout' && value > 3600)) {
          errors[field] = field === 'threshold' ? '请填写正整数 token 阈值' : field === 'trigger' ? '请填写正整数群触发条数'
            : field === 'primaryLimit' ? '请填写正整数整理条数，或留空跟随单聊消息注入' : field === 'timeout' ? '请填写 1～3600 秒最长等待时间' : '请填写正整数输出 token，或留空跟随总结模型';
          continue;
        }
        if (field === 'threshold') patch.secondaryTokenThreshold = value;
        else if (field === 'timeout') patch.requestTimeoutSeconds = value;
        else if (field === 'trigger') patch.groupTriggerCount = value;
        else if (field === 'primaryLimit') patch.primaryLimit = value;
        else patch.maxOutputTokens = value;
        accepted.push(field);
      }
      return { patch, accepted, errors };
    },
    save: onSave,
  });
  useImperativeHandle(ref, () => ({ flush: thresholdEditor.flush }), [thresholdEditor.flush]);
  const error = thresholdEditor.errors.threshold;
  const saveSwitch = async (patch: ChatSummarySettingsPatch) => {
    try { await onSave(patch); }
    catch (failure) { showAppDialog({ title: '操作失败', message: failure instanceof Error ? failure.message : '请稍后再试', tone: 'error' }); }
  };
  // 表单单卡跟随原生玻璃；输入框自带主题染色，不在玻璃上叠白底。
  return <ThemedSurface nativeGlass variant="card" style={styles.card}>
    {/* 开关说明跟开关同一行（与手机工具页一致），长解释统一放页面问号说明。 */}
    <ToggleField layout="inline" rowStyle={styles.switchRow} label="注入已有摘要"
      value={settings.injectEnabled} disabled={busy} onValueChange={(injectEnabled) => { void saveSwitch({ injectEnabled }); }}>
      <View style={styles.rowText}>
        <Text style={styles.body}>注入已有摘要</Text>
        <Text style={styles.subtitle}>关闭后来源会话摘要不再进入上下文，记录与自动生成不受影响。</Text>
      </View>
    </ToggleField>
    {group && <>
      <View style={styles.row}><Text style={styles.body}>群摘要触发条数</Text><AppTextInput accessibilityLabel="群摘要触发条数"
        style={styles.thresholdInput} value={thresholdEditor.draft.trigger} keyboardType="number-pad" editable={!busy}
        onChangeText={(trigger) => thresholdEditor.change({ trigger })} onBlur={() => { void thresholdEditor.commit(); }} /></View>
      {thresholdEditor.errors.trigger && <Text style={styles.danger}>{thresholdEditor.errors.trigger}</Text>}
    </>}
    <ToggleField layout="inline" rowStyle={styles.switchRow} label="开启一级摘要"
      value={settings.generationEnabled} disabled={busy || settings.fixedMessageId !== null}
      onValueChange={(generationEnabled) => { void saveSwitch({ generationEnabled }); }}>
      <View style={styles.rowText}>
        <Text style={styles.body}>开启一级摘要</Text>
        <Text style={styles.subtitle}>{settings.fixedMessageId !== null
          ? '已固定消息起点，一级摘要暂停生成；取消固定后需手动开启，从原进度继续。'
          : group ? '按整理条数与处理进度自动归纳聊天，关闭后仅保留近期消息窗口。'
            : '保留单聊注入条数的近期原文，更早的聊天与通话按批次归纳；摘要与对应原文成功后交接。'}</Text>
      </View>
    </ToggleField>
    {!group && <>
      <View style={styles.row}><Text style={styles.body}>每次整理条数</Text><AppTextInput accessibilityLabel="每次整理条数"
        style={styles.thresholdInput} keyboardType="number-pad" editable={!busy} value={thresholdEditor.draft.primaryLimit}
        placeholder={followPrimaryLimit === null ? '跟随单聊注入' : `跟随单聊注入（${followPrimaryLimit}）`}
        onChangeText={(primaryLimit) => { void thresholdEditor.change({ primaryLimit }); }} onBlur={() => { void thresholdEditor.commit(); }} /></View>
      {thresholdEditor.errors.primaryLimit && <Text accessibilityRole="alert" style={styles.danger}>{thresholdEditor.errors.primaryLimit}</Text>}
    </>}
    <ToggleField layout="inline" rowStyle={styles.switchRow} label="开启二级摘要"
      value={settings.secondaryEnabled} disabled={busy} onValueChange={(secondaryEnabled) => { void saveSwitch({ secondaryEnabled }); }}>
      <View style={styles.rowText}>
        <Text style={styles.body}>开启二级摘要</Text>
        <Text style={styles.subtitle}>只归纳已形成的一级摘要，关闭后恢复注入现存一级摘要并暂停新的归纳。</Text>
      </View>
    </ToggleField>
    <View style={styles.row}><Text style={styles.body}>一级摘要最大 token</Text><AppTextInput accessibilityLabel="一级摘要最大 token"
      style={[styles.thresholdInput, error && { borderColor: theme.colors.feedback.error }]} value={thresholdEditor.draft.threshold}
      onChangeText={(threshold) => thresholdEditor.change({ threshold })} onBlur={() => { void thresholdEditor.commit(); }}
      editable={!busy && settings.secondaryEnabled} keyboardType="number-pad" returnKeyType="done" submitBehavior="blurAndSubmit" /></View>
    {error && <Text accessibilityRole="alert" style={styles.danger}>{error}</Text>}
    <View style={styles.row}><Text style={styles.body}>摘要最长等待（秒）</Text><AppTextInput accessibilityLabel="摘要最长等待秒数"
      style={styles.thresholdInput} keyboardType="number-pad" value={thresholdEditor.draft.timeout} editable={!busy}
      onChangeText={(timeout) => thresholdEditor.change({ timeout })} onBlur={() => { void thresholdEditor.commit(); }} /></View>
    {thresholdEditor.errors.timeout && <Text accessibilityRole="alert" style={styles.danger}>{thresholdEditor.errors.timeout}</Text>}
    <View style={styles.row}><Text style={styles.body}>摘要输出 token 上限</Text><AppTextInput accessibilityLabel="摘要输出 token 上限"
      style={styles.thresholdInput} keyboardType="number-pad" value={thresholdEditor.draft.maxTokens} placeholder="跟随总结模型" editable={!busy}
      onChangeText={(maxTokens) => thresholdEditor.change({ maxTokens })} onBlur={() => { void thresholdEditor.commit(); }} /></View>
    {thresholdEditor.errors.maxTokens && <Text accessibilityRole="alert" style={styles.danger}>{thresholdEditor.errors.maxTokens}</Text>}
    <AutoSaveErrors error={thresholdEditor.saveError} blocked={false}
      retry={() => { void thresholdEditor.flush(); }} restore={() => { void thresholdEditor.restore(); }} />
    <Text style={styles.meta}>待归纳一级摘要：约 {pendingTokens} token</Text>
  </ThemedSurface>;
});
