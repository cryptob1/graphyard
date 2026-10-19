import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1694: tests/shared-identity-followups.test.ts held an account until 2026-10-11T05:00Z, a reset
// written as Date.UTC(2026, 9, 11, 5), and judged the hold with Date.now() in its fake control plane
// and in the roles under test. From 05:00Z every required CI run failed on a test nobody touched.
// Such a test is a time bomb: an absolute calendar instant that the test also reads the wall clock
// against, in a file that never stubs Date. This file finds them, and it judges nothing against the
// clock it runs on: whether the instant lies ahead of today, what the wall-clock reading is used for
// and which test body holds either line are not its business, because every one of those readings
// is a guess that hides the next GY-1694 the day the guess is wrong (a fuse the lint saw as spent, a
// Date.now() it took for a stamp, a module-scope reset judged in a test body it did not pair).
//
// The rule, per file under tests/:
//   1. the file constructs an absolute calendar instant: Date.UTC(YYYY, …), new Date('YYYY-…'),
//      Date.parse('YYYY-…') or an ISO date literal 'YYYY-MM-DDT…' (data the code under test parses);
//   2. the file also calls Date.now() or new Date() where no stubbed clock covers the call;
//   3. a stubbed clock is clock.install (tests/helpers/soak-world.ts), node:test's mock.timers.enable
//      with 'Date' among its apis, or an assignment to globalThis.Date, written as code: the same text
//      inside a string literal is data (a preload script, a fixture) and installs nothing, while a
//      Date.now() or new Date() quoted in a string is still a reading, since the lint cannot tell a
//      child's script from a label and a reading it misses is a bomb it misses. A stub covers exactly
//      the code that runs after it, until the clock is restored. Installed at module
//      scope, it covers the file from the stub on: a reading above it at module scope ran at load,
//      before the stub. Installed in a before/beforeEach hook, with a brace body or as the one
//      expression of `before(() => clock.install(now))`, it covers the test bodies that run once the
//      hook has (the tests of the file for a top-level hook, of the describe for a hook in one, the
//      tests inside a sibling describe or loop but not that block's own code, which ran at
//      collection), the hooks that run after it (a before hook written above it, or any before hook
//      beside a beforeEach stub, ran earlier and is not covered) and the hook's own body from the
//      stub on, but neither the code written directly in the hook's block, which ran at load or at
//      collection before any hook, nor a helper's body, which runs whenever it is called. Installed
//      inside any other block, a test body above all, it covers that block from the stub to its
//      closing brace, and no other test in the file;
//   4. a restoration ends the coverage: mock.timers.reset(), mock.reset(), clock.uninstall() or an
//      assignment of the saved real Date back to globalThis.Date (`globalThis.Date = original` after
//      `const original = Date`). Written in the block the stub covers, it ends the coverage there; in
//      a block nested in it (a finally, an if, a helper), it ends the coverage there too, since what
//      follows may run restored; in an after callback nested in it, it ends only that callback, which
//      runs once the tests have, and a brace-less `after(() => clock.uninstall())` ends nothing.
//   A reading in another test body, in a helper, at module scope, earlier in the same body or after
//   the restoration ran on the real clock, however many stubs the file holds elsewhere.
// A file that meets the rule fails this test, named with its first instant line and its first
// uncovered wall-clock line. The way out is to derive the instant from the test's fixed now, to stub
// Date where the reading happens (or for the file), or to list the file in `allowances` by the comment
// in it that documents why its absolute date is safe (a past instant that forces an expiry and stays
// past; fixture dates the code under test receives beside a clock it is handed; a stamp on a record
// nothing compares with the fixture; helpers that read Date only while a test's stub is installed). An
// allowance is bound to what it documents: the calendar dates of the instants the file constructs and
// the number of wall-clock readings no stub covers. A file that later constructs another date or reads
// the clock once more (or less) fails until its comment documents the new pair and the allowance is
// rebound, so an allowance never admits a pair nobody judged. An allowance for a file without that
// comment, or for a file that no longer trips the rule, fails.
// This file is the one file the rule skips, by name: its fixtures are strings holding instants,
// wall-clock calls and stubs for the lint to find, so no reading of its text says anything true.

const self = relative(process.cwd(), fileURLToPath(import.meta.url)).split('\\').join('/');

/** Any four-digit calendar year: 2100 is as absolute as 2026, and 1970 as 2000. The groups give the instant's date. */
const instant = /\bDate\.UTC\(\s*(\d{4})\b(?:\s*,\s*(\d+)\b)?(?:\s*,\s*(\d+)\b)?|\bnew Date\(\s*['"`](\d{4}-\d\d-\d\d)|\bDate\.parse\(\s*['"`](\d{4}-\d\d-\d\d)|['"`](\d{4}-\d\d-\d\dT\d\d:\d\d)/g;
/** The calendar date (YYYY-MM-DD) an instant match constructs. */
const dateOf = (match: RegExpMatchArray) => match[1] ? new Date(Date.UTC(Number(match[1]), match[2] ? Number(match[2]) : 0, match[3] ? Number(match[3]) : 1)).toISOString().slice(0, 10) : (match[4] ?? match[5] ?? match[6]).slice(0, 10);
const wallClock = /\bDate\.now\(\)|\bnew Date\(\s*\)/g;
/** A stub of Date; the mock.timers form is checked for 'Date' among its apis against the line with its strings. */
const stubsDate = /\bclock\.install\(|\bmock\.timers\.enable\(\s*\{[^}]*apis:\s*\[[^\]]*\]/g;
const assignsDate = /\b(?:globalThis|global)\.Date\s*=(?!=)\s*([A-Za-z_$][\w$]*)?/g;
/** `const original = Date` / `= globalThis.Date`: the name assigning the real Date back is a restoration, not a stub. */
const savesDate = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:globalThis\.|global\.)?Date\s*(?=[;,)]|$)/g;
const restoresDate = /\bmock\.timers\.reset\(|\bmock\.reset\(|\bclock\.uninstall\(/g;
/** The hook, describe or test call whose `(` the code ends at: `test.only(`, `t.before(`, `suite(`. */
const callee = /\b(before|beforeEach|after|afterEach|describe|suite|test|it)(?:\.(?:only|skip|todo))?\s*$/;

/** A position in the source: 1-based line, 0-based column in that line's code. */
interface Position { line: number; column: number }
/** A `{ … }` block: where it opens and closes, and the block around it. */
interface Block { open: Position; close: Position; parent: Block | null }
const before = (a: Position, b: Position) => a.line < b.line || (a.line === b.line && a.column < b.column);
const within = (at: Position, from: Position, to: Position) => !before(at, from) && !before(to, at);

/**
 * The source read as code: each line with its comments dropped and strings kept (`lines`, so an ISO literal is still an
 * instant), the same lines with the contents of their strings blanked (`code`, so a stub or a wall-clock call quoted in
 * a string is neither), and every brace block with its position. Comments contribute nothing; strings contribute no
 * braces, except the code inside a template literal's `${…}`, which is code; a string other than a template literal
 * ends with its line, so a regex literal mistaken for one costs at most that line's braces.
 */
export function parse(source: string): { lines: string[]; code: string[]; blocks: Block[] } {
  const lines: string[] = [], code: string[] = [], blocks: Block[] = [], open: Block[] = [];
  const strings: Array<{ quote: '\'' | '"' | '`'; expression: number | null }> = []; // open string literals; `expression` is the brace depth inside a template's `${…}`, null in its text
  let line = '', masked = '', comment: 'line' | 'block' | null = null, escaped = false;
  const here = (): Position => ({ line: lines.length + 1, column: line.length });
  const put = (char: string, text: boolean) => { line += char; masked += text ? ' ' : char; };
  for (let index = 0; index < source.length; index++) {
    const char = source[index], next = source[index + 1], string = strings.at(-1), inText = string !== undefined && string.expression === null;
    if (char === '\n') { lines.push(line); code.push(masked); line = ''; masked = ''; if (comment === 'line') comment = null; if (inText && string.quote !== '`') strings.pop(); escaped = false; continue; }
    if (comment === 'line') continue;
    if (comment === 'block') { if (char === '*' && next === '/') { comment = null; index++; } continue; }
    if (inText) {
      if (escaped) { escaped = false; put(char, true); continue; }
      if (char === '\\') { escaped = true; put(char, true); continue; }
      if (char === string.quote) { strings.pop(); put(char, false); continue; }
      if (string.quote === '`' && char === '$' && next === '{') { string.expression = 0; put(char, false); put('{', false); index++; continue; }
      put(char, true); continue;
    }
    if (char === '/' && next === '/') { comment = 'line'; continue; }
    if (char === '/' && next === '*') { comment = 'block'; index++; continue; }
    if (char === '\'' || char === '"' || char === '`') { strings.push({ quote: char, expression: null }); put(char, false); continue; }
    if (char === '{') { if (string) string.expression!++; const block = { open: here(), close: here(), parent: open.at(-1) ?? null }; open.push(block); blocks.push(block); }
    else if (char === '}') {
      if (string && string.expression === 0) { string.expression = null; put(char, false); continue; } // the end of a template's `${…}`: back to its text
      if (string) string.expression!--;
      const block = open.pop(); if (block) block.close = here();
    }
    put(char, false);
  }
  lines.push(line); code.push(masked);
  for (const block of open) block.close = { line: lines.length, column: line.length }; // never closed: runs to the end of the file
  return { lines, code, blocks };
}

/** The innermost block holding `at`. */
const enclosing = (blocks: Block[], at: Position) => blocks.filter(block => within(at, block.open, block.close) && !(at.line === block.open.line && at.column === block.open.column)).sort((a, b) => before(a.open, b.open) ? 1 : -1)[0] ?? null;
type Kind = 'before' | 'beforeEach' | 'after' | 'afterEach' | 'describe' | 'test' | null;
/** A hook, describe or test call: what it is, where its `(` is and where the matching `)` closes it (the end of the file if it never does). */
interface Call { kind: Exclude<Kind, null>; open: Position; close: Position }
/**
 * The hook, describe or test call the code at `at` is an argument of, read by walking back over the code to the call's
 * `(` past whole (…) and {…} pairs: for a block's `{`, the call it is the callback body of, however many lines the header
 * spans (`test('a',\n  async () => {`); for a stub or restoration, the call whose brace-less callback it is
 * (`before(() => clock.install(now))`), since the walk stops at a `{` or a `;` of the block it is written in, and at a
 * call that is none of these (`assert.ok(`, `foo(() => {`). `suite` is `describe`, `it` is `test`.
 */
function callAround(code: string[], at: Position): Call | null {
  let parens = 0, braces = 0;
  for (let line = at.line; line >= 1; line--) {
    const text = code[line - 1];
    for (let column = (line === at.line ? at.column : text.length) - 1; column >= 0; column--) {
      const char = text[column];
      if (char === ')') parens++;
      else if (char === '}') braces++;
      else if (char === '{') { if (braces === 0) return null; braces--; }
      else if (char === ';' && parens === 0 && braces === 0) return null;
      else if (char === '(' && braces === 0) {
        if (parens > 0) { parens--; continue; }
        const name = callee.exec(text.slice(0, column))?.[1];
        if (!name) return null;
        const open = { line, column };
        return { kind: name === 'suite' ? 'describe' : name === 'it' ? 'test' : name as Exclude<Kind, null>, open, close: callEnd(code, open) };
      }
    }
  }
  return null;
}
/** Where the call opened by the `(` at `from` closes: the matching `)`, or the end of the file if there is none. */
function callEnd(code: string[], from: Position): Position {
  let depth = 0;
  for (let line = from.line; line <= code.length; line++) {
    const text = code[line - 1];
    for (let column = line === from.line ? from.column : 0; column < text.length; column++) {
      if (text[column] === '(') depth++;
      else if (text[column] === ')' && --depth === 0) return { line, column };
    }
  }
  return { line: code.length, column: code[code.length - 1].length };
}
/** What call a block is the callback body of: the test, describe or hook whose `{` it opens with, or null for a helper, an object literal, a loop or any other block. */
const kindOf = (code: string[], block: Block | null): Kind => block ? callAround(code, block.open)?.kind ?? null : null;
/** The before/beforeEach call a stub is the brace-less callback of, as a block standing in for the body it has none of: `before(() => clock.install(now))`. */
function bracelessHook(code: string[], at: Position, parent: Block | null): { hook: Block; kind: 'before' | 'beforeEach' } | null {
  const call = callAround(code, at);
  if (!call || (call.kind !== 'before' && call.kind !== 'beforeEach')) return null;
  return { hook: { open: call.open, close: call.close, parent }, kind: call.kind };
}
/** A stretch of code one stub covers, and the block whose code it is (null for module scope). */
interface Range { from: Position; to: Position; block: Block | null }

/** Every stub and restoration of Date in the code (not in its strings), in source order. */
function clockEvents(lines: string[], code: string[]): Array<{ at: Position; kind: 'stub' | 'restore' }> {
  const saved = new Set(code.flatMap(text => [...text.matchAll(savesDate)].map(match => match[1])));
  const events: Array<{ at: Position; kind: 'stub' | 'restore' }> = [];
  for (const [index, text] of code.entries()) {
    const at = (match: RegExpMatchArray): Position => ({ line: index + 1, column: match.index! });
    for (const match of text.matchAll(stubsDate)) if (!match[0].startsWith('mock') || /['"]Date['"]/.test(lines[index].slice(match.index, match.index! + match[0].length))) events.push({ at: at(match), kind: 'stub' });
    for (const match of text.matchAll(assignsDate)) events.push({ at: at(match), kind: match[1] && saved.has(match[1]) ? 'restore' : 'stub' });
    for (const match of text.matchAll(restoresDate)) events.push({ at: at(match), kind: 'restore' });
  }
  return events.sort((a, b) => before(a.at, b.at) ? -1 : 1);
}

/**
 * The blocks a hook's stub covers: the test bodies and the hooks beside it that run once the hook has, and the same
 * inside a sibling describe, loop or any other block, but never a describe's own code (it ran at collection), a
 * helper's or any other block's own code (it runs whenever it is called, which no hook orders) or a hook that ran earlier.
 */
function coveredByHook(blocks: Block[], code: string[], hook: Block, kind: 'before' | 'beforeEach', parent: Block | null = hook.parent, nested = false): Range[] {
  const ranges: Range[] = [];
  for (const sibling of blocks) {
    if (sibling.parent !== parent || sibling === hook || within(sibling.open, hook.open, hook.close)) continue; // a block inside the hook call (its stub's own `{ apis }`) is the hook's own
    const other = kindOf(code, sibling);
    if (other === 'before' && (kind === 'beforeEach' || (!nested && before(sibling.open, hook.open)))) continue; // every before hook runs before any beforeEach; same-kind hooks run in the order written
    if (other === 'beforeEach' && kind === 'beforeEach' && !nested && before(sibling.open, hook.open)) continue;
    if (other === 'describe' || other === null) { ranges.push(...coveredByHook(blocks, code, hook, kind, sibling, true)); continue; } // the block's own code is not covered; the test bodies in it run after the hook
    ranges.push({ from: sibling.open, to: sibling.close, block: sibling });
  }
  return ranges;
}

/**
 * The stretches of code a stubbed clock covers, each from a stub to the end of what it governs or to the restoration
 * that ends it, read off the text. A module-scope stub covers the rest of the file; a hook's stub covers the blocks
 * nested in the hook's block's parent that run once the hook has and the hook's own body from the stub on, never the
 * parent's own code, which ran before any hook; a stub in any other block covers that block from the stub on. A
 * restoration in a covered block ends the coverage there; in a block nested in a covered block it ends it there too,
 * unless that block is an after callback, which runs once the tests have, so only the callback's remainder is ended.
 */
export function stubbedRanges(lines: string[], code: string[], blocks: Block[]): Range[] {
  const end: Position = { line: lines.length, column: lines[lines.length - 1].length };
  const events = clockEvents(lines, code);
  let ranges: Range[] = [];
  for (const { at } of events.filter(event => event.kind === 'stub')) {
    const block = enclosing(blocks, at), kind = kindOf(code, block), braceless = bracelessHook(code, at, block);
    if (braceless) ranges.push({ from: at, to: braceless.hook.close, block: braceless.hook }, ...coveredByHook(blocks, code, braceless.hook, braceless.kind)); // `before(() => clock.install(now))`: a hook without a body block is a hook still, not the scope it is written in
    else if (!block) ranges.push({ from: at, to: end, block: null }); // module scope: the file's clock from here on; a reading above ran at load
    else if (kind === 'before' || kind === 'beforeEach') ranges.push({ from: at, to: block.close, block }, ...coveredByHook(blocks, code, block, kind)); // a hook stubs the bodies its block runs, not the block's own code
    else ranges.push({ from: at, to: block.close, block }); // a test body: this test, from here on
  }
  for (const { at } of events.filter(event => event.kind === 'restore')) {
    const inner = enclosing(blocks, at), call = callAround(code, at);
    if (call && (call.kind === 'after' || call.kind === 'afterEach')) continue; // `after(() => clock.uninstall())`: runs once the tests have, ends nothing written here
    ranges = ranges.flatMap(range => {
      if (!before(range.from, at) || !before(at, range.to)) return [range];
      let child: Block | null = null, cursor: Block | null = inner;
      while (cursor && cursor !== range.block) { child = cursor; cursor = cursor.parent; }
      if (cursor !== range.block) return [range]; // the restoration is not in the block this stretch covers
      if (child && kindOf(code, child) === 'after') return [{ ...range, to: at }, { ...range, from: child.close }]; // an after callback runs once the tests have: only its remainder is restored
      return [{ ...range, to: at }]; // the covered block itself, or a finally/if/helper in it: nothing after the restoration is trusted
    });
  }
  return ranges;
}

export interface TimeBomb {
  file: string;
  /** The first line constructing an instant, the first line reading the wall clock uncovered, and how many lines hold each. */
  instant: number; wallClock: number; instants: number; wallClocks: number;
  /** Each calendar date the file constructs, with the first line constructing it, in date order. */
  dates: Array<{ date: string; line: number }>;
  /** The line of each wall-clock reading no stub covers, one entry per call. */
  readings: number[];
}

/** Every match of `pattern` in the lines read as one text, with the position of its first character: a call split over lines (`Date.parse(\n  '2030-…'\n)`) is one match, on the line it starts. */
function matchesIn(lines: string[], pattern: RegExp): Array<{ match: RegExpMatchArray; at: Position }> {
  const text = lines.join('\n'), found: Array<{ match: RegExpMatchArray; at: Position }> = [];
  let line = 1, start = 0;
  for (const match of text.matchAll(pattern)) {
    for (let newline = text.indexOf('\n', start); newline !== -1 && newline < match.index!; newline = text.indexOf('\n', start)) { start = newline + 1; line++; }
    found.push({ match, at: { line, column: match.index! - start } });
  }
  return found;
}

/** The time bomb in one file's source, if the file constructs an absolute instant and reads the wall clock where no stub covers the reading. */
export function timeBombIn(file: string, source: string): TimeBomb | null {
  const { lines, code, blocks } = parse(source);
  const ranges = stubbedRanges(lines, code, blocks);
  const dated = new Map<string, number>(), instantLines = new Set<number>(), readings: number[] = [];
  for (const { match, at } of matchesIn(lines, instant)) { instantLines.add(at.line); if (!dated.has(dateOf(match))) dated.set(dateOf(match), at.line); }
  for (const { at } of matchesIn(lines, wallClock)) if (!ranges.some(range => within(at, range.from, range.to))) readings.push(at.line);
  const readingLines = [...new Set(readings)];
  if (!instantLines.size || !readings.length) return null;
  return { file, instant: [...instantLines][0], wallClock: readingLines[0], instants: instantLines.size, wallClocks: readingLines.length, dates: [...dated].map(([date, line]) => ({ date, line })).sort((a, b) => a.date.localeCompare(b.date)), readings };
}

async function* sources(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sources(path); else if (/\.(?:ts|mts|mjs|js)$/.test(entry.name)) yield path;
  }
}

/** A file's allowance: the comment in it that documents why its dates are safe, bound to those dates and to how many wall-clock readings no stub covers. */
export interface Allowance { why: string; dates: string[]; readings: number }
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** Every time bomb under `root` not covered by an allowance, and the allowances that do not hold. */
export async function timeBombs(root: string, allowed: Record<string, Allowance>) {
  const bombs: TimeBomb[] = [], refused: string[] = [];
  for await (const path of sources(root)) {
    const file = relative(process.cwd(), path).split('\\').join('/');
    if (file === self) continue;
    const source = await readFile(path, 'utf8'), found = timeBombIn(file, source);
    if (!(file in allowed)) { if (found) bombs.push(found); continue; }
    const { why, dates, readings } = allowed[file];
    if (!found) { refused.push(`${file}: allowed, but trips the rule no more; drop its allowance`); continue; }
    if (!source.split('\n').some(line => /^\s*(?:\/\/|\*|\/\*)/.test(line) && line.includes(why))) { refused.push(`${file}: allowed, but no comment in it documents why its absolute date is safe ("${why}")`); continue; }
    const added = found.dates.filter(entry => !dates.includes(entry.date)), gone = dates.filter(date => !found.dates.some(entry => entry.date === date)), changes: string[] = [];
    if (added.length) changes.push(`constructs ${added.map(entry => `${entry.date} (line ${entry.line})`).join(', ')} too`);
    if (gone.length) changes.push(`constructs ${gone.join(', ')} no more`);
    if (found.readings.length !== readings) changes.push(`reads the wall clock ${plural(found.readings.length, 'time')} where no stub covers it, at line${found.readings.length === 1 ? '' : 's'} ${[...new Set(found.readings)].join(', ')}`);
    if (changes.length) refused.push(`${file}: allowed for ${dates.join(', ')} beside ${plural(readings, 'uncovered wall-clock reading')}, but it now ${changes.join(' and ')}; document in its comment why each new instant or reading is safe, and bind the allowance to the dates and readings it has now`);
  }
  return { bombs: bombs.sort((a, b) => a.file.localeCompare(b.file)), refused: refused.sort() };
}

const count = (n: number, noun: string) => n === 1 ? `` : ` (and ${n - 1} more ${noun}${n > 2 ? 's' : ''})`;
export const describeBomb = (bomb: TimeBomb) => `${bomb.file}:${bomb.instant} constructs an absolute calendar instant${count(bomb.instants, 'instant')} and ${bomb.file}:${bomb.wallClock} reads the wall clock${count(bomb.wallClocks, 'reading')} where no stubbed clock covers it; derive the instant from the test's fixed now, stub Date where the reading runs (a module-scope stub covers the file from the stub on, a top-level before hook its test bodies, each until the clock is restored), or document in the file why its absolute date is safe and list that comment in allowances, bound to the dates ${bomb.dates.map(entry => entry.date).join(', ')} and ${plural(bomb.readings.length, 'reading')}`;
test('unit:no-wall-clock-time-bombs — no test file under tests/ constructs an absolute calendar instant and calls Date.now() or new Date() without a stubbed clock, beyond the fixtures whose allowance quotes their own comment on why their date is safe', async () => {
  const { bombs, refused } = await timeBombs(join(process.cwd(), 'tests'), allowances);
  assert.deepEqual(bombs.map(describeBomb), [], 'time bombs: each names the instant line and the wall-clock line');
  assert.deepEqual(refused, [], 'every allowance names a file that still trips the rule and documents why its date is safe');
});

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
async function fixtures(name: string, files: Record<string, string>) {
  const root = await temporaryDirectory(`time-bombs-${name}`); directories.push(root);
  for (const [path, text] of Object.entries(files)) { await mkdir(join(root, dirname(path)), { recursive: true }); await writeFile(join(root, path), text); }
  return { root, run: (allowed: Record<string, Allowance> = {}) => timeBombs(join(root, 'tests'), allowed), file: (path: string) => relative(process.cwd(), join(root, path)).split('\\').join('/') };
}
const sourceLines = (...lines: string[]) => lines.join('\n') + '\n';
// GY-1694's shape: a reset built from a calendar date at module scope, a fake control plane reading Date.now(), the hold recorded against the test's own fixed now.
const gy1694 = sourceLines(
  `import { test } from 'node:test';`,
  `const spentAt = Date.parse('2026-10-09T05:30:28Z'), now = spentAt + 60_000;`,
  `const resetsAt = new Date(Date.UTC(2026, 9, 11, 5)).toISOString();`,
  `const spent = { at: new Date(spentAt).toISOString(), resetsAt };`,
  `test('unit:role-selection', async () => {`,
  `  await recordObservedExhaustion(config, 'claude-a', spent, now);`,
  `  globalThis.fetch = (async () => { const at = { actor: 'executor', at: new Date().toISOString() }; const choice = chooseSession(registry, body, Date.now()); return choice; }) as typeof fetch;`,
  `});`);

test('unit:no-wall-clock-time-bombs — GY-1694\'s file is named with its instant line and its wall-clock line, whatever the clock the lint runs on', async () => {
  const { run, file } = await fixtures('gy-1694', { 'tests/followups.test.ts': gy1694 });
  const { bombs, refused } = await run();
  assert.deepEqual(bombs, [{ file: file('tests/followups.test.ts'), instant: 2, wallClock: 7, instants: 2, wallClocks: 1, dates: [{ date: '2026-10-09', line: 2 }, { date: '2026-10-11', line: 3 }], readings: [7, 7] }], 'the first instant line and the first wall-clock line, with the count of lines holding each, the date each instant constructs (Date.UTC(2026, 9, 11, 5) is 2026-10-11) and the line of each uncovered reading (line 7 reads the clock twice)');
  assert.match(describeBomb(bombs[0]), /followups\.test\.ts:2 constructs an absolute calendar instant \(and 1 more instant\) and .*followups\.test\.ts:7 reads the wall clock where no stubbed clock covers it/);
  assert.deepEqual(refused, []);
  // The original fuse of 2026-10-11T05:00Z is reported before, at and after the instant alike: the rule reads no clock.
  const past = gy1694.replace('Date.UTC(2026, 9, 11, 5)', 'Date.UTC(2000, 0, 1)');
  const { run: runPast } = await fixtures('gy-1694-past', { 'tests/followups.test.ts': past });
  assert.equal((await runPast()).bombs.length, 1, 'an instant already behind the clock is reported just the same');
  // The reviewer's case on 650074a22ee2: a year outside 19xx/20xx is an absolute calendar instant like any other.
  const century = sourceLines(
    `import { test } from 'node:test';`,
    `const expiresAt = Date.UTC(2100, 0, 1), windowOpens = new Date('2100-01-01T01:00:00Z'), start = Date.parse('1969-12-31T23:59:59Z');`,
    `const window = { since: '2103-01-01T00:00:00.000Z' };`,
    `test('unit:century', () => { assert.ok(expiresAt > Date.now()); });`);
  const { run: runCentury, file: centuryFile } = await fixtures('century', { 'tests/century.test.ts': century });
  assert.deepEqual((await runCentury()).bombs, [{ file: centuryFile('tests/century.test.ts'), instant: 2, wallClock: 4, instants: 2, wallClocks: 1, dates: [{ date: '1969-12-31', line: 2 }, { date: '2100-01-01', line: 2 }, { date: '2103-01-01', line: 3 }], readings: [4] }], 'Date.UTC(2100, …), a 2100 ISO string and a 1969 one are instants; so is a 2103 literal; each date is bound once, by its first line');
  for (const form of [`Date.UTC(2100, 0, 1)`, `new Date('2100-01-01T01:00:00Z')`, `Date.parse('1969-12-31T23:59:59Z')`, `'2103-01-01T00:00:00.000Z'`]) {
    const only = sourceLines(`const value = ${form};`, `const observed = Date.now();`);
    assert.equal(timeBombIn('only.ts', only)?.instant, 1, `${form} alone is an absolute calendar instant`);
  }
});

test('unit:no-wall-clock-time-bombs — a file that stubs Date, one without an absolute instant, or one that never reads the wall clock is no time bomb', async () => {
  const stubbed = gy1694.replace(`const spent =`, `clock.install(now);\nconst spent =`);
  const perTest = gy1694.replace(`test('unit:role-selection', async () => {`, `test('unit:role-selection', async () => {\n  mock.timers.enable({ apis: ['setTimeout', 'Date'], now });`);
  const assigned = gy1694.replace(`const spent =`, `globalThis.Date = fakeDate(now);\nconst spent =`);
  const derived = gy1694.replace(`Date.parse('2026-10-09T05:30:28Z')`, `1_760_000_000_000`).replace(`new Date(Date.UTC(2026, 9, 11, 5))`, `new Date(now + 47 * hour + 28 * minute + 32_000)`);
  const fixed = gy1694.replace(`new Date().toISOString()`, `new Date(now).toISOString()`).replace(`Date.now()`, `now`);
  const commented = sourceLines(
    `import { test } from 'node:test';`,
    `// The hold of 2026-10-11T05:00Z described here is history; Date.now() in this comment is not a call.`,
    `/* new Date('2030-01-01T00:00:00Z') in a block comment is not a construction either. */`,
    `test('unit:plain', () => { assert.equal(judge(work, 0), 'free'); }); // Date.now() after code is dropped too`);
  const timersOnly = gy1694.replace(`test('unit:role-selection', async () => {`, `test('unit:role-selection', async () => {\n  mock.timers.enable({ apis: ['setTimeout'] });`);
  const { run, file } = await fixtures('safe', { 'tests/stubbed.test.ts': stubbed, 'tests/per-test.test.ts': perTest, 'tests/assigned.test.ts': assigned, 'tests/derived.test.ts': derived, 'tests/fixed.test.ts': fixed, 'tests/commented.test.ts': commented, 'tests/timers-only.test.ts': timersOnly });
  assert.deepEqual((await run()).bombs.map(bomb => bomb.file), [file('tests/timers-only.test.ts')], 'mocking setTimeout alone stubs no clock; every other file is safe');
});

test('unit:no-wall-clock-time-bombs — a stub covers only the code that runs after it: in one test, that test from the stub on; at module scope, the file from the stub on; in a before hook, the bodies of its block, never the block\'s own code; a reading in another test, in a helper, before the stub or at load is named', async () => {
  // The reviewer's case on 1b52f78fadff: one test stubs Date, another compares a fixed 2030 expiry with the real clock.
  const mixed = sourceLines(
    `import { mock, test } from 'node:test';`,
    `const expiresAt = Date.UTC(2030, 0, 1);`,
    `test('unit:stubbed', () => { mock.timers.enable({ apis: ['Date'], now: expiresAt - 60_000 }); assert.ok(expiresAt > Date.now()); });`,
    `test('unit:real-clock', () => {`,
    `  assert.ok(expiresAt > Date.now());`,
    `});`);
  const helper = sourceLines(
    `import { mock, test } from 'node:test';`,
    `const resetsAt = new Date('2030-01-01T00:00:00Z');`,
    `const stamp = () => ({ at: new Date().toISOString(), resetsAt });`,
    `test('unit:stubbed', () => {`,
    `  mock.timers.enable({ apis: ['Date'], now: 0 });`,
    `  assert.equal(stamp().at, new Date(0).toISOString());`,
    `});`);
  const late = sourceLines(
    `import { test } from 'node:test';`,
    `import { clock } from './helpers/soak-world.js';`,
    `const start = Date.parse('2031-06-02T08:00:00Z');`,
    `test('unit:stubbed-late', async () => {`,
    `  const observedAt = new Date().toISOString();`,
    `  clock.install(start);`,
    `  assert.ok(Date.parse(observedAt) < Date.now());`,
    `});`);
  const describeHook = sourceLines(
    `import { before, describe, test } from 'node:test';`,
    `const start = Date.parse('2031-06-02T08:00:00Z');`,
    `describe('held', () => {`,
    `  before(() => { mock.timers.enable({ apis: ['Date'], now: start }); });`,
    `  test('unit:in-describe', () => { assert.ok(Date.now() >= start); });`,
    `});`,
    `test('unit:outside', () => { assert.ok(Date.now() < start); });`);
  const topHook = sourceLines(
    `import { beforeEach, test } from 'node:test';`,
    `const start = Date.parse('2031-06-02T08:00:00Z');`,
    `test('unit:registered-first', () => { assert.ok(Date.now() >= start); });`,
    `beforeEach(async () => {`,
    `  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start });`,
    `  assert.equal(Date.now(), start);`,
    `});`,
    `test('unit:a', () => { assert.ok(Date.now() >= start); });`,
    `test('unit:b', () => { assert.equal(new Date().toISOString(), new Date(start).toISOString()); });`);
  // The reviewer's cases on 650074a22ee2: a module-scope stub or a top-level hook covered the file from line 1, so a
  // reading that ran at load, before the stub was installed, passed as covered. Module-scope code above a module-scope
  // stub, and module-scope code anywhere beside a hook (a hook runs after the module has loaded), read the real clock.
  const loadBeforeStub = sourceLines(
    `import { test } from 'node:test';`,
    `import { clock } from './helpers/soak-world.js';`,
    `const expiry = Date.UTC(2030, 0, 1);`,
    `const observed = Date.now();`,
    `clock.install(expiry);`,
    `test('unit:stubbed', () => { assert.ok(observed < Date.now()); });`);
  const loadBesideHook = sourceLines(
    `import { before, test } from 'node:test';`,
    `const expiry = Date.UTC(2030, 0, 1);`,
    `before(() => { mock.timers.enable({ apis: ['Date'], now: expiry - 60_000 }); });`,
    `const observed = Date.now();`,
    `const stamp = () => new Date().toISOString();`,
    `test('unit:stubbed', () => { assert.ok(observed < Date.now()); assert.equal(stamp(), new Date(Date.now()).toISOString()); });`);
  const hookBeforeStub = sourceLines(
    `import { before, test } from 'node:test';`,
    `const expiry = Date.UTC(2030, 0, 1);`,
    `before(() => { const entered = Date.now(); mock.timers.enable({ apis: ['Date'], now: expiry - 60_000 }); assert.ok(entered < Date.now()); });`,
    `test('unit:stubbed', () => { assert.ok(expiry > Date.now()); });`);
  const loadInsideDescribe = sourceLines(
    `import { before, describe, test } from 'node:test';`,
    `const expiry = Date.UTC(2030, 0, 1);`,
    `describe('held', () => {`,
    `  before(() => { mock.timers.enable({ apis: ['Date'], now: expiry - 60_000 }); });`,
    `  const collected = Date.now();`,
    `  test('unit:in-describe', () => { assert.ok(collected < Date.now()); });`,
    `});`);
  const oneLiners = sourceLines(
    `import { mock, test } from 'node:test';`,
    `const start = Date.parse('2031-06-02T08:00:00Z');`,
    `test('unit:a', () => { mock.timers.enable({ apis: ['Date'], now: start }); assert.equal(Date.now(), start); });`,
    `test('unit:b', () => { assert.ok(Date.now() < start); });`);
  const { run, file } = await fixtures('scoped', { 'tests/mixed.test.ts': mixed, 'tests/helper.test.ts': helper, 'tests/late.test.ts': late, 'tests/describe-hook.test.ts': describeHook, 'tests/top-hook.test.ts': topHook, 'tests/one-liners.test.ts': oneLiners,
    'tests/load-before-stub.test.ts': loadBeforeStub, 'tests/load-beside-hook.test.ts': loadBesideHook, 'tests/hook-before-stub.test.ts': hookBeforeStub, 'tests/load-inside-describe.test.ts': loadInsideDescribe });
  assert.deepEqual((await run()).bombs.map(bomb => [bomb.file, bomb.instant, bomb.wallClock, bomb.wallClocks]), [
    [file('tests/describe-hook.test.ts'), 2, 7, 1],
    [file('tests/helper.test.ts'), 2, 3, 1],
    [file('tests/hook-before-stub.test.ts'), 2, 3, 1],
    [file('tests/late.test.ts'), 3, 5, 1],
    [file('tests/load-before-stub.test.ts'), 3, 4, 1],
    [file('tests/load-beside-hook.test.ts'), 2, 4, 2],
    [file('tests/load-inside-describe.test.ts'), 2, 5, 1],
    [file('tests/mixed.test.ts'), 2, 5, 1],
    [file('tests/one-liners.test.ts'), 2, 4, 1],
  ], 'the uncovered reading is the one named: the other test (mixed, one-liners), the helper, the line before the stub, the test outside the describe, the module-scope reading above a module-scope stub, the module-scope reading and helper beside a top-level hook, the hook\'s own reading before its stub, the describe body\'s own reading; a top-level hook covers every test body, registered before or after it, and its own body from the stub on');
});

test('unit:no-wall-clock-time-bombs — a restoration ends a stub\'s coverage: mock.timers.reset(), mock.reset(), clock.uninstall() or the saved real Date assigned back ends the covered block there, a finally in it too, an after callback only itself, and a brace-less after(() => …) nothing', async () => {
  // The reviewer's case on 5de841472ebe: a fixed 2030 expiry compared with Date.now() after the stub is reset, before the test's closing brace.
  const resetInBody = sourceLines(
    `import { mock, test } from 'node:test';`,
    `const expiresAt = Date.UTC(2030, 0, 1);`,
    `test('unit:reset', () => {`,
    `  mock.timers.enable({ apis: ['Date'], now: expiresAt - 60_000 });`,
    `  assert.ok(expiresAt > Date.now());`,
    `  mock.timers.reset();`,
    `  assert.ok(expiresAt > Date.now());`,
    `});`);
  const resetInFinally = sourceLines(
    `import { mock, test } from 'node:test';`,
    `const expiresAt = Date.UTC(2030, 0, 1);`,
    `test('unit:finally', async () => {`,
    `  mock.timers.enable({ apis: ['Date'], now: expiresAt - 60_000 });`,
    `  try { assert.ok(expiresAt > Date.now()); } finally { mock.reset(); }`,
    `  assert.ok(expiresAt > Date.now());`,
    `});`);
  const finallyLast = resetInFinally.replace(`  assert.ok(expiresAt > Date.now());\n});`, `});`); // the usual shape: nothing runs after the finally
  const uninstalled = sourceLines(
    `import { test } from 'node:test';`,
    `import { clock } from './helpers/soak-world.js';`,
    `const start = Date.parse('2031-06-02T08:00:00Z');`,
    `clock.install(start);`,
    `test('unit:a', () => { assert.ok(Date.now() >= start); });`,
    `clock.uninstall();`,
    `test('unit:b', () => { assert.ok(Date.now() >= start); });`);
  const restoredDate = sourceLines(
    `import { test } from 'node:test';`,
    `const original = globalThis.Date, expiresAt = Date.UTC(2030, 0, 1);`,
    `test('unit:proxy', () => {`,
    `  globalThis.Date = fakeDate(expiresAt - 60_000);`,
    `  try { assert.ok(expiresAt > Date.now()); } finally { globalThis.Date = original; }`,
    `  assert.ok(expiresAt > Date.now());`,
    `});`);
  const afterCallback = sourceLines(
    `import { after, mock, test } from 'node:test';`,
    `const expiresAt = Date.UTC(2030, 0, 1);`,
    `mock.timers.enable({ apis: ['Date'], now: expiresAt - 60_000 });`,
    `after(() => { mock.timers.reset(); assert.ok(expiresAt > Date.now()); });`,
    `test('unit:covered', () => { assert.ok(expiresAt > Date.now()); });`);
  const braceless = sourceLines(
    `import { after, test } from 'node:test';`,
    `import { clock } from './helpers/soak-world.js';`,
    `const start = Date.parse('2031-06-02T08:00:00Z');`,
    `clock.install(start);`,
    `after(() => clock.uninstall());`,
    `test('unit:covered', () => { assert.ok(Date.now() >= start); });`);
  const testAfter = sourceLines(
    `import { mock, test } from 'node:test';`,
    `const start = Date.parse('2031-06-02T08:00:00Z');`,
    `test('unit:t-after', t => {`,
    `  mock.timers.enable({ apis: ['Date'], now: start });`,
    `  t.after(() => { mock.timers.reset(); });`,
    `  assert.equal(Date.now(), start);`,
    `});`);
  const eachHooks = sourceLines(
    `import { afterEach, beforeEach, mock, test } from 'node:test';`,
    `const start = Date.parse('2031-06-02T08:00:00Z');`,
    `beforeEach(() => { mock.timers.enable({ apis: ['Date'], now: start }); });`,
    `afterEach(() => { mock.timers.reset(); assert.ok(Date.now() > start); });`,
    `test('unit:a', () => { assert.equal(Date.now(), start); });`);
  const { run, file } = await fixtures('restored', { 'tests/reset-in-body.test.ts': resetInBody, 'tests/reset-in-finally.test.ts': resetInFinally, 'tests/finally-last.test.ts': finallyLast, 'tests/uninstalled.test.ts': uninstalled, 'tests/restored-date.test.ts': restoredDate,
    'tests/after-callback.test.ts': afterCallback, 'tests/braceless.test.ts': braceless, 'tests/test-after.test.ts': testAfter, 'tests/each-hooks.test.ts': eachHooks });
  assert.deepEqual((await run()).bombs.map(bomb => [bomb.file, bomb.instant, bomb.wallClock, bomb.wallClocks]), [
    [file('tests/after-callback.test.ts'), 2, 4, 1],
    [file('tests/each-hooks.test.ts'), 2, 4, 1],
    [file('tests/reset-in-body.test.ts'), 2, 7, 1],
    [file('tests/reset-in-finally.test.ts'), 2, 6, 1],
    [file('tests/restored-date.test.ts'), 2, 6, 1],
    [file('tests/uninstalled.test.ts'), 3, 7, 1],
  ], 'the reading after the restoration is the one named: after mock.timers.reset() in the body, after a finally that calls mock.reset() or assigns the saved Date back, in the test after a module-scope clock.uninstall(), and in the after/afterEach callback\'s own remainder, while the test bodies an after callback\'s reset does not reach stay covered; a finally with nothing after it, a brace-less after(() => clock.uninstall()) and t.after(() => { mock.timers.reset(); }) end nothing the file reads');
});

test('unit:no-wall-clock-time-bombs — a stub or restoration quoted in a string is text and installs nothing; a wall-clock call quoted in a string is still a reading, since the lint cannot tell a child\'s script from a label; code inside a template\'s ${…} is code', async () => {
  // The reviewer's case on 5de841472ebe: a fixture holding `clock.install(now)` as text was taken for a module-scope stub covering the file.
  const quoted = sourceLines(
    `import { test } from 'node:test';`,
    `const expiresAt = Date.UTC(2030, 0, 1);`,
    `const fixture = 'clock.install(now)';`,
    `test('unit:real-clock', () => { assert.ok(expiresAt > Date.now()); });`);
  // tests/shared-identity-followups.test.ts's shape: a preload script in a template literal assigns globalThis.Date and reads new Date(); the braces in it are not blocks.
  const preload = sourceLines(
    `import { test } from 'node:test';`,
    `const at = '2026-10-11T04:00:00Z';`,
    'const stub = `const Real = Date; globalThis.Date = class extends Real { static now() { return Real.now(); } }; console.error(new Date().toISOString());`;',
    `test('unit:child', () => { assert.ok(Date.parse(at) < Date.now()); });`);
  const interpolated = sourceLines(
    `import { test } from 'node:test';`,
    `const expiresAt = new Date('2030-01-01T00:00:00Z');`,
    'test(\'unit:name\', () => { const name = `work-${Date.now()}`; assert.ok(expiresAt.getTime() > Date.parse(name.slice(5))); });');
  const quotedReading = sourceLines(
    `import { test } from 'node:test';`,
    `const expiresAt = Date.UTC(2030, 0, 1);`,
    `const script = 'console.log(Date.now() < ' + expiresAt + ')';`,
    `test('unit:runs-script', async () => { assert.equal(await run(script), 'true'); });`);
  const quotedReset = sourceLines(
    `import { test } from 'node:test';`,
    `import { clock } from './helpers/soak-world.js';`,
    `const start = Date.parse('2031-06-02T08:00:00Z');`,
    `clock.install(start);`,
    `const note = "clock.uninstall() is never called here";`,
    `test('unit:covered', () => { assert.ok(Date.now() >= start); });`);
  const { run, file } = await fixtures('strings', { 'tests/quoted.test.ts': quoted, 'tests/preload.test.ts': preload, 'tests/interpolated.test.ts': interpolated, 'tests/quoted-reading.test.ts': quotedReading, 'tests/quoted-reset.test.ts': quotedReset });
  assert.deepEqual((await run()).bombs.map(bomb => [bomb.file, bomb.instant, bomb.wallClock, bomb.wallClocks]), [
    [file('tests/interpolated.test.ts'), 2, 3, 1],
    [file('tests/preload.test.ts'), 2, 3, 2],
    [file('tests/quoted-reading.test.ts'), 2, 3, 1],
    [file('tests/quoted.test.ts'), 2, 4, 1],
  ], 'a quoted clock.install covers nothing; a quoted globalThis.Date assignment stubs nothing, so the test beside it is named and the quoted new Date() counts as a reading too; a Date.now() in a template\'s ${…} is a reading; a quoted Date.now() handed to a child is a reading; a quoted clock.uninstall() ends nothing');
});

test('unit:no-wall-clock-time-bombs — hooks run in the order written, every before hook before any beforeEach, and a describe\'s own code at collection: a stub in a hook covers none of what ran earlier', async () => {
  const earlierBefore = sourceLines(
    `import { before, mock, test } from 'node:test';`,
    `const expiry = Date.UTC(2030, 0, 1);`,
    `before(() => { assert.ok(expiry > Date.now()); });`,
    `before(() => { mock.timers.enable({ apis: ['Date'], now: expiry - 60_000 }); });`,
    `before(() => { assert.ok(expiry > Date.now()); });`,
    `test('unit:covered', () => { assert.ok(expiry > Date.now()); });`);
  const beforeBesideEach = sourceLines(
    `import { before, beforeEach, mock, test } from 'node:test';`,
    `const expiry = Date.UTC(2030, 0, 1);`,
    `beforeEach(() => { mock.timers.enable({ apis: ['Date'], now: expiry - 60_000 }); });`,
    `before(() => { assert.ok(expiry > Date.now()); });`,
    `beforeEach(() => { assert.ok(expiry > Date.now()); });`,
    `test('unit:covered', () => { assert.ok(expiry > Date.now()); });`);
  const describeBody = sourceLines(
    `import { before, describe, mock, test } from 'node:test';`,
    `const expiry = Date.UTC(2030, 0, 1);`,
    `before(() => { mock.timers.enable({ apis: ['Date'], now: expiry - 60_000 }); });`,
    `describe('held', () => {`,
    `  const collected = Date.now();`,
    `  before(() => { assert.ok(expiry > Date.now()); });`,
    `  test('unit:in-describe', () => { assert.ok(collected < Date.now()); });`,
    `});`);
  const { run, file } = await fixtures('ordered', { 'tests/earlier-before.test.ts': earlierBefore, 'tests/before-beside-each.test.ts': beforeBesideEach, 'tests/describe-body.test.ts': describeBody });
  assert.deepEqual((await run()).bombs.map(bomb => [bomb.file, bomb.instant, bomb.wallClock, bomb.wallClocks]), [
    [file('tests/before-beside-each.test.ts'), 2, 4, 1],
    [file('tests/describe-body.test.ts'), 2, 5, 1],
    [file('tests/earlier-before.test.ts'), 2, 3, 1],
  ], 'the before hook written above the stubbing before hook, the before hook beside a beforeEach stub wherever it is written, and the describe body\'s own code are named; the later same-kind hook, the later beforeEach, the describe\'s before hook and every test body are covered');
});

test('unit:no-wall-clock-time-bombs — a hook is a hook without a brace body: before(() => clock.install(now)) covers the test bodies, in a describe or a loop and under a header split over lines, never the module-scope or describe code beside it nor a helper\'s body; a hook\'s stub covers no helper either', async () => {
  // The reviewer's case on abb26c93c11c: a brace-less before callback has no block for the stub to be enclosed in, so the
  // stub was taken for a module-scope install covering the file from there on, and the module-scope reading below it, which
  // runs at load before any hook, passed as covered. The file must be named with both lines, as its braced twin is.
  const braceless = sourceLines(
    `import { before, test } from 'node:test';`,
    `import { clock } from './helpers/soak-world.js';`,
    `const expiry = Date.UTC(2030, 0, 1);`,
    `before(() => clock.install(expiry - 60_000));`,
    `const observed = Date.now();`,
    `test('unit:stubbed', () => { assert.ok(observed < Date.now()); });`);
  const braced = braceless.replace(`before(() => clock.install(expiry - 60_000));`, `before(() => { clock.install(expiry - 60_000); });`);
  const bracelessInDescribe = sourceLines(
    `import { before, describe, mock, test } from 'node:test';`,
    `const expiry = Date.UTC(2030, 0, 1);`,
    `describe('held', () => {`,
    `  before(() => mock.timers.enable({ apis: ['Date'], now: expiry - 60_000 }));`,
    `  const collected = Date.now();`,
    `  test('unit:in-describe', () => { assert.ok(collected < Date.now()); });`,
    `});`);
  const bracelessCovers = sourceLines(
    `import { after, before, test } from 'node:test';`,
    `import { clock } from './helpers/soak-world.js';`,
    `const start = Date.parse('2031-06-02T08:00:00Z');`,
    `before(async () => clock.install(start));`,
    `after(() => clock.uninstall());`,
    `test('unit:a', () => { assert.ok(Date.now() >= start); });`,
    `test('unit:b',`,
    `  async () => { assert.equal(new Date().toISOString(), new Date(start).toISOString()); });`,
    `for (const name of ['c', 'd']) {`,
    `  test(\`unit:\${name}\`, () => { assert.ok(Date.now() >= start); });`,
    `}`);
  const bracelessBeforeEach = sourceLines(
    `import { before, beforeEach, mock, test } from 'node:test';`,
    `const expiry = Date.UTC(2030, 0, 1);`,
    `beforeEach(() => mock.timers.enable({ apis: ['Date'], now: expiry - 60_000 }));`,
    `before(() => assert.ok(expiry > Date.now()));`,
    `test('unit:covered', () => { assert.ok(expiry > Date.now()); });`);
  // The reviewer's case on abb26c93c11c beside it: a helper's braced body is not a test body. It runs whenever the helper is
  // called, at load here, so a hook's stub covers none of it; a loop's own code is not covered either, the tests in it are.
  const helperBesideHook = sourceLines(
    `import { before, mock, test } from 'node:test';`,
    `const expiry = Date.UTC(2030, 0, 1);`,
    `before(() => { mock.timers.enable({ apis: ['Date'], now: expiry - 60_000 }); });`,
    `function stamp() { return Date.now(); }`,
    `const loadedAt = stamp();`,
    `test('unit:stubbed', () => { assert.ok(loadedAt < Date.now()); });`);
  const loopBesideHook = sourceLines(
    `import { before, mock, test } from 'node:test';`,
    `const expiry = Date.UTC(2030, 0, 1);`,
    `before(() => { mock.timers.enable({ apis: ['Date'], now: expiry - 60_000 }); });`,
    `for (const name of ['a', 'b']) {`,
    `  const registeredAt = Date.now();`,
    `  test(\`unit:\${name}\`, () => { assert.ok(registeredAt < Date.now()); });`,
    `}`);
  const { run, file } = await fixtures('braceless-hooks', { 'tests/braceless.test.ts': braceless, 'tests/braced.test.ts': braced, 'tests/braceless-in-describe.test.ts': bracelessInDescribe, 'tests/braceless-covers.test.ts': bracelessCovers, 'tests/braceless-before-each.test.ts': bracelessBeforeEach, 'tests/helper-beside-hook.test.ts': helperBesideHook, 'tests/loop-beside-hook.test.ts': loopBesideHook });
  assert.deepEqual((await run()).bombs.map(bomb => [bomb.file, bomb.instant, bomb.wallClock, bomb.wallClocks]), [
    [file('tests/braced.test.ts'), 3, 5, 1],
    [file('tests/braceless-before-each.test.ts'), 2, 4, 1],
    [file('tests/braceless-in-describe.test.ts'), 2, 5, 1],
    [file('tests/braceless.test.ts'), 3, 5, 1],
    [file('tests/helper-beside-hook.test.ts'), 2, 4, 1],
    [file('tests/loop-beside-hook.test.ts'), 2, 5, 1],
  ], 'the brace-less hook\'s file is named with the module-scope reading below the hook, as its braced twin is; so is the describe\'s own reading beside a brace-less hook in it, the before hook beside a brace-less beforeEach stub, the helper\'s body and the loop\'s own code; the test bodies (a brace-less hook\'s, a header split over lines, the tests a loop registers) are covered, and a brace-less after(() => clock.uninstall()) ends nothing');
  assert.equal(timeBombIn('reviewer.ts', sourceLines(`const expiry = Date.UTC(2030, 0, 1);`, `before(() => clock.install(now));`, `const observed = Date.now();`))?.wallClock, 3, 'the reviewer\'s three lines name line 3');
});

test('unit:no-wall-clock-time-bombs — an instant or a reading split over lines is one call, found on the line it starts', async () => {
  // The reviewer's case on abb26c93c11c: a Date.parse whose string sits on the next line matched no line on its own.
  const split = sourceLines(
    `import { test } from 'node:test';`,
    `const expiresAt = Date.parse(`,
    `  '2030-01-01T00:00:00Z',`,
    `);`,
    `const windowOpens = new Date(`,
    `  '2030-01-02T00:00:00Z');`,
    `const resetsAt = Date.UTC(`,
    `  2030, 0, 3);`,
    `test('unit:real-clock', () => { const at = new Date(`,
    `); assert.ok(expiresAt > at.getTime()); });`);
  const { run, file } = await fixtures('split', { 'tests/split.test.ts': split });
  assert.deepEqual((await run()).bombs, [{ file: file('tests/split.test.ts'), instant: 2, wallClock: 9, instants: 3, wallClocks: 1, dates: [{ date: '2030-01-01', line: 2 }, { date: '2030-01-02', line: 5 }, { date: '2030-01-03', line: 7 }], readings: [9] }], 'each split constructor is an instant on the line it starts, with its date; the split new Date() is a reading on its line');
});

test('unit:no-wall-clock-time-bombs — a wall-clock stamp, an elapsed-time measurement or an instant handed to the code under test as its clock is not told apart from a judgement: the file is named, and its allowance documents why', async () => {
  const handed = sourceLines(
    `import { test } from 'node:test';`,
    `const clock = Date.parse('2030-01-01T00:00:00Z');`,
    `test('unit:fixed-clock', async () => {`,
    `  const started = Date.now();`,
    `  assert.equal(nextAction(work, [work], clock), null);`,
    `  assert.ok(Date.now() - started < 5_000);`,
    `});`);
  const stamps = sourceLines(
    `import { test } from 'node:test';`,
    `const expiresAt = new Date(Date.UTC(2031, 0, 1)).toISOString();`,
    `test('unit:stamps-only', async () => {`,
    `  const row = { createdAt: new Date().toISOString(), updatedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt };`,
    `});`);
  const literal = sourceLines(
    `import { test } from 'node:test';`,
    `const reviewer = { slug: 'graphyard-reviewer', boundAt: '2026-09-01T00:00:00.000Z' };`,
    `test('unit:literal', () => { assert.equal(bound(reviewer, Date.now()), true); });`);
  const separate = sourceLines(
    `import { test } from 'node:test';`,
    `test('unit:fixed', () => { const until = new Date('2030-01-01T00:00:00Z'); assert.equal(judge(work, until), 'held'); });`,
    `test('unit:live', () => { assert.equal(judge(work, new Date()), 'free'); });`);
  const helper = sourceLines(
    `export const expiresAt = Date.UTC(2031, 5, 2);`,
    `export const fresh = () => expiresAt > Date.now();`);
  const { run, file } = await fixtures('named', { 'tests/handed.test.ts': handed, 'tests/stamps.test.ts': stamps, 'tests/literal.test.ts': literal, 'tests/separate.test.ts': separate, 'tests/helpers/world.ts': helper });
  assert.deepEqual((await run()).bombs.map(bomb => [bomb.file, bomb.instant, bomb.wallClock]), [
    [file('tests/handed.test.ts'), 2, 4],
    [file('tests/helpers/world.ts'), 1, 2],
    [file('tests/literal.test.ts'), 2, 3],
    [file('tests/separate.test.ts'), 2, 3],
    [file('tests/stamps.test.ts'), 2, 4],
  ], 'every file pairs its first instant with its first wall-clock reading, across test bodies and in helpers alike');
});

test('unit:no-wall-clock-time-bombs — an allowance holds only for a fixture that documents why its absolute date is safe and still trips the rule', async () => {
  const documented = sourceLines(
    `// The recorded reset of 2031-06-02 is the fixture's own: nothing here compares it with the clock, the loop under test reads clock.now().`,
    `export const resetsAt = new Date('2031-06-02T08:00:00Z').toISOString();`,
    `export const observedAt = () => new Date();`);
  const undocumented = documented.split('\n').slice(1).join('\n');
  const settled = documented.replace(`export const observedAt = () => new Date();`, `export const observedAt = (now: number) => new Date(now);`);
  const inCode = documented.split('\n').slice(1).join('\n').replace(`export const observedAt`, `export const why = 'nothing here compares it with the clock';\nexport const observedAt`);
  const { run, file } = await fixtures('allowances', { 'tests/fixtures/documented.ts': documented, 'tests/fixtures/undocumented.ts': undocumented, 'tests/fixtures/settled.ts': settled, 'tests/fixtures/in-code.ts': inCode });
  const why = 'nothing here compares it with the clock';
  const all = await run();
  assert.deepEqual(all.bombs.map(bomb => bomb.file), [file('tests/fixtures/documented.ts'), file('tests/fixtures/in-code.ts'), file('tests/fixtures/undocumented.ts')], 'without allowances every file that trips the rule is a bomb; the one that reads no wall clock is not');
  const allowance = { why, dates: ['2031-06-02'], readings: 1 };
  const allowed = await run({ [file('tests/fixtures/documented.ts')]: allowance, [file('tests/fixtures/undocumented.ts')]: allowance, [file('tests/fixtures/settled.ts')]: allowance, [file('tests/fixtures/in-code.ts')]: allowance });
  assert.deepEqual(allowed.bombs, [], 'an allowed file is not reported as a bomb');
  assert.deepEqual(allowed.refused, [
    `${file('tests/fixtures/in-code.ts')}: allowed, but no comment in it documents why its absolute date is safe ("${why}")`,
    `${file('tests/fixtures/settled.ts')}: allowed, but trips the rule no more; drop its allowance`,
    `${file('tests/fixtures/undocumented.ts')}: allowed, but no comment in it documents why its absolute date is safe ("${why}")`,
  ].sort(), 'an allowance without its documentation in a comment, or for a file that no longer trips the rule, is refused');
});

test('unit:no-wall-clock-time-bombs — an allowance is bound to the dates and uncovered readings it documents: a file that gains another instant or another wall-clock reading fails, named with the new lines, until its comment and allowance cover them', async () => {
  // The reviewer's case on 5de841472ebe: an allowed file (its comment intact, its documented pair intact) gains an unrelated
  // 2030 expiry and an unstubbed Date.now() that judges it. The old comment says nothing about the new pair.
  const documented = sourceLines(
    `import { test } from 'node:test';`,
    `// Time-bomb allowance: the 2000-01-01 lease expiry forces a lapse that stays lapsed; Date.now() only stamps the record.`,
    `const expired = { expiresAt: new Date(Date.UTC(2000, 0, 1)).toISOString() };`,
    `test('unit:lapsed', () => { assert.equal(judge(expired, { at: new Date().toISOString() }), 'lapsed'); });`);
  const why = 'the 2000-01-01 lease expiry forces a lapse that stays lapsed';
  const bound = { why, dates: ['2000-01-01'], readings: 1 };
  const grown = documented.replace(`test('unit:lapsed'`, sourceLines(
    `const window = { until: '2030-01-01T00:00:00.000Z' };`,
    `test('unit:open-window', () => { assert.ok(Date.parse(window.until) > Date.now()); });`,
    `test('unit:lapsed'`).trimEnd());
  const reading = documented.replace(`test('unit:lapsed'`, sourceLines(
    `test('unit:still-open', () => { assert.ok(Date.now() < Date.UTC(2000, 0, 1) + 10 ** 15); });`,
    `test('unit:lapsed'`).trimEnd());
  const fewer = documented.replace(`{ at: new Date().toISOString() }`, `{ at: expired.expiresAt }`).replace(`judge(expired`, `judge({ ...expired, since: Date.now() - 1 }`);
  const gone = documented.replace(`Date.UTC(2000, 0, 1)`, `Date.UTC(1999, 11, 31)`);
  const { run, file } = await fixtures('bound', { 'tests/documented.test.ts': documented, 'tests/grown.test.ts': grown, 'tests/reading.test.ts': reading, 'tests/fewer.test.ts': fewer, 'tests/gone.test.ts': gone });
  const files = ['documented', 'grown', 'reading', 'fewer', 'gone'].map(name => file(`tests/${name}.test.ts`));
  const result = await run(Object.fromEntries(files.map(path => [path, bound])));
  assert.deepEqual(result.bombs, [], 'an allowed file is reported through its allowance, not as a bomb');
  assert.deepEqual(result.refused, [
    `${file('tests/gone.test.ts')}: allowed for 2000-01-01 beside 1 uncovered wall-clock reading, but it now constructs 1999-12-31 (line 3) too and constructs 2000-01-01 no more; document in its comment why each new instant or reading is safe, and bind the allowance to the dates and readings it has now`,
    `${file('tests/grown.test.ts')}: allowed for 2000-01-01 beside 1 uncovered wall-clock reading, but it now constructs 2030-01-01 (line 4) too and reads the wall clock 2 times where no stub covers it, at lines 5, 6; document in its comment why each new instant or reading is safe, and bind the allowance to the dates and readings it has now`,
    `${file('tests/reading.test.ts')}: allowed for 2000-01-01 beside 1 uncovered wall-clock reading, but it now reads the wall clock 2 times where no stub covers it, at lines 4, 5; document in its comment why each new instant or reading is safe, and bind the allowance to the dates and readings it has now`,
  ].sort(), 'the file whose documented pair is unchanged passes; a new date is named with its line, a new reading with every uncovered reading line, and a date the file no longer constructs is named too; the readings count is of calls, so one call fewer on the same lines is a change as well');
  assert.ok(result.refused.every(line => !line.startsWith(file('tests/fewer.test.ts')) || line.includes('reads the wall clock 1 time')), 'a file whose reading moved to another line but whose count holds is not a change: the count binds calls, not lines');
  assert.deepEqual((await run({ ...Object.fromEntries(files.map(path => [path, bound])), [file('tests/grown.test.ts')]: { why, dates: ['2000-01-01', '2030-01-01'], readings: 2 }, [file('tests/reading.test.ts')]: { why, dates: ['2000-01-01'], readings: 2 }, [file('tests/gone.test.ts')]: { why, dates: ['1999-12-31'], readings: 1 } })).refused, [], 'rebound to what each file holds now, every allowance holds');
});

/**
 * Files allowed to keep an absolute calendar instant beside a wall-clock reading, each by the comment in it that
 * documents why its absolute date is safe, bound to the calendar dates it constructs and to how many wall-clock
 * readings no stub covers. Every entry is a file that trips the rule today; an entry for a file that stops tripping
 * it, whose comment is gone, or whose dates or uncovered readings have changed fails the test above. A new file that
 * trips the rule earns an entry only with such a comment, and never by widening the rule.
 */
export const allowances: Record<string, Allowance> = {
  'tests/action-priority.test.ts': { why: 'the 2000-01-01 lease expiry forces a lapse that stays lapsed, 2026-09-22 resetsAt is a past record the note quotes, and 2026-09-21 `at` is the fixed now handed to nextAction', dates: ['2000-01-01', '2026-09-21', '2026-09-22'], readings: 11 },
  'tests/action-queue.test.ts': { why: 'the 2026-09-01 boundAt is reviewer config and the 2026-09-20 `at`/clock is the fixed now handed to reconcileActions and evaluate; Date.now() serves only the live engine tests', dates: ['2026-09-01', '2026-09-20'], readings: 54 },
  'tests/action-totality.test.ts': { why: 'the 2026-09-21 `now` is handed explicitly to nextAction and actionAccount over fixtures built from it; new Date() serves the engine tests and stamps observations', dates: ['2026-09-21'], readings: 3 },
  'tests/agent-registry.test.ts': { why: 'the 2026-09-20 at/now/resetsAt trio is the fixed clock handed to fleetView, chooseSession and sessionEnded; Date.now() only builds relative expiries and reset times', dates: ['2026-09-20'], readings: 13 },
  'tests/answered-owner-close.test.ts': { why: 'the 2026-10-07 base instants are throughput fixtures judged by verifyThroughput against the explicit `now` derived from base; Date.now() only stamps closures and steps cycles', dates: ['2026-10-07'], readings: 8 },
  'tests/answered-review-request.test.ts': { why: 'the 2026-10-01 verdict timestamps are the recorded GY-1083 instances and only order replayed verdicts; observedAt, closedAt, requestedAt and expiry are built relative to Date.now()', dates: ['2026-10-01'], readings: 18 },
  'tests/approver-refusal.test.ts': { why: 'the 2026-09-23 instants are the explicit now/at handed to unansweredDecisions, terminalDecisions and approvalStep; new Date()/Date.now() only stamp the stubbed master\'s records', dates: ['2026-09-23'], readings: 2 },
  'tests/async-runner.test.ts': { why: 'the 2030-01-01 clock is handed to runCycle, loopLiveness and daemonSummary as their explicit now over fixtures derived from it; Date.now() only measures elapsed time and child deadlines', dates: ['2030-01-01'], readings: 9 },
  'tests/auto-dispatch.test.ts': { why: 'the 2026-09-19 `at`/clock stamps fixture items and dispatch cursors judged at that clock; Date.now()/new Date() stamp live observations and measure launch latency only', dates: ['2026-09-19'], readings: 19 },
  'tests/auto-scope.test.ts': { why: 'the only absolute instant is the 2000-01-01 lease expiry, a past date that forces a lapse the cycle keeps lapsed; Date.now() is the loop\'s live clock and only moves further past it', dates: ['2000-01-01'], readings: 9 },
  'tests/autonomy-contract.test.ts': { why: 'the 2026-09-24 `at` is a past createdAt/updatedAt stamp and the fixed now handed to reconcileAutoDispatch; new Date() readings stamp observations and launches, which nothing compares with it', dates: ['2026-09-24'], readings: 4 },
  'tests/autonomy-promotion.test.ts': { why: 'the 2026-10-08 boundAt is reviewer config and the 2026-10-08 `now` is handed explicitly to promoteToAutonomy for its audit stamp; the one new Date() is the status snapshot\'s own now', dates: ['2026-10-08'], readings: 1 },
  'tests/await-reviewers-exhausted.test.ts': { why: 'the 2026-09-25 `at`/clock is the fixed now handed to reconcileAutoDispatch, dispatchEffects and dispatchSummary; the new Date() readings only stamp the stub\'s snapshot and review records', dates: ['2026-09-25'], readings: 2 },
  'tests/base-break-refresh.test.ts': { why: 'the 2026-09-26 `at` is passed to judgeBaseBreak as its explicit observation time and echoed back; new Date()/Date.now() stamp live observations in separate tests', dates: ['2026-09-26'], readings: 16 },
  'tests/base-failure-rework.test.ts': { why: 'the 2030-01-01 clock drives the pure runCycle tests through `() => unobserved.now` over fixtures derived from it; the one new Date() stamps the engine tests\' observations', dates: ['2030-01-01'], readings: 1 },
  'tests/batch-deadlock.test.ts': { why: 'the 2026-09-22 created_at is a past, fixed field of the stub GitHub pull payload; Date.now() only measures how long a retry streak takes and new Date() stamps stub reviews\' submitted_at', dates: ['2026-09-22'], readings: 2 },
  'tests/blocked-session.test.ts': { why: 'the 2030-01-01 clock is handed to runCycle as `() => clock` and the 2026-10-05 now is startAgentSession\'s explicit clock; Date.now() builds relative expiries for the account tests', dates: ['2026-10-05', '2030-01-01'], readings: 2 },
  'tests/blocker-followups.test.ts': { why: 'the 2026-10-03 start is handed to cycleOf as the explicit now and stepped by blockerEscalateMs; Date.now()/new Date() serve separate cycles and stamp sessions and exhaustions', dates: ['2026-10-03'], readings: 16 },
  'tests/bootstrap-policy.test.ts': { why: 'the 2026-09-18 declaredAt is a past fixture field of an operator declaration that evaluate and diagnose carry through unchanged; new Date()/Date.now() are the explicit now they are handed', dates: ['2026-09-18'], readings: 7 },
  'tests/capacity-failover.test.ts': { why: 'the 2026-09-20/09-30 instants are the explicit now handed to detectExhaustion, parseResetTime and outputReadDue, which judge parsed resets against it; Date.now() builds relative resets', dates: ['2026-09-20', '2026-09-26', '2026-09-30'], readings: 45 },
  'tests/checkout-restore-release.test.ts': { why: 'the 2030-01-01 ledger `at` is a stored string nothing dates; the 2026-10-11 grants are judged by the explicit now/clock handed to the act; Date.now() bounds waits and real-clock grants', dates: ['2026-10-11', '2030-01-01'], readings: 22 },
  'tests/cli.test.ts': { why: 'the 2030-01-01 leases are judged against the snapshot\'s own 2030 now or a monotonic stub; the 2026 snapshot nows and deadline are stub fixtures; Date.now() builds relative expiries', dates: ['2026-01-01', '2026-09-16', '2030-01-01'], readings: 12 },
  'tests/consent-prompt.test.ts': { why: 'the 2026-09-23 `at`/clock stamps fixture items\' createdAt/updatedAt; Date.now()/new Date() build live lease expiries and the explicit now for consentHoldItems only', dates: ['2026-09-23'], readings: 9 },
  'tests/cycle-failure.test.ts': { why: 'the 2030-01-01 iso() values are the stub snapshot\'s own now and deployment stamp handed back to the daemon; Date.now() only measures how long the loop waited between retries, or offsets it by the stall hold the backoff test skips', dates: ['2030-01-01'], readings: 7 },
  'tests/daemon-unsubmitted-bound.test.ts': { why: 'the 2026-10-07 clock is the explicit now handed to workFaults, cycleFaults and unsubmittedAttempt over fixtures derived from it; the DB tests build stamps relative to Date.now()', dates: ['2026-10-07'], readings: 6 },
  'tests/decision-application.test.ts': { why: 'the 2026-10-03/10-05 instants are the explicit now handed to approvalStep, routineDecision and actionableSubjects over same-day watches; new Date() only stamps live records', dates: ['2026-10-03', '2026-10-05'], readings: 6 },
  'tests/decision-held-until-attempt-ends.test.ts': { why: 'the 2026-10-11 base only yields relative event stamps that foldDecisions and approvalStep read with an explicit now from the same base; Date.now() serves the live DB tests', dates: ['2026-10-11'], readings: 5 },
  'tests/decision-lifecycle.test.ts': { why: 'the 2000-01-01 lease expiry forces a lapse that stays lapsed, and the 2030-01-01 escalation `at` is compared by samePin only between two pins; Date.now() serves live items', dates: ['2000-01-01', '2030-01-01'], readings: 4 },
  'tests/decision-moved-revision.test.ts': { why: 'the 2030-01-01 lease and quarantine stamps are two snapshots decisionGroundsChange compares with each other, never with a clock; the one new Date() stamps a session\'s observedAt', dates: ['2030-01-01'], readings: 1 },
  'tests/decisions-held-rework.test.ts': { why: 'the 2030-01-01 clock drives the pure loop tests through `() => clock` over fixtures derived from it; the new Date() readings stamp observations for the engine-backed tests on the real clock', dates: ['2030-01-01'], readings: 4 },
  'tests/direct-merge-mode.test.ts': { why: 'every absolute instant (the 2024-2026 `since` windows and mergedAt values) is past and compared only with the others; the new Date() merge follows off closing the window', dates: ['2024-01-01', '2024-03-01', '2024-04-01', '2025-01-01', '2025-06-01', '2025-12-01', '2026-01-01', '2026-02-01'], readings: 3 },
  'tests/dismissed-review.test.ts': { why: 'the 2026-09-21 clock is the explicit now handed to reconcileReviews, runDispatchTick and sessionRetry; Date.now()-stamped ledger records are judged by attempt counts, not age', dates: ['2026-09-21'], readings: 19 },
  'tests/docs-budget-headroom.test.ts': { why: 'the 2026-09-26 instants are the explicit now handed to fileDocsTrim, which only stamps the action it records; the Date.now() cycles are bounded by the open item, not elapsed time', dates: ['2026-09-26'], readings: 7 },
  'tests/drained-fleet-dispatch.test.ts': { why: 'the 2030-01-01T12:00Z observedAt is the clock handed to reclaimableAgent and runCycle', dates: ['2030-01-01'], readings: 5 },
  'tests/escalation-context.test.ts': { why: 'the 2026-01-01 and 2026-09-2x stamps are ledger and decision fixtures assembleEscalationContext copies verbatim', dates: ['2026-01-01', '2026-09-20', '2026-09-22', '2026-09-23'], readings: 1 },
  'tests/every-launch-registered.test.ts': { why: 'the 2026-09-01 boundAt is reviewer-binding fixture data nothing ages', dates: ['2026-09-01'], readings: 5 },
  'tests/evidence-reuse.test.ts': { why: 'the 2000-01-01 attempt expiry is written to force a lapse that stays lapsed', dates: ['2000-01-01'], readings: 5 },
  'tests/executor-presence-restart.test.ts': { why: 'The 2026-10-05 `at` instants are the clock each replay installs with mock.timers before its first call; stubEngine\'s new Date() stamp runs only inside those replays', dates: ['2026-10-05'], readings: 1 },
  'tests/executor-release.test.ts': { why: 'the 2026-09-22 claimedAt/since stamps are claim fixtures restartExecutors reports verbatim (any claim refuses, lapsed or not)', dates: ['2026-09-22'], readings: 11 },
  'tests/executor-supervision.test.ts': { why: 'the 2026-09-21T10:00Z t0 is handed to registry.observe and registry.live as their clock', dates: ['2026-09-21'], readings: 14 },
  'tests/exhaustion-launch-account.test.ts': { why: 'the 2026-10-09T09:40Z selection entry is a profile-keyed log row nothing ages or prunes (only \'|\' session keys are pruned)', dates: ['2026-10-09'], readings: 10 },
  'tests/exhaustion-notice.test.ts': { why: 'the 2026-09-26 and 2026-10-03 instants are the fixed now handed to detectRuntimeExhaustion and the resets it parses from notices', dates: ['2026-09-26', '2026-10-01', '2026-10-02', '2026-10-03'], readings: 3 },
  'tests/failed-launch-pane.test.ts': { why: 'the 2030-01-01T12:00Z observedAt is the clock handed to runCycle, containmentSettlementRefusals and assessContainment', dates: ['2030-01-01'], readings: 2 },
  'tests/fault-class-configuration.test.ts': { why: 'The 2030-01-01 clock and the iso() offsets from it are handed explicitly as now to ledgerLoopMerger, observe and performSelfUpgrade', dates: ['2026-09-28', '2030-01-01'], readings: 12 },
  'tests/fault-class-containment.test.ts': { why: 'the 2026-10-03/05 instance stamps are replayed ledger fixtures judged on Date.parse(entry.observedAt); the Date.now() case builds its own lapsed fence relative to the real clock and judges it there; the 2026-10-18/19 instance ids are test names, replayed as relative-deadline fixtures whose fence deadlines derive from the real clock (GY-2151)', dates: ['2026-10-03', '2026-10-05'], readings: 8 },
  'tests/fault-class-review-convergence.test.ts': { why: 'the 2026-10-07 request and verdict stamps are judged on handed ticks (tickAt, faultAt, clock)', dates: ['2026-10-07'], readings: 3 },
  'tests/fault-class-scope.test.ts': { why: 'the 2026-10-01..06 scope-request stamps are ledger fixtures judged on Date.parse(observedAt) handed to cycleFaults, runCycle and workFaults', dates: ['2026-10-01', '2026-10-02', '2026-10-06', '2026-10-14', '2026-10-16', '2026-10-17'], readings: 1 },
  'tests/fault-class-session-liveness.test.ts': { why: 'the 2026-10-08/09/14, GY-1863\'s 2026-10-16/17 and GY-1895\'s 2026-10-17 instants are fixed clocks handed to checkInvariants, observeSessions, buildMasterStatus, resumeStep, the fake planes and the fault fixtures; new Date()/Date.now() only mint leases for the live supervisor timed by performance.now()', dates: ['2026-10-08', '2026-10-09', '2026-10-14', '2026-10-16', '2026-10-17'], readings: 5 },
  'tests/flow-analytics.test.ts': { why: 'the 2026-09/10 instants are calendar fixtures judged on the `to`, deliveryNow or now each case hands in', dates: ['2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-10-01', '2026-10-05'], readings: 25 },
  'tests/github-budget.test.ts': { why: 'the 2026-09-26 instants are the clock handed to github.clock and the charge ledger, plus PR created_at fixtures', dates: ['2026-09-26'], readings: 8 },
  'tests/github-delivery.test.ts': { why: 'the 2026-10-04T12:30Z now is handed to evaluate, mergeQueueAction and reviewNeed with observations stamped from it', dates: ['2026-10-04'], readings: 1 },
  'tests/github-http.test.ts': { why: 'the 2026-09-18 suspended_at is installation fixture data preflight reads for truthiness only', dates: ['2026-09-18'], readings: 13 },
  'tests/github-rate-budget.test.ts': { why: 'The 2026-09-21 item stamps and PR payload dates are past fixtures that evaluate\'s real new Date() only trails, the 2026-10-10 webhook attempts are judged by the now each corroboration case hands in', dates: ['2026-09-21', '2026-10-10'], readings: 31 },
  'tests/github.test.ts': { why: 'the 2026-01-01, 2026-09-17 and 2026-10-05 instants are fixture stamps and fixed clocks handed to enforcement and reconcileCheckReruns', dates: ['2026-01-01', '2026-09-17', '2026-10-05'], readings: 3 },
  'tests/case-change-routing.test.ts': { why: 'the 2026-10-14 daemon clock is handed to caseChangeStep as its clock', dates: ['2026-10-14'], readings: 3 },
  'tests/goal-acceptance.test.ts': { why: 'the 2026-10-07 daemon clock lies behind every approval the server stamps, so the day-after-approval verdict needs the explicit Date.now() + 25h', dates: ['2026-10-07'], readings: 4 },
  'tests/goal-pipeline-outright-refusals.test.ts': { why: 'the 2026-10-10T00:00Z daemon clock lies behind every goal stamped with new Date(), so no acceptanceStuckMs bound is crossed', dates: ['2026-10-10'], readings: 4 },
  'tests/goal-planner.test.ts': { why: 'the 2026-10-07 clock is handed to plannerStep as its now', dates: ['2026-10-07'], readings: 6 },
  'tests/gy-1050-review-followups.test.ts': { why: 'the 2026-09-30T12:00Z at/now stamp the work, evidence and observation fixtures the GitHub harness reads', dates: ['2026-09-30'], readings: 1 },
  'tests/gy-1159-review-followups.test.ts': { why: 'the 2026-10-03T12:00Z now is the fixed clock handed to the worker-pane cases', dates: ['2026-10-03'], readings: 1 },
  'tests/harness-apply-checkout.test.ts': { why: 'the 2026-10-10T18:00Z observedAt is the clock handed to each cycle (now: () => clock, later = clock + 1h)', dates: ['2026-10-10'], readings: 2 },
  'tests/headless-restart.test.ts': { why: 'the 2030-01-01 records are sessionRetry fixtures judged on the now handed beside them', dates: ['2030-01-01'], readings: 6 },
  'tests/helpers/review-fleet.ts': { why: 'the 2026-10-01T10:00Z at stamps createdAt, stageEnteredAt and evidence of fixture items', dates: ['2026-10-01'], readings: 4 },
  'tests/helpers/soak-plane.ts': { why: 'start is the simulated day\'s clock, installed by soakControlPlanes\' before hook; failoverInstalled\'s Date.now() runs inside a soak test, after that hook', dates: ['2031-06-02'], readings: 1 },
  'tests/human-decisions-ui.test.ts': { why: 'the 2026-09-26 and 2026-10-02 instants are clocks handed to HumanSignIn', dates: ['2026-09-26', '2026-10-02'], readings: 3 },
  'tests/install-harness.ts': { why: 'the 2024-01-01 deprecation announcement is Hetzner server-type fixture data the pricing reads for presence only', dates: ['2024-01-01'], readings: 3 },
  'tests/intervention-feedback.test.ts': { why: 'the 2026-09-01, 2026-10-06 and 2026-10-07 instants are ledger rows and the now handed to foldInterventions, detectPatterns and loopSettledInBound', dates: ['2026-09-01', '2026-10-06', '2026-10-07'], readings: 9 },
  'tests/intervention-pattern-containment-settlement-build.test.ts': { why: 'the Date.UTC(2026, 9, 10, 3, m) rows are a ledger judged on at(30) handed to foldInterventions', dates: ['2026-10-10'], readings: 3 },
  'tests/intervention-pattern-escalation-build.test.ts': { why: 'the 2026-10-07..09 instants are fixture clocks handed to foldInterventio', dates: ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-18'], readings: 7 },
  'tests/intervention-pattern-escalation-ready.test.ts': { why: 'the 2026-10-04..06 lease-loss escalations are judged at after5(escalatio', dates: ['2026-10-04', '2026-10-06'], readings: 3 },
  'tests/intervention-rework-rounds.test.ts': { why: 'the 2026-09-24..10-06 fixtures are folded at explicit nows (at(5), 2026-', dates: ['2026-09-24', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06'], readings: 3 },
  'tests/item-split.test.ts': { why: 'NOW (2026-10-03) is the explicit clock of the unit half; the Postgres ha', dates: ['2026-01-01', '2026-02-01', '2026-10-03'], readings: 4 },
  'tests/landing-guard-ancestry.test.ts': { why: 'the 2026-01-01 direct-merge window (no until) and the 2026-09-26 PR crea', dates: ['2026-01-01', '2026-09-26'], readings: 1 },
  'tests/launch-bound.test.ts': { why: '2026-10-06T13:41 is the tick\'s explicit clock (now: () => clock, snapsho', dates: ['2026-10-06'], readings: 2 },
  'tests/launch-delivery.test.ts': { why: '2026-09-22 and 2026-09-30 are virtual pane clocks the launcher\'s bounds ', dates: ['2026-09-22', '2026-09-30'], readings: 4 },
  'tests/launch-prompt-delivery.test.ts': { why: '2026-09-20 is the request clock (sessionRetry, reconcileProducers now: (', dates: ['2026-09-20'], readings: 10 },
  'tests/launches-off-cycle.test.ts': { why: 'the 2030-01-01 snapshot `now` is the cycle\'s own logic clock (runCycle a', dates: ['2030-01-01'], readings: 3 },
  'tests/live-scope-widening.test.ts': { why: 'the 2030-01-03 clock is handed to every runCycle (() => at) over a 2030 ', dates: ['2026-10-05', '2030-01-03'], readings: 8 },
  'tests/live-throughput.test.ts': { why: 'windows at 2099/2100/2103 are isolation fences so real-clock deliveries ', dates: ['2026-09-20', '2026-09-21', '2026-10-07', '2099-01-01', '2100-01-01', '2103-01-01'], readings: 60 },
  'tests/liveness-invariant.test.ts': { why: 't0 (2026-09-20) drives a virtual clock (now = () => new Date(clock)) han', dates: ['2026-09-20'], readings: 17 },
  'tests/loop-faults.test.ts': { why: 'slowPlane\'s Date.now() runs under the cycle tests\' mock.timers clock, and the checkout guards\' snapshots hold no work, so the Date.now() stamping their now meets no lease', dates: ['2026-09-27', '2026-10-01', '2026-10-03', '2026-10-05', '2026-10-06', '2026-10-08'], readings: 7 },
  'tests/loop-liveness-namespace.test.ts': { why: 'the 2026-10-06 instants are the explicit `now` of each loopLiveness call', dates: ['2026-10-06'], readings: 1 },
  'tests/loop-self-upgrade.test.ts': { why: 'the 2030-01-01 clock is passed as now: () => clock to performSelfUpgrade', dates: ['2026-10-07', '2030-01-01'], readings: 2 },
  'tests/main-guard.test.ts': { why: '2026-10-05T08:00 is the guard\'s explicit `now` in every runMainGuard/app', dates: ['2026-10-05'], readings: 1 },
  'tests/managed-worktree-root.test.ts': { why: 'the 2026-09-26 `at` is the explicit clock of the AC-2 memory-hold cycles; the 2026-01-02 `observed` is the snapshot clock the reclaim-stamp case hands to runCycle and compares with the stamp, never a wall-clock read', dates: ['2026-01-02', '2026-09-26'], readings: 30 },
  'tests/master-autonomy.test.ts': { why: 'the 2030-01-01 lease expiry and quarantine instants are judged by buildM', dates: ['2030-01-01'], readings: 2 },
  'tests/master-browser.test.ts': { why: '2026-09-18T12:00 is the stub flow\'s ticking `now` and the recording page', dates: ['2026-09-18'], readings: 3 },
  'tests/master-loop-resilience.test.ts': { why: 'the 2026-09-19 at dates the fixture item (createdAt/stageEnteredAt, alre', dates: ['2026-09-19', '2026-10-09'], readings: 24 },
  'tests/master-supervision.test.ts': { why: 'the 2026-10-07 upgrade.last.at is a cursor record loopSupervisorEvidence', dates: ['2026-10-07'], readings: 6 },
  'tests/master.test.ts': { why: 'every 2030-01-01 instant is judged at a 2030 `now`/observedAt the test p', dates: ['2029-12-31', '2030-01-01'], readings: 2 },
  'tests/mechanical-findings.test.ts': { why: "Time-bomb allowance (GY-1694): the 2026-09-30 commit and verdict instants are already past their 60-minute mechanical bound and only recorded; the holds asserted come from approvals stamped new Date() and judged at Date.now(). The plan report's stamps (planOf, and the hold-freshness test's one Date.now() every plan instant derives from) are the loop's own report of a ledger the test just read, judged against the same reading.", dates: ['2026-09-30'], readings: 14 },
  'tests/merge-executor-owner.test.ts': { why: 'the 2026-09-20 merge instant is a recorded observation the status only r', dates: ['2026-09-20'], readings: 5 },
  'tests/merge-queue-removed.test.ts': { why: 'the 2026-10-05 instant is the explicit `now` of evaluate() over a legacy', dates: ['2026-10-05'], readings: 1 },
  'tests/observation-capacity.test.ts': { why: '2026-10-02T12:00 is the explicit `now` of the fleet fixtures and observa', dates: ['2026-10-02'], readings: 3 },
  'tests/observation-throughput.test.ts': { why: 'the 2026-09-21 PR created_at is fixture data the observer never compares', dates: ['2026-09-21'], readings: 26 },
  'tests/one-reviewer-per-request.test.ts': { why: 'the 2026-09-22 review submittedAt instants only order verdicts and alrea', dates: ['2026-09-22'], readings: 18 },
  'tests/orphan-supervisor.test.ts': { why: 'the 2030-01-01 observedAt is the snapshot `now` and the clock of every r', dates: ['2030-01-01'], readings: 2 },
  'tests/pacer-reserve.test.ts': { why: 'the 2026-09-26 15:xx reading series is reported against its own `now = at(\'15:28:00\')`; Date.now() only seeds the separate per-token test, whose resets are offsets from it', dates: ['2026-09-26'], readings: 1 },
  'tests/pi-account-key.test.ts': { why: 'the 2026-09-25/26 instants are past and are the explicit `at` handed, with offsets, to recordRunOutcome, chooseSession and needsSmoke; Date.now() stamps and judges only real-clock records', dates: ['2026-09-25', '2026-09-26'], readings: 12 },
  'tests/pi-runner.test.ts': { why: 'the 2030-01-01 strings only stamp a session line and a runRecord\'s startedAt/endedAt, which nothing compares with a clock; Date.now() measures how long the hung process took to stop', dates: ['2030-01-01'], readings: 2 },
  'tests/pipeline-speed.test.ts': { why: 'the 2026-09-20/21 instants are past claim/merge fixtures judged against an explicit `now` of the same day; Date.now()/new Date() only stamp and judge the DB-backed items the engine creates', dates: ['2026-09-20', '2026-09-21', '2026-10-06'], readings: 19 },
  'tests/pipeline-wait-hotspots.test.ts': { why: 'the 2030-01-01 `clock` is handed explicitly to every loopWakeSubjects call; the real daemon and tick only ever see unleased `waiting()` items, and Date.now() measures sleep/wake latency', dates: ['2030-01-01'], readings: 19 },
  'tests/post-merge-review.test.ts': { why: 'the 2026-10-08 `at` fixtures are already past, so a delivery, launch or expiry stamped with them reads the same on any later day; Date.now()/new Date() only stamp the live-API launch and its filing', dates: ['2026-10-08'], readings: 3 },
  'tests/producer-environment.test.ts': { why: 'the 2026-10-02 `clock` is the explicit tick clock handed to runDispatchTick and its snapshot; new Date() only stamps request/observation records that no clock compares to it', dates: ['2026-10-02'], readings: 11 },
  'tests/project-memory-followups.test.ts': { why: 'the 2026-10-01 `at` values only order fixture decisions, pitfalls and merges, and the 2026-10-03 `now` is handed explicitly to checkAgentEnvironment; Date.now() stamps other fixtures on the real clock', dates: ['2026-10-01', '2026-10-03'], readings: 6 },
  'tests/project-memory.test.ts': { why: 'the 2026-10-02 instants are memory/answer timestamps that updateProjectMemoryFromWork only sorts; its 24 h merge window runs on Date.now() against mergedAt values also derived from Date.now()', dates: ['2026-10-02'], readings: 6 },
  'tests/ready-scope-widening.test.ts': { why: 'the 2026-10-06 `at` values stamp exhaustion fixtures and feed foldInterventions as its explicit clock; new Date() is only the clock for DB-backed ledger rows the engine stamped itself', dates: ['2026-10-06'], readings: 1 },
  'tests/recovery.test.ts': { why: 'the 2000-01-01 expiresAt forces an attempt lapse that stays lapsed, and 2026-09-18 is the injected SigV4 signing clock; Date.now() builds deadlines and snapshot instants on the real clock only', dates: ['2000-01-01', '2026-09-18'], readings: 4 },
  'tests/registry-discovery.test.ts': { why: 'the 2030-01-01 `clock0` drives runCycle and the snapshot through `() => at.value`, so the master-session cycles never read the real clock; Date.now() only stamps discovered credentials\' expiry', dates: ['2030-01-01'], readings: 2 },
  'tests/release-candidate.test.ts': { why: 'the 2026-10-01 instants are explicit `now` arguments to cut/promote/validate, already more than the 4 h UAT window in the past, so deployToUat\'s default new Date() never reads them as pending; the 2026-10-03 trio are the explicit cut/validate `now` arguments of the pending-outcome test, ordered between candidates and never read by a wall clock', dates: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-07', '2026-10-08'], readings: 11 },
  'tests/resource-observation.test.ts': { why: '2026-09-23 and 2026-10-07 are explicit clocks handed to reconcile/claim/settle, reclaimResources and readResources; Date.now() only stamps records and clocks the live-ledger tests on the real clock', dates: ['2026-09-23', '2026-10-07'], readings: 18 },
  'tests/resource-reading-instants.test.ts': { why: 'the 2026-10-08 snapshot, session and reflog instants are replayed against the explicit `now`/`clock` of the same snapshot; the one Date.now() case builds its own relative start and reflog', dates: ['2026-10-08'], readings: 4 },
  'tests/retro-synthesis.test.ts': { why: 'the 2026-09-30 signals are judged against `now = at(0)` handed explicitly to detectRecurringCauses and stamped into events; Date.now() only bounds the test\'s own waits and stamps failures', dates: ['2026-09-30'], readings: 4 },
  'tests/revert-recheck.test.ts': { why: 'the 2026-09-20/21 instants are past PR, review and landing timestamps plus the fixed status `now`; evaluate\'s new Date() only judges gates of items whose timestamps all lie behind it', dates: ['2026-09-20', '2026-09-21'], readings: 1 },
  'tests/review-convergence-recurrence.test.ts': { why: 'the 2026-10-03 verdict, window and fault instants are replayed as explicit clocks to reconcileAutoDispatch, reconcileReviewConflict and launchReview; new Date() only stamps items and mint expiry', dates: ['2026-10-03'], readings: 4 },
  'tests/review-followups.test.ts': { why: '2026-09-24 verdict/thread instants are ordered only against each other; 2026-09-30 stamps pendingFollowUps on items that are not machine-filed, so overdueTriage never ages them; Date.now() stamps the rest', dates: ['2026-09-24', '2026-09-30'], readings: 34 },
  'tests/review-ledger-cap.test.ts': { why: 'the 2026-09-23 `at()` ledger instants are past, so those records already read settled or expired on the real clock and stay so; records that must be live get tokenExpiresAt from Date.now()', dates: ['2026-09-23'], readings: 11 },
  'tests/review-ledger-lock.test.ts': { why: 'the 2026-10-05 submittedAt is a past verdict literal that reconcile records without comparing it to a clock; the gh stub\'s submitted_at and the item timestamps come from Date.now()', dates: ['2026-10-05'], readings: 10 },
  'tests/review-provider.test.ts': { why: 'the 2026-01-01 request/verdict instants are judged against `now = 2026-01-01T00:06Z` handed explicitly to observeAgentReview; new Date() only stamps work() items and clocks their gate evaluation', dates: ['2025-12-31', '2026-01-01'], readings: 5 },
  'tests/review-rounds.test.ts': { why: 'the 2026-09-24 instants stamp settled prior rounds and the reviewer binding, which the round logic orders by head rather than by clock; new Date() stamps the live item and the launch observedAt', dates: ['2026-09-24'], readings: 9 },
  'tests/review-thread-resolution.test.ts': { why: 'the 2026-09-23/24 instants stamp threads, verdicts and legacy records that the resolution judges by listing and mutual order, never against a clock; Date.now()/new Date() stamp live items and mint expiry', dates: ['2026-09-23', '2026-09-24'], readings: 23 },
  'tests/reviewer.test.ts': { why: 'the 2026-09-23 thread createdAt and 2026-09-18 submittedAt are parsed fixture fields passed through unchanged; the real clock only bounds observation age and token expiry via offsets from Date.now()', dates: ['2026-09-18', '2026-09-23'], readings: 19 },
  'tests/rework-interventions.test.ts': { why: '2026-10-05 only bounds recorded requestedAt strings and 2026-10-12 is the explicit `now` handed to detectPatterns; new Date() clocks the DB-backed fold whose rows the engine stamped itself', dates: ['2026-10-05', '2026-10-12'], readings: 2 },
  'tests/role-concurrency.test.ts': { why: 'the 2026-09-21 `clock` is handed explicitly to roleConcurrency and to the requested() fixtures of that test; the other tests stamp items, verdicts and mint expiry from the real clock alone', dates: ['2026-09-21'], readings: 7 },
  'tests/runner-attestor.test.ts': { why: 'the 2026-09-16 interval is a forged startedAt/finishedAt the attestation must reject whatever the date; the grant deadline is Date.now()+10 min on the real clock', dates: ['2026-09-16'], readings: 1 },
  'tests/runner-executor.test.ts': { why: 'the 2026-09-16 clock is handed explicitly to executeAttempt and lies before the Date.now()+10 min grant deadline on any day; the expiry case uses a Date.now()-1 s deadline instead', dates: ['2026-09-16'], readings: 7 },
  'tests/runtime-limit-menu.test.ts': { why: 'the 2026-10-09 `now` is explicit and the Oct 10/12 resets carry no year, so parseResetTime rolls them forward past any real Date.now(); the integration cycle clocks from Date.now()+skew', dates: ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'], readings: 3 },
  'tests/runtime-screens.test.ts': { why: 'the 2026-09-25 `clock` is the ScreenPane\'s virtual start clock, advanced only by wait() and handed via bounds(); Date.now()/new Date() stamp the credential expiry and the dispatch observedAt', dates: ['2026-09-25'], readings: 5 },
  'tests/scope-approver-routine.test.ts': { why: 'the 2031-03-01 instants are judged only by the pure scopeRoutineDecision against its explicit `now` of the same minute; Date.now() clocks the DB-backed items the engine stamped itself', dates: ['2031-03-01'], readings: 20 },
  'tests/scope-directory-collapse.test.ts': { why: 'the 2031-03-01 lease and refusal instants meet only the explicit now Date.parse(\'2031-03-01T10:00:00Z\') given ', dates: ['2031-03-01'], readings: 3 },
  'tests/scope-request-carry.test.ts': { why: 'the 2026-10-07 start is past and handed explicitly to scopeRequestOutcome (Date.now is mocked to it for the wa', dates: ['2026-10-07'], readings: 11 },
  'tests/scope-request-new-file.test.ts': { why: 'the 2031-03-01 lease and refusal instants meet only the explicit now Date.parse(\'2031-03-01T10:00:00Z\') given ', dates: ['2031-03-01'], readings: 1 },
  'tests/session-cwd.test.ts': { why: 'the 2030-01-01 iso() instants are judged against the stub snapshot\'s own now iso(0) (lease expiry, fault ages,', dates: ['2026-09-24', '2030-01-01'], readings: 8 },
  'tests/session-liveness-launch-window.test.ts': { why: 'the 2026-10-05 instants are past and every judgement of them takes that test\'s explicit clock; the Date.now()-', dates: ['2026-10-05'], readings: 8 },
  'tests/session-liveness-model.test.ts': { why: 'the 2026-09-24 and 2026-10-08 fixture instants are past and handed explicitly as now to observeSessions/sessio', dates: ['2026-09-24', '2026-10-08'], readings: 9 },
  'tests/session-liveness.test.ts': { why: 'boundAt 2026-09-01 is config fixture and the 2026-09-21 instants are explicit past now/at arguments; the Date.', dates: ['2026-09-01', '2026-09-21'], readings: 4 },
  'tests/session-reconcile.test.ts': { why: 'the 2026-09-23 request instants are past and judged only against the explicit now Date.parse(\'2026-09-23T07:36', dates: ['2026-09-23'], readings: 12 },
  'tests/soak-approver-idle-stall.test.ts': { why: 'item() stamps its work with new Date() only inside the soak test, after mock.timers installed the 2026-10-09 clock', dates: ['2026-10-09'], readings: 1 },
  'tests/soak-approver-pane-rebind.test.ts': { why: 'item() stamps its work with new Date() only inside the soak tests, after mock.timers installed the 2026-10-09 clock', dates: ['2026-10-09'], readings: 1 },
  'tests/soak-checkout-restore.test.ts': { why: 'the 2030-01-01 simulated clock is the loop\'s injected now and every request/journal instant derives from it; D', dates: ['2030-01-01'], readings: 1 },
  'tests/speed-metric.test.ts': { why: 'the 2026-10-07 delivery and timeline fixtures are measured against the explicit now constant; pipelineSpeedSum', dates: ['2026-10-07'], readings: 1 },
  'tests/stale-rework-requests.test.ts': { why: 'the 2030-01-01 clock is the loop\'s injected now beside the snapshot\'s now iso(0); the Date.now()-based pause t', dates: ['2030-01-01'], readings: 1 },
  'tests/stalled-actions.test.ts': { why: 'the 2026-09-21 clock is passed explicitly to claim/settle/reconcile; the 2026-01-01 window and 2026-02-01 merg', dates: ['2026-01-01', '2026-02-01', '2026-09-21', '2026-10-18'], readings: 13 },
  'tests/stalled-gate-faults.test.ts': { why: 'the 2026-10-01/02 instants are past fixture ats whose stall reading (actionStall) reads row history, not the c', dates: ['2026-10-01', '2026-10-02'], readings: 7 },
  'tests/status-conflict-probe-bounded.test.ts': { why: 'the 2030-01-01 stamps are work/cache fixture fields and the explicit status now; nothing dates them against th', dates: ['2030-01-01'], readings: 8 },
  'tests/submit-head.test.ts': { why: 'the 2026-10-08 observation at and the 12:30 evaluate now are past and handed explicitly to observeHead/evaluat', dates: ['2026-10-08'], readings: 1 },
  'tests/sudo-form-capture.test.ts': { why: 'the 2026-10-07 tick clock is handed explicitly as now to the browser flow; Date.now() only fakes a form timest', dates: ['2026-10-07'], readings: 2 },
  'tests/supervised-local.test.ts': { why: 'boundAt and the 2026-10-08 fixture instants are past and handed explicitly as seen/now to the registry, evalua', dates: ['2026-10-08'], readings: 2 },
  'tests/system.test.ts': { why: 'Every 2000-01-01 expiry is written to force a lease, evidence or observation lapse that stays lapsed on any later day; the 2099 Date proxy serves one test\'s clock-skew check', dates: ['2000-01-01', '2099-01-01'], readings: 33 },
  'tests/test-case-repository.test.ts': { why: 'artifact createdAt 2026-09-01 is provenance fixture nothing dates against the clock; new Date()/Date.now() sta', dates: ['2026-09-01'], readings: 3 },
  'tests/test-isolation.test.ts': { why: 'the 2026-09-24 pause resets are judged against the injected now () => clock of that test; the live command\'s r', dates: ['2026-09-24'], readings: 1 },
  'tests/throughput-admission.test.ts': { why: 'the 2026-10-07 base and the 2026-09-28 GY-468 span are past and every measurement takes an explicit now or clo', dates: ['2026-09-28', '2026-10-02', '2026-10-07'], readings: 2 },
  'tests/throughput-ledger.test.ts': { why: 'the 2100 delivery and deployment instants are the measurement tests\' own clock, handed in as now: () => clock; the loop-cycle tests stub measureThroughput, so runCycle\'s Date.now() never meets them', dates: ['2100-01-01', '2100-02-01'], readings: 7 },
  'tests/throughput-owner-standing.test.ts': { why: 'the 2026-10-07 base is past and every measurement takes an explicit now/clock; the Date.now() cycles drive a s', dates: ['2026-10-07'], readings: 19 },
  'tests/timeline-backfill.test.ts': { why: 'the 2026-09-01 attempt instants are pure mergeTimeline inputs no clock judges; Date.now() stamps live DB deliv', dates: ['2026-09-01'], readings: 6 },
  'tests/timing-baseline-companion.test.ts': { why: 'the 2026-09-30 and 2026-10-04 scope-request ats are past refusal fixtures judged on plannedFiles, not the cloc', dates: ['2026-09-30', '2026-10-04'], readings: 12 },
  'tests/unattended-cycle.test.ts': { why: 'the 2031-03-01 clockStart is the loop\'s injected now and every verdict/lease instant and loopLiveness call tak', dates: ['2031-01-01', '2031-03-01'], readings: 1 },
  'tests/unresolved-threads.test.ts': { why: 'the 2026-09-23/24 instants are past PR fixtures and explicit now values for evaluate/routineDecision; the new ', dates: ['2026-09-23', '2026-09-24'], readings: 4 },
  'tests/upgrade-slot-restart.test.ts': { why: 'the 2026-10-07 now is past and handed explicitly to the registry, report and snapshot; slot down time is measu', dates: ['2026-10-07'], readings: 13 },
  'tests/validation.test.ts': { why: 'the 2000-01-01 expiresAt/deadline/expires_at writes are past and only force an already-lapsed expiry; Date.now', dates: ['2000-01-01'], readings: 5 },
  'tests/worker-push-credential.test.ts': { why: 'the 2030-01-01 clock is the loop\'s injected now and the snapshot\'s now iso(0), so held() leases are judged aga', dates: ['2030-01-01'], readings: 16 },
  'tests/zero-touch-onboarding.test.ts': { why: 'the 2026-10-07 clock is the scenario\'s injected now and advances only by its own sleeps; new Date() only stamp', dates: ['2026-10-07'], readings: 1 },
};
