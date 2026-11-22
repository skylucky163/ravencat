import { repoRoot as ROOT } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';


const SRC = path.join(ROOT, 'src');
const NEW_ROOT_NAMES = new Set(['app', 'host', 'features', 'platform', 'shared']);
  const HOST_ONLY_FEATURE_COMPOSITIONS = new Set([
    'assistants',
    'calls',
    'chat',
    'deviceControl',
    'floatingLayer',
    'memory',
    'mcpTools',
    'moments',
    'companion',
    'phoneTools',
    'protocol',
    'webTools',
  ]);
const CHAT_APPLICATION_ASSISTANT_CONCRETE_REPOSITORIES = new Set([
  'AIAssistantRepository',
  'aiAssistantRepository',
  'AIHostRepository',
  'aiHostRepository',
  'SQLiteAssistantToolPermissionRepository',
  'assistantToolPermissionRepository',
  'AuxiliaryModelRepository',
  'auxiliaryModelRepository',
]);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const ALIASES = new Map([
  ['@host', path.join(SRC, 'host')],
  ['@features', path.join(SRC, 'features')],
  ['@platform', path.join(SRC, 'platform')],
  ['@shared', path.join(SRC, 'shared')],
]);

function normalize(filePath) {
  return path.resolve(filePath).replaceAll('\\', '/');
}

function isWithin(candidate, parent) {
  const normalizedCandidate = normalize(candidate);
  const normalizedParent = normalize(parent);
  return normalizedCandidate === normalizedParent
    || normalizedCandidate.startsWith(`${normalizedParent}/`);
}

function resolveImport(importer, specifier) {
  if (specifier.startsWith('.')) {
    return path.resolve(path.dirname(importer), specifier);
  }

  for (const [alias, target] of ALIASES) {
    if (specifier === alias) {
      return target;
    }
    if (specifier.startsWith(`${alias}/`)) {
      return path.join(target, specifier.slice(alias.length + 1));
    }
  }

  return null;
}

function sourceArea(filePath) {
  const relative = path.relative(SRC, filePath);
  const [rootName, featureName] = relative.split(path.sep);
  return {
    rootName,
    featureName: rootName === 'features' ? featureName : null,
    relative,
  };
}

function targetArea(targetPath) {
  const relative = path.relative(SRC, targetPath);
  const [rootName, featureName] = relative.split(path.sep);
  return {
    rootName,
    featureName: rootName === 'features' ? featureName : null,
  };
}

function isFeaturePublicApi(targetPath, featureName) {
  const featureRoot = normalize(path.join(SRC, 'features', featureName));
  const normalizedTarget = normalize(targetPath).replace(/\.(?:js|jsx|ts|tsx)$/, '');
  return normalizedTarget === featureRoot || normalizedTarget === `${featureRoot}/index`;
}

function isHostOnlyFeatureComposition(targetPath, featureName) {
  if (!HOST_ONLY_FEATURE_COMPOSITIONS.has(featureName)) {
    return false;
  }
  const featureRoot = normalize(path.join(SRC, 'features', featureName));
  const normalizedTarget = normalize(targetPath).replace(/\.(?:js|jsx|ts|tsx)$/, '');
  return normalizedTarget === `${featureRoot}/composition`;
}

export function evaluateSourceLocation(filePath) {
  const source = sourceArea(filePath);
  return NEW_ROOT_NAMES.has(source.rootName)
    ? null
    : 'source files must live under app, host, features, platform, or shared';
}

export function evaluateBoundary(importer, specifier) {
  const source = sourceArea(importer);
  const resolvedTarget = resolveImport(importer, specifier);
  if (!resolvedTarget || !isWithin(resolvedTarget, SRC)) {
    return null;
  }

  const target = targetArea(resolvedTarget);

  if (source.rootName === 'shared' && ['app', 'host', 'features', 'platform'].includes(target.rootName)) {
    return 'shared may only depend on shared or external packages';
  }

  if (source.rootName === 'platform' && ['app', 'host', 'features'].includes(target.rootName)) {
    return 'platform may not depend on app, host, or features';
  }

  if (source.rootName === 'features' && ['app', 'host'].includes(target.rootName)) {
    return 'features may not depend on app or host';
  }

  if (source.rootName === 'host' && target.rootName === 'app') {
    return 'host may not depend on the app routing layer';
  }

  if (source.rootName === 'app' && target.rootName === 'platform') {
    return 'app routes may not depend directly on platform';
  }

  if (
    target.rootName === 'features'
    && isHostOnlyFeatureComposition(resolvedTarget, target.featureName)
    && source.rootName !== 'host'
  ) {
    return `@features/${target.featureName}/composition is host-only`;
  }

  if (
    source.rootName === 'features'
    && target.rootName === 'features'
    && source.featureName !== target.featureName
    && !isFeaturePublicApi(resolvedTarget, target.featureName)
  ) {
    return `cross-feature imports must use @features/${target.featureName}`;
  }

  if (
    source.rootName === 'features'
    && source.relative.split(path.sep).includes('application')
    && target.rootName === 'features'
    && source.featureName === target.featureName
    && isWithin(resolvedTarget, path.join(SRC, 'features', source.featureName, 'infrastructure'))
  ) {
    return 'feature application code may not import its concrete infrastructure';
  }

  if (
    source.rootName === 'features'
    && source.relative.split(path.sep).includes('presentation')
    && target.rootName === 'features'
    && source.featureName === target.featureName
    && isWithin(resolvedTarget, path.join(SRC, 'features', source.featureName, 'infrastructure'))
  ) {
    return 'feature presentation code may not import its concrete infrastructure';
  }

  return null;
}

function collectFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(entryPath);
    }
    return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [entryPath] : [];
  });
}

function importSpecifiers(filePath) {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const scriptKind = filePath.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : filePath.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : filePath.endsWith('.ts')
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const imports = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push({ specifier: node.moduleSpecifier.text, line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }

    if (
      ts.isCallExpression(node)
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
      && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      )
    ) {
      imports.push({ specifier: node.arguments[0].text, line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

function isChatApplicationSource(filePath) {
  const source = sourceArea(filePath);
  return source.rootName === 'features'
    && source.featureName === 'chat'
    && source.relative.split(path.sep).includes('application');
}

function isAssistantsPublicFacade(importer, specifier) {
  const resolvedTarget = resolveImport(importer, specifier);
  return Boolean(
    resolvedTarget
      && isWithin(resolvedTarget, SRC)
      && targetArea(resolvedTarget).rootName === 'features'
      && targetArea(resolvedTarget).featureName === 'assistants'
      && isFeaturePublicApi(resolvedTarget, 'assistants'),
  );
}

function concreteAssistantImportViolations(filePath, sourceText = fs.readFileSync(filePath, 'utf8')) {
  if (!isChatApplicationSource(filePath)) {
    return [];
  }

  const scriptKind = filePath.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : filePath.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : filePath.endsWith('.ts')
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const violations = [];

  function addViolation(node, specifier, binding) {
    violations.push({
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      specifier,
      message: `Chat application may not import concrete Assistants repository binding ${binding}; inject assistantDirectory through Chat composition`,
    });
  }

  function visit(node) {
    if (
      ts.isImportDeclaration(node)
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
      && isAssistantsPublicFacade(filePath, node.moduleSpecifier.text)
      && node.importClause
    ) {
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = (element.propertyName || element.name).text;
          if (CHAT_APPLICATION_ASSISTANT_CONCRETE_REPOSITORIES.has(importedName)) {
            addViolation(node, node.moduleSpecifier.text, importedName);
          }
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        addViolation(node, node.moduleSpecifier.text, '* as namespace');
      }
    }

    if (
      ts.isExportDeclaration(node)
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
      && isAssistantsPublicFacade(filePath, node.moduleSpecifier.text)
    ) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const exportedName = (element.propertyName || element.name).text;
          if (CHAT_APPLICATION_ASSISTANT_CONCRETE_REPOSITORIES.has(exportedName)) {
            addViolation(node, node.moduleSpecifier.text, exportedName);
          }
        }
      } else {
        addViolation(node, node.moduleSpecifier.text, '* export');
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function directAbortSignalMethodViolations(
  filePath,
  sourceText = fs.readFileSync(filePath, 'utf8'),
) {
  const scriptKind = filePath.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : filePath.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : filePath.endsWith('.ts')
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const violations = [];

  function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'throwIfAborted'
    ) {
      violations.push({
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        message: '直接调用 AbortSignal.throwIfAborted 不兼容 React Native；请使用 @shared/runtime/abortSignal',
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function runSelfTest() {
  const sharedFile = path.join(SRC, 'shared', 'format.ts');
  const platformFile = path.join(SRC, 'platform', 'ai', 'client.ts');
  const appFile = path.join(SRC, 'app', 'index.tsx');
  const hostFile = path.join(SRC, 'host', 'composition', 'configureAIRuntime.ts');
  const walletAppFile = path.join(SRC, 'features', 'wallet', 'application', 'CreateRecord.ts');
  const floatingLayerPresentationFile = path.join(SRC, 'features', 'floatingLayer', 'presentation', 'FloatingInteractionScreen.tsx');
  const chatFile = path.join(SRC, 'features', 'chat', 'application', 'SendMessage.ts');
  const legacyFile = path.join(SRC, 'presentation', 'modules', 'wallet', 'WalletScreen.tsx');

  assert.equal(evaluateBoundary(sharedFile, '@features/chat'), 'shared may only depend on shared or external packages');
  assert.equal(evaluateBoundary(sharedFile, '@host'), 'shared may only depend on shared or external packages');
  assert.equal(evaluateBoundary(platformFile, '@host'), 'platform may not depend on app, host, or features');
  assert.equal(evaluateBoundary(appFile, '@platform'), 'app routes may not depend directly on platform');
  assert.equal(evaluateBoundary(hostFile, '../../app'), 'host may not depend on the app routing layer');
  assert.equal(evaluateBoundary(walletAppFile, '../infrastructure/SQLiteWalletRepository'), 'feature application code may not import its concrete infrastructure');
  assert.equal(evaluateBoundary(floatingLayerPresentationFile, '../infrastructure/FloatingLayerAdapter'), 'feature presentation code may not import its concrete infrastructure');
  assert.equal(evaluateBoundary(chatFile, '@features/wallet/domain/WalletRecord'), 'cross-feature imports must use @features/wallet');
  assert.equal(evaluateBoundary(chatFile, '@features/wallet'), null);
  assert.equal(evaluateBoundary(hostFile, '@features/chat/composition'), null);
  assert.equal(evaluateBoundary(appFile, '@features/chat/composition'), '@features/chat/composition is host-only');
  assert.equal(evaluateBoundary(walletAppFile, '@features/chat/composition'), '@features/chat/composition is host-only');
  assert.equal(evaluateBoundary(chatFile, '@host'), 'features may not depend on app or host');
  assert.equal(evaluateBoundary(walletAppFile, '../domain/WalletRecord'), null);
  assert.equal(evaluateSourceLocation(walletAppFile), null);
  assert.equal(evaluateSourceLocation(legacyFile), 'source files must live under app, host, features, platform, or shared');
  assert.equal(evaluateBoundary(legacyFile, 'react'), null);

  const chatApplicationFixture = path.join(SRC, 'features', 'chat', 'messages', 'application', 'Fixture.ts');
  const concreteImportViolation = concreteAssistantImportViolations(
    chatApplicationFixture,
    "import { aiAssistantRepository as assistantRepo } from '@features/assistants';",
  );
  assert.equal(concreteImportViolation.length, 1);
  assert.equal(concreteImportViolation[0].line, 1);
  assert.match(concreteImportViolation[0].message, /assistantDirectory/);
  assert.equal(
    concreteAssistantImportViolations(
      chatApplicationFixture,
      "import * as assistants from '@features/assistants'; assistants.aiHostRepository;",
    ).length,
    1,
    'Chat application 不得通过 namespace import 绕过 Assistants concrete singleton guard',
  );
  assert.equal(
    concreteAssistantImportViolations(
      chatApplicationFixture,
      "import type { AIProfile } from '@features/assistants';",
    ).length,
    0,
    '稳定的 Assistants 类型导入不应触发 concrete repository guard',
  );
  assert.equal(
    concreteAssistantImportViolations(
      chatApplicationFixture,
      "import type { aiAssistantRepository } from '@features/assistants';",
    ).length,
    1,
    'type-only 也不得依赖 concrete Assistants repository',
  );
  const hostFixture = path.join(SRC, 'host', 'composition', 'Fixture.ts');
  assert.equal(
    concreteAssistantImportViolations(
      hostFixture,
      "import { aiAssistantRepository } from '@features/assistants';",
    ).length,
    0,
    'Host composition 可以使用 concrete Assistants repository 进行装配',
  );
  const abortSignalFixture = path.join(SRC, 'features', 'companion', 'aiTools', 'Fixture.ts');
  assert.equal(
    directAbortSignalMethodViolations(
      abortSignalFixture,
      'signal.throwIfAborted(); signal?.throwIfAborted();',
    ).length,
    2,
    '标准调用和 optional chaining 都必须命中 React Native AbortSignal 兼容门禁',
  );
  assert.equal(
    directAbortSignalMethodViolations(
      abortSignalFixture,
      'throwIfAbortSignalAborted(signal);',
    ).length,
    0,
    '统一兼容 helper 不应触发门禁',
  );
  console.log('Architecture boundary self-test passed.');
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--self-test')) {
    runSelfTest();
    return;
  }

  const violations = [];
  for (const filePath of collectFiles(SRC)) {
    const sourceLocationMessage = evaluateSourceLocation(filePath);
    if (sourceLocationMessage) {
      violations.push({ filePath, line: 1, message: sourceLocationMessage });
      continue;
    }

    for (const imported of importSpecifiers(filePath)) {
      const message = evaluateBoundary(filePath, imported.specifier);
      if (message) {
        violations.push({ filePath, ...imported, message });
      }
    }

    for (const violation of concreteAssistantImportViolations(filePath)) {
      violations.push({ filePath, ...violation });
    }

    for (const violation of directAbortSignalMethodViolations(filePath)) {
      violations.push({ filePath, ...violation });
    }
  }

  if (violations.length === 0) {
    console.log('Architecture boundary check passed.');
    return;
  }

  for (const violation of violations) {
    const relativePath = path.relative(ROOT, violation.filePath).replaceAll('\\', '/');
    const importContext = violation.specifier ? ` (${violation.specifier})` : '';
    console.error(`${relativePath}:${violation.line} error: ${violation.message}${importContext}`);
  }
  console.error(`${violations.length} architecture boundary error(s).`);
  process.exitCode = 1;
}

main();
