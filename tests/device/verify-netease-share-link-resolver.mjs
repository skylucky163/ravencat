/**
 * PHONE-8B2A：网易云 share-link resolver 契约与安全边界验证。
 *
 * 锁住的目标：
 * - 只有 song / playlist 两种 identity，numeric ID 必须是正安全整数；
 * - HTTPS only + exact host allowlist（163cn.tv / music.163.com / y.music.163.com）；
 * - manual redirect（不自动跟随），max 5 跳，每一跳重新校验 scheme/host；
 * - 不携带 Cookie / Authorization / MUSIC_U / MUSIC_A，不读响应正文；
 * - capability 不通过 Phone Tools 公共根出口或通用 composition 出口暴露。
 */

import assert from 'node:assert/strict';
import { loadTypeScriptModule, readRepoFile as read } from '../helpers/load-typescript-module.mjs';

const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/\/\/[^\n]*/gu, '');

// ——— 1. TS application contract 形状 ———
const contractPath = 'src/features/phoneTools/application/NetEaseShareLinkResolver.ts';
const contractModule = loadTypeScriptModule(contractPath);

assert.equal(typeof contractModule, 'object', 'application contract 必须可加载');

const contractSource = stripComments(read(contractPath));
assert.match(
  contractSource,
  /resolveNetEaseShareLink\(url: string\)/u,
  'application capability 必须接受单个 URL 字符串',
);
assert.match(contractSource, /type: 'song'; songId: number/u, '必须表达 song identity');
assert.match(contractSource, /type: 'playlist'; playlistId: number/u, '必须表达 playlist identity');

const expectedFailureCodes = [
  'invalid_url',
  'unsupported_host',
  'redirect_rejected',
  'too_many_redirects',
  'network_failure',
  'unsupported_resource_type',
  'invalid_resource_id',
  'unresolvable_share_link',
];
for (const code of expectedFailureCodes) {
  assert.match(
    contractSource,
    new RegExp(`'${code}'`, 'u'),
    `typed failure 必须包含 ${code}`,
  );
}
// 不把不同问题收敛成单一 invalid_response。
assert.doesNotMatch(
  contractSource,
  /invalid_response/u,
  'share-link resolver 不得复用 EAPI 的 invalid_response 语义',
);
// identity 不含 metadata。
for (const forbiddenMetadata of ['title', 'name', 'artist', 'cover', 'description']) {
  assert.doesNotMatch(
    contractSource,
    new RegExp(`\\b${forbiddenMetadata}\\b`, 'iu'),
    `identity 不得包含 ${forbiddenMetadata}`,
  );
}

// ——— 2. infrastructure adapter 只把 native resolveShareLink 交给 contract ———
const adapterPath = 'src/features/phoneTools/infrastructure/NativeNetEaseShareLinkResolver.ts';
const adapterSource = stripComments(read(adapterPath));
assert.match(
  adapterSource,
  /resolveShareLink/u,
  'infrastructure adapter 必须调用 native resolveShareLink',
);
assert.match(
  adapterSource,
  /from '\.\.\/\.\.\/\.\.\/\.\.\/modules\/netease-public-data'/u,
  'adapter 必须依赖 modules/netease-public-data',
);
assert.doesNotMatch(
  adapterSource,
  /fetch\(|XMLHttpRequest|axios|http\.request/u,
  'adapter 不得包含 generic web fetch',
);

// ——— 3. TS module wrapper 暴露 resolveShareLink ———
const wrapperPath = 'modules/netease-public-data/src/NetEasePublicDataModule.ts';
const wrapperSource = stripComments(read(wrapperPath));
assert.match(wrapperSource, /resolveShareLink/u, 'native wrapper 必须暴露 resolveShareLink');

// ——— 4. Kotlin resolver 安全边界（source guard） ———
const kotlinSources = {
  resolver: stripComments(read(
    'modules/netease-public-data/android/src/main/java/expo/modules/neteasepublicdata/resolver/NetEaseShareLinkResolver.kt',
  )),
  transport: stripComments(read(
    'modules/netease-public-data/android/src/main/java/expo/modules/neteasepublicdata/resolver/ShareLinkRedirectTransport.kt',
  )),
  model: stripComments(read(
    'modules/netease-public-data/android/src/main/java/expo/modules/neteasepublicdata/model/SharedResource.kt',
  )),
};

for (const [name, source] of Object.entries(kotlinSources)) {
  // 不携带凭据。
  for (const forbidden of ['Cookie', 'Authorization', 'MUSIC_U', 'MUSIC_A', 'CookieManager']) {
    assert.doesNotMatch(
      source,
      new RegExp(forbidden, 'u'),
      `${name} 不得携带 ${forbidden}`,
    );
  }
  // 不读取响应正文。
  for (const forbidden of ['getInputStream', 'bufferedReader', 'errorStream', 'readBody', 'bodyBytes']) {
    assert.doesNotMatch(
      source,
      new RegExp(forbidden, 'u'),
      `${name} 不得读取响应正文（${forbidden}）`,
    );
  }
  // 不做宽松 host 判断。
  for (const forbidden of ['endsWith(', '.contains(', 'contains(']) {
    assert.doesNotMatch(
      source,
      new RegExp(forbidden.replace('(', '\\('), 'u'),
      `${name} 不得使用宽松 host 判断`,
    );
  }
}

const resolverSource = kotlinSources.resolver;
// exact host allowlist。
assert.match(resolverSource, /"163cn\.tv"/u, '必须允许 163cn.tv');
assert.match(resolverSource, /"music\.163\.com"/u, '必须允许 music.163.com');
assert.match(resolverSource, /"y\.music\.163\.com"/u, '必须允许 y.music.163.com');
// HTTPS only。
assert.match(resolverSource, /"https"/u, '必须强制 HTTPS');
assert.match(resolverSource, /MAX_REDIRECTS = 5/u, 'redirect 上限必须是 5');

const transportSource = kotlinSources.transport;
// manual redirect：绝不允许自动跟随。
assert.match(
  transportSource,
  /instanceFollowRedirects\s*=\s*false/u,
  'transport 必须关闭自动跟随重定向',
);
assert.doesNotMatch(
  transportSource,
  /instanceFollowRedirects\s*=\s*true/u,
  'transport 不得开启自动跟随重定向',
);

// ——— 5. Feature 公共边界：share-link capability 只从专用 production assembly 被 Host 消费 ———
const phoneToolsIndexSource = read('src/features/phoneTools/index.ts');
assert.doesNotMatch(
  phoneToolsIndexSource,
  /resolveNetEaseShareLink|NetEaseShareLinkBackend|NetEaseSharedResource/u,
  'PHONE-8B2A 尚无真实 consumer，不得在 Phone Tools 公共出口暴露 share-link 能力',
);

const phoneToolsCompositionSource = read('src/features/phoneTools/composition.ts');
assert.doesNotMatch(
  phoneToolsCompositionSource,
  /NetEaseShareLink|nativeNetEaseShareLinkResolver|resolveShareLink/u,
  'composition 出口不得接线 share-link resolver（避免无 consumer 的启动依赖）',
);

console.log('PHONE-8B2A NetEase share-link resolver 契约与安全边界检查通过。');
