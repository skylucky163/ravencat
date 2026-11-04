/** 单聊和群聊共用正文编辑器；草稿与聊天输入分开，失败时保留草稿。 */
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, InputField, ModalSheet } from '@shared/ui';
import { useTheme } from '@shared/theme';
import type { ChatMessage } from '../../../messages/domain/ChatMessage';
import { editChatMessage } from '../../../messages/application/EditChatMessage';

interface ChatMessageEditorProps {
  message: ChatMessage;
  onClose: () => void;
  onSaved: (message: ChatMessage) => void;
}

export default function ChatMessageEditor({ message, onClose, onSaved }: ChatMessageEditorProps) {
  const theme = useTheme();
  const [text, setText] = useState(message.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const savingRef = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const edited = await editChatMessage({ messageId: message.id, expectedText: message.text, text });
      if (mounted.current) {
        onSaved(edited);
        onClose();
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '改写失败');
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <ModalSheet visible title="改写消息" onClose={() => { if (!saving) onClose(); }}>
      <View style={{ padding: theme.spacing.lg }}>
        <InputField
          value={text}
          onChangeText={(next) => { if (!saving) setText(next); }}
          multiline
          inputStyle={styles.input}
          error={error}
          hint="保存会修改原消息，保留原发言者，不会自动生成 AI 回复。"
        />
        <View style={styles.actions}>
          <Button title="取消" variant="secondary" disabled={saving} onPress={onClose} />
          <Button title={saving ? '保存中…' : '保存'} disabled={saving || !text.trim() || text === message.text} onPress={() => { void save(); }} />
        </View>
      </View>
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  input: { height: 180, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
});
