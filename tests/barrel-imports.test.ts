import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

test('unit:barrel-imports — source imports owning master modules and the daemon barrel is gone', () => {
  assert.equal(existsSync(resolve(root, 'src/master-daemon.ts')), false);
  const violations: string[] = [];
  for (const file of sources(resolve(root, 'src'))) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
      if (specifier && ts.isStringLiteral(specifier)) {
        const target = resolve(dirname(file), specifier.text).replace(/\.(?:js|ts)$/, '');
        if (target === resolve(root, 'src/master-daemon') ||
          target === resolve(root, 'src/master') && !file.startsWith(resolve(root, 'src/cli') + '/')) {
          violations.push(`${relative(root, file)}: ${specifier.text}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(violations, []);
});
