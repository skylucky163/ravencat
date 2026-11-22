/** 在 HTTP 边界旁路采集原文；诊断存储失败不得改变模型调用结果。 */
import { aiHttpDiagnostics } from './HttpExchangeDiagnostics';
import type { AIProtocolIssue } from './types';

export interface AIHttpCapture {
  setResponse(status: number, rawText: string): void;
  appendResponse(rawChunk: string): void;
  finish(error?: unknown, protocolIssues?: readonly AIProtocolIssue[]): Promise<void>;
}

export async function beginAIHttpCapture(request: {
  url: string;
  requestBody: string;
  model: string;
  transport: 'complete' | 'stream';
}, apiKey: string): Promise<AIHttpCapture | null> {
  let generation: number | null;
  try { generation = await aiHttpDiagnostics.beginCapture(); }
  catch { return null; }
  if (generation === null) return null;

  const startedAt = new Date().toISOString();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let status: number | null = null;
  let responseBody = '';
  return {
    setResponse(code, rawText) { status = code; responseBody = rawText; },
    appendResponse(chunk) { responseBody += chunk; },
    async finish(error, protocolIssues) {
      try {
        await aiHttpDiagnostics.record({
          ...request, id, startedAt, completedAt: new Date().toISOString(), method: 'POST',
          status, responseBody,
          error: error === undefined ? null : error instanceof Error ? error.message : String(error),
          ...(protocolIssues?.length ? { protocolIssues: [...protocolIssues] } : {}),
        }, apiKey, generation);
      } catch { /* 存储层在诊断页暴露错误；不把旁路故障升级为聊天失败。 */ }
    },
  };
}
