/** 创建或更新服务；地址或认证身份改变时原子清除旧连接与授权。 */

import type { McpServerConfig, McpServerAuthMode } from '../domain/McpServerConfig';
import { getMcpToolsRuntimeDependencies } from './McpToolsRuntimeDependencies';
import { McpConfigError } from './McpConfigError';
import { validateMcpServerEndpoint } from './McpEndpointValidator';

/** 限制会进入 MCP 提示词的用户可编辑文本，避免单个 Server 无界膨胀上下文。 */
export const MCP_SERVER_NAME_MAX_LENGTH = 100;
export const MCP_SERVER_DESCRIPTION_MAX_LENGTH = 500;

export interface SaveMcpServerUseCaseInput {
  id: string | null;
  name: string;
  url: string;
  description: string;
  assistantIds: readonly string[];
  enabled: boolean;
  authMode?: McpServerAuthMode;
  /** 省略表示保留已有凭据；明文只在配置写入边界短暂存在。 */
  bearerToken?: string;
}

export async function saveMcpServer(input: SaveMcpServerUseCaseInput): Promise<McpServerConfig> {
  const runtime = getMcpToolsRuntimeDependencies();
  const hasNameControlCharacter = Array.from(input.name).some((character) => {
    const codeUnit = character.charCodeAt(0);
    return codeUnit <= 0x1f
      || (codeUnit >= 0x7f && codeUnit <= 0x9f)
      || codeUnit === 0x2028
      || codeUnit === 0x2029;
  });
  if (hasNameControlCharacter) {
    throw new McpConfigError('NAME_INVALID', '显示名称不能包含换行或控制字符');
  }
  const name = input.name.trim();
  if (!name) {
    throw new McpConfigError('NAME_REQUIRED', '显示名称不能为空');
  }
  if (name.length > MCP_SERVER_NAME_MAX_LENGTH) {
    throw new McpConfigError(
      'NAME_TOO_LONG',
      `显示名称不能超过 ${MCP_SERVER_NAME_MAX_LENGTH} 个字符`,
    );
  }
  const description = input.description.replace(/\r\n?/g, '\n').trim();
  if (description.length > MCP_SERVER_DESCRIPTION_MAX_LENGTH) {
    throw new McpConfigError(
      'DESCRIPTION_TOO_LONG',
      `服务简介不能超过 ${MCP_SERVER_DESCRIPTION_MAX_LENGTH} 个字符`,
    );
  }
  const endpoint = validateMcpServerEndpoint(input.url);

  const nowIso = new Date().toISOString();
  const existing = input.id
    ? await runtime.serverConfigRepository.getById(input.id)
    : null;
  if (input.id && !existing) {
    throw new McpConfigError('SERVER_NOT_FOUND', 'MCP Server 不存在');
  }
  if (!existing && input.assistantIds.length === 0) {
    throw new McpConfigError('ASSISTANT_REQUIRED', '新增 MCP 服务请至少选择一位生效 AI');
  }

  const duplicate = (await runtime.serverConfigRepository.list()).some(
    (server) => server.id !== input.id && server.name.trim() === name,
  );
  if (duplicate) {
    throw new McpConfigError('NAME_CONFLICT', '已有同名 MCP Server，请换一个名称');
  }

  const authMode = input.authMode ?? existing?.authMode ?? 'none';
  const token = input.bearerToken?.trim();
  if (authMode === 'bearer_token' && token !== undefined && !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) {
    throw new McpConfigError('TOKEN_INVALID', '请输入有效的 Bearer Token，不要包含 Bearer 前缀');
  }
  const endpointChanged = existing !== null && existing.url !== endpoint.normalizedUrl;
  if (authMode === 'bearer_token' && token === undefined
    && (!existing?.credentialRef || endpointChanged)) {
    throw new McpConfigError('TOKEN_REQUIRED', '请填写 Token；更换服务地址后需要重新填写');
  }
  const credentialRef = authMode === 'none' ? null
    : token === undefined ? existing!.credentialRef : await runtime.credentialStore.save(token);
  const newCredential = credentialRef !== null && credentialRef !== existing?.credentialRef;
  let saved: McpServerConfig;
  try {
    // 编辑 URL 或认证身份意味着连接的是另一个服务/账号：必须在单个事务内完成全部失效。
    // 不得先执行普通 save() 再逐项清理——那样会出现 URL 已变但 enabled 仍为 true 的中间态。
    if (existing && (endpointChanged || existing.credentialRef !== credentialRef || existing.authMode !== authMode)) {
      const invalidated = await runtime.serverConfigRepository.invalidateAndUpdateEndpoint({
        id: existing.id,
        name,
        url: endpoint.normalizedUrl,
        description,
        assistantIds: input.assistantIds,
        authMode,
        credentialRef,
        expectedConnection: { url: existing.url, credentialRef: existing.credentialRef },
        endpointClass: endpoint.endpointClass,
        nowIso,
      });
      if (!invalidated) {
        throw new McpConfigError('CONFIG_CHANGED', '服务已删除或连接配置已改变，请重新打开配置页');
      }
      saved = invalidated;
    } else {
      // 新增服务默认启用；实际工具暴露仍以成功连接和工具授权为门槛。
      saved = await runtime.serverConfigRepository.save({
        id: input.id,
        name,
        url: endpoint.normalizedUrl,
        description,
        assistantIds: input.assistantIds,
        authMode,
        credentialRef,
        endpointClass: endpoint.endpointClass,
        expectedConnection: existing ? { url: existing.url, credentialRef: existing.credentialRef } : null,
        enabled: existing ? input.enabled : true,
        nowIso,
      });
    }
  } catch (error) {
    // 新引用尚未发布时回收；原引用仍由数据库持有，不回写或覆盖原 Token。
    if (newCredential) await runtime.credentialStore.delete(credentialRef);
    throw error;
  }
  if (existing?.credentialRef && existing.credentialRef !== credentialRef) {
    await runtime.credentialStore.delete(existing.credentialRef);
  }
  return saved;
}
