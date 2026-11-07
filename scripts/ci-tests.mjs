// Which test files the merge writer's trial executes (GY-499, GY-3192). The trial runs only the test
// files the change can affect; the install, the compiler configuration and the runner run every file,
// while a change limited to documentation runs none.
//
//   node scripts/ci-tests.mjs affected FILE...            the selection for changed FILEs: `mode: reason`, then
//                                                         the files it runs, one per line (every one when full)
//
// The dependency map is built from the source itself, parsed with TypeScript: a test depends on the
// modules it imports (static and literal dynamic imports), and through each only on the top-level
// declarations the names it takes reach — a class method once reached code reads its name — and on
// the paths a test or test helper reads as data (`'../docs/x.md'`, `join(root, 'e2e/cases')`). With
// a base revision (GRAPHYARD_SELECTION_BASE), a changed file selects only the tests needing the
// declarations its diff touches.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const defaultShardCount = 4;
export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every test file of the Node suite, as `npm test` runs it by default. */
export function listTestFiles(root = repositoryRoot) {
  return readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.ts')).sort().map(name => `tests/${name}`);
}

// ---- Shards ------------------------------------------------------------------------------------

/**
 * Splits `files` into `count` shards of as near as possible the same size: the files sorted, dealt
 * round-robin. Deterministic, so every shard job computes the same split independently.
 */
export function shardFiles(files, count = defaultShardCount) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`Shard count must be a positive integer: ${count}`);
  const shards = Array.from({ length: count }, () => []);
  [...new Set(files)].sort().forEach((file, at) => shards[at % count].push(file));
  return shards;
}

/** `"I/N"` as `{ index, count }`, 1-based. */
export function parseShard(text) {
  const match = String(text).match(/^(\d+)\/(\d+)$/);
  const index = Number(match?.[1]), count = Number(match?.[2]);
  if (!match || index < 1 || count < 1 || index > count) throw new Error(`--shard takes I/N with 1 <= I <= N: ${text}`);
  return { index, count };
}

// ---- Affected tests ----------------------------------------------------------------------------

const codeExtension = /\.(?:[cm]?[jt]sx?)$/;
// Changes that alter every test's run without being imported by it: the install, the compiler's
// configuration, and the test runner, the reporters it starts and the sharding it imports.
const fullSuitePaths = [
  /^package(?:-lock)?\.json$/, /^\.npmrc$/, /^tsconfig[\w.-]*\.json$/,
  /^tests\/helpers\/(?:run-tests\.ts|bounded-tests\.mjs|ordered-tests\.mjs|file-durations\.mjs)$/, /^scripts\/ci-tests\.mjs$/,
];
// Documentation no test executes: prose a change cannot break, whether or not a test names its path.
const isDocumentation = file => file.startsWith('docs/') || file.endsWith('.md');

function trackedFiles(root) {
  try { return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); }
  catch { return walk(root, '').filter(file => !file.startsWith('node_modules/') && !file.startsWith('.git/')); }
}
function walk(root, directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.name === 'node_modules' || entry.name === '.git') return [];
    return entry.isDirectory() ? walk(root, path) : [path];
  });
}

/**
 * The edges out of one file. `imports`: every file its relative module specifiers resolve to
 * (static and literal dynamic imports, re-exports, require, import.meta.resolve, new URL) — code it
 * runs. `shape`: the same edges per top-level declaration, so a walk can follow only what the names
 * it takes reach (`moduleShape`). `data`: the tracked paths a file outside src/ and web/ names in
 * text (`'../docs/x.md'`, `join(root, 'e2e/cases/a.json')`, a directory it lists) — files it reads.
 * `files` is the set of tracked files; `directories` maps a directory to the files under it.
 */
export function fileEdges(file, text, files, directories) {
  const data = new Set(), directory = posix.dirname(file);
  // Only a test or a test helper reads paths as data; a directory is data only of a file that lists
  // directories, and elsewhere a named directory is a fixture or a scope pattern.
  const scans = /\breaddir(?:Sync)?\b|\bglob\b/.test(text), reads = file.startsWith('tests/');
  const resolveIn = (path, named = false) => {
    const normal = posix.normalize(path).replace(/\/$/, '');
    if (normal.startsWith('..') || !normal || normal === '.') return [];
    // A path ending in a slash names a directory, never the module of that name beside it.
    if (!path.endsWith('/')) for (const candidate of [normal, normal.replace(/\.js$/, '.ts'), normal.replace(/\.js$/, '.tsx'), normal.replace(/\.mjs$/, '.mts'), `${normal}.ts`, `${normal}.tsx`, `${normal}.js`, `${normal}.mjs`, `${normal}/index.ts`, `${normal}/index.js`]) {
      if (files.has(candidate)) return [candidate];
    }
    return directories.has(normal) && (!named || scans) ? directories.get(normal) : [];
  };
  const shape = moduleShape(file, text, specifier => /^\.{1,2}\//.test(specifier) ? resolveIn(posix.join(directory, specifier)) : []);
  const imports = new Set([...shape.imports]);
  if (!reads) return { imports, shape, data };
  // Paths named in a statement's strings, relative to the file or to the repository root.
  const roots = [...new Set([...files].map(path => path.split('/')[0]))].filter(name => name !== '.' && name.length > 1).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pathPattern = new RegExp(`(?<![\\w@.-])((?:\\.{1,2}/)*)((?:${roots.join('|')})(?:/[\\w.@-]+)*/?)(?![\\w@-])`, 'g');
  for (const statement of shape.statements.flatMap(statement => [statement, ...statement.members])) {
    statement.data = new Set();
    for (const [, up, path] of statement.strings.join('\n').matchAll(pathPattern)) {
      const found = up ? resolveIn(posix.join(directory, up + path), true) : [];
      for (const target of found.length ? found : resolveIn(path, true)) if (!imports.has(target)) { statement.data.add(target); data.add(target); }
    }
  }
  return { imports, shape, data };
}

let typescript;
/**
 * A module's top-level structure, parsed with TypeScript: `statements`, each with the local names it
 * declares, the local names it references and the modules it loads itself (a dynamic import,
 * require, new URL); `bindings`, each imported local name and the module and name it takes (`null`:
 * the whole module); `exports`, each exported name and its local name or the module it re-exports
 * it from; `stars`, the modules `export *` passes on; `effects`, the indexes of statements that run
 * for their effect (no declaration), and `imports`, every module it loads. Type-only syntax is erased
 * before a test runs, so it references nothing.
 */
export function moduleShape(file, text, resolveSpecifier) {
  typescript ??= createRequire(import.meta.url)('typescript');
  const ts = typescript, kind = /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const shape = { statements: [], bindings: new Map(), exports: new Map(), stars: [], effects: [], imports: new Set(), loads: [], spans: [] };
  const specifier = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? resolveSpecifier(node.text) : [];
  const exported = node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);
  const patternNames = (name, into) => { if (ts.isIdentifier(name)) into.add(name.text); else for (const element of name.elements ?? []) if (!ts.isOmittedExpression(element)) patternNames(element.name, into); return into; };
  const load = targets => { for (const target of targets) shape.imports.add(target); return targets; };
  // What a statement references and loads: every identifier outside type syntax, every module a call
  // names, the strings it holds and the property names it reads (`a.name`, `a['name']`, `{ name } = a`).
  const scan = (node, part, skip) => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || skip?.has(node)) return;
    const named = (ts.isPropertyAccessExpression(node.parent) || ts.isPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent) || ts.isPropertyDeclaration(node.parent) || ts.isGetAccessor(node.parent) || ts.isSetAccessor(node.parent)) && node.parent.name === node;
    // A property name (`a.name`, `{ name: a }`) names no local; a shorthand `{ name }` does.
    if (ts.isIdentifier(node) && !named) part.refs.add(node.text);
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) part.props.add(node.text);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) part.props.add(node.argumentExpression.text);
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) { const key = node.propertyName ?? node.name; if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) part.props.add(key.text); }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node)) part.strings.push(node.text);
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments?.length) {
      const callee = node.expression, name = callee.kind === ts.SyntaxKind.ImportKeyword ? 'import' : ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (['import', 'require', 'resolve', 'URL'].includes(name)) for (const target of load(specifier(node.arguments[0]))) part.loads.push({ target, name: name === 'import' ? taken(node) : null });
    }
    ts.forEachChild(node, child => scan(child, part, skip));
  };
  // The names a dynamic import takes: `const { a, b } = await import(...)` or `(await import(...)).a`; else the whole module.
  const taken = call => {
    let node = call.parent;
    while (ts.isParenthesizedExpression(node)) node = node.parent;
    if (!ts.isAwaitExpression(node)) return null;
    do node = node.parent; while (ts.isParenthesizedExpression(node));
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) return new Set([node.name.text]);
    if (!ts.isVariableDeclaration(node) || !ts.isObjectBindingPattern(node.name) || node.name.elements.some(element => element.dotDotDotToken || !ts.isIdentifier(element.propertyName ?? element.name))) return null;
    return new Set(node.name.elements.map(element => (element.propertyName ?? element.name).text));
  };
  const part = (node, skip) => { const scanned = { refs: new Set(), loads: [], strings: [], props: new Set() }; scan(node, scanned, skip); return scanned; };
  const line = position => source.getLineAndCharacterOfPosition(position).line + 1;
  const statement = (node, declares) => {
    // A class's methods and accessors are parts of their own, needed once reached code reads their name.
    const methods = ts.isClassDeclaration(node) ? node.members.filter(member => (ts.isMethodDeclaration(member) || ts.isGetAccessor(member) || ts.isSetAccessor(member)) && member.body && (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name) || ts.isStringLiteral(member.name))) : [];
    const scanned = part(node, new Set(methods)), owner = [...declares][0];
    const members = methods.map(member => ({ name: member.name.text, declares: new Set([`${owner}.${member.name.text}`]), ...part(member), first: line(member.getStart(source)), last: line(member.end) }));
    for (const name of declares) scanned.refs.delete(name);
    shape.statements.push({ declares, ...scanned, members });
    // A statement declaring nothing runs on load, except the entry-point guard, which runs only when
    // the file is the process's main module.
    if (!declares.size && !(ts.isIfStatement(node) && /process\.argv\[1\]/.test(node.expression.getText(source)) && /import\.meta\.(?:url|filename|main)/.test(node.expression.getText(source)))) shape.effects.push(shape.statements.length - 1);
  };
  // Each top-level statement's last line and what a change inside it touches: the names it declares
  // (a method, its class and its own name), none for type-only syntax, or `null` for the whole module
  // (an import, an export list, an effect).
  const span = (node, names) => {
    for (const member of shape.statements.at(-1)?.members ?? []) if (names && ts.isClassDeclaration(node)) shape.spans.push({ first: member.first, last: member.last, names: member.declares });
    shape.spans.push({ last: line(node.end), names: names && shape.effects.includes(shape.statements.length - 1) ? null : names });
  };
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node)) {
      const targets = load(specifier(node.moduleSpecifier)), clause = node.importClause;
      // An import touches the declarations using its bindings.
      span(node, clause?.isTypeOnly ? new Set() : clause ? { bindings: new Set([clause.name?.text, clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings.name.text : undefined, ...(clause.namedBindings && !ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings.elements.map(element => element.name.text) : [])].filter(Boolean)) } : null);
      if (!clause) { shape.loads.push(...targets); continue; }
      if (clause.isTypeOnly) continue;
      for (const target of targets) {
        if (clause.name) shape.bindings.set(clause.name.text, { target, name: 'default' });
        const named = clause.namedBindings;
        if (named && ts.isNamespaceImport(named)) shape.bindings.set(named.name.text, { target, name: null });
        else for (const element of named?.elements ?? []) if (!element.isTypeOnly) shape.bindings.set(element.name.text, { target, name: (element.propertyName ?? element.name).text });
      }
    } else if (ts.isExportDeclaration(node)) {
      // An export list touches the declarations it exports; a re-export, the whole module.
      span(node, node.isTypeOnly ? new Set() : !node.moduleSpecifier && node.exportClause && !ts.isNamespaceExport(node.exportClause) ? new Set(node.exportClause.elements.map(element => (element.propertyName ?? element.name).text)) : null);
      if (node.isTypeOnly) continue;
      const targets = node.moduleSpecifier ? load(specifier(node.moduleSpecifier)) : null, clause = node.exportClause;
      if (targets && !clause) shape.stars.push(...targets);
      else if (targets && ts.isNamespaceExport(clause)) for (const target of targets) shape.exports.set(clause.name.text, { target, name: null });
      else for (const element of clause?.elements ?? []) {
        if (element.isTypeOnly) continue;
        const name = (element.propertyName ?? element.name).text;
        if (targets) for (const target of targets) shape.exports.set(element.name.text, { target, name });
        else shape.exports.set(element.name.text, { local: name });
      }
    } else if (ts.isExportAssignment(node)) {
      shape.exports.set('default', { local: '*default' }); statement(node, new Set(['*default'])); span(node, new Set(['*default']));
    } else if (ts.isImportEqualsDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) {
      span(node, ts.isImportEqualsDeclaration(node) ? null : new Set());
    } else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
      const name = node.name && ts.isIdentifier(node.name) ? node.name.text : '*default';
      if (exported(node)) shape.exports.set(isDefault(node) ? 'default' : name, { local: name });
      statement(node, new Set([name])); span(node, new Set([name]));
    } else if (ts.isVariableStatement(node)) {
      const names = new Set();
      for (const declaration of node.declarationList.declarations) patternNames(declaration.name, names);
      if (exported(node)) for (const name of names) shape.exports.set(name, { local: name });
      statement(node, names); span(node, names);
    } else { statement(node, new Set()); span(node, null); }
  }
  shape.declaring = new Map();
  shape.statements.forEach((statement, at) => { for (const name of statement.declares) shape.declaring.set(name, [...(shape.declaring.get(name) ?? []), at]); });
  return shape;
}

/**
 * The dependency map: every tracked file some test file reaches, mapped to the test files that
 * reach it. A test reaches the modules it loads, and from each module only what the names it takes
 * reference — the declarations behind them, the statements every load runs, and the modules those
 * load — transitively; and the paths it or anything it loads outside src/ and web/ reads as data,
 * which are not followed further. A test file maps to itself. `map.declarations` holds, per file, the
 * tests each top-level declaration is needed by; `map.readers` the tests reading each file as data; `map.reverse` every code file's importers, and
 * `map.texts` each test file's text, for placing a file the map does not hold.
 */
export function dependencyMap(root = repositoryRoot, tests = listTestFiles(root)) {
  const tracked = trackedFiles(root).filter(file => existsSync(join(root, file)));
  const files = new Set(tracked), directories = new Map();
  for (const file of tracked) {
    const parts = file.split('/');
    for (let at = 1; at < parts.length; at++) { const directory = parts.slice(0, at).join('/'); directories.set(directory, [...(directories.get(directory) ?? []), file]); }
  }
  const none = { imports: new Set(), shape: null, data: new Set() }, edgeCache = new Map(), texts = new Map();
  const text = file => { if (!texts.has(file)) texts.set(file, readFileSync(join(root, file), 'utf8')); return texts.get(file); };
  const edgesOf = file => {
    if (!edgeCache.has(file)) edgeCache.set(file, codeExtension.test(file) && files.has(file) ? fileEdges(file, text(file), files, directories) : none);
    return edgeCache.get(file);
  };
  // Whether `name` is exported by `file`, itself or through its `export *`.
  const provides = (file, name, seen = new Set()) => {
    const shape = edgesOf(file).shape;
    if (!shape || seen.has(file)) return false;
    seen.add(file);
    return shape.exports.has(name) || shape.stars.some(target => provides(target, name, seen));
  };
  const reach = test => {
    // Each module with the names asked of it so far (`null`: all); a module asked for new names is resolved again.
    const asked = new Map([[test, null]]), modules = [[test, null]], statements = [], done = new Set(), read = new Set(), used = new Map(), props = new Set();
    let methods = [];
    const ask = (file, names) => {
      const before = asked.get(file);
      if (asked.has(file) && (before === null || (names && [...names].every(name => before.has(name))))) return;
      const merged = !asked.has(file) ? names : before === null || names === null ? null : new Set([...before, ...names]);
      asked.set(file, merged); modules.push([file, merged]);
    };
    const askBinding = ({ target, name }) => ask(target, name === null ? null : new Set([name]));
    const want = (file, at) => { const key = `${file}\0${at}`; if (!done.has(key)) { done.add(key); statements.push([file, at]); } };
    const take = (file, shape, part) => {
      for (const name of part.declares) used.set(file, (used.get(file) ?? new Set()).add(name));
      for (const { target, name } of part.loads) ask(target, name);
      for (const target of part.data ?? []) read.add(target);
      for (const name of part.props) props.add(name);
      for (const ref of part.refs) if (shape.bindings.has(ref)) askBinding(shape.bindings.get(ref)); else for (const at of shape.declaring.get(ref) ?? []) want(file, at);
    };
    for (;;) {
      if (modules.length) {
        const [file, names] = modules.pop(), { shape } = edgesOf(file);
        if (!shape) continue;
        for (const target of shape.loads) ask(target, new Set());
        for (const at of shape.effects) want(file, at);
        if (names === null) { shape.statements.forEach((_, at) => want(file, at)); for (const target of shape.stars) ask(target, null); }
        for (const [name, entry] of shape.exports) {
          if (names !== null && !names.has(name)) continue;
          if (entry.local) for (const at of shape.declaring.get(entry.local) ?? []) want(file, at); else askBinding(entry);
        }
        if (names !== null) for (const name of names) if (!shape.exports.has(name)) for (const target of shape.stars) if (provides(target, name)) ask(target, new Set([name]));
      } else if (statements.length) {
        const [file, at] = statements.pop(), { shape } = edgesOf(file), statement = shape.statements[at];
        take(file, shape, statement);
        for (const member of statement.members) methods.push([file, shape, member]);
      } else {
        const ready = methods.filter(([, , member]) => props.has(member.name));
        if (!ready.length) break;
        methods = methods.filter(entry => !ready.includes(entry));
        for (const [file, shape, member] of ready) take(file, shape, member);
      }
    }
    return { files: new Set([...asked.keys(), ...read]), read, used };
  };
  const map = new Map(), declarations = new Map(), readers = new Map();
  for (const test of tests) {
    const { files: reached, read, used } = reach(test);
    for (const file of reached) map.set(file, [...(map.get(file) ?? []), test]);
    for (const file of read) readers.set(file, [...(readers.get(file) ?? []), test]);
    for (const [file, names] of used) {
      if (!declarations.has(file)) declarations.set(file, new Map());
      for (const name of names) declarations.get(file).set(name, [...(declarations.get(file).get(name) ?? []), test]);
    }
  }
  map.declarations = declarations; map.readers = readers;
  map.reverse = new Map();
  for (const file of tracked) for (const next of edgesOf(file).imports) map.reverse.set(next, [...(map.reverse.get(next) ?? []), file]);
  map.texts = new Map(tests.filter(test => files.has(test)).map(test => [test, text(test)]));
  return map;
}

/**
 * The tests for a file the map does not hold: those reaching or naming it, or any file that imports
 * it, transitively. A test names a file by its file name (a code file's with any code extension).
 */
function unmappedTests(file, map) {
  const seen = new Set([file]), queue = [file];
  while (queue.length) for (const next of map.reverse?.get(queue.pop()) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  const selected = new Set();
  for (const path of seen) {
    for (const test of map.get(path) ?? []) selected.add(test);
    const name = posix.basename(path), stem = name.replace(codeExtension, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const named = new RegExp(`(?<![\\w-])${codeExtension.test(name) ? `${stem}\\.[cm]?[jt]sx?` : name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
    for (const [test, text] of map.texts ?? []) if (named.test(text)) selected.add(test);
  }
  return selected;
}

/**
 * The top-level declarations each changed code file's diff from `base` to `head` (default: the
 * working tree) touches, on both sides of every hunk, or `null` for a file the change touches as a whole: a
 * test file, an import, an export list or a statement run on load, or a diff git cannot answer.
 */
export function changedDeclarations(changed, base, root = repositoryRoot, head = null) {
  const result = new Map();
  for (const file of changed) {
    if (!codeExtension.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file)) { result.set(file, null); continue; }
    let diff;
    try { diff = execFileSync('git', ['diff', '-U0', '--no-renames', '--no-ext-diff', base, ...(head ? [head] : []), '--', file], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { result.set(file, null); continue; }
    const show = revision => { try { return execFileSync('git', ['show', `${revision}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
    const side = text => text === null ? null : moduleShape(file, text, () => []);
    const before = side(show(base)), after = side(head ? show(head) : existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : null);
    let names = new Set();
    const touch = (shape, from, count) => {
      for (let line = from; line < from + count && names; line++) {
        const span = shape?.spans.find(entry => (entry.first ?? 0) <= line && line <= entry.last);
        if (!shape || span?.names === null) names = null;
        else if (span?.names.bindings) for (const statement of shape.statements.flatMap(statement => [statement, ...statement.members])) { if ([...span.names.bindings].some(binding => statement.refs.has(binding))) { if (!statement.declares.size) names = null; else for (const name of statement.declares) names?.add(name); } }
        else if (span) for (const name of span.names) names.add(name);
      }
    };
    for (const [, from, count = '1', to, length = '1'] of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) { touch(before, Number(from), Number(count)); touch(after, Number(to), Number(length)); }
    result.set(file, names);
  }
  return result;
}

/**
 * The test files a change affects, the full suite and why, or nothing. The full suite runs when a
 * changed file is the install or configuration, or when the changed files are unknown. A changed file
 * selects the tests reaching it — only those needing the declarations it touches, where `declarations`
 * (`changedDeclarations`) names them — and a file the map does not hold the tests that import or name
 * it. A change limited to documentation selects nothing: no test executes it.
 */
export function selectAffected(changed, map, tests, declarations = new Map()) {
  if (!changed) return { mode: 'full', reason: 'the changed files are unknown', files: tests };
  const effective = changed.filter(file => !isDocumentation(file));
  if (!effective.length) return { mode: 'affected', reason: `${changed.length} changed file(s) are documentation only`, files: [] };
  for (const file of effective) if (fullSuitePaths.some(pattern => pattern.test(file))) return { mode: 'full', reason: `${file} changes the install, the test runner or configuration`, files: tests };
  const testsFor = file => {
    if (!map.has(file)) return [...unmappedTests(file, map)];
    const names = declarations.get(file);
    return names ? [...(map.readers?.get(file) ?? []), ...[...names].flatMap(name => map.declarations?.get(file)?.get(name) ?? [])] : map.get(file);
  };
  const selected = new Set(effective.flatMap(testsFor));
  if (selected.size === tests.length) return { mode: 'full', reason: `every test file reaches the ${effective.length} changed file(s)`, files: tests };
  return { mode: 'affected', reason: `${selected.size} of ${tests.length} test files are affected by ${effective.length} changed file(s)`, files: tests.filter(test => selected.has(test)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'affected') {
    // GRAPHYARD_SELECTION_BASE (the merge writer's trial sets its base tip) narrows each changed file to the declarations its diff touches.
    const base = process.env.GRAPHYARD_SELECTION_BASE;
    const selection = selectAffected(args, dependencyMap(), listTestFiles(), base ? changedDeclarations(args, base) : undefined);
    // The files follow in both modes, so the merge writer's trial runs exactly this selection; an empty one runs nothing.
    console.log(`${selection.mode}: ${selection.reason}`); if (selection.files.length) console.log(selection.files.join('\n'));
  } else {
    throw new Error('Usage: ci-tests affected FILE...');
  }
}
