import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text } from 'react-native';
import { Button, InputField } from '@shared/ui';
import { useTheme } from '@shared/theme';
import {
  realtimeSpeechAudioSource,
  localAudioPlaybackPort,
  temporarySpeechAudioStore,
  requestMicrophonePermission,
  type LocalAudioPlaybackSession,
  type RealtimeSpeechAudioSourceSession,
} from '@platform/device';
import { synthesizeConfiguredSpeech } from '../SynthesizeConfiguredSpeech';
import { startRealtimeSpeechToText, type RealtimeSpeechToTextSession } from '../StartRealtimeSpeechToText';
import type { SpeechConnectionConfig, SpeechKind } from '../domain/SpeechProvider';

interface TestRun {
  controller: AbortController;
  recognition?: RealtimeSpeechToTextSession;
  microphone?: RealtimeSpeechAudioSourceSession;
  microphoneStarting?: Promise<RealtimeSpeechAudioSourceSession>;
  finished?: Promise<void>;
  audioUri?: string;
  playback?: LocalAudioPlaybackSession;
  playbackStarting?: Promise<LocalAudioPlaybackSession>;
}
/** 设置页只持有一次临时测试；麦克风、播放器和正式调用协议继续使用已有 owner。 */
export function SpeechConfigurationTest({
  kind,
  getConfiguration,
  configurationRevision,
}: {
  kind: SpeechKind;
  getConfiguration(): SpeechConnectionConfig | null;
  configurationRevision: string;
}) {
  const theme = useTheme();
  const [text, setText] = useState('你好，我在这里。Take your time. I am right here with you.');
  const [expected, setExpected] = useState('');
  const [transcript, setTranscript] = useState('');
  const [status, setStatus] = useState<
    'idle' | 'starting' | 'listening' | 'finishing' | 'generating' | 'ready' | 'playing' | 'paused'
  >('idle');
  const [error, setError] = useState<string | null>(null);
  const active = useRef<TestRun | null>(null);
  const cleanup = useRef<Promise<void>>(Promise.resolve());
  const action = useRef(false);
  const revision = useRef(0);
  const invalidate = useCallback(() => {
    revision.current++;
  }, []);
  const dispose = useCallback(() => {
    const run = active.current;
    active.current = null;
    if (!run) return cleanup.current;
    run.controller.abort();
    run.recognition?.close();
    const work = (async () => {
      try {
        await (run.microphone ?? (await run.microphoneStarting))?.stop();
      } finally {
        try {
          await (run.playback ?? (await run.playbackStarting))?.stop();
        } finally {
          if (run.audioUri) await temporarySpeechAudioStore.deleteIfExists(run.audioUri);
        }
      }
    })();
    // 释放失败由发起动作报告；完成屏障不把旧错误传给下一次测试。
    cleanup.current = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }, []);
  useEffect(() => {
    setStatus('idle');
    setTranscript('');
    setError(null);
    void dispose().catch((cause) => console.warn('[SpeechTest] 清理失败', cause));
    return () => {
      invalidate();
      void dispose().catch((cause) => console.warn('[SpeechTest] 清理失败', cause));
    };
  }, [configurationRevision, dispose, invalidate]);
  const fail = async (run: TestRun, cause: unknown) => {
    if (active.current !== run) return;
    const message = cause instanceof Error ? cause.message : '语音测试失败';
    setError(message);
    try {
      await dispose();
    } catch (cleanupError) {
      setError(
        `${message}；清理失败：${cleanupError instanceof Error ? cleanupError.message : '资源释放失败'}`,
      );
    }
    if (!active.current) setStatus('idle');
  };
  const generate = async () => {
    const startedAt = revision.current;
    const configuration = getConfiguration();
    if (!configuration) return;
    if (!text.trim()) {
      setError('请输入测试文本');
      return;
    }
    await dispose();
    if (revision.current !== startedAt) return;
    const run: TestRun = { controller: new AbortController() };
    active.current = run;
    setStatus('generating');
    setError(null);
    try {
      const result = await synthesizeConfiguredSpeech({
        configuration,
        text: text.trim(),
        signal: run.controller.signal,
      });
      if (active.current !== run) {
        await temporarySpeechAudioStore.deleteIfExists(result.audioUri);
        return;
      }
      run.audioUri = result.audioUri;
      setStatus('ready');
    } catch (cause) {
      await fail(run, cause);
    }
  };
  const play = async () => {
    const run = active.current!;
    try {
      if (status === 'playing') {
        await run.playback!.pause();
        if (active.current === run) setStatus('paused');
        return;
      }
      if (status === 'paused') {
        await run.playback!.resume();
        if (active.current === run) setStatus('playing');
        return;
      }
      await run.playback?.stop();
      if (active.current !== run) return;
      run.playbackStarting = localAudioPlaybackPort.play(run.audioUri!);
      run.playback = await run.playbackStarting;
      if (active.current !== run) {
        await run.playback.stop();
        return;
      }
      run.playback.subscribe((snapshot) => {
        if (active.current !== run) return;
        if (snapshot.state === 'error') {
          void fail(run, new Error(snapshot.errorMessage));
          return;
        }
        setStatus(snapshot.state === 'ended' ? 'ready' : snapshot.state);
      });
    } catch (cause) {
      await fail(run, cause);
    }
  };
  const startRecognition = async () => {
    const startedAt = revision.current;
    const configuration = getConfiguration();
    if (!configuration) return;
    await dispose();
    if (revision.current !== startedAt) return;
    const run: TestRun = { controller: new AbortController() };
    active.current = run;
    setStatus('starting');
    setError(null);
    setTranscript('');
    const segments = new Map<number, string>();
    let complete!: () => void;
    let reject!: (error: Error) => void;
    run.finished = new Promise<void>((resolve, fail) => {
      complete = resolve;
      reject = fail;
    });
    void run.finished.catch(() => undefined);
    try {
      if (!(await requestMicrophonePermission())) throw new Error('请允许麦克风权限后测试');
      if (active.current !== run) return;
      const started = await startRealtimeSpeechToText({
        configuration,
        signal: run.controller.signal,
        onInterimTranscript: (result) => {
          if (active.current === run) setTranscript([...segments.values(), result.text].join(''));
        },
        onFinalTranscript: (result) => {
          segments.set(result.index, result.text);
          if (active.current === run)
            setTranscript(
              [...segments.entries()]
                .sort(([a], [b]) => a - b)
                .map(([, value]) => value)
                .join(''),
            );
        },
        onFinished: complete,
        onError: (info) => {
          reject(new Error(info.message));
          void fail(run, new Error(info.message));
        },
      });
      if (started.success === false) throw new Error(started.rawError);
      run.recognition = started.session;
      if (active.current !== run) {
        started.session.close();
        return;
      }
      run.microphoneStarting = realtimeSpeechAudioSource.start({
        onAudioChunk: (chunk) => {
          if (active.current !== run) return;
          try {
            started.session.sendAudioChunk(chunk);
          } catch (cause) {
            void fail(run, cause);
          }
        },
        onError: (cause) => {
          void fail(run, cause);
        },
      });
      const microphone = await run.microphoneStarting;
      if (active.current !== run) {
        await microphone.stop();
        return;
      }
      run.microphone = microphone;
      setStatus('listening');
    } catch (cause) {
      await fail(run, cause);
    }
  };
  const finishRecognition = async () => {
    const run = active.current!;
    setStatus('finishing');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await run.microphone!.stop();
      run.microphone = undefined;
      if (active.current !== run) return;
      run.recognition!.finish();
      await Promise.race([
        run.finished!,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('识别结束超时')), 10_000);
        }),
      ]);
      if (active.current === run) {
        await dispose();
        if (!active.current) setStatus('idle');
      }
    } catch (cause) {
      await fail(run, cause);
    } finally {
      clearTimeout(timer);
    }
  };
  const busy = ['starting', 'finishing', 'generating'].includes(status);
  const perform = async (work: () => Promise<void>) => {
    if (action.current) return;
    action.current = true;
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '语音测试失败');
      setStatus('idle');
    } finally {
      action.current = false;
    }
  };
  return (
    <View>
      {kind === 'tts' ? (
        <>
          <InputField label="测试文本" value={text} onChangeText={setText} multiline />
          <Button
            title={status === 'generating' ? '生成中…' : '生成测试语音'}
            onPress={() => {
              void perform(generate);
            }}
            disabled={busy}
            variant="secondary"
          />
          {['ready', 'playing', 'paused'].includes(status) ? (
            <Button
              title={status === 'playing' ? '暂停' : status === 'paused' ? '继续播放' : '播放'}
              onPress={() => {
                void perform(play);
              }}
              variant="secondary"
            />
          ) : null}
        </>
      ) : (
        <>
          <InputField
            label="预期识别文本（可选）"
            value={expected}
            onChangeText={setExpected}
            multiline
          />
          <Button
            title={
              status === 'listening'
                ? '停止并完成识别'
                : status === 'starting'
                  ? '连接中…'
                  : status === 'finishing'
                    ? '等待最终结果…'
                    : '开始实时识别'
            }
            onPress={() => {
              void perform(status === 'listening' ? finishRecognition : startRecognition);
            }}
            disabled={busy}
            variant="secondary"
          />
          <Text selectable style={{ color: theme.colors.text.primary, marginTop: theme.spacing.md }}>
            {transcript || '识别结果会显示在这里'}
          </Text>
        </>
      )}
      {error ? (
        <Text
          selectable
          accessibilityRole="alert"
          style={{ color: theme.colors.feedback.error, marginTop: theme.spacing.sm }}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}
