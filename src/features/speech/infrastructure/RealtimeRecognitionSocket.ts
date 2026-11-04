import type {
  RealtimeRecognitionConnection,
  RealtimeRecognitionHandlers,
  SpeechConnectionConfig,
} from '../domain/SpeechProvider';

interface RecognitionSocketControl {
  send(data: string | ArrayBuffer): void;
  ready(): void;
  complete(): void;
}
interface RecognitionSocketProtocol {
  onOpen(): void;
  onMessage(data: unknown): void;
  sendAudioChunk(chunk: ArrayBuffer): void;
  finish(): void;
}

/** 两种协议共用连接所有权；只有协议确认初始化后才交付会话，取消后丢弃迟到事件。 */
export function connectRecognitionSocket(
  config: SpeechConnectionConfig,
  provider: string,
  headers: Record<string, string>,
  handlers: RealtimeRecognitionHandlers,
  createProtocol: (control: RecognitionSocketControl) => RecognitionSocketProtocol,
  signal?: AbortSignal,
): Promise<RealtimeRecognitionConnection> {
  if (signal?.aborted) return Promise.reject(new Error('实时语音识别已取消'));
  return new Promise((resolve, reject) => {
    // Android 的原生 WebSocket 支持握手 headers 与二进制 ArrayBuffer。
    const NativeWebSocket = WebSocket as unknown as {
      new (url: string, protocols: null, options: { headers: Record<string, string> }): WebSocket;
    };
    const socket = new NativeWebSocket(config.baseURL, null, { headers });
    socket.binaryType = 'arraybuffer';
    let ready = false;
    let closed = false;
    let networkFailed = false;
    let timer: ReturnType<typeof setTimeout>;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      socket.close();
    };
    const fail = (cause: unknown) => {
      if (closed) return;
      let message = cause instanceof Error ? cause.message : String(cause);
      if (config.apiKey) {
        for (const secret of new Set([config.apiKey, JSON.stringify(config.apiKey).slice(1, -1), encodeURIComponent(config.apiKey)]))
          message = message.split(secret).join('[REDACTED]');
      }
      const error = new Error(message);
      try {
        if (!ready) reject(error);
        else handlers.onError?.(error);
      } finally { close(); }
    };
    const cancel = () => {
      if (!ready) reject(new Error('实时语音识别已取消'));
      close();
    };
    const protocol = createProtocol({
      send: data => socket.send(data),
      ready: () => {
        if (ready) return;
        ready = true;
        clearTimeout(timer);
        resolve({
          sendAudioChunk: chunk => { if (!closed) protocol.sendAudioChunk(chunk); },
          finish: () => { if (!closed) protocol.finish(); },
          close,
        });
      },
      complete: () => {
        if (!ready) throw new Error(`${provider} 在初始化前结束了识别`);
        try { handlers.onFinished?.(); }
        finally { close(); }
      },
    });
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => fail(new Error(`${provider} 实时语音识别连接超时`)), 15_000);
    socket.onopen = () => {
      if (closed) return;
      try { protocol.onOpen(); } catch (error) { fail(error); }
    };
    socket.onmessage = event => {
      if (closed) return;
      try { protocol.onMessage(event.data); } catch (error) { fail(error); }
    };
    // React Native 先发无详情的 error，再以 close.reason 交付原生错误；不能在 error 中提前关闭并丢掉原因。
    socket.onerror = () => { networkFailed = true; };
    socket.onclose = event => {
      if (!closed) fail(new Error(networkFailed
        ? `${provider} STT WebSocket 网络失败（code=${event.code}）：${event.reason}`
        : `${provider} 实时语音识别连接提前关闭（code=${event.code}）：${event.reason}`));
    };
  });
}
