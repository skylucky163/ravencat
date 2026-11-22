import { repoRoot as root } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';


const source = fs.readFileSync(
  path.join(root, 'src/host/media/MigrateLegacyAvatarReferences.ts'),
  'utf8',
);
const javascript = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`;
const { migrateLegacyAvatarReferences } = await import(moduleUrl);

function createOwner(ownerKind, category, candidates, commits) {
  return {
    ownerKind,
    category,
    async listCandidates() {
      return candidates;
    },
    async commitReferenceInTransaction(_transaction, candidate, mediaAssetId) {
      commits.push({ ownerKind, candidate, mediaAssetId });
    },
  };
}

test('只迁移三类 canonical 当前头像', async () => {
  const commits = [];
  const adopted = [];
  const result = await migrateLegacyAvatarReferences({
    avatarOwners: [
      createOwner('user', 'userAvatar', [
        { ownerId: 'self', legacyUri: 'file:///avatars/user/self.jpg' },
      ], commits),
      createOwner('assistant', 'aiAvatar', [
        { ownerId: 'ai-1', legacyUri: 'file:///avatars/ai/ai-1.png' },
      ], commits),
      createOwner('group', 'groupAvatar', [
        { ownerId: 'group-1', legacyUri: 'file:///avatars/group/group-1.webp' },
      ], commits),
    ],
    async locateLegacyAvatarFile(uri, category) {
      const fileName = uri.slice(uri.lastIndexOf('/') + 1);
      return {
        storageBackend: 'persistent-image',
        storageKey: `avatars/${category}/${fileName}`,
        localUri: uri,
      };
    },
    async adoptExistingAvatar(input, commit) {
      adopted.push(input);
      const asset = { id: `asset-${adopted.length}` };
      const value = await commit({}, asset);
      return { value, asset, reused: adopted.length === 3 };
    },
  });

  assert.equal(result.scannedCanonicalAvatars, 3);
  assert.equal(result.migratedCanonicalAvatars, 3);
  assert.equal(result.createdAssets, 2);
  assert.equal(result.reusedAssets, 1);
  assert.equal(result.unresolvedCanonicalAvatars, 0);
  assert.deepEqual(result.issues, []);
  // Moments 不再持有 avatar 快照：迁移结果里不应再出现朋友圈相关字段。
  assert.equal(Object.hasOwn(result, 'clearedMomentAvatarSnapshots'), false);
  assert.equal(Object.hasOwn(result, 'unresolvedMomentCommentAuthors'), false);
  assert.equal(adopted.every((input) => input.storageBackend === 'persistent-image'), true);
  assert.deepEqual(adopted.map((input) => input.mimeType), [
    'image/jpeg',
    'image/png',
    'image/webp',
  ]);
  assert.equal(commits.length, 3);
});

test('不可定位头像和 CAS 失败保持 unresolved，但继续其他 canonical owner', async () => {
  const commits = [];
  const result = await migrateLegacyAvatarReferences({
    avatarOwners: [
      createOwner('user', 'userAvatar', [
        { ownerId: 'self', legacyUri: 'https://example.com/avatar.jpg' },
      ], commits),
      {
        ...createOwner('assistant', 'aiAvatar', [
          { ownerId: 'ai-conflict', legacyUri: 'file:///avatars/ai/conflict.png' },
        ], commits),
        async commitReferenceInTransaction() {
          throw new Error('avatar CAS conflict');
        },
      },
      createOwner('group', 'groupAvatar', [
        { ownerId: 'group-ok', legacyUri: 'file:///avatars/group/ok.gif' },
      ], commits),
    ],
    async locateLegacyAvatarFile(uri, category) {
      if (uri.startsWith('https://')) return null;
      return {
        storageBackend: 'persistent-image',
        storageKey: `avatars/${category}/${uri.slice(uri.lastIndexOf('/') + 1)}`,
        localUri: uri,
      };
    },
    async adoptExistingAvatar(input, commit) {
      const asset = { id: `asset:${input.storageKey}` };
      const value = await commit({}, asset);
      return { value, asset, reused: false };
    },
  });

  assert.equal(result.scannedCanonicalAvatars, 3);
  assert.equal(result.migratedCanonicalAvatars, 1);
  assert.equal(result.unresolvedCanonicalAvatars, 2);
  assert.deepEqual(result.issues.map((issue) => issue.reason), [
    'unmanaged_or_unavailable_uri',
    'commit_failed',
  ]);
  assert.equal(commits[0].ownerKind, 'group');
});

console.log('M3b canonical avatar migration behavior tests passed.');
