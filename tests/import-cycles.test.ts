import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sourceFiles(resolve(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [resolve(directory, entry.name)] : []))).flat();
}

// Runtime imports include re-exports and literal import() calls. An import containing only
// `type` specifiers creates no runtime edge, while a side-effect import does.
async function importGraph() {
  const files = await sourceFiles(resolve('src')), known = new Set(files);
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const edges = new Set<string>();
    const add = (specifier: ts.Expression | undefined) => {
      if (!specifier || !ts.isStringLiteralLike(specifier) || !specifier.text.startsWith('.')) return;
      // A plain-JavaScript module outside src (bin/cli-release.mjs, which the npm launcher shares) imports nothing from src, so it closes no cycle.
      if (specifier.text.endsWith('.mjs')) return;
      const target = resolve(dirname(file), specifier.text).replace(/\.js$/, '.ts');
      const found = [target, target.replace(/\.ts$/, '.tsx'), resolve(target, 'index.ts')].find(path => known.has(path));
      assert.ok(found, `Unresolved source import ${specifier.text} in ${file}`);
      edges.add(found);
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause, bindings = clause?.namedBindings;
        if (!clause?.isTypeOnly && (!clause || clause.name || !bindings || !ts.isNamedImports(bindings) || bindings.elements.length === 0 || bindings.elements.some(element => !element.isTypeOnly))) add(node.moduleSpecifier);
      } else if (ts.isExportDeclaration(node)) {
        if (!node.isTypeOnly && (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.length === 0 || node.exportClause.elements.some(element => !element.isTypeOnly))) add(node.moduleSpecifier);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
      ts.forEachChild(node, visit);
    };
    visit(source);
    graph.set(file, [...edges]);
  }
  return graph;
}

function components(graph: Map<string, string[]>) {
  let next = 0;
  const indices = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], active = new Set<string>(), result: string[][] = [];
  const visit = (file: string) => {
    indices.set(file, next); low.set(file, next++); stack.push(file); active.add(file);
    for (const dependency of graph.get(file) ?? []) {
      if (!indices.has(dependency)) { visit(dependency); low.set(file, Math.min(low.get(file)!, low.get(dependency)!)); }
      else if (active.has(dependency)) low.set(file, Math.min(low.get(file)!, indices.get(dependency)!));
    }
    if (low.get(file) === indices.get(file)) {
      const component: string[] = [];
      let member: string;
      do { member = stack.pop()!; active.delete(member); component.push(member); } while (member !== file);
      result.push(component);
    }
  };
  for (const file of graph.keys()) if (!indices.has(file)) visit(file);
  return result;
}

test('unit:import-cycles — src runtime import components contain at most three modules', async () => {
  const oversized = components(await importGraph()).filter(component => component.length > 3);
  assert.deepEqual(oversized, [], `Runtime import cycles exceed three modules:\n${oversized.map(component => component.join('\n')).join('\n\n')}`);
});
