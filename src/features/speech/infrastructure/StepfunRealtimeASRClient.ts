import { createRandomUUID } from '@platform/device';
import type { RealtimeRecognitionHandlers, SpeechConnectionConfig, SpeechMetadata } from '../domain/SpeechProvider';
import { audioBytesToBase64 } from './speechAudioEncoding';
import { connectRecognitionSocket } from './RealtimeRecognitionSocket';

interface TranscriptionItem {
  index: number;
  startTime: number;
}

/** 通话由服务端 VAD 持续断句；单段录音关闭自动提交，finish 的 commit 对应最后结果屏障。 */
export function connectStepfunRealtimeASR(
  config: SpeechConnectionConfig,
  metadata: SpeechMetadata,
  handlers: RealtimeRecognitionHandlers,
  continuous: boolean,
  signal?: AbortSignal,
) {
  return connectRecognitionSocket(config, '阶跃星辰', { Authorization: `Bearer ${config.apiKey}` }, handlers, control => {
    const items = new Map<string, TranscriptionItem>();
    let nextIndex = 0;
    let audioBytes = 0;
    let finishing = false;
    const send = (type: string, fields: Record<string, unknown> = {}) =>
      control.send(JSON.stringify({ event_id: createRandomUUID(), type, ...fields }));
    const itemFor = (id: unknown): TranscriptionItem => {
      if (typeof id !== 'string' || !id) throw new Error('阶跃星辰返回了无效语音片段 ID');
      let item = items.get(id);
      if (!item) {
        item = { index: nextIndex++, startTime: 0 };
        items.set(id, item);
      }
      return item;
    };
    return {
      onOpen: () => send('session.update', { session: { audio: { input: {
        format: { type: 'pcm', codec: 'pcm_s16le', rate: 16000, bits: 16, channel: 1 },
        transcription: {
          model: config.model, enable_itn: true, enable_timestamp_align: true,
          ...(metadata.language ? { language: metadata.language } : {}),
          ...(metadata.prompt ? { prompt: metadata.prompt } : {}),
          full_rerun_on_commit: metadata.fullRerunOnCommit ?? false,
        },
        ...(continuous ? { turn_detection: { type: 'server_vad', silence_duration_ms: 800, threshold: 0.6 } } : {}),
      } } } }),
      sendAudioChunk: chunk => {
        if (finishing) throw new Error('阶跃星辰语音识别已经结束音频输入');
        audioBytes += chunk.byteLength;
        send('input_audio_buffer.append', { audio: audioBytesToBase64(chunk) });
      },
      finish: () => {
        if (finishing) return;
        finishing = true;
        if (audioBytes === 0) control.complete();
        else send('input_audio_buffer.commit');
      },
      onMessage: data => {
        if (typeof data !== 'string') throw new Error('阶跃星辰识别响应必须为 JSON 文本');
        const message = JSON.parse(data);
        if (!message || typeof message !== 'object' || typeof message.type !== 'string')
          throw new Error('阶跃星辰识别响应格式无效');
        switch (message.type) {
          case 'session.updated':
            control.ready();
            break;
          case 'conversation.item.input_audio_transcription.delta': {
            if (typeof message.text !== 'string' || (message.stash != null && typeof message.stash !== 'string'))
              throw new Error('阶跃星辰返回了无效实时识别文本');
            const item = itemFor(message.item_id);
            // 当前模型的 text 是累计正文，stash 是可能修订的尾部，不能把每个 delta 再次拼接。
            handlers.onInterimTranscript?.({ ...item, text: message.text + (message.stash ?? ''), endTime: audioBytes / 32 });
            break;
          }
          case 'conversation.item.input_audio_transcription.completed': {
            if (typeof message.transcript !== 'string') throw new Error('阶跃星辰返回了无效最终识别文本');
            const item = itemFor(message.item_id);
            // 精确字级时间戳沿采集时间轴交给通话录音归档，不能用网络响应时刻推测片段时间。
            if (message.transcript.trim()) {
              if (!Array.isArray(message.words) || message.words.length === 0
                || message.words.some((word: any) => !Number.isFinite(word.start) || !Number.isFinite(word.end)
                  || word.start < 0 || word.end < word.start))
                throw new Error('阶跃星辰未返回请求的有效字级时间戳');
              handlers.onFinalTranscript?.({
                index: item.index, text: message.transcript,
                startTime: Math.round(message.words[0].start * 1000),
                endTime: Math.round(message.words[message.words.length - 1].end * 1000),
              });
            }
            items.delete(message.item_id);
            // 提交项与实际转写片段使用不同 ID；只有转写事件拥有待完成片段，不能把 created/committed 加入集合。
            if (finishing && items.size === 0) control.complete();
            break;
          }
          case 'error':
            throw new Error(`阶跃星辰 STT ${message.error.code}: ${message.error.message}`);
        }
      },
    };
  }, signal);
}
