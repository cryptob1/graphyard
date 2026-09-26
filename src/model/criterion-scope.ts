// ---------------------------------------------------------------------------
// Criteria-implied files (GY-438). A criterion rarely names the file its behaviour lives in: it
// names the function, export, route, CLI command, config key or UI label, and the worker asks for
// the file that holds it. On 2026-09-25 a master granted six such requests by hand (GY-259, GY-402,
// GY-406, GY-409, GY-413 twice). The loop reads each requested file from the base branch outside
// every transaction and grants it when it defines or directly calls a symbol a criterion names, or
// — for a test — when it holds a label, route or CLI output a criterion changes. Nothing here reads
// a file; anything these rules do not ground still goes to the approver.
// ---------------------------------------------------------------------------
import { namedPaths, pathScope, testFile, type ScopeCriterion } from './scope.js';

/** What a criterion names: a code identifier, a phrase an identifier spells (`launch failure` → `launchFailure…`), a config key, a route, a CLI command or a quoted label. */
export interface CriterionSymbol { criterion: string; kind: 'identifier' | 'phrase' | 'key' | 'route' | 'command' | 'label'; symbol: string }

const proseWords = new Set(('a an the and or nor but of to in on at by for with from into onto over under that this these those its it is are be been was were as not no only each every any all one two ' +
  'before after then than through same when which whose while never also has have had does do did their them they there here what who how why may must can could should would will shall ' +
  'test tests asserts assert both either else other others such own more most less least new old per via so if up us we my me he she vs etc ie eg').split(' '));
const humps = (identifier: string) => identifier.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[\s_$]+/).filter(Boolean).map(word => word.toLowerCase());
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The least length of a symbol or label the rules read: a shorter one is too common to tie a file to a criterion. */
export const criterionSymbolMin = 4;

/**
 * Every symbol the item's criteria name, in the bounded forms prose can name one: camelCase,
 * PascalCase, snake_case and `call()` identifiers, dotted config keys and quoted JSON keys, routes
 * (`/api/…`), `graphyard [master] COMMAND` commands, `X › Y` navigation labels and quoted text, and
 * each run of two or three plain words as the identifier it would spell. Paths are not symbols:
 * the implication rule (scope.ts impliedScopes) already reads those.
 */
export function criterionSymbols(criteria: readonly ScopeCriterion[]): CriterionSymbol[] {
  const found = new Map<string, CriterionSymbol>();
  const add = (criterion: string, kind: CriterionSymbol['kind'], symbol: string) => {
    if (symbol.length >= criterionSymbolMin && !found.has(`${kind}:${symbol}`)) found.set(`${kind}:${symbol}`, { criterion, kind, symbol });
  };
  for (const { id, text } of criteria) {
    const paths = new Set(namedPaths(text));
    // Quoted text: a UI label, an output line, a config value or a command.
    for (const match of text.matchAll(/`([^`\n]+)`|"([^"\n]+)"|“([^”\n]+)”|‘([^’\n]+)’|(?<![A-Za-z0-9])'([^'\n]+)'(?![A-Za-z0-9])/g)) {
      const quoted = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]).trim();
      if (!paths.has(quoted) && !/^(?:graphyard\s+)?master\s/.test(quoted)) add(id, 'label', quoted);
    }
    for (const match of text.matchAll(/"([A-Za-z_][\w-]*)"\s*:/g)) add(id, 'key', match[1]);
    for (const match of text.matchAll(/(?<![\w/.-])([a-z][A-Za-z0-9]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)(?![\w/-]|\.[A-Za-z])/g)) {
      if (paths.has(match[1]) || /\.(?:ts|tsx|js|mjs|cjs|json|md|ya?ml|sh|css|html)$/.test(match[1])) continue;
      for (const segment of match[1].split('.')) if (/[A-Z_]/.test(segment) || segment.length >= 6) add(id, 'key', segment);
    }
    for (const match of text.matchAll(/(?<![\w./-])([A-Za-z_$][\w$]*)(\(\))?(?![\w/-]|\.[A-Za-z])/g)) {
      const word = match[1];
      // PascalCase of two humps is as often a name (GitHub, OpenAI) as code: a phrase reads those.
      if (match[2] || /^[a-z][a-z0-9]*[A-Z]/.test(word) || /^[A-Z][a-z0-9]+[A-Z][a-z0-9]+[A-Z]/.test(word) || /^[a-z]+_[a-z_]+$/.test(word)) add(id, 'identifier', word);
    }
    for (const match of text.matchAll(/(?<![\w.-])(\/(?:api|v\d)\/[\w:{}./-]*[\w}]|\/[a-z][\w-]*(?:\/[\w:{}-]+)+)/g)) add(id, 'route', match[1]);
    for (const match of text.matchAll(/\bgraphyard\s+((?:master\s+)?[a-z][a-z-]*)/g)) add(id, 'command', match[1]);
    for (const match of text.matchAll(/`((?:master\s+)?[a-z][a-z-]*)(?:\s[^`]*)?`/g)) if (/^master\s/.test(match[1])) add(id, 'command', match[1]);
    for (const match of text.matchAll(/\b(?:the\s+)?`?(master\s+[a-z][a-z-]+)`?\s+(?:command|report|output|attention)/g)) add(id, 'command', match[1]);
    for (const match of text.matchAll(/([A-Z][\w-]*(?:\s+[A-Z][\w-]*)*(?:\s*›\s*[A-Z][\w-]*(?:\s+[A-Z][\w-]*)*)+)/g)) add(id, 'label', match[1].replace(/\s*›\s*/g, ' › '));
    // Runs of plain words, as the identifier they spell: `launch that fails`, never across punctuation.
    for (const clause of text.split(/[^A-Za-z\s-]+/)) {
      const words = clause.split(/[\s-]+/).filter(Boolean);
      for (let start = 0; start < words.length; start++) for (const length of [2, 3]) {
        const run = words.slice(start, start + length);
        if (run.length === length && run.every(word => /^[A-Za-z][a-z]+$/.test(word) && !proseWords.has(word.toLowerCase()))) add(id, 'phrase', run.map(word => word.toLowerCase()).join(' '));
      }
    }
  }
  return [...found.values()];
}

/** The identifiers a file declares or exports (`declared`; `exported` those it only lists in an export), and the members its objects, classes and types define (`members`). */
function definedIdentifiers(source: string) {
  const declared = new Set<string>(), members = new Set<string>(), exported = new Set<string>();
  // An import names a symbol another file defines: it is neither a declaration nor a member here.
  const text = source.replace(/^\s*import\s[\s\S]*?\bfrom\s*['"][^'"]+['"]\s*;?/gm, '');
  for (const match of text.matchAll(/\bexport\s*(?:type\s*)?\{([^}]*)\}/g)) for (const entry of match[1].split(',')) {
    const name = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/).at(-1)?.trim();
    if (name && /^[A-Za-z_$][\w$]*$/.test(name) && !declared.has(name)) exported.add(name);
  }
  // Export lists read, they are cut away: `type X` inside one names a symbol, not a declaration here.
  const code = text.replace(/\bexport\s*(?:type\s*)?\{[^}]*\}/g, '');
  for (const match of code.matchAll(/\b(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1]);
  for (const name of exported) if (!declared.has(name)) declared.add(name); else exported.delete(name);
  // A property (`name:`), a field (`name =`) or a method (`name(…) {`) — never a call statement (`name(…);`).
  for (const match of text.matchAll(/^\s*(?:(?:public|private|protected|readonly|static|async|get|set)\s+)*([A-Za-z_$][\w$]*)\??\s*(?::(?!:)|=(?![=>])|\([^()]*\)\s*(?::[^{;=]*)?\{)/gm)) members.add(match[1]);
  return { declared, members, exported };
}
/** The identifiers a file calls directly: `name(`, never a declaration of it. */
function calledIdentifiers(text: string) {
  const names = new Set<string>();
  for (const match of text.matchAll(/(?<!\bfunction\*?\s+|\bnew\s+)(?<![\w$])([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\(/g)) names.add(match[1]);
  return names;
}
const spells = (identifier: string, phrase: string) => {
  const words = phrase.split(' '), parts = humps(identifier);
  return parts.some((_, start) => words.every((word, index) => parts[start + index] === word || index === words.length - 1 && parts[start + index] === `${word}s`));
};
const literal = (text: string, value: string) => new RegExp(`['"\`]${escapeRegExp(value)}(?:['"\`/?]|\\$\\{)`).test(text);

/** The most files on the base that may mention an identifier a phrase spells for a call of it to ground a file: more, and it is shared plumbing, not the criterion's behaviour. */
export const criterionCallersMax = 10;
/**
 * The identifiers `text` calls that spell a phrase of the criteria: the ones whose spread over the
 * base tree the caller searches for (`criterionSymbolGround`'s `mentions`) before a call of one
 * can ground the file.
 */
export function phraseCallees(text: string | null, symbols: readonly CriterionSymbol[]) {
  if (!text) return [];
  const phrases = symbols.filter(entry => entry.kind === 'phrase');
  return [...calledIdentifiers(text)].filter(name => phrases.some(entry => spells(name, entry.symbol)));
}

/**
 * The ground a file is granted on because it defines or directly calls a symbol a criterion names,
 * or null. An identifier counts where the file declares, defines or calls it; a config key where
 * it declares or reads it; a route where it holds it as a string; a CLI command where the file is
 * named for it or dispatches on its word. A phrase spells an identifier less exactly than code
 * names one, so it grounds the file that declares that identifier, or a file that calls it when
 * the base-tree search (`mentions`, files per identifier) finds it in at most criterionCallersMax
 * files. A mere mention — an import, a comment, prose — grounds nothing.
 */
export function criterionSymbolGround(path: string, text: string | null, symbols: readonly CriterionSymbol[], mentions: ReadonlyMap<string, number> = new Map()): string | null {
  if (!text || pathScope(path).prefix) return null;
  const { declared, members, exported } = definedIdentifiers(text), called = calledIdentifiers(text);
  const defines = (name: string) => exported.has(name) ? 'exports' : 'defines';
  const base = path.split('/').at(-1)!.replace(/\.[^.]+$/, '');
  for (const entry of symbols) {
    const { criterion, symbol } = entry;
    if (entry.kind === 'identifier') {
      if (declared.has(symbol) || members.has(symbol)) return `${path} ${defines(symbol)} ${symbol}, which ${criterion} names`;
      if (called.has(symbol)) return `${path} calls ${symbol}, which ${criterion} names`;
    } else if (entry.kind === 'key') {
      if (declared.has(symbol) || members.has(symbol)) return `${path} declares the config key ${symbol}, which ${criterion} names`;
      if (new RegExp(`(?:\\.|\\[['"])${escapeRegExp(symbol)}\\b(?!\\s*\\()`).test(text)) return `${path} reads the config key ${symbol}, which ${criterion} names`;
    } else if (entry.kind === 'route') {
      const prefix = symbol.split(/[:{]/)[0].replace(/\/$/, '');
      if (prefix.length > 1 && literal(text, prefix)) return `${path} holds the route ${symbol}, which ${criterion} names`;
    } else if (entry.kind === 'command') {
      const words = symbol.split(/\s+/), last = words.at(-1)!;
      if (base === words.join('-')) return `${path} is the \`${symbol}\` command ${criterion} names`;
      // A subcommand's word alone (`status`) is everywhere: its dispatcher lives under its parent command's name.
      const under = words.length === 1 || words.slice(0, -1).every(word => path.split('/').some(segment => segment.startsWith(word)));
      if (under && new RegExp(`(?:===\\s*|case\\s+)['"]${escapeRegExp(last)}['"]`).test(text)) return `${path} dispatches the \`${symbol}\` command ${criterion} names`;
    }
  }
  const phrases = symbols.filter(entry => entry.kind === 'phrase');
  for (const { criterion, symbol } of phrases) {
    const definer = [...declared].find(name => spells(name, symbol));
    if (definer) return `${path} ${defines(definer)} ${definer}, the "${symbol}" ${criterion} names`;
  }
  for (const { criterion, symbol } of phrases) {
    const caller = [...called].find(name => spells(name, symbol) && (mentions.get(name) ?? Infinity) <= criterionCallersMax);
    if (caller) return `${path} calls ${caller}, the "${symbol}" ${criterion} names`;
  }
  return null;
}

/** A relative module specifier resolved against the file that imports it, without its extension. */
const moduleStem = (from: string, specifier: string) => {
  const parts = from.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.') parts.push(segment);
  }
  return parts.join('/').replace(/\.(?:[cm]?[jt]sx?)$/, '');
};
const stem = (path: string) => path.replace(/\.(?:[cm]?[jt]sx?)$/, '').replace(/\/index$/, '');
/**
 * The ground a file is granted on as the successor of a planned file split before the item was
 * planned, or null. GY-259 planned src/master-daemon.ts after GY-177 had already split it into
 * src/daemon/*, so git history since the item's creation (model/successors.ts) holds no split to
 * find; the planned file itself does. A planned file the base holds as a pure re-export barrel —
 * nothing but comments and `export … from` — names its successors: each module it re-exports, and
 * every file directly inside a directory it re-exports from other than its own.
 */
export function barrelSuccessorGround(path: string, planned: readonly { path: string; text: string | null }[]): string | null {
  if (pathScope(path).prefix || !/\.[cm]?[jt]sx?$/.test(path)) return null;
  for (const file of planned) {
    if (!file.text || file.path === path) continue;
    const sources = [...file.text.matchAll(/\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map(match => moduleStem(file.path, match[1]));
    if (!sources.length) continue;
    if (sources.includes(stem(path))) return `successor of ${file.path}, which re-exports it`;
    const code = file.text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"][^'"]+['"]\s*;?/g, '');
    if (code.trim()) continue;
    const own = file.path.split('/').slice(0, -1).join('/');
    const directory = path.split('/').slice(0, -1).join('/');
    if (directory !== own && sources.some(source => source.split('/').slice(0, -1).join('/') === directory)) return `successor of ${file.path}, a barrel over ${directory}/ where it was split`;
  }
  return null;
}

/**
 * The ground an existing test file is granted on because it pins a UI label, route or CLI output a
 * criterion changes — the test holds that string, so the change breaks it — or null. A browser
 * test pins labels, never source, so the pinning rule (scope.ts pinningTestGround) cannot ground it; this one can.
 */
export function criterionTestGround(path: string, text: string | null, symbols: readonly CriterionSymbol[]): string | null {
  if (!text || !testFile(path)) return null;
  for (const entry of symbols) {
    // A command's name is not its output: dozens of tests run `master status`, few pin what it prints.
    if (entry.kind !== 'label' && entry.kind !== 'route') continue;
    // A one-word label is only a pinned string where the test quotes it whole.
    const pinned = entry.kind === 'label' && !/\s/.test(entry.symbol) ? literal(text, entry.symbol) && new RegExp(`['"\`]${escapeRegExp(entry.symbol)}['"\`]`).test(text) : text.includes(entry.symbol);
    if (pinned) return `${path} pins the ${entry.kind === 'label' ? 'label or output' : entry.kind} "${entry.symbol.length > 80 ? `${entry.symbol.slice(0, 79)}…` : entry.symbol}" that ${entry.criterion} changes`;
  }
  return null;
}
