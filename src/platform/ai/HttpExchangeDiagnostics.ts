import * as FileSystem from 'expo-file-system/legacy';

export interface AIHttpExchange {
  id: string;
  startedAt: string;
  completedAt: string;
  url: string;
  method: 'POST';
  model: string;
  transport: 'complete' | 'stream';
  status: number | null;
  requestBody: string;
  responseBody: string;
  error: string | null;
}

export interface AIHttpDiagnosticsSnapshot {
  enabled: boolean;
  records: AIHttpExchange[];
  error: string | null;
}

const RETENTION = 10;
const FILE_NAME = 'exchanges.json';
const REDACTED = '[REDACTED]';

function getDirectory(): string {
  if (!FileSystem.documentDirectory) {
    throw new Error('应用持久存储目录不可用');
  }
  // 开关和最近十条记录一起持久保存，系统清理缓存不能撤销用户选择或删除记录。
  return `${FileSystem.documentDirectory}ai-http-diagnostics/`;
}

function sanitizeUrl(value: string): string {
  // RN 的 URL 没有凭据 setter；直接处理 HTTP authority/query，避免旧查询被重新附加。
  const match = /^(https?:\/\/)([^/?#]+)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i.exec(value);
  if (!match) return '[无效 URL]';
  const [, scheme, authority, path, query] = match;
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  if (query === undefined) return `${scheme}${host}${path}`;
  const sanitized = query.split('&').map((field) => {
    const separator = field.indexOf('=');
    const name = separator < 0 ? field : field.slice(0, separator);
    try {
      const decoded = decodeURIComponent(name.replace(/\+/g, ' '));
      return /key|token|secret|password|passwd|authorization|credential|signature|^sig$|^auth$/i.test(decoded)
        ? `${name}=${encodeURIComponent(REDACTED)}` : field;
    } catch {
      return encodeURIComponent(REDACTED);
    }
  }).join('&');
  // fragment 不属于实际 HTTP 请求目标，也不保留其中可能存在的凭据。
  return `${scheme}${host}${path}?${sanitized}`;
}

function sanitizeExchange(exchange: AIHttpExchange, apiKey?: string): AIHttpExchange {
  const redact = (value: string): string => apiKey ? value.split(apiKey).join(REDACTED) : value;
  // 明确投影契约字段，不让调用方额外携带的 headers 等运行时属性进入文件。
  return {
    id: redact(exchange.id),
    startedAt: redact(exchange.startedAt),
    completedAt: redact(exchange.completedAt),
    url: redact(sanitizeUrl(exchange.url)),
    method: exchange.method,
    model: redact(exchange.model),
    transport: exchange.transport,
    status: exchange.status,
    requestBody: redact(exchange.requestBody),
    responseBody: redact(exchange.responseBody),
    error: exchange.error === null ? null : redact(exchange.error),
  };
}

function isExchange(value: unknown): value is AIHttpExchange {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return ['id', 'startedAt', 'completedAt', 'url', 'model', 'requestBody', 'responseBody']
    .every((key) => typeof record[key] === 'string')
    && record.method === 'POST'
    && (record.transport === 'complete' || record.transport === 'stream')
    && (record.status === null || typeof record.status === 'number')
    && (record.error === null || typeof record.error === 'string');
}

class HttpExchangeDiagnostics {
  private enabled = false;
  private records: AIHttpExchange[] = [];
  private error: string | null = null;
  private initialized = false;
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const directory = getDirectory();
      const file = `${directory}${FILE_NAME}`;
      let info = await FileSystem.getInfoAsync(file);
      // 只在长期文件尚未建立时迁移旧缓存；移动已提交文件，不恢复未提交的临时正文。
      if (!info.exists && FileSystem.cacheDirectory) {
        const legacyDirectory = `${FileSystem.cacheDirectory}ai-http-diagnostics/`;
        const legacyFile = `${legacyDirectory}${FILE_NAME}`;
        info = await FileSystem.getInfoAsync(legacyFile);
        if (info.exists) {
          await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
          await FileSystem.moveAsync({ from: legacyFile, to: file });
          await FileSystem.deleteAsync(legacyDirectory, { idempotent: true });
        }
      }
      if (info.exists) {
        const saved: unknown = JSON.parse(await FileSystem.readAsStringAsync(file));
        if (typeof saved !== 'object' || saved === null) throw new Error('文件格式无效');
        const state = saved as Record<string, unknown>;
        if (state.version !== 1 || typeof state.enabled !== 'boolean' || !Array.isArray(state.records)
          || state.records.length > RETENTION || !state.records.every(isExchange)) {
          throw new Error('文件格式无效');
        }
        this.enabled = state.enabled;
        this.records = state.records.map((record) => sanitizeExchange(record));
      }
      // 未提交的临时文件不参与恢复，避免恢复失败的写入或额外保留一份正文。
      await FileSystem.deleteAsync(`${directory}${FILE_NAME}.tmp`, { idempotent: true });
    } catch (error) {
      this.enabled = false;
      this.records = [];
      this.setError('读取', error);
    }
  }

  private setError(action: string, error: unknown): void {
    this.error = `HTTP 诊断${action}失败：${error instanceof Error ? error.message : String(error)}`;
  }

  private async persist(records: AIHttpExchange[], enabled = this.enabled): Promise<void> {
    const directory = getDirectory();
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    const file = `${directory}${FILE_NAME}`;
    // Android 同目录 rename 替换已提交文件；中断写入不会破坏上一份完整记录。
    try {
      await FileSystem.writeAsStringAsync(`${file}.tmp`, JSON.stringify({ version: 1, enabled, records }));
      await FileSystem.moveAsync({ from: `${file}.tmp`, to: file });
    } catch (error) {
      await FileSystem.deleteAsync(`${file}.tmp`, { idempotent: true });
      throw error;
    }
  }

  async getSnapshot(): Promise<AIHttpDiagnosticsSnapshot> {
    return this.enqueue(async () => {
      await this.initialize();
      return { enabled: this.enabled, records: this.records.map((record) => ({ ...record })), error: this.error };
    });
  }

  async beginCapture(): Promise<number | null> {
    const generation = this.generation;
    return this.enqueue(async () => {
      await this.initialize();
      return this.enabled && generation === this.generation ? generation : null;
    });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    // 在排队前废弃旧捕获，不能让开关后的迟到请求重新写入正文。
    if (!enabled) this.generation++;
    return this.enqueue(async () => {
      await this.initialize();
      try {
        if (!enabled) this.enabled = false;
        await this.persist(this.records, enabled);
        this.enabled = enabled;
        this.error = null;
      } catch (error) {
        this.setError(enabled ? '开启' : '关闭', error);
        throw error;
      } finally {
        this.notify();
      }
    });
  }

  async clear(): Promise<void> {
    this.generation++;
    return this.enqueue(async () => {
      await this.initialize();
      try {
        await this.persist([]);
        this.records = [];
        this.error = null;
      } catch (error) {
        this.setError('清空', error);
        throw error;
      } finally {
        this.notify();
      }
    });
  }

  async reset(): Promise<void> {
    this.generation++;
    return this.enqueue(async () => {
      this.initialized = true;
      this.enabled = false;
      try {
        await FileSystem.deleteAsync(getDirectory(), { idempotent: true });
        // 恢复出厂同时移除尚未迁移的旧文件，避免下一次启动重新导入。
        if (FileSystem.cacheDirectory) {
          await FileSystem.deleteAsync(`${FileSystem.cacheDirectory}ai-http-diagnostics/`, { idempotent: true });
        }
        this.records = [];
        this.error = null;
      } catch (error) {
        this.setError('重置', error);
        throw error;
      } finally {
        this.notify();
      }
    });
  }

  async record(exchange: AIHttpExchange, apiKey?: string, captureGeneration = this.generation): Promise<void> {
    return this.enqueue(async () => {
      await this.initialize();
      if (!this.enabled || captureGeneration !== this.generation) return;
      try {
        const records = [sanitizeExchange(exchange, apiKey), ...this.records].slice(0, RETENTION);
        await this.persist(records);
        this.records = records;
        this.error = null;
      } catch (error) {
        // 捕获失败只进入诊断状态，不改变模型请求的成败。
        this.setError('保存', error);
      }
      this.notify();
    });
  }
}

export const aiHttpDiagnostics = new HttpExchangeDiagnostics();
