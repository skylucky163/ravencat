import { fetch } from 'expo/fetch';
import { Directory, File, Paths } from 'expo-file-system';
import { createRandomUUID, getCachedZipReader } from '@platform/device';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import type { DeepSeekExportArchive } from '../domain/DeepSeekImport';
import { parseDeepSeekExportConversation, parseDeepSeekExportIndex, readDeepSeekExportLink, validateDeepSeekExportManifest } from './DeepSeekExportProtocol';
import { materializeDeepSeekAttachments } from './DeepSeekImportAttachments';

const MIB = 1024 * 1024;
const ZIP_BYTES = 512 * MIB;

async function downloadArchive(url: string, file: File, signal: AbortSignal): Promise<void> {
  throwIfAbortSignalAborted(signal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 600_000);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit', redirect: 'error' }).catch(() => {
      throw new Error('无法连接 DeepSeek，请检查网络后重试。');
    });
    if (response.status === 403 || response.status === 404) {
      throw new Error(`DeepSeek 导出链接无法下载（HTTP ${response.status}），请获取新的导出链接。`);
    }
    if (!response.ok) throw new Error(`DeepSeek 请求失败（HTTP ${response.status}）。`);
    if (!response.body) throw new Error('DeepSeek 返回了空响应。');
    if (Number(response.headers.get('content-length')) > ZIP_BYTES) {
      throw new Error('DeepSeek ZIP 超过导入大小上限。');
    }
    file.create();
    const handle = file.open();
    const reader = response.body.getReader();
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read().catch(() => {
          throw new Error('DeepSeek ZIP 下载中断。');
        });
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > ZIP_BYTES) throw new Error('DeepSeek ZIP 超过导入大小上限。');
        handle.writeBytes(chunk.value);
      }
    } finally {
      reader.releaseLock();
      handle.close();
    }
  } catch (error) {
    throwIfAbortSignalAborted(signal);
    if (controller.signal.aborted) throw new Error('DeepSeek ZIP 下载超时，请重试。');
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    controller.abort();
  }
}

export async function openDeepSeekArchive(link: string, signal: AbortSignal): Promise<DeepSeekExportArchive> {
  const url = readDeepSeekExportLink(link);
  const zip = getCachedZipReader();
  if (!zip) throw new Error('当前安装版本无法读取 ZIP，请更新 RavenCat 后重试。');

  const directory = new Directory(Paths.cache, `deepseek-export-${createRandomUUID()}`);
  directory.create();
  const archive = new File(directory, 'history.zip');
  const dispose = () => {
    try { directory.delete(); }
    catch { console.warn('[DeepSeekImport] 临时 ZIP 清理失败'); }
  };
  const readJson = async (entry: string, limit: number, signal: AbortSignal): Promise<unknown> => {
    throwIfAbortSignalAborted(signal);
    const content = await zip.readText(archive.uri, entry, limit).catch(() => {
      throw new Error('无法读取 DeepSeek ZIP，压缩包可能不完整。');
    });
    throwIfAbortSignalAborted(signal);
    if (content === null) throw new Error('DeepSeek ZIP 缺少所需文件，或文件超过读取上限。');
    try { return JSON.parse(content); }
    catch { throw new Error('无法读取 DeepSeek ZIP 中的对话数据。'); }
  };
  try {
    await downloadArchive(url, archive, signal);
    validateDeepSeekExportManifest(await readJson('manifest.json', 64 * 1024, signal));
    const conversations = parseDeepSeekExportIndex(await readJson('chat_session_index.json', 12 * MIB, signal));
    return {
      conversations,
      async readConversation(id, signal) {
        const data = await readJson(`chat_sessions/${id}.json`, 24 * MIB, signal);
        return parseDeepSeekExportConversation(id, data);
      },
      extractAttachments(conversation, signal) {
        return materializeDeepSeekAttachments(conversation, signal,
          (path, targetUri, limit) => zip.extract(archive.uri, path, targetUri, limit));
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
