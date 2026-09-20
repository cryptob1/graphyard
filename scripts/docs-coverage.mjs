// The documented surface. Condensing the guides may remove repetition and rationale, never a
// name a reader has to be able to find: every CLI command and flag, every environment variable
// the server reads, every operator-agent capability, gate, proof family and refusal trigger,
// every work command and every HTTP route the server registers.
//
// Each set is extracted from the code that defines it rather than from a list kept by hand, so
// a surface added in source fails this check until the documentation names it.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { corpusPaths } from './docs-budget.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (root, path) => readFileSync(join(root, path), 'utf8');

/** The prose a reader searches: the budgeted corpus plus the repository README. */
export function documentation(root = repositoryRoot) {
  return [...corpusPaths(root), 'README.md'].map(path => ({ path, text: read(root, path) }));
}

/**
 * Command names and flags as the CLI's own help prints them. A help entry begins at column
 * three; its command is the run of plain lowercase words before the first placeholder,
 * argument or alternation, so `runner snapshot file.json` is the command `runner snapshot`.
 */
export function cliSurface(help) {
  const commands = [...new Set([...help.matchAll(/^ {2}(\S.*)$/gm)].map(match => {
    const words = [];
    for (const token of match[1].split(/\s+/)) { if (!/^[a-z][a-z0-9-]*$/.test(token)) break; words.push(token); }
    return words.join(' ');
  }).filter(Boolean))];
  const flags = [...new Set([...help.matchAll(/--[a-z][a-z0-9-]*/g)].map(match => match[0]))];
  return { commands, flags };
}

/** Every module the server process can reach, following relative imports from its entry point. */
function serverModules(root, entry = 'src/server.ts') {
  const seen = new Set(), queue = [entry];
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const text = read(root, path);
    for (const match of text.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = relative(root, resolve(root, dirname(path), match[1].replace(/\.js$/, '.ts')));
      try { read(root, target); queue.push(target); } catch { /* a type-only or package import */ }
    }
  }
  return [...seen];
}

/**
 * Environment variables the server reads: every literal `process.env.NAME`/`env.NAME` access in
 * a module it can reach, plus the capacity variables it looks up by name from a list.
 */
export function serverEnvironment(root = repositoryRoot) {
  const names = new Set();
  for (const path of serverModules(root)) {
    const text = read(root, path);
    for (const match of text.matchAll(/(?:process\.)?env(?:\.([A-Z][A-Z0-9_]{2,})|\[\s*'([A-Z][A-Z0-9_]{2,})'\s*\])/g)) names.add(match[1] ?? match[2]);
  }
  for (const name of arrayLiteral(read(root, 'src/delegation.ts'), 'delegationLimitVariables')) names.add(name);
  return [...names].sort();
}

/** The string entries of an exported `const NAME = [...]` array literal. */
function arrayLiteral(text, name) {
  const match = text.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`));
  return match ? [...match[1].matchAll(/'([^']+)'/g)].map(entry => entry[1]) : [];
}

export const capabilities = (root = repositoryRoot) => arrayLiteral(read(root, 'src/model/work.ts'), 'operatorCapabilities');
export const refusalTriggers = (root = repositoryRoot) => arrayLiteral(read(root, 'src/model/work.ts'), 'escalationTriggers');
export const gateNames = (root = repositoryRoot) => [...new Set([...read(root, 'src/model/gates.ts').matchAll(/\badd\('([a-z-]+)'/g)].map(match => match[1]))];
export function proofFamilies(root = repositoryRoot) {
  const schema = read(root, 'src/model/proof.ts').match(/\^\(([a-z0-9|]+)\):/);
  return schema ? schema[1].split('|') : [];
}

/** The keys of the engine's `const commands = {…}` map: every `POST /api/work/:id/COMMAND`. */
export function workCommands(root = repositoryRoot) {
  const body = read(root, 'src/engine.ts').match(/\nconst commands = \{\n([\s\S]*?)\n\} as const;/);
  return body ? [...body[1].matchAll(/^ {2}([a-z]+):/gm)].map(match => match[1]) : [];
}

/**
 * Every spelling a compact path stands for. The guides write `[…]` for an optional part, `(a|b)`
 * and `{a,b}` for alternatives, and `:id` or an upper-case word (`UUID`, `GY-N`, `REQUEST_ID`)
 * for a placeholder segment, so `GET /api/validation[/capacity|/attempt/REQUEST_ID]` documents
 * `/api/validation`, `/api/validation/capacity` and `/api/validation/attempt/*`.
 */
export function expandPath(path) {
  const open = path.search(/[[({]/);
  if (open < 0) return [path.split('/').map(segment => /^(:.+|[A-Z][A-Z0-9_-]*)$/.test(segment) ? '*' : segment).join('/')];
  const closer = { '[': ']', '(': ')', '{': '}' }[path[open]];
  let depth = 0, close = open;
  for (; close < path.length; close++) {
    if ('[({'.includes(path[close])) depth++;
    else if ('])}'.includes(path[close]) && --depth === 0) break;
  }
  if (path[close] !== closer) return [];
  const alternatives = [], inner = path.slice(open + 1, close);
  let start = 0;
  for (let index = 0, nested = 0; index <= inner.length; index++) {
    if ('[({'.includes(inner[index])) nested++;
    else if ('])}'.includes(inner[index])) nested--;
    else if (index === inner.length || (!nested && inner[index] === (closer === '}' ? ',' : '|'))) { alternatives.push(inner.slice(start, index)); start = index + 1; }
  }
  if (closer === ']') alternatives.push('');
  return [...new Set(alternatives.flatMap(alternative => expandPath(path.slice(0, open) + alternative + path.slice(close + 1))))];
}

/**
 * Every route a module under src/server/routes registers, one entry per concrete path: a regex
 * path is rewritten into the guides' own notation and expanded, a capture of one free segment
 * becoming `*`. A pattern that is not anchored at its end guards a prefix and is no endpoint.
 */
export function httpRoutes(root = repositoryRoot) {
  const routes = new Set();
  for (const file of readdirSync(join(root, 'src/server/routes')).filter(name => name.endsWith('.ts')).sort()) {
    for (const [, method, literal, pattern] of read(root, join('src/server/routes', file)).matchAll(/method: '([A-Z*]+)', path: (?:'([^']+)'|\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n[])+)\/)/g)) {
      if (pattern && !pattern.endsWith('$')) continue;
      const path = literal ?? pattern.replace(/^\^|\$$/g, '').replace(/\\\//g, '/').replace(/\((?:\[\^\/\]\+|\\d\+|\[a-z\]\+)\)/g, 'ID').replace(/\(\?:((?:[^()]|\([^()]*\))*)\)\?/g, '[$1]');
      for (const expanded of expandPath(path)) routes.add(`${method === '*' ? 'GET' : method} ${expanded}`);
    }
  }
  return [...routes].sort();
}

/** Every `METHOD /path` the pages spell, expanded the same way; `GET|POST /path` names both methods. */
export function documentedRoutes(pages) {
  const documented = new Set();
  for (const { text } of pages) {
    for (const [, methods, path] of text.matchAll(/\b((?:GET|POST)(?:\|(?:GET|POST))?) (\/(?:api\/|healthz)[\w:/.*|()[\]{},?=&-]*)/g)) {
      const bare = path.replace(/\?[\w=&.-]*/g, '').replace(/[.,]+$/, '');
      for (const method of methods.split('|')) for (const expanded of expandPath(bare)) documented.add(`${method} ${expanded}`);
    }
  }
  return documented;
}

/** One entry per name the documentation must contain, with the source that defines it. */
export function surface(root = repositoryRoot, help) {
  return [
    ...cliSurface(help).commands.map(name => ({ kind: 'cli command', name })),
    ...cliSurface(help).flags.map(name => ({ kind: 'cli flag', name })),
    ...serverEnvironment(root).map(name => ({ kind: 'environment variable', name })),
    ...capabilities(root).map(name => ({ kind: 'capability', name })),
    ...gateNames(root).map(name => ({ kind: 'gate', name })),
    ...proofFamilies(root).map(name => ({ kind: 'proof family', name: `${name}:` })),
    ...refusalTriggers(root).map(name => ({ kind: 'refusal trigger', name })),
    ...workCommands(root).map(name => ({ kind: 'work command', name: `\`${name}\`` })),
    ...httpRoutes(root).map(name => ({ kind: 'http route', name })),
  ];
}

/** Every surface entry no page mentions, with the kind that defines it. */
export function missing(root = repositoryRoot, help) {
  const pages = documentation(root), routes = documentedRoutes(pages);
  return surface(root, help)
    .filter(entry => entry.kind === 'http route' ? !routes.has(entry.name) : !pages.some(page => page.text.includes(entry.name)))
    .map(entry => `${entry.kind} ${entry.name} is documented nowhere`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { renderHelp } = await import('../src/cli/index.ts');
  const gaps = missing(repositoryRoot, renderHelp());
  for (const gap of gaps) console.error(gap);
  console.log(`${surface(repositoryRoot, renderHelp()).length} documented names checked, ${gaps.length} missing`);
  process.exit(gaps.length ? 1 : 0);
}
