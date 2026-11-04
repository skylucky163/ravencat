/** 单帖以用户权限读取最新事实；从聊天打开不会替任何 AI 消费未读或绕过 ACL。 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, EmptyState, NavigationHeader, showAppDialog } from '@shared/ui';
import { useThemedStyles, type PresentationTheme } from '@shared/theme';
import { subscribeMomentMediaAnalysisUpdated } from '../application/MomentMediaAnalysis';
import { getMomentRecord, createUserMomentComment, createUserMomentLike, removeUserMomentLike, removeMomentRecord, removeMomentCommentById, type MomentRecord } from '../presentationFacade';
import MomentItem from './MomentItem';

export default function MomentDetailScreen({ momentId, onBack }: { momentId: string; onBack(): void }) {
  const styles = useThemedStyles(createStyles);
  const [record, setRecord] = useState<MomentRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    let active = true;
    setError(false);
    void getMomentRecord(momentId).then(value => { if (active) setRecord(value); })
      .catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [momentId, revision]);
  useEffect(() => subscribeMomentMediaAnalysisUpdated(reload), [reload]);
  const mutate = async (work: () => Promise<unknown>) => { await work(); reload(); };
  const like = (id: string, remove = false) => {
    void mutate(() => remove ? removeUserMomentLike(id) : createUserMomentLike(id)).catch(failure => {
      showAppDialog({ title: '操作失败', message: failure instanceof Error ? failure.message : '请稍后重试', tone: 'error' });
    });
  };
  return <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
    <NavigationHeader title="时刻详情" onGoBack={onBack} />
    {loading ? <ActivityIndicator style={styles.status} /> : error ? <View style={styles.status}><EmptyState title="读取失败" /><Button title="重试" onPress={reload} /></View>
      : record ? <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"><MomentItem item={record} detail
        onLike={id => like(id)} onUnlike={id => like(id, true)}
        onComment={(id, content, parent) => mutate(() => createUserMomentComment(id, content, parent))}
        onDelete={id => mutate(() => removeMomentRecord(id))}
        onDeleteComment={id => mutate(() => removeMomentCommentById(id))} onMediaUpdated={reload} /></ScrollView>
        : <EmptyState title="这条时刻已删除" description="聊天中保留的是分享时的内容。" />}
  </SafeAreaView>;
}
const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background.screen }, status: { flex: 1, alignItems: 'center', justifyContent: 'center' }, content: { paddingBottom: 24 },
});
