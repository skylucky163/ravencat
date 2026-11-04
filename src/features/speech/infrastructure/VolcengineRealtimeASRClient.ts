import { createRandomUUID } from '@platform/device';
import type { RealtimeRecognitionHandlers, SpeechConnectionConfig, SpeechMetadata } from '../domain/SpeechProvider';
import { connectRecognitionSocket } from './RealtimeRecognitionSocket';

interface VolcengineUtterance {
  start_time: number;
  end_time: number;
  text: string;
  definite: boolean;
}

/** v3 使用带序号的二进制帧；协商无压缩，响应沿用同一压缩方式，不引入额外编解码依赖。 */
export function connectVolcengineRealtimeASR(
  config: SpeechConnectionConfig,
  metadata: SpeechMetadata,
  handlers: RealtimeRecognitionHandlers,
  signal?: AbortSignal,
) {
  const requestId = createRandomUUID();
  return connectRecognitionSocket(config, '火山引擎', {
    'X-Api-Key': config.apiKey,
    'X-Api-Resource-Id': config.model,
    'X-Api-Request-Id': requestId,
  }, handlers, control => {
    let sequence = 1;
    let finishing = false;
    let finalEndTime = -1;
    let currentStartTime = -1;
    return {
      onOpen: () => control.send(encodeRequest(1, sequence++, new TextEncoder().encode(JSON.stringify({
        user: { uid: requestId },
        audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
        request: {
          model_name: 'bigmodel', enable_itn: true, enable_punc: true,
          show_utterances: true, result_type: 'single',
          enable_nonstream: metadata.enableNonstream ?? true,
        },
      })))),
      sendAudioChunk: chunk => {
        if (finishing) throw new Error('火山引擎语音识别已经结束音频输入');
        control.send(encodeRequest(2, sequence++, new Uint8Array(chunk)));
      },
      finish: () => {
        if (finishing) return;
        finishing = true;
        // 负序号只结束音频输入；收到服务端负包后才能宣布识别完成。
        control.send(encodeRequest(2, -sequence++, new Uint8Array()));
      },
      onMessage: data => {
        const { payload, last } = decodeResponse(data);
        const utterances = readUtterances(payload.result);
        control.ready();
        for (const utterance of utterances) {
          // 定稿结果可能随累计响应再次出现；时间水位只提交每个分句一次。
          if (utterance.end_time <= finalEndTime) continue;
          const transcript = { index: utterance.start_time, text: utterance.text, startTime: utterance.start_time, endTime: utterance.end_time };
          if (currentStartTime !== transcript.startTime) {
            currentStartTime = transcript.startTime;
            handlers.onSpeechStart?.(transcript);
          }
          if (utterance.definite) {
            finalEndTime = transcript.endTime;
            handlers.onFinalTranscript?.(transcript);
          } else handlers.onInterimTranscript?.(transcript);
        }
        if (last) control.complete();
      },
    };
  }, signal);
}

/** 首包与后续识别结果在同一网络边界解码，初始化失败不能先交付一个已经关闭的会话。 */
function readUtterances(result: unknown): VolcengineUtterance[] {
  if (result == null) return [];
  if (typeof result !== 'object' || Array.isArray(result)) throw new Error('火山引擎返回了无效识别结果');
  const value = result as { text?: unknown; utterances?: unknown };
  if (value.utterances === undefined && !value.text) return [];
  if (!Array.isArray(value.utterances)) throw new Error('火山引擎未返回请求的语音分句信息');
  for (const utterance of value.utterances) {
    if (!utterance || !Number.isSafeInteger(utterance.start_time) || !Number.isSafeInteger(utterance.end_time)
      || utterance.start_time < 0 || utterance.end_time < utterance.start_time
      || typeof utterance.text !== 'string' || typeof utterance.definite !== 'boolean')
      throw new Error('火山引擎返回了无效语音分句');
  }
  return value.utterances;
}

function encodeRequest(type: 1 | 2, sequence: number, payload: Uint8Array): ArrayBuffer {
  const frame = new Uint8Array(12 + payload.byteLength);
  frame.set([0x11, (type << 4) | (sequence < 0 ? 3 : 1), type === 1 ? 0x10 : 0, 0]);
  const view = new DataView(frame.buffer);
  view.setInt32(4, sequence);
  view.setUint32(8, payload.byteLength);
  frame.set(payload, 12);
  return frame.buffer;
}

function decodeResponse(data: unknown): { payload: { result?: unknown }; last: boolean } {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 8) throw new Error('火山引擎返回了无效二进制帧');
  const view = new DataView(data);
  const header = view.getUint8(0);
  const type = view.getUint8(1) >> 4;
  const flags = view.getUint8(1) & 15;
  const serialization = view.getUint8(2) >> 4;
  const compression = view.getUint8(2) & 15;
  let offset = (header & 15) * 4;
  if (header >> 4 !== 1 || offset < 4 || (type !== 9 && type !== 15) || compression !== 0)
    throw new Error('火山引擎响应不符合协商的 v3 无压缩协议');
  if (flags & 1) offset += 4;
  if (flags & 4) offset += 4;
  if (offset + (type === 15 ? 8 : 4) > data.byteLength) throw new Error('火山引擎响应头不完整');
  const code = type === 15 ? view.getInt32(offset) : 0;
  if (type === 15) offset += 4;
  const size = view.getUint32(offset);
  offset += 4;
  if (offset + size !== data.byteLength) throw new Error('火山引擎响应长度无效');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(data, offset, size));
  if (type === 15) throw new Error(`火山引擎 STT code=${code}: ${text}`);
  if (serialization !== 1) throw new Error('火山引擎响应必须为 JSON');
  const payload = JSON.parse(text);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('火山引擎识别响应格式无效');
  if (payload.code != null && payload.code !== 0 && payload.code !== 20000000)
    throw new Error(`火山引擎 STT code=${payload.code}: ${payload.message}`);
  return { payload, last: (flags & 2) !== 0 };
}
