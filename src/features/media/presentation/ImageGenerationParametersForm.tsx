import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { Button, DropdownField } from '@shared/ui';
import { useThemedStyles, type PresentationTheme } from '@shared/theme';
import type { ImageGenerationCapabilities, ImageGenerationParameters } from '@platform/ai/imageGenerationConfig';
import type { ImageGenerationReferenceSelection } from '../application/ImageGenerationReference';

interface Props {
  capabilities: ImageGenerationCapabilities | null; value: ImageGenerationParameters; disabled: boolean;
  reference: ImageGenerationReferenceSelection | null; picking: boolean;
  onChange(parameters: ImageGenerationParameters): void; onPickReference(): void; onRemoveReference(): void;
}
export default function ImageGenerationParametersForm({ capabilities, value, disabled, reference, picking, onChange, onPickReference, onRemoveReference }: Props) {
  const styles = useThemedStyles(createStyles);
  if (!capabilities) return null;
  const { aspectRatios, resolutions } = capabilities;
  return <View>
    {aspectRatios.length > 0 ? <View style={styles.row}>
      <View style={styles.column}><DropdownField label="图片比例" value={value.aspectRatio ?? ''} disabled={disabled}
        options={[{ value: '', label: '模型默认' }, ...aspectRatios.map(ratio => ({ value: ratio, label: capabilities.imageSizes?.[ratio] ? `${ratio} · ${capabilities.imageSizes[ratio]!.replace('x', ' × ')}` : ratio }))]}
        onChange={aspectRatio => onChange({ ...value, aspectRatio: (aspectRatio || undefined) as ImageGenerationParameters['aspectRatio'] })} /></View>
      {resolutions.length > 0 && <View style={styles.column}><DropdownField label="清晰度" value={value.resolution ?? ''} disabled={disabled}
        options={[{ value: '', label: '模型默认' }, ...resolutions.map(resolution => ({ value: resolution, label: resolution }))]}
        onChange={resolution => onChange({ ...value, resolution: (resolution || undefined) as ImageGenerationParameters['resolution'] })} /></View>}
    </View> : null}
    {capabilities.quality && <View style={styles.row}>
      <View style={styles.column}><DropdownField label="渲染画质" value={value.quality ?? ''} disabled={disabled}
        options={[{ value: '', label: '自动' }, { value: 'low', label: '快速' }, { value: 'medium', label: '均衡' }, { value: 'high', label: '精细' }]}
        onChange={quality => onChange({ ...value, quality: (quality || undefined) as ImageGenerationParameters['quality'] })} /></View>
      <View style={styles.column}><DropdownField label="文件格式" value={value.outputFormat ?? ''} disabled={disabled}
        options={[{ value: '', label: '服务默认' }, { value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }, { value: 'webp', label: 'WebP' }]}
        onChange={format => onChange({ ...value, outputFormat: (format || undefined) as ImageGenerationParameters['outputFormat'], outputCompression: undefined })} /></View>
    </View>}
    {capabilities.outputFormat && (value.outputFormat === 'jpeg' || value.outputFormat === 'webp') && <DropdownField label="压缩质量" value={value.outputCompression == null ? '' : String(value.outputCompression)} disabled={disabled}
      options={[{ value: '', label: '服务默认' }, { value: '100', label: '100 · 细节优先' }, { value: '80', label: '80 · 均衡体积' }, { value: '60', label: '60 · 较小体积' }]}
      onChange={compression => onChange({ ...value, outputCompression: compression ? Number(compression) : undefined })} />}
    {(capabilities.references || reference) && <>
      {reference && <View style={styles.reference}><Image source={{ uri: reference.uri }} style={styles.thumbnail} /><View style={styles.column}>
        <Text style={styles.referenceTitle}>人物／主体参考</Text><Text style={styles.hint}>{reference.width} × {reference.height}</Text>
      </View><Button title="移除" variant="text" onPress={onRemoveReference} disabled={disabled || picking} /></View>}
      <Button title={picking ? '正在选择…' : reference ? '更换参考人像' : capabilities.referenceRequired ? '添加参考图（必需）' : '添加参考人像'} variant="secondary" disabled={disabled || picking || !capabilities.references} onPress={onPickReference} />
    </>}
  </View>;
}
const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  row: { flexDirection: 'row', gap: theme.spacing.md }, column: { flex: 1 },
  hint: { color: theme.colors.text.secondary, fontSize: 12, lineHeight: 20, marginVertical: 8 },
  reference: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, marginBottom: theme.spacing.sm },
  thumbnail: { width: 54, height: 62, borderRadius: theme.radius.md },
  referenceTitle: { color: theme.colors.text.primary, fontSize: 14 },
});
