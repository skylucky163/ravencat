import React from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { useTheme, useThemedStyles } from '@shared/theme';
import { Button } from '@shared/ui';
import { Plus } from 'lucide-react-native';
import Slider from '@shared/ui/Slider';
import { MAX_BUBBLE_DECORATIONS, type BubbleDecorationConfig } from '../domain/ChatBubbleSkin';
import type { BubbleDraftDecoration } from '../application/BubbleSkinDraft';
import { createBubbleSkinEditorStyles } from './BubbleSkinEditor.styles';

export function BubbleDecorationControls({ decorations, selectedId, busy, onSelect, onChange, onAdd, onRemove }: {
  decorations: readonly BubbleDraftDecoration[]; selectedId: string | null; busy: boolean;
  onSelect: (id: string) => void; onChange: (id: string, config: BubbleDecorationConfig) => void;
  onAdd: (slot: number) => void; onRemove: (id: string) => void;
}) {
  const styles = useThemedStyles(createBubbleSkinEditorStyles);
  const theme = useTheme();
  const selected = decorations.find(item => item.id === selectedId);
  return <>
    <Text style={styles.label}>静态 PNG，每张不超过 2 MiB；导入时自动适配至最长边 512 像素。</Text>
    <View style={styles.slots}>
      {Array.from({ length: MAX_BUBBLE_DECORATIONS }, (_, slot) => {
        const item = decorations.find(decoration => decoration.slot === slot);
        return <Pressable key={slot} style={[styles.slot, item?.id === selectedId && styles.slotSelected]} disabled={busy}
          accessibilityRole="button" accessibilityLabel={item ? `选择饰品槽 ${slot + 1}` : `上传到饰品槽 ${slot + 1}`}
          accessibilityState={{ selected: item?.id === selectedId, disabled: busy }} onPress={() => item ? onSelect(item.id) : onAdd(slot)}>
          {item ? <Image source={{ uri: item.uri }} style={styles.thumbnail} resizeMode="contain" fadeDuration={0} /> : <Plus size={22} color={theme.colors.text.secondary} />}
          <Text style={styles.slotLabel}>{slot + 1}</Text>
        </Pressable>;
      })}
    </View>
    {selected && <>
      <Text style={styles.label}>在预览中自由拖动，可伸出气泡并跟随最近的角。短气泡会等比缩小装饰和偏移。</Text>
      <View>
        <View style={styles.parameterHeading}><Text style={styles.label}>最大尺寸</Text><Text style={styles.value}>{selected.config.size} dp</Text></View>
        <Slider value={selected.config.size} min={16} max={160} step={1} disabled={busy} accessibilityLabel="装饰最大尺寸"
          onValueChange={size => onChange(selected.id, { ...selected.config, size })} />
      </View>
      <Button title="移除装饰" variant="text" disabled={busy} onPress={() => onRemove(selected.id)} />
    </>}
  </>;
}
