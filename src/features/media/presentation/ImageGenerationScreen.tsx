import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Keyboard, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import { Button, ConfiguredModelPicker, InputField, ImageViewerModal, KeyboardAvoidingContainer, NavigationHeader } from '@shared/ui';
import { generateImageForUser, saveUserGeneratedImage, type UserGeneratedImage } from '../application/GenerateImageForUser';
import { getImageGenerationModelSettings, selectImageGenerationModel, subscribeImageGenerationModelsChanged } from '../application/ImageGenerationModels';
import type { ImageGenerationProgress } from '../application/PrepareGeneratedImage';
import { getImageSizeRatio, type ImageGenerationParameters } from '@platform/ai/imageGenerationConfig';
import { pickImageGenerationReference, releaseImageGenerationReference, type ImageGenerationReferenceSelection } from '../application/ImageGenerationReference';
import ImageGenerationCanvas from './ImageGenerationCanvas';
import ImageGenerationParametersForm from './ImageGenerationParametersForm';
import CustomImageParametersForm from './CustomImageParametersForm';
import { useCustomImageParameters } from './useCustomImageParameters';

interface Props { isActive: boolean; onBack(): void; onManageModels(): void; onUnsavedImageChange(value: boolean): void }
export default function ImageGenerationScreen({ isActive, onBack, onManageModels, onUnsavedImageChange }: Props) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UserGeneratedImage | null>(null);
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof getImageGenerationModelSettings>> | null>(null);
  const [parameters, setParameters] = useState<ImageGenerationParameters>({});
  const customParameters = useCustomImageParameters();
  const { activate: activateCustomConnection, cancel: cancelCustomCheck } = customParameters;
  const [progress, setProgress] = useState<ImageGenerationProgress | null>(null);
  const [reference, setReference] = useState<ImageGenerationReferenceSelection | null>(null);
  const [picking, setPicking] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [runRatio, setRunRatio] = useState(1);
  const [runRatioLabel, setRunRatioLabel] = useState('模型默认');
  const scroll = useRef<ScrollView>(null);
  const referenceRef = useRef<ImageGenerationReferenceSelection | null>(null);
  const pickingRef = useRef(false);
  const pickRevision = useRef(0);
  const releaseAfterRun = useRef(false);
  const request = useRef<AbortController | null>(null);
  const current = useRef<UserGeneratedImage | null>(null);
  const updateResult = useCallback((value: UserGeneratedImage | null) => {
    current.current = value; setResult(value); onUnsavedImageChange(value?.status === 'save_failed');
  }, [onUnsavedImageChange]);
  const cancel = useCallback(() => { request.current?.abort(); }, []);
  const clearReference = useCallback(() => {
    if (referenceRef.current) releaseImageGenerationReference(referenceRef.current);
    referenceRef.current = null; setReference(null);
  }, []);
  const leave = useCallback(() => {
    cancel();
    cancelCustomCheck();
    pickRevision.current++;
    if (request.current) releaseAfterRun.current = true;
    else clearReference();
    if (current.current?.status === 'save_failed') {
      if (request.current === null) current.current.image.cleanup();
      updateResult(null);
      setError('未保存的图片已随页面离开或进入后台而清理。');
    }
    setProgress(null); setViewing(false);
  }, [cancel, cancelCustomCheck, clearReference, updateResult]);
  useEffect(() => {
    let active = true;
    let revision = 0;
    let signature = '';
    const reload = async () => {
      const id = ++revision;
      try {
        const next = await getImageGenerationModelSettings();
        if (!active || id !== revision) return;
        activateCustomConnection(next.customConnection);
        const nextSignature = JSON.stringify([next.selectedModelId, next.capabilities]);
        if (signature !== nextSignature) {
          signature = nextSignature; setParameters({});
          if (!next.capabilities?.references) {
            pickRevision.current++;
            if (referenceRef.current) {
              if (request.current) releaseAfterRun.current = true;
              else clearReference();
            }
          }
        }
        setSettings(next);
      } catch (failure) { if (active && id === revision) { activateCustomConnection(null); setSettings(null); setError(`读取模型配置失败：${failure instanceof Error ? failure.message : String(failure)}`); } }
    };
    void reload();
    const unsubscribe = subscribeImageGenerationModelsChanged(() => { void reload(); });
    return () => { active = false; unsubscribe(); };
  }, [activateCustomConnection, clearReference]);
  useEffect(() => {
    if (!isActive) leave();
    const subscription = AppState.addEventListener('change', state => {
      // 相册选择由原生 Activity 持有；它的正常前后台切换不丢弃这次选图。
      if (state !== 'active' && !pickingRef.current) leave();
    });
    return () => subscription.remove();
  }, [isActive, leave]);
  useEffect(() => () => {
    pickRevision.current++;
    request.current?.abort();
    if (request.current === null && current.current?.status === 'save_failed') current.current.image.cleanup();
    if (request.current) releaseAfterRun.current = true;
    else if (referenceRef.current) releaseImageGenerationReference(referenceRef.current);
  }, []);
  const pickReference = async () => {
    if (pickingRef.current || request.current) return;
    pickingRef.current = true; setPicking(true);
    const revision = ++pickRevision.current;
    try {
      const picked = await pickImageGenerationReference();
      if (!picked) return;
      if (revision !== pickRevision.current) { releaseImageGenerationReference(picked); return; }
      clearReference(); referenceRef.current = picked; setReference(picked);
    } catch (failure) { if (revision === pickRevision.current) setError(`参考图选择失败：${failure instanceof Error ? failure.message : String(failure)}`); }
    finally { pickingRef.current = false; setPicking(false); }
  };
  const customConnection = settings?.customConnection;
  const customSize = customParameters.getParameters().size;
  const selectedSize = customSize ?? settings?.capabilities?.imageSizes?.[parameters.aspectRatio ?? '1:1'];
  const selectedRatio = selectedSize ? selectedSize.split('x').map(Number).reduce((width, height) => width / height)
    : settings?.capabilities?.referenceRequired && reference ? reference.width / reference.height
      : parameters.aspectRatio ? parameters.aspectRatio.split(':').map(Number).reduce((width, height) => width / height) : 1;
  const selectedRatioLabel = customSize ? getImageSizeRatio(customSize) : selectedSize ? `${parameters.aspectRatio ?? '默认'} · ${selectedSize.replace('x', ' × ')}`
    : settings?.capabilities?.referenceRequired ? '参考图比例' : parameters.aspectRatio ?? '模型默认';
  const run = async (retrySave: boolean) => {
    if (request.current !== null || customParameters.isChecking()) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(null); setProgress({ stage: retrySave ? 'saving' : 'preparing' });
    setRunRatio(selectedRatio);
    setRunRatioLabel(selectedRatioLabel);
    Keyboard.dismiss(); scroll.current?.scrollToEnd({ animated: true });
    const onProgress = (next: ImageGenerationProgress) => {
      if (!controller.signal.aborted) setProgress(previous => ({ ...next, preview: next.preview ?? previous?.preview }));
    };
    const previous = current.current;
    if (!retrySave) updateResult(null);
    try {
      const next = retrySave && previous?.status === 'save_failed'
        ? await saveUserGeneratedImage(previous.image, controller.signal, onProgress)
        : await generateImageForUser(prompt, controller.signal, {
          parameters: customConnection ? { custom: customParameters.getParameters() } : parameters,
          ...(customConnection ? { customConnection } : {}),
          reference: referenceRef.current ?? undefined, onProgress,
        });
      if (controller.signal.aborted) {
        if (next.status === 'save_failed') next.image.cleanup();
        return;
      }
      updateResult(next);
      setProgress(null);
    } catch (failure) {
      if (!controller.signal.aborted) setError(`生图失败：${failure instanceof Error ? failure.message : String(failure)}`);
      else if (retrySave) updateResult(null);
    } finally {
      if (request.current === controller) {
        request.current = null; setBusy(false); setProgress(null);
        if (releaseAfterRun.current) { releaseAfterRun.current = false; clearReference(); }
      }
    }
  };
  const image = result?.status === 'saved' ? result : result?.status === 'save_failed' ? result.image : null;
  const imageUri = image?.uri ?? null;
  const ratio = busy ? runRatio : image ? image.width / image.height : selectedRatio;
  return <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
    <KeyboardAvoidingContainer style={styles.screen}>
      <NavigationHeader title="AI 生图" onGoBack={onBack} />
      <ScrollView ref={scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ConfiguredModelPicker title="生图模型" unconfiguredLabel="选择一个模型" getSettings={getImageGenerationModelSettings}
          onSelect={selectImageGenerationModel} subscribeChanged={subscribeImageGenerationModelsChanged}
          disabled={busy || picking} onManageModels={onManageModels} />
        {customConnection ? <CustomImageParametersForm rows={customParameters.rows} checking={customParameters.activeField}
          disabled={busy} checkPending={customParameters.checking !== null} onChange={customParameters.change}
          onCheck={field => { if (!request.current) void customParameters.check(field); }} />
          : <ImageGenerationParametersForm capabilities={settings?.capabilities ?? null} value={parameters} onChange={setParameters}
            disabled={busy} reference={reference} picking={picking} onPickReference={() => { void pickReference(); }} onRemoveReference={clearReference} />}
        <InputField label="提示词" value={prompt} onChangeText={setPrompt} placeholder="描述想生成的画面…" autoGrow
          maxLength={settings?.capabilities?.promptMaxLength ?? 2000} editable={!busy} />
        <ImageGenerationCanvas busy={busy} ratio={ratio} ratioLabel={busy ? runRatioLabel : image ? `${image.width} × ${image.height}` : selectedRatioLabel} progress={progress} imageUri={imageUri} onOpenImage={() => setViewing(true)} />
        {error && <Text selectable accessibilityRole="alert" style={{ color: theme.colors.feedback.error }}>{error}</Text>}
        {result && <>
          <Text selectable style={result.status === 'saved' ? styles.hint : { color: theme.colors.feedback.error }}>
            {result.status === 'saved' ? `已保存到相册 · ${result.width} × ${result.height} · ${(result.byteSize / 1024 / 1024).toFixed(2)} MB` : `保存失败：${result.error}\n请重试保存。离开页面或切到后台会清理暂存，届时图片将丢失。`}
          </Text>
        </>}
      </ScrollView>
      <View style={styles.actions}>
        <Button title={busy ? '取消' : result?.status === 'save_failed' ? '重试保存' : '生成'} variant={busy ? 'secondary' : 'primary'}
          disabled={picking || customParameters.checking !== null || !busy && result?.status !== 'save_failed' && (!prompt.trim() || settings?.status !== 'active' || settings.capabilities?.referenceRequired && !reference)}
          onPress={busy ? cancel : () => { void run(result?.status === 'save_failed'); }} />
      </View>
    </KeyboardAvoidingContainer>
    {imageUri && <ImageViewerModal visible={viewing} onClose={() => setViewing(false)} sources={[{ uri: imageUri }]} />}
  </SafeAreaView>;
}
const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background.screen },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
  hint: { color: theme.colors.text.secondary, lineHeight: 22 },
  actions: { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md },
});
