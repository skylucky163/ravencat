export interface CallHistoryRecord {
  callId: string;
  assistantId: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  mediaMode: 'voice' | 'video';
}

export interface CallHistoryEntry {
  id: string;
  callId: string;
  speaker: 'user' | 'ai';
  inputKind: 'text' | 'speech';
  text: string;
  mediaAssetId: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface CallInputAudio {
  uri: string;
  durationMs: number;
}

export interface CallHistoryImage {
  id: string;
  callId: string;
  mediaAssetId: string;
  createdAt: string;
}

export type CallHistoryPageEntry =
  | { kind: 'message'; id: string; createdAt: string; speaker: 'user' | 'ai'; text: string }
  | { kind: 'image'; id: string; createdAt: string; mediaAssetId: string };

export interface CallHistoryPage {
  call: CallHistoryRecord;
  entries: CallHistoryPageEntry[];
  nextOffset: number | null;
}

/** 显式拼出本地日期，避免设备 locale 的窄空格、方向符等进入标题。 */
export function formatCallHistoryTitle(timestamp: string): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
