/** 画布动效只表达正在处理，不把动画或已等待时长换算为完成百分比。 */
import React, { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Expand, Image as ImageIcon } from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useReducedMotion } from 'react-native-reanimated';
import { useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import type { ImageGenerationProgress } from '../application/PrepareGeneratedImage';
import ImageGenerationPixelEffect from './ImageGenerationPixelEffect';

export const IMAGE_GENERATION_STAGE_LABELS = {
  preparing: '准备画面', generating: '正在绘制', downloading: '取回图片', checking: '整理图片', saving: '完成处理中',
};
interface Props {
  busy: boolean;
  ratio: number;
  ratioLabel: string;
  progress: ImageGenerationProgress | null;
  imageUri: string | null;
  onOpenImage(): void;
}

function DrawingActivity({ stage, previewIndex }: { stage: string; previewIndex?: number }) {
  const styles = useThemedStyles(createStyles);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const started = Date.now();
    // 本次等待的计时由画布持有；阶段更新和中间预览不重置，也不参与请求裁决。
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  return <View pointerEvents="none" style={styles.activity}>
    <View style={styles.timerContent}>
      <Text accessibilityLiveRegion="polite" style={styles.status}>{stage}</Text>
      <Text style={styles.timer}>{seconds}<Text style={styles.timerUnit}> 秒</Text></Text>
      <Text style={styles.caption}>已等待{previewIndex !== undefined ? ` · 预览 ${previewIndex + 1}` : ''}</Text>
    </View>
  </View>;
}

export default function ImageGenerationCanvas({ busy, ratio, ratioLabel, progress, imageUri, onOpenImage }: Props) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const reducedMotion = useReducedMotion();
  const [showEffect, setShowEffect] = useState(busy);
  const [effectRun, setEffectRun] = useState(0);
  const [decodedUri, setDecodedUri] = useState<string | null>(null);
  const finishEffect = useCallback(() => setShowEffect(false), []);
  useEffect(() => {
    if (busy) { setShowEffect(true); setEffectRun(run => run + 1); }
  }, [busy]);
  useEffect(() => { if (!busy && !imageUri) setShowEffect(false); }, [busy, imageUri]);
  const preview = progress?.preview;
  const uri = imageUri ?? (preview ? `data:${preview.mimeType};base64,${preview.base64}` : null);
  const stage = progress ? IMAGE_GENERATION_STAGE_LABELS[progress.stage] : '正在准备';
  return <View style={styles.card}>
    <View style={styles.heading}>
      <Text style={styles.title}>{busy ? '生成中' : '预览'}</Text>
      <Text style={styles.badge}>{ratioLabel}</Text>
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel="查看生成图片" accessibilityState={{ busy }}
      disabled={!imageUri || busy} onPress={onOpenImage} style={[styles.canvas, busy && styles.canvasBusy, { aspectRatio: ratio }]}>
      <LinearGradient colors={[theme.colors.surface.input, theme.colors.background.screen]} style={StyleSheet.absoluteFillObject} />
      {uri && <Image source={{ uri }} resizeMode="contain" style={StyleSheet.absoluteFillObject}
        onLoad={() => setDecodedUri(uri)} onError={finishEffect} />}
      {!uri && !busy && <View style={styles.placeholder}>
        <ImageIcon size={32} strokeWidth={1.2} color={theme.colors.brand.primary} />
        <Text style={styles.caption}>画面将在这里呈现</Text>
      </View>}
      {showEffect && <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFillObject}>
        <ImageGenerationPixelEffect key={effectRun} reducedMotion={reducedMotion} hasPreview={busy && preview !== undefined}
          reveal={!busy && imageUri !== null && decodedUri === imageUri} onFinished={finishEffect} />
      </View>}
      {busy && <DrawingActivity stage={stage} previewIndex={preview?.index} />}
      {imageUri && !busy && <View style={styles.expand}><Expand size={17} color={theme.colors.text.primary} /></View>}
    </Pressable>
  </View>;
}
const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  card: { gap: theme.spacing.sm },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: theme.colors.text.primary, fontSize: 17, fontWeight: '600' },
  badge: { color: theme.colors.text.secondary, fontSize: 12, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: theme.colors.surface.input, borderRadius: 20 },
  canvas: { width: '100%', overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderRadius: theme.radius.lg, borderWidth: 1, borderColor: theme.colors.border.default },
  canvasBusy: { borderColor: theme.colors.border.strong },
  placeholder: { alignItems: 'center', gap: theme.spacing.md, padding: theme.spacing.xl },
  activity: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  timerContent: { alignItems: 'center', gap: theme.spacing.xs, maxWidth: '90%', padding: theme.spacing.md },
  status: { color: theme.colors.text.secondary, fontSize: 13 },
  timer: { color: theme.colors.text.primary, fontSize: 42, fontWeight: '500', fontVariant: ['tabular-nums'] },
  timerUnit: { fontSize: 16, fontWeight: '400', color: theme.colors.text.secondary },
  caption: { color: theme.colors.text.secondary, fontSize: 12, lineHeight: 18 },
  expand: { position: 'absolute', top: 12, right: 12, padding: 8, borderRadius: 20, backgroundColor: theme.colors.background.screen },
});
