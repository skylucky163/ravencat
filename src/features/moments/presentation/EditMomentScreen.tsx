/** 编辑页先读取同一快照的正文、图片、可见范围与版本，再复用发布表单。 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, EmptyState, NavigationHeader } from '@shared/ui';
import { useTheme } from '@shared/theme';
import { editUserMomentRecord, getUserMomentEditDraft } from '../presentationFacade';
import { describeMomentEditFailure } from './momentActionFeedback';
import PublishView from './PublishView';

export default function EditMomentScreen({ momentId, onBack }: { momentId: string; onBack(): void }) {
  const theme = useTheme();
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof getUserMomentEditDraft>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void getUserMomentEditDraft(momentId).then(value => { if (active) setSnapshot(value); })
      .catch(failure => { if (active) setError(describeMomentEditFailure(failure)); });
    return () => { active = false; };
  }, [momentId]);
  if (snapshot) return <PublishView mode="edit" initialDraft={snapshot.draft} onCancel={onBack} onPublish={async draft => {
    await editUserMomentRecord(momentId, snapshot.expectedRevision, draft);
    onBack();
  }} />;
  return <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background.app }} edges={['top', 'left', 'right', 'bottom']}>
    <NavigationHeader title="编辑时刻" onGoBack={onBack} />
    {error ? <><EmptyState title="无法编辑" description={error} /><Button title="返回" onPress={onBack} /></> : <ActivityIndicator />}
  </SafeAreaView>;
}
