/** 可计费的同步生图 POST 显式选择单次发送，避免 OkHttp 恢复连接或跟进响应时重放请求。 */
const fs = require('node:fs');
const path = require('node:path');
const expo = path.join(__dirname, '..', 'node_modules', 'expo');
const native = 'android/src/main/java/expo/modules/fetch';
const js = 'src/winter/fetch';

const changes = [
  [`${js}/fetch.types.ts`, [
    ['  redirect?: RequestRedirect;', '  redirect?: RequestRedirect;\n  oneShot?: boolean;'],
  ]],
  [`${js}/fetch.ts`, [
    ["    redirect: init?.redirect ?? 'follow',", "    redirect: init?.redirect ?? 'follow',\n    oneShot: init?.oneShot ?? false,"],
  ]],
  [`${js}/NativeRequest.ts`, [
    ['  redirect?: RequestRedirect;', '  redirect?: RequestRedirect;\n  oneShot?: boolean;'],
  ]],
  [`${native}/NativeRequestInit.kt`, [
    ['  @Field val redirect: NativeRequestRedirect = NativeRequestRedirect.FOLLOW',
      '  @Field val redirect: NativeRequestRedirect = NativeRequestRedirect.FOLLOW,\n  @Field val oneShot: Boolean = false'],
  ]],
  [`${native}/NativeRequest.kt`, [
    ['import okhttp3.Request\n', 'import okhttp3.Request\nimport okhttp3.RequestBody\nimport okio.BufferedSink\n'],
    ['    val newClient = clientBuilder.build()', '    if (requestInit.oneShot) clientBuilder.retryOnConnectionFailure(false)\n    val newClient = clientBuilder.build()'],
    ['      .method(requestInit.method, reqBody)', `      .method(requestInit.method, if (requestInit.oneShot && reqBody != null) {
        object : RequestBody() {
          override fun contentType() = reqBody.contentType()
          override fun contentLength() = reqBody.contentLength()
          override fun writeTo(sink: BufferedSink) = reqBody.writeTo(sink)
          override fun isOneShot() = true
        }
      } else reqBody)`],
  ]],
];

for (const [file, replacements] of changes) {
  const target = path.join(expo, file);
  let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  for (const [original, patched] of replacements) {
    if (source.includes(patched)) continue;
    if (!source.includes(original)) throw new Error(`Expo Fetch 实现已变化，请检查单次请求补丁：${file}`);
    source = source.replace(original, patched);
  }
  fs.writeFileSync(target, source, 'utf8');
}
console.log('[postinstall] Expo Fetch 支持显式禁止请求重放');
