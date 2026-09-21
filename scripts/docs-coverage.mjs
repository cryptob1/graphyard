// The documented surface. Condensing the guides may remove repetition and rationale, never a
// name a reader has to be able to find: every CLI command and flag, including the options the
// CLI parses but its help omits, every environment variable the server reads and every
// `GRAPHYARD_*` variable any source module names, every operator-agent capability, gate, proof
// family and refusal trigger, every work command, every HTTP route the server registers and
// every query parameter a route accepts, and every route that answers by audit role.
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

/** Every TypeScript module under a source directory. */
function sourceFiles(root, directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sourceFiles(root, join(directory, entry.name))
    : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []).sort();
}

/**
 * Option names the CLI hands to `parseArgs`. The help prints the common flags only, so an option
 * a command accepts without advertising (`master init --browser-executable`) is found here.
 */
export function parsedFlags(root = repositoryRoot) {
  const flags = new Set();
  for (const path of sourceFiles(root, 'src/cli'))
    for (const match of read(root, path).matchAll(/(?:'([a-z][a-z0-9-]*)'|\b([a-z][a-zA-Z0-9]*))\s*:\s*\{\s*type:\s*'(?:string|boolean)'/g)) flags.add(`--${match[1] ?? match[2]}`);
  return [...flags].sort();
}

/**
 * Every `GRAPHYARD_*` variable a source module names, whoever reads it: the CLI, a runner
 * container, a launched session or a test run are out of the server's import graph. A name
 * ending in `_` is a prefix the code builds names from, not a variable.
 */
export function sourceEnvironment(root = repositoryRoot) {
  const names = new Set();
  for (const path of sourceFiles(root, 'src'))
    for (const match of read(root, path).matchAll(/\bGRAPHYARD_[A-Z0-9]+(?:_[A-Z0-9]+)*\b(?!_)/g)) names.add(match[0]);
  return [...names].sort();
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
 * Each registration carries its module's text and its own slice of it, up to the next one.
 */
function routeRegistrations(root) {
  const registrations = [];
  for (const file of readdirSync(join(root, 'src/server/routes')).filter(name => name.endsWith('.ts')).sort()) {
    const text = read(root, join('src/server/routes', file));
    const matches = [...text.matchAll(/method: '([A-Z*]+)', path: (?:'([^']+)'|\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n[])+)\/)/g)];
    matches.forEach(([, method, literal, pattern], index) => {
      if (pattern && !pattern.endsWith('$')) return;
      const path = literal ?? pattern.replace(/^\^|\$$/g, '').replace(/\\\//g, '/').replace(/\((?:\[\^\/\]\+|\\d\+|\[a-z\]\+)\)/g, 'ID').replace(/\(\?:((?:[^()]|\([^()]*\))*)\)\?/g, '[$1]');
      registrations.push({ routes: expandPath(path).map(expanded => `${method === '*' ? 'GET' : method} ${expanded}`), module: text, handler: text.slice(matches[index].index, matches[index + 1]?.index) });
    });
  }
  return registrations;
}

export const httpRoutes = (root = repositoryRoot) => [...new Set(routeRegistrations(root).flatMap(registration => registration.routes))].sort();

/**
 * Every query parameter a route accepts, one entry per concrete route: each `searchParams.get('NAME')`
 * its handler reads, and the keys of each `z.object({…})` schema that parses the query string, in
 * the handler, in a module function the handler calls, or in a parser the module imports and hands
 * `searchParams`. A schema that parses a request body names
 * no query parameter. Such schemas are `.strict()`, so a parameter a client cannot learn from the
 * guides is one it cannot discover by trial either.
 */
export function queryParameters(root = repositoryRoot) {
  const parameters = new Set();
  for (const { routes, module, handler } of routeRegistrations(root)) {
    const names = [...handler.matchAll(/searchParams\.get\('([A-Za-z]\w*)'\)/g)].map(match => match[1]);
    for (const [, schema, body] of module.matchAll(/\bconst (\w+) = z\.object\(\{\n([\s\S]*?)\n\}\)/g)) {
      const parse = module.match(new RegExp(`(?:const (\\w+) = ([^\\n]*)\\n\\s*)?[^\\n]*\\b${schema}\\.parse\\((\\w*)([^\\n]*)`));
      if (!parse || !(parse[4].includes('searchParams') || (parse[1] === parse[3] && parse[2].includes('searchParams')))) continue;
      const callers = [`${schema}.parse(`, ...[...module.matchAll(/\nfunction (\w+)\([^\n]*\{\n([\s\S]*?)\n\}/g)].filter(helper => helper[2].includes(`${schema}.parse(`)).map(helper => `${helper[1]}(`)];
      if (callers.some(call => handler.includes(call))) names.push(...[...body.matchAll(/(?:^|,)\s*([A-Za-z]\w*): z\./gm)].map(match => match[1]));
    }
    names.push(...importedQueryParsers(root, module, handler));
    for (const route of routes) for (const name of names) parameters.add(`${name} on ${route}`);
  }
  return [...parameters].sort();
}

/**
 * Schema keys of a query parser the route module imports: the handler passes it `searchParams`
 * (`parseEventHistoryQuery(url.searchParams)`), and the module that exports it parses a
 * `z.object({…})` schema inside that function.
 */
function importedQueryParsers(root, module, handler) {
  const names = [];
  for (const [, parser] of handler.matchAll(/\b(\w+)\(url\.searchParams\)/g)) {
    const source = module.match(new RegExp(`import \\{[^}]*\\b${parser}\\b[^}]*\\} from '(\\.[^']+)\\.js'`));
    if (!source) continue;
    const text = read(root, join('src/server/routes', `${source[1]}.ts`));
    const body = text.match(new RegExp(`\\nexport function ${parser}\\([^\\n]*\\{\\n([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
    for (const [, schema, keys] of text.matchAll(/\bconst (\w+) = z\.object\(\{\n([\s\S]*?)\n\}\)/g))
      if (body.includes(`${schema}.parse(`)) names.push(...[...keys.matchAll(/(?:^|,)\s*([A-Za-z]\w*): z\./gm)].map(match => match[1]));
  }
  return names;
}

/**
 * Whether a page documents a query parameter: it spells the route, and spells the parameter as a
 * code span of its own or as `?name=` or `&name=` inside one. A word in running prose, or on a
 * page about something else (`slice` the delegation term), documents nothing a client can send.
 */
function spellsParameter(page, entry) {
  const [name, route] = entry.split(' on ');
  return documentedRoutes([page]).has(route) && new RegExp(`\`${name}\`|\`[^\`\\n]*[?&]${name}=[^\`\\n]*\``).test(page.text);
}

/**
 * Every route whose answer depends on the caller holding an audit role: its handler consults the
 * module's `auditRoles`, to refuse the read or to withhold identifiers. Most role checks live in
 * the services and are out of a route module's sight; this one is a route's own, so it is
 * extracted. A page documents it by spelling the route and stating the audit-role rule, or
 * linking to it by that name.
 */
export const auditRoleRoutes = (root = repositoryRoot) => [...new Set(routeRegistrations(root).filter(registration => /\bauditRoles\b/.test(registration.handler)).flatMap(registration => registration.routes))].sort();
const statesAuditRule = (page, route) => documentedRoutes([page]).has(route) && /\baudit[- ]roles?\b/i.test(page.text);

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
    ...[...new Set([...cliSurface(help).flags, ...parsedFlags(root)])].map(name => ({ kind: 'cli flag', name })),
    ...[...new Set([...serverEnvironment(root), ...sourceEnvironment(root)])].map(name => ({ kind: 'environment variable', name })),
    ...capabilities(root).map(name => ({ kind: 'capability', name })),
    ...gateNames(root).map(name => ({ kind: 'gate', name })),
    ...proofFamilies(root).map(name => ({ kind: 'proof family', name: `${name}:` })),
    ...refusalTriggers(root).map(name => ({ kind: 'refusal trigger', name })),
    ...workCommands(root).map(name => ({ kind: 'work command', name: `\`${name}\`` })),
    ...httpRoutes(root).map(name => ({ kind: 'http route', name })),
    ...queryParameters(root).map(name => ({ kind: 'query parameter', name })),
    ...auditRoleRoutes(root).map(name => ({ kind: 'audit-role rule', name })),
  ];
}

/** Whether a page spells a flag or variable whole: `--deployment-url` does not document `--deployment`. */
const spelled = (text, name) => new RegExp(`(?<![A-Za-z0-9_-])${name}(?![A-Za-z0-9_-])`).test(text);

/** Every surface entry no page mentions, with the kind that defines it. */
export function missing(root = repositoryRoot, help, pages = documentation(root)) {
  const routes = documentedRoutes(pages);
  const mentioned = entry => entry.kind === 'http route' ? routes.has(entry.name)
    : entry.kind === 'query parameter' ? pages.some(page => spellsParameter(page, entry.name))
    : entry.kind === 'audit-role rule' ? pages.some(page => statesAuditRule(page, entry.name))
    : pages.some(page => entry.kind === 'cli flag' || entry.kind === 'environment variable' ? spelled(page.text, entry.name) : page.text.includes(entry.name));
  return surface(root, help)
    .filter(entry => !mentioned(entry))
    .map(entry => `${entry.kind} ${entry.name} is documented nowhere`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { renderHelp } = await import('../src/cli/index.ts');
  const gaps = missing(repositoryRoot, renderHelp());
  for (const gap of gaps) console.error(gap);
  console.log(`${surface(repositoryRoot, renderHelp()).length} documented names checked, ${gaps.length} missing`);
  process.exit(gaps.length ? 1 : 0);
}
