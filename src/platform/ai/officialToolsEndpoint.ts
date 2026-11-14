export type OfficialToolProvider = 'moonshot' | 'deepseek';

/** 官方工具只接受对应服务商的 API 根地址，不根据模型名或域名子串推断。 */
export function resolveOfficialToolsAPIBaseURL(provider: OfficialToolProvider, baseURL: string | null | undefined): string | null {
  if (!baseURL) return null;
  let url: URL;
  try { url = new URL(baseURL.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) return null;
  const hosts = provider === 'moonshot' ? ['api.moonshot.cn', 'api.moonshot.ai'] : ['api.deepseek.com'];
  if (!hosts.includes(url.hostname)) return null;
  if (!['', '/v1'].includes(url.pathname.replace(/\/+$/, ''))) return null;
  return `${url.origin}/v1`;
}
