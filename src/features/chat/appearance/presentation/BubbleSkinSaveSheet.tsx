import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Button, InputField, ModalSheet } from '@shared/ui';
import { useThemedStyles } from '@shared/theme';
import { createBubbleSkinEditorStyles } from './BubbleSkinEditor.styles';

/** 保存与退出共用一个命名窗口，不改变通用提示弹窗的职责。 */
export function BubbleSkinSaveSheet({ mode, name, onNameChange, busy, error, canSave, onSave, onCancel, onDiscard }: {
  mode: 'save' | 'leave' | null; name: string; onNameChange(value: string): void;
  busy: boolean; error: string | null; canSave: boolean;
  onSave(): void; onCancel(): void; onDiscard(): void;
}) {
  const styles = useThemedStyles(createBubbleSkinEditorStyles);
  const disabled = busy || mode === null;
  return <ModalSheet visible={mode !== null} title={mode === 'leave' ? '保存后退出？' : '保存气泡组合'}
    onClose={() => { if (mode !== null) onCancel(); }}>
    <ScrollView style={styles.saveScroll} contentContainerStyle={styles.saveContent} keyboardShouldPersistTaps="handled">
      <InputField label="组合名称" value={name} onChangeText={onNameChange} maxLength={32} editable={!disabled} />
      {error && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
    <View style={[styles.row, styles.saveActions]}>
      <Button title={mode === 'leave' ? '继续编辑' : '取消'} variant="text" disabled={disabled} onPress={onCancel} />
      {mode === 'leave' && <Button title="放弃修改" variant="outline" disabled={disabled} onPress={onDiscard} />}
      <Button title={busy ? '保存中' : '保存'} disabled={disabled || !canSave || !name.trim()} onPress={onSave} />
    </View>
  </ModalSheet>;
}
