import React, { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { Check, Crown, NotebookPen, X } from 'lucide-react-native';
import { createHostAIAppointmentDialog, getHostAppointmentAvailability, subscribeHostAppointmentChanged, type HostAppointmentAvailability } from '@features/assistants';
import { isMoonKimiTheme, isPaperNoteTheme, ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import { showAppDialog } from '@shared/ui';
import { respondToRoleApplicationCard } from '../../../messages/application/RoleApplicationCards';
import { roleApplicationTitle, type RoleApplicationCardMetadata } from '../../../messages/domain/RoleApplicationCard';
import type { ChatMessage } from '../../../messages/domain/ChatMessage';
import { Avatar } from '../MessageBubble/Avatar';
import PaperNoteMessageFrame from '../MessageBubble/PaperNoteMessageFrame';
import { createMessageBubbleStyles } from '../MessageBubble/styles';
import type { ResolvedMessageAIIdentity } from './chatMessageRenderUtils';

type ApplicationAction = 'accept' | 'decline';
type AvailabilityStatus = HostAppointmentAvailability['status'] | 'loading' | 'unavailable';

const HOST_APPOINTMENT_HINTS: Record<AvailabilityStatus, string> = {
  loading: '正在确认主理任命状态…',
  unavailable: '暂时无法读取主理任命状态。',
  occupied: '已有主理 AI 在任。',
  cooldown: '任命冷静期尚未结束。',
  vacant: '确认任命后，申请者将接任主理 AI。',
};

function useHostAppointmentStatus(active: boolean) {
  const [status, setStatus] = useState<AvailabilityStatus>('loading');
  useEffect(() => {
    if (!active) return;
    let request = 0;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      const revision = ++request;
      clearTimeout(expiry);
      void getHostAppointmentAvailability().then((availability) => {
        if (revision !== request) return;
        setStatus(availability.status);
        if (availability.status === 'cooldown') {
          // 冷静期自然到期也会改变按钮资格，无须离开会话。
          expiry = setTimeout(refresh, Math.max(0, Date.parse(availability.endAt) - Date.now()));
        }
      }, () => {
        if (revision === request) setStatus('unavailable');
      });
    };
    setStatus('loading');
    const unsubscribe = subscribeHostAppointmentChanged(refresh);
    const appState = AppState.addEventListener('change', (state) => { if (state === 'active') refresh(); });
    refresh();
    return () => {
      ++request;
      clearTimeout(expiry);
      appState.remove();
      unsubscribe();
    };
  }, [active]);
  return status;
}

export function RoleApplicationCard({ card, message, identity, onOpenAssistantProfile }: {
  card: RoleApplicationCardMetadata;
  message: ChatMessage;
  identity: ResolvedMessageAIIdentity;
  onOpenAssistantProfile?: (aiId: string) => void;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const bubbleStyles = useThemedStyles(createMessageBubbleStyles);
  const paper = isPaperNoteTheme(theme);
  const { borderRadius } = paper
    ? bubbleStyles.paperNoteContent
    : StyleSheet.flatten([bubbleStyles.bubble, bubbleStyles.aiBubble]);
  const inlineAvatar = paper || isMoonKimiTheme(theme);
  const [pendingAction, setPendingAction] = useState<ApplicationAction | null>(null);
  const isHost = card.role === 'host';
  const isPending = card.decision === 'pending';
  const hostAppointment = useHostAppointmentStatus(isHost && isPending);
  const isAccepted = card.decision === 'accepted';
  const speakerName = identity.name?.trim() || 'AI';
  const { aiId } = identity;
  const RoleIcon = isHost ? Crown : NotebookPen;
  const StatusIcon = isAccepted ? Check : X;
  const context = getApplicationContext(card);
  const hint = isHost ? HOST_APPOINTMENT_HINTS[hostAppointment] : '同意后，申请者将接任记账。';

  async function respond(action: ApplicationAction) {
    setPendingAction(action);
    try {
      if (await respondToRoleApplicationCard(message.sessionId, message.id, action, card.role) === 'unavailable') {
        showAppDialog({ title: '申请已不可用', message: '当前无法处理这张申请卡。', tone: 'warning' });
      }
    } catch {
      showAppDialog({ title: '处理申请失败', message: '请稍后再试。', tone: 'error' });
    } finally {
      setPendingAction(null);
    }
  }

  function accept() {
    if (isHost) {
      showAppDialog(createHostAIAppointmentDialog(speakerName, () => void respond('accept')));
      return;
    }
    void respond('accept');
  }

  const busy = pendingAction !== null;
  const avatar = (
    <Avatar
      avatarContent={identity.avatar as string | null}
      isUser={false}
      aiName={speakerName}
      onPress={aiId && onOpenAssistantProfile ? () => onOpenAssistantProfile(aiId) : undefined}
    />
  );
  const canAccept = !isHost || hostAppointment === 'vacant';
  const acceptDisabled = busy || !canAccept;
  const content = (
    <ThemedSurface
      backgroundColor={paper ? 'transparent' : theme.colors.surface.default}
      cornerRadius={borderRadius}
      style={[styles.card, { borderRadius }]}
    >
      <View style={styles.details}>
        <View style={styles.header}>
          {inlineAvatar ? avatar : (
            <View style={styles.roleIcon}>
              <RoleIcon size={19} color={theme.colors.brand.primary} />
            </View>
          )}
          <View style={styles.heading}>
            <Text style={styles.title}>{roleApplicationTitle(card.role)}</Text>
            {!paper ? <Text style={styles.sender} numberOfLines={1}>{speakerName}</Text> : null}
          </View>
        </View>
        {context ? <Text style={styles.body}>{context}</Text> : null}
        {isPending ? <Text style={styles.body}>{hint}</Text> : null}
      </View>
      <View style={styles.footer}>
        {isPending ? (
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy}
              onPress={() => void respond('decline')} style={[styles.action, busy && styles.disabled]}>
              <Text style={styles.actionText}>{pendingAction === 'decline' ? '处理中…' : '拒绝'}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: acceptDisabled }} disabled={acceptDisabled}
              onPress={accept} style={[styles.action, canAccept && styles.primary, acceptDisabled && styles.disabled]}>
              <Text style={[styles.actionText, canAccept && styles.primaryText]}>
                {pendingAction === 'accept' ? '处理中…' : '同意'}
              </Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.status}>
            <StatusIcon size={16} color={isAccepted ? theme.colors.feedback.success : theme.colors.text.secondary} />
            <Text style={styles.statusText}>{isAccepted ? '已同意' : '已拒绝'}</Text>
          </View>
        )}
      </View>
    </ThemedSurface>
  );

  if (paper) return <PaperNoteMessageFrame speakerName={speakerName}>{content}</PaperNoteMessageFrame>;
  return (
    <View style={[bubbleStyles.container, bubbleStyles.aiContainer]}>
      {!inlineAvatar ? <View style={bubbleStyles.avatarWrapper}>{avatar}</View> : null}
      {content}
    </View>
  );
}

function getApplicationContext(card: RoleApplicationCardMetadata): string | null {
  if (card.role === 'ledger') {
    return card.incumbentName ? `申请时由「${card.incumbentName}」负责记账。` : null;
  }
  if (card.incumbentName) return `申请时「${card.incumbentName}」正在担任主理 AI。`;
  if (card.cooldownEndAt) {
    const end = new Date(card.cooldownEndAt).toLocaleString('zh-CN', { hour12: false });
    return `申请时处于任命冷静期，原定于 ${end} 结束。`;
  }
  return '申请时主理 AI 空缺。';
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  const paper = isPaperNoteTheme(theme);
  return StyleSheet.create({
    card: {
      width: paper ? '100%' : 300,
      flexShrink: 1,
      minWidth: 0,
      borderWidth: paper ? 0 : StyleSheet.hairlineWidth,
      borderColor: theme.effects.glass.enabled ? theme.effects.glass.borderColor : theme.colors.border.default,
    },
    details: { paddingHorizontal: paper ? 0 : theme.spacing.md, paddingVertical: theme.spacing.sm, gap: theme.spacing.xs },
    header: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
    heading: { flex: 1, gap: 2 },
    roleIcon: {
      width: 36,
      height: 36,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.surface.muted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: { color: theme.colors.text.primary, fontSize: 15, fontWeight: '700' },
    sender: { color: theme.colors.text.secondary, fontSize: 12 },
    body: { color: theme.colors.text.secondary, fontSize: 14, lineHeight: 20 },
    footer: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border.light,
      paddingHorizontal: paper ? 0 : theme.spacing.md, paddingVertical: theme.spacing.sm },
    actions: { flexDirection: 'row', gap: theme.spacing.sm },
    action: { flex: 1, minHeight: 44, paddingHorizontal: theme.spacing.sm, justifyContent: 'center', alignItems: 'center',
      borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border.default, borderRadius: theme.radius.md },
    actionText: { color: theme.colors.text.primary, fontWeight: '600' },
    disabled: { opacity: 0.45 },
    primary: { borderColor: theme.colors.brand.primary, backgroundColor: theme.colors.brand.primary },
    primaryText: { color: theme.colors.brand.onPrimary },
    status: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs },
    statusText: { color: theme.colors.text.secondary, fontWeight: '600' },
  });
}
