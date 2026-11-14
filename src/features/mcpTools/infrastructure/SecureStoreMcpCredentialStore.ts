import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';
import type { McpCredentialStore } from '../domain/McpCredentialStore';

/** Android Keystore 加密存储；无需前台生物认证，Headless 与前台共用凭据。 */
export const secureStoreMcpCredentialStore: McpCredentialStore = {
  async save(token) {
    const reference = `mcp.token.${randomUUID()}`;
    await SecureStore.setItemAsync(reference, token);
    return reference;
  },
  read: (reference) => SecureStore.getItemAsync(reference),
  delete: (reference) => SecureStore.deleteItemAsync(reference),
};

interface McpCredentialBackupEntry {
  reference: string;
  token: string | null;
}

function parseMcpCredentialsBackup(input: unknown): McpCredentialBackupEntry[] {
  if (!Array.isArray(input)) throw new Error('备份 MCP 凭据无效');
  const seen = new Set<string>();
  return input.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('备份 MCP 凭据无效');
    const { reference, token } = entry as Record<string, unknown>;
    // 外部备份只能写入 MCP 自己的凭据命名空间，不能覆盖其他安全存储项。
    if (typeof reference !== 'string'
      || !/^mcp\.token\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(reference)
      || seen.has(reference)
      || (token !== null && (typeof token !== 'string' || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)))) {
      throw new Error('备份 MCP 凭据无效');
    }
    seen.add(reference);
    return { reference, token: token as string | null };
  });
}

export async function readMcpCredentialsBackup(references: readonly string[]): Promise<McpCredentialBackupEntry[]> {
  return Promise.all(references.map(async reference => ({
    reference,
    token: await secureStoreMcpCredentialStore.read(reference),
  })));
}

export function validateMcpCredentialsBackup(input: unknown, references: readonly string[]): void {
  const entries = parseMcpCredentialsBackup(input);
  const expected = new Set(references);
  if (entries.length !== expected.size || entries.some(entry => !expected.has(entry.reference))) {
    throw new Error('备份 MCP 凭据与数据库引用不一致');
  }
}

/** 保留数据库引用与授权事实；失败时由恢复流程重放原稳定设置快照。 */
export async function restoreMcpCredentialsBackup(input: unknown): Promise<void> {
  const entries = parseMcpCredentialsBackup(input);
  for (const { reference, token } of entries) {
    // null 表达原本缺失，也让补偿回滚能撤销同名引用的新值。
    if (token === null) await SecureStore.deleteItemAsync(reference);
    else await SecureStore.setItemAsync(reference, token);
  }
}
