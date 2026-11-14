/** 模型 HTML 只在不透明来源的 iframe 中运行，不接入 RN 消息桥或应用权限。 */
const CONTENT_POLICY = "default-src 'none'; script-src 'unsafe-inline' https: blob:; style-src 'unsafe-inline' https:; img-src https: data: blob:; font-src https: data:; media-src https: data: blob:; connect-src https:; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildChatCodePreviewDocument(source: string): string {
  // 策略先于模型内容进入 HTML parser；模型后续声明不能放宽已有 CSP。
  const document = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<meta http-equiv="Content-Security-Policy" content="${CONTENT_POLICY}">` + source;
  return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#fff}iframe{display:block;width:100%;height:100%;border:0}</style>'
    + '</head><body><iframe title="网页预览" sandbox="allow-scripts" referrerpolicy="no-referrer"'
    + ' allow="camera \'none\'; microphone \'none\'; geolocation \'none\'; clipboard-read \'none\'; clipboard-write \'none\'"'
    + ` srcdoc="${escapeAttribute(document)}"></iframe></body></html>`;
}

/** originWhitelist 只防止链接被交给系统；真正的页面跳转许可由此处裁决。 */
export function allowChatCodePreviewNavigation(url: string): boolean {
  const documentUrl = url.split('#')[0];
  return documentUrl === 'about:blank' || documentUrl === 'about:srcdoc';
}
