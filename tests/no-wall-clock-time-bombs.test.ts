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
//      with 'Date' among its apis, or an assignment to globalThis.Date, and it covers exactly the code
//      that runs after it: installed at module scope, or in a before/beforeEach hook, it covers the
//      block the hook belongs to (the whole file for a top-level hook); installed inside any other
//      block, a test body above all, it covers that block from the stub to its closing brace, and no
//      other test in the file. A reading in another test body, in a helper, or earlier in the same
//      body ran on the real clock, however many stubs the file holds elsewhere.
// A file that meets the rule fails this test, named with its first instant line and its first
// uncovered wall-clock line. The way out is to derive the instant from the test's fixed now, to stub
// Date where the reading happens (or for the file), or to list the file in `allowances` by the comment
// in it that documents why its absolute date is safe (a past instant that forces an expiry and stays
// past; fixture dates the code under test receives beside a clock it is handed; a stamp on a record
// nothing compares with the fixture; helpers that read Date only while a test's stub is installed). An
// allowance for a file without that comment, or for a file that no longer trips the rule, fails.
// This file is the one file the rule skips, by name: its fixtures are strings holding instants,
// wall-clock calls and stubs for the lint to find, so no reading of its text says anything true.

const self = relative(process.cwd(), fileURLToPath(import.meta.url)).split('\\').join('/');

const instant = /\bDate\.UTC\(\s*(?:19|20)\d\d\b|\bnew Date\(\s*['"`](?:19|20)\d\d-\d\d-\d\d|\bDate\.parse\(\s*['"`](?:19|20)\d\d-\d\d-\d\d|['"`](?:19|20)\d\d-\d\d-\d\dT\d\d:\d\d/;
const wallClock = /\bDate\.now\(\)|\bnew Date\(\s*\)/g;
const stubsDate = /\bclock\.install\(|\bmock\.timers\.enable\(\s*\{[^}]*apis:\s*\[[^\]]*'Date'|\b(?:globalThis|global)\.Date\s*=[^=]/g;
/** The code before a block's `{` ends in a before/beforeEach call whose callback the block is: `before(async () => {`. */
const hookOpener = /\b(?:before|beforeEach)\s*\((?:[^()]|\([^()]*\))*$/;

/** A position in the source: 1-based line, 0-based column in that line's code. */
interface Position { line: number; column: number }
/** A `{ … }` block: where it opens and closes, and the block around it. */
interface Block { open: Position; close: Position; parent: Block | null }
const before = (a: Position, b: Position) => a.line < b.line || (a.line === b.line && a.column < b.column);
const within = (at: Position, from: Position, to: Position) => !before(at, from) && !before(to, at);

/**
 * The source read as code: each line with its comments dropped (strings kept, so an ISO literal is still an instant),
 * and every brace block with its position. Strings and comments contribute no braces; a string other than a template
 * literal ends with its line, so a regex literal mistaken for one costs at most that line's braces.
 */
export function parse(source: string): { lines: string[]; blocks: Block[] } {
  const lines: string[] = [], blocks: Block[] = [], open: Block[] = [];
  let line = '', quote: '\'' | '"' | '`' | null = null, comment: 'line' | 'block' | null = null, escaped = false;
  const here = (): Position => ({ line: lines.length + 1, column: line.length });
  for (let index = 0; index < source.length; index++) {
    const char = source[index], next = source[index + 1];
    if (char === '\n') { lines.push(line); line = ''; if (comment === 'line') comment = null; if (quote && quote !== '`') quote = null; escaped = false; continue; }
    if (comment === 'line') continue;
    if (comment === 'block') { if (char === '*' && next === '/') { comment = null; index++; } continue; }
    if (quote) { line += char; if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = null; continue; }
    if (char === '/' && next === '/') { comment = 'line'; continue; }
    if (char === '/' && next === '*') { comment = 'block'; index++; continue; }
    if (char === '\'' || char === '"' || char === '`') quote = char;
    else if (char === '{') { const block = { open: here(), close: here(), parent: open.at(-1) ?? null }; open.push(block); blocks.push(block); }
    else if (char === '}') { const block = open.pop(); if (block) block.close = here(); }
    line += char;
  }
  lines.push(line);
  for (const block of open) block.close = { line: lines.length, column: line.length }; // never closed: runs to the end of the file
  return { lines, blocks };
}

const start: Position = { line: 1, column: 0 };
/** The innermost block holding `at`. */
const enclosing = (blocks: Block[], at: Position) => blocks.filter(block => within(at, block.open, block.close) && !(at.line === block.open.line && at.column === block.open.column)).sort((a, b) => before(a.open, b.open) ? 1 : -1)[0] ?? null;

/** The stretches of code a stubbed clock covers: each from a stub to the end of what it governs. */
export function stubbedRanges(lines: string[], blocks: Block[]): Array<{ from: Position; to: Position }> {
  const end: Position = { line: lines.length, column: lines[lines.length - 1].length };
  const ranges: Array<{ from: Position; to: Position }> = [];
  for (const [index, text] of lines.entries()) {
    for (const match of text.matchAll(stubsDate)) {
      const at: Position = { line: index + 1, column: match.index };
      const block = enclosing(blocks, at);
      if (!block) { ranges.push({ from: start, to: end }); continue; } // module scope: the file's clock
      const opener = lines[block.open.line - 1].slice(0, block.open.column);
      if (hookOpener.test(opener)) ranges.push(block.parent ? { from: block.parent.open, to: block.parent.close } : { from: start, to: end }); // a hook stubs the block its tests run in
      else ranges.push({ from: at, to: block.close }); // a test body: this test, from here on
    }
  }
  return ranges;
}

export interface TimeBomb { file: string; instant: number; wallClock: number; instants: number; wallClocks: number }

/** The time bomb in one file's source, if the file constructs an absolute instant and reads the wall clock where no stub covers the reading. */
export function timeBombIn(file: string, source: string): TimeBomb | null {
  const { lines, blocks } = parse(source);
  const ranges = stubbedRanges(lines, blocks);
  const instants = lines.flatMap((line, index) => instant.test(line) ? [index + 1] : []);
  const wallClocks = lines.flatMap((line, index) => [...line.matchAll(wallClock)].some(match => !ranges.some(range => within({ line: index + 1, column: match.index }, range.from, range.to))) ? [index + 1] : []);
  if (!instants.length || !wallClocks.length) return null;
  return { file, instant: instants[0], wallClock: wallClocks[0], instants: instants.length, wallClocks: wallClocks.length };
}

async function* sources(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sources(path); else if (/\.(?:ts|mts|mjs|js)$/.test(entry.name)) yield path;
  }
}

/** Every time bomb under `root` not covered by an allowance, and the allowances that do not hold. */
export async function timeBombs(root: string, allowed: Record<string, string>) {
  const bombs: TimeBomb[] = [], refused: string[] = [];
  for await (const path of sources(root)) {
    const file = relative(process.cwd(), path).split('\\').join('/');
    if (file === self) continue;
    const source = await readFile(path, 'utf8'), found = timeBombIn(file, source);
    if (!(file in allowed)) { if (found) bombs.push(found); continue; }
    if (!found) refused.push(`${file}: allowed, but trips the rule no more; drop its allowance`);
    else if (!source.split('\n').some(line => /^\s*(?:\/\/|\*|\/\*)/.test(line) && line.includes(allowed[file]))) refused.push(`${file}: allowed, but no comment in it documents why its absolute date is safe ("${allowed[file]}")`);
  }
  return { bombs: bombs.sort((a, b) => a.file.localeCompare(b.file)), refused: refused.sort() };
}

const count = (n: number, noun: string) => n === 1 ? `` : ` (and ${n - 1} more ${noun}${n > 2 ? 's' : ''})`;
export const describeBomb = (bomb: TimeBomb) => `${bomb.file}:${bomb.instant} constructs an absolute calendar instant${count(bomb.instants, 'instant')} and ${bomb.file}:${bomb.wallClock} reads the wall clock${count(bomb.wallClocks, 'reading')} where no stubbed clock covers it; derive the instant from the test's fixed now, stub Date where the reading runs (a module-scope stub or a before hook covers the file), or document in the file why its absolute date is safe and list that comment in allowances`;

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
  return { root, run: (allowed: Record<string, string> = {}) => timeBombs(join(root, 'tests'), allowed), file: (path: string) => relative(process.cwd(), join(root, path)).split('\\').join('/') };
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
  assert.deepEqual(bombs, [{ file: file('tests/followups.test.ts'), instant: 2, wallClock: 7, instants: 2, wallClocks: 1 }], 'the first instant line and the first wall-clock line, with the count of lines holding each (line 7 reads the clock twice)');
  assert.match(describeBomb(bombs[0]), /followups\.test\.ts:2 constructs an absolute calendar instant \(and 1 more instant\) and .*followups\.test\.ts:7 reads the wall clock where no stubbed clock covers it/);
  assert.deepEqual(refused, []);
  // The original fuse of 2026-10-11T05:00Z is reported before, at and after the instant alike: the rule reads no clock.
  const past = gy1694.replace('Date.UTC(2026, 9, 11, 5)', 'Date.UTC(2000, 0, 1)');
  const { run: runPast } = await fixtures('gy-1694-past', { 'tests/followups.test.ts': past });
  assert.equal((await runPast()).bombs.length, 1, 'an instant already behind the clock is reported just the same');
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

test('unit:no-wall-clock-time-bombs — a stub installed in one test covers that test from the stub on, not the file: a reading in another test, in a helper or before the stub is named, while a module-scope stub or a before hook covers the file', async () => {
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
    `beforeEach(async () => {`,
    `  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start });`,
    `});`,
    `const stamp = () => new Date().toISOString();`,
    `test('unit:a', () => { assert.ok(Date.now() >= start); });`,
    `test('unit:b', () => { assert.equal(stamp(), new Date(start).toISOString()); });`);
  const oneLiners = sourceLines(
    `import { mock, test } from 'node:test';`,
    `const start = Date.parse('2031-06-02T08:00:00Z');`,
    `test('unit:a', () => { mock.timers.enable({ apis: ['Date'], now: start }); assert.equal(Date.now(), start); });`,
    `test('unit:b', () => { assert.ok(Date.now() < start); });`);
  const { run, file } = await fixtures('scoped', { 'tests/mixed.test.ts': mixed, 'tests/helper.test.ts': helper, 'tests/late.test.ts': late, 'tests/describe-hook.test.ts': describeHook, 'tests/top-hook.test.ts': topHook, 'tests/one-liners.test.ts': oneLiners });
  assert.deepEqual((await run()).bombs.map(bomb => [bomb.file, bomb.instant, bomb.wallClock, bomb.wallClocks]), [
    [file('tests/describe-hook.test.ts'), 2, 7, 1],
    [file('tests/helper.test.ts'), 2, 3, 1],
    [file('tests/late.test.ts'), 3, 5, 1],
    [file('tests/mixed.test.ts'), 2, 5, 1],
    [file('tests/one-liners.test.ts'), 2, 4, 1],
  ], 'the uncovered reading is the one named: the other test (mixed, one-liners), the helper, the line before the stub, the test outside the describe; a top-level hook covers the file');
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
  const allowed = await run({ [file('tests/fixtures/documented.ts')]: why, [file('tests/fixtures/undocumented.ts')]: why, [file('tests/fixtures/settled.ts')]: why, [file('tests/fixtures/in-code.ts')]: why });
  assert.deepEqual(allowed.bombs, [], 'an allowed file is not reported as a bomb');
  assert.deepEqual(allowed.refused, [
    `${file('tests/fixtures/in-code.ts')}: allowed, but no comment in it documents why its absolute date is safe ("${why}")`,
    `${file('tests/fixtures/settled.ts')}: allowed, but trips the rule no more; drop its allowance`,
    `${file('tests/fixtures/undocumented.ts')}: allowed, but no comment in it documents why its absolute date is safe ("${why}")`,
  ].sort(), 'an allowance without its documentation in a comment, or for a file that no longer trips the rule, is refused');
});

/**
 * Files allowed to keep an absolute calendar instant beside a wall-clock reading, each by the comment in it that
 * documents why its absolute date is safe. Every entry is a file that trips the rule today; an entry for a file
 * that stops tripping it, or whose comment is gone, fails the test above. A new file that trips the rule earns an
 * entry only with such a comment, and never by widening the rule.
 */
export const allowances: Record<string, string> = {
  'tests/action-priority.test.ts': 'the 2000-01-01 lease expiry forces a lapse that stays lapsed, 2026-09-22 resetsAt is a past record the note quotes, and 2026-09-21 `at` is the fixed now handed to nextAction',
  'tests/action-queue.test.ts': 'the 2026-09-01 boundAt is reviewer config and the 2026-09-20 `at`/clock is the fixed now handed to reconcileActions and evaluate; Date.now() serves only the live engine tests',
  'tests/action-totality.test.ts': 'the 2026-09-21 `now` is handed explicitly to nextAction and actionAccount over fixtures built from it; new Date() serves the engine tests and stamps observations',
  'tests/agent-registry.test.ts': 'the 2026-09-20 at/now/resetsAt trio is the fixed clock handed to fleetView, chooseSession and sessionEnded; Date.now() only builds relative expiries and reset times',
  'tests/answered-owner-close.test.ts': 'the 2026-10-07 base instants are throughput fixtures judged by verifyThroughput against the explicit `now` derived from base; Date.now() only stamps closures and steps cycles',
  'tests/answered-review-request.test.ts': 'the 2026-10-01 verdict timestamps are the recorded GY-1083 instances and only order replayed verdicts; observedAt, closedAt, requestedAt and expiry are built relative to Date.now()',
  'tests/approver-refusal.test.ts': 'the 2026-09-23 instants are the explicit now/at handed to unansweredDecisions, terminalDecisions and approvalStep; new Date()/Date.now() only stamp the stubbed master\'s records',
  'tests/async-runner.test.ts': 'the 2030-01-01 clock is handed to runCycle, loopLiveness and daemonSummary as their explicit now over fixtures derived from it; Date.now() only measures elapsed time and child deadlines',
  'tests/auto-dispatch.test.ts': 'the 2026-09-19 `at`/clock stamps fixture items and dispatch cursors judged at that clock; Date.now()/new Date() stamp live observations and measure launch latency only',
  'tests/auto-scope.test.ts': 'the only absolute instant is the 2000-01-01 lease expiry, a past date that forces a lapse the cycle keeps lapsed; Date.now() is the loop\'s live clock and only moves further past it',
  'tests/autonomy-contract.test.ts': 'the 2026-09-24 `at` is a past createdAt/updatedAt stamp and the fixed now handed to reconcileAutoDispatch; new Date() readings stamp observations and launches, which nothing compares with it',
  'tests/autonomy-promotion.test.ts': 'the 2026-10-08 boundAt is reviewer config and the 2026-10-08 `now` is handed explicitly to promoteToAutonomy for its audit stamp; the one new Date() is the status snapshot\'s own now',
  'tests/await-reviewers-exhausted.test.ts': 'the 2026-09-25 `at`/clock is the fixed now handed to reconcileAutoDispatch, dispatchEffects and dispatchSummary; the new Date() readings only stamp the stub\'s snapshot and review records',
  'tests/base-break-refresh.test.ts': 'the 2026-09-26 `at` is passed to judgeBaseBreak as its explicit observation time and echoed back; new Date()/Date.now() stamp live observations in separate tests',
  'tests/base-failure-rework.test.ts': 'the 2030-01-01 clock drives the pure runCycle tests through `() => unobserved.now` over fixtures derived from it; the one new Date() stamps the engine tests\' observations',
  'tests/batch-deadlock.test.ts': 'the 2026-09-22 created_at is a past, fixed field of the stub GitHub pull payload; Date.now() only measures how long a retry streak takes and new Date() stamps stub reviews\' submitted_at',
  'tests/blocked-session.test.ts': 'the 2030-01-01 clock is handed to runCycle as `() => clock` and the 2026-10-05 now is startAgentSession\'s explicit clock; Date.now() builds relative expiries for the account tests',
  'tests/blocker-followups.test.ts': 'the 2026-10-03 start is handed to cycleOf as the explicit now and stepped by blockerEscalateMs; Date.now()/new Date() serve separate cycles and stamp sessions and exhaustions',
  'tests/bootstrap-policy.test.ts': 'the 2026-09-18 declaredAt is a past fixture field of an operator declaration that evaluate and diagnose carry through unchanged; new Date()/Date.now() are the explicit now they are handed',
  'tests/capacity-failover.test.ts': 'the 2026-09-20/09-30 instants are the explicit now handed to detectExhaustion, parseResetTime and outputReadDue, which judge parsed resets against it; Date.now() builds relative resets',
  'tests/checkout-restore-release.test.ts': 'the 2030-01-01 ledger `at` is a stored string nothing dates; the 2026-10-11 grants are judged by the explicit now/clock handed to the act; Date.now() bounds waits and real-clock grants',
  'tests/cli.test.ts': 'the 2030-01-01 leases are judged against the snapshot\'s own 2030 now or a monotonic stub; the 2026 snapshot nows and deadline are stub fixtures; Date.now() builds relative expiries',
  'tests/consent-prompt.test.ts': 'the 2026-09-23 `at`/clock stamps fixture items\' createdAt/updatedAt; Date.now()/new Date() build live lease expiries and the explicit now for consentHoldItems only',
  'tests/cycle-failure.test.ts': 'the 2030-01-01 iso() values are the stub snapshot\'s own now and deployment stamp handed back to the daemon; Date.now() only measures how long the loop waited between retries',
  'tests/daemon-unsubmitted-bound.test.ts': 'the 2026-10-07 clock is the explicit now handed to workFaults, cycleFaults and unsubmittedAttempt over fixtures derived from it; the DB tests build stamps relative to Date.now()',
  'tests/decision-application.test.ts': 'the 2026-10-03/10-05 instants are the explicit now handed to approvalStep, routineDecision and actionableSubjects over same-day watches; new Date() only stamps live records',
  'tests/decision-held-until-attempt-ends.test.ts': 'the 2026-10-11 base only yields relative event stamps that foldDecisions and approvalStep read with an explicit now from the same base; Date.now() serves the live DB tests',
  'tests/decision-lifecycle.test.ts': 'the 2000-01-01 lease expiry forces a lapse that stays lapsed, and the 2030-01-01 escalation `at` is compared by samePin only between two pins; Date.now() serves live items',
  'tests/decision-moved-revision.test.ts': 'the 2030-01-01 lease and quarantine stamps are two snapshots decisionGroundsChange compares with each other, never with a clock; the one new Date() stamps a session\'s observedAt',
  'tests/decisions-held-rework.test.ts': 'the 2030-01-01 clock drives the pure loop tests through `() => clock` over fixtures derived from it; the new Date() readings stamp observations for the engine-backed tests on the real clock',
  'tests/direct-merge-mode.test.ts': 'every absolute instant (the 2024-2026 `since` windows and mergedAt values) is past and compared only with the others; the new Date() merge follows off closing the window',
  'tests/dismissed-review.test.ts': 'the 2026-09-21 clock is the explicit now handed to reconcileReviews, runDispatchTick and sessionRetry; Date.now()-stamped ledger records are judged by attempt counts, not age',
  'tests/docs-budget-headroom.test.ts': 'the 2026-09-26 instants are the explicit now handed to fileDocsTrim, which only stamps the action it records; the Date.now() cycles are bounded by the open item, not elapsed time',
  'tests/drained-fleet-dispatch.test.ts': 'the 2030-01-01T12:00Z observedAt is the clock handed to reclaimableAgent and runCycle',
  'tests/escalation-context.test.ts': 'the 2026-01-01 and 2026-09-2x stamps are ledger and decision fixtures assembleEscalationContext copies verbatim',
  'tests/every-launch-registered.test.ts': 'the 2026-09-01 boundAt is reviewer-binding fixture data nothing ages',
  'tests/evidence-reuse.test.ts': 'the 2000-01-01 attempt expiry is written to force a lapse that stays lapsed',
  'tests/executor-presence-restart.test.ts': 'The 2026-10-05 `at` instants are the clock each replay installs with mock.timers before its first call; stubEngine\'s new Date() stamp runs only inside those replays',
  'tests/executor-release.test.ts': 'the 2026-09-22 claimedAt/since stamps are claim fixtures restartExecutors reports verbatim (any claim refuses, lapsed or not)',
  'tests/executor-supervision.test.ts': 'the 2026-09-21T10:00Z t0 is handed to registry.observe and registry.live as their clock',
  'tests/exhaustion-launch-account.test.ts': 'the 2026-10-09T09:40Z selection entry is a profile-keyed log row nothing ages or prunes (only \'|\' session keys are pruned)',
  'tests/exhaustion-notice.test.ts': 'the 2026-09-26 and 2026-10-03 instants are the fixed now handed to detectRuntimeExhaustion and the resets it parses from notices',
  'tests/failed-launch-pane.test.ts': 'the 2030-01-01T12:00Z observedAt is the clock handed to runCycle, containmentSettlementRefusals and assessContainment',
  'tests/fault-class-configuration.test.ts': 'The 2030-01-01 clock and the iso() offsets from it are handed explicitly as now to ledgerLoopMerger, observe and performSelfUpgrade',
  'tests/fault-class-containment.test.ts': 'the 2026-10-03/05 instance stamps are replayed ledger fixtures judged on Date.parse(entry.observedAt)',
  'tests/fault-class-review-convergence.test.ts': 'the 2026-10-07 request and verdict stamps are judged on handed ticks (tickAt, faultAt, clock)',
  'tests/fault-class-scope.test.ts': 'the 2026-10-01..06 scope-request stamps are ledger fixtures judged on Date.parse(observedAt) handed to cycleFaults, runCycle and workFaults',
  'tests/fault-class-session-liveness.test.ts': 'the 2026-10-08/09 instants are fixed clocks handed to checkInvariants, observeSessions and buildMasterStatus',
  'tests/flow-analytics.test.ts': 'the 2026-09/10 instants are calendar fixtures judged on the `to`, deliveryNow or now each case hands in',
  'tests/github-budget.test.ts': 'the 2026-09-26 instants are the clock handed to github.clock and the charge ledger, plus PR created_at fixtures',
  'tests/github-delivery.test.ts': 'the 2026-10-04T12:30Z now is handed to evaluate, mergeQueueAction and reviewNeed with observations stamped from it',
  'tests/github-http.test.ts': 'the 2026-09-18 suspended_at is installation fixture data preflight reads for truthiness only',
  'tests/github-rate-budget.test.ts': 'The 2026-09-21 item stamps and PR payload dates are past fixtures that evaluate\'s real new Date() only trails, the 2026-10-10 webhook attempts are judged by the now each corroboration case hands in',
  'tests/github.test.ts': 'the 2026-01-01, 2026-09-17 and 2026-10-05 instants are fixture stamps and fixed clocks handed to enforcement and reconcileCheckReruns',
  'tests/goal-acceptance.test.ts': 'the 2026-10-07 daemon clock lies behind every approval the server stamps, so the day-after-approval verdict needs the explicit Date.now() + 25h',
  'tests/goal-pipeline-outright-refusals.test.ts': 'the 2026-10-10T00:00Z daemon clock lies behind every goal stamped with new Date(), so no acceptanceStuckMs bound is crossed',
  'tests/goal-planner.test.ts': 'the 2026-10-07 clock is handed to plannerStep as its now',
  'tests/gy-1050-review-followups.test.ts': 'the 2026-09-30T12:00Z at/now stamp the work, evidence and observation fixtures the GitHub harness reads',
  'tests/gy-1159-review-followups.test.ts': 'the 2026-10-03T12:00Z now is the fixed clock handed to the worker-pane cases',
  'tests/harness-apply-checkout.test.ts': 'the 2026-10-10T18:00Z observedAt is the clock handed to each cycle (now: () => clock, later = clock + 1h)',
  'tests/headless-restart.test.ts': 'the 2030-01-01 records are sessionRetry fixtures judged on the now handed beside them',
  'tests/helpers/review-fleet.ts': 'the 2026-10-01T10:00Z at stamps createdAt, stageEnteredAt and evidence of fixture items',
  'tests/helpers/soak-plane.ts': 'start is the simulated day\'s clock, installed by soakControlPlanes\' before hook; failoverInstalled\'s Date.now() runs inside a soak test, after that hook',
  'tests/human-decisions-ui.test.ts': 'the 2026-09-26 and 2026-10-02 instants are clocks handed to HumanSignIn',
  'tests/install-harness.ts': 'the 2024-01-01 deprecation announcement is Hetzner server-type fixture data the pricing reads for presence only',
  'tests/intervention-feedback.test.ts': 'the 2026-09-01, 2026-10-06 and 2026-10-07 instants are ledger rows and the now handed to foldInterventions, detectPatterns and loopSettledInBound',
  'tests/intervention-pattern-containment-settlement-build.test.ts': 'the Date.UTC(2026, 9, 10, 3, m) rows are a ledger judged on at(30) handed to foldInterventions',
  'tests/intervention-pattern-escalation-build.test.ts': 'the 2026-10-07..09 instants are fixture clocks handed to foldInterventio',
  'tests/intervention-pattern-escalation-ready.test.ts': 'the 2026-10-04..06 lease-loss escalations are judged at after5(escalatio',
  'tests/intervention-rework-rounds.test.ts': 'the 2026-09-24..10-06 fixtures are folded at explicit nows (at(5), 2026-',
  'tests/item-split.test.ts': 'NOW (2026-10-03) is the explicit clock of the unit half; the Postgres ha',
  'tests/landing-guard-ancestry.test.ts': 'the 2026-01-01 direct-merge window (no until) and the 2026-09-26 PR crea',
  'tests/launch-bound.test.ts': '2026-10-06T13:41 is the tick\'s explicit clock (now: () => clock, snapsho',
  'tests/launch-delivery.test.ts': '2026-09-22 and 2026-09-30 are virtual pane clocks the launcher\'s bounds ',
  'tests/launch-prompt-delivery.test.ts': '2026-09-20 is the request clock (sessionRetry, reconcileProducers now: (',
  'tests/launches-off-cycle.test.ts': 'the 2030-01-01 snapshot `now` is the cycle\'s own logic clock (runCycle a',
  'tests/live-scope-widening.test.ts': 'the 2030-01-03 clock is handed to every runCycle (() => at) over a 2030 ',
  'tests/live-throughput.test.ts': 'windows at 2099/2100/2103 are isolation fences so real-clock deliveries ',
  'tests/liveness-invariant.test.ts': 't0 (2026-09-20) drives a virtual clock (now = () => new Date(clock)) han',
  'tests/loop-faults.test.ts': 'slowPlane\'s Date.now() runs under the cycle tests\' mock.timers clock, and the checkout guards\' snapshots hold no work, so the Date.now() stamping their now meets no lease',
  'tests/loop-liveness-namespace.test.ts': 'the 2026-10-06 instants are the explicit `now` of each loopLiveness call',
  'tests/loop-self-upgrade.test.ts': 'the 2030-01-01 clock is passed as now: () => clock to performSelfUpgrade',
  'tests/main-guard.test.ts': '2026-10-05T08:00 is the guard\'s explicit `now` in every runMainGuard/app',
  'tests/managed-worktree-root.test.ts': 'the 2026-09-26 `at` is the explicit clock of the AC-2 memory-hold cycles',
  'tests/master-autonomy.test.ts': 'the 2030-01-01 lease expiry and quarantine instants are judged by buildM',
  'tests/master-browser.test.ts': '2026-09-18T12:00 is the stub flow\'s ticking `now` and the recording page',
  'tests/master-loop-resilience.test.ts': 'the 2026-09-19 at dates the fixture item (createdAt/stageEnteredAt, alre',
  'tests/master-supervision.test.ts': 'the 2026-10-07 upgrade.last.at is a cursor record loopSupervisorEvidence',
  'tests/master-verification.test.ts': 'the 2030-01-01 clock is passed as `now` to assessDeploymentVerification ',
  'tests/master.test.ts': 'every 2030-01-01 instant is judged at a 2030 `now`/observedAt the test p',
  'tests/mechanical-findings.test.ts': 'the 2026-09-30 commit and verdict instants are already past their 60-min',
  'tests/merge-executor-owner.test.ts': 'the 2026-09-20 merge instant is a recorded observation the status only r',
  'tests/merge-queue-removed.test.ts': 'the 2026-10-05 instant is the explicit `now` of evaluate() over a legacy',
  'tests/merger-setting.test.ts': 'the 2026-10-08 `since` is a string mergerDoctorLine only renders; new Da',
  'tests/observation-capacity.test.ts': '2026-10-02T12:00 is the explicit `now` of the fleet fixtures and observa',
  'tests/observation-throughput.test.ts': 'the 2026-09-21 PR created_at is fixture data the observer never compares',
  'tests/one-reviewer-per-request.test.ts': 'the 2026-09-22 review submittedAt instants only order verdicts and alrea',
  'tests/orphan-supervisor.test.ts': 'the 2030-01-01 observedAt is the snapshot `now` and the clock of every r',
  'tests/pacer-reserve.test.ts': 'the 2026-09-26 15:xx reading series is reported against its own `now = at(\'15:28:00\')`; Date.now() only seeds the separate per-token test, whose resets are offsets from it',
  'tests/pi-account-key.test.ts': 'the 2026-09-25/26 instants are past and are the explicit `at` handed, with offsets, to recordRunOutcome, chooseSession and needsSmoke; Date.now() stamps and judges only real-clock records',
  'tests/pi-runner.test.ts': 'the 2030-01-01 strings only stamp a session line and a runRecord\'s startedAt/endedAt, which nothing compares with a clock; Date.now() measures how long the hung process took to stop',
  'tests/pipeline-speed.test.ts': 'the 2026-09-20/21 instants are past claim/merge fixtures judged against an explicit `now` of the same day; Date.now()/new Date() only stamp and judge the DB-backed items the engine creates',
  'tests/pipeline-wait-hotspots.test.ts': 'the 2030-01-01 `clock` is handed explicitly to every loopWakeSubjects call; the real daemon and tick only ever see unleased `waiting()` items, and Date.now() measures sleep/wake latency',
  'tests/post-merge-review.test.ts': 'the 2026-10-08 `at` fixtures are already past, so a delivery, launch or expiry stamped with them reads the same on any later day; Date.now()/new Date() only stamp the live-API launch and its filing',
  'tests/producer-environment.test.ts': 'the 2026-10-02 `clock` is the explicit tick clock handed to runDispatchTick and its snapshot; new Date() only stamps request/observation records that no clock compares to it',
  'tests/project-memory-followups.test.ts': 'the 2026-10-01 `at` values only order fixture decisions, pitfalls and merges, and the 2026-10-03 `now` is handed explicitly to checkAgentEnvironment; Date.now() stamps other fixtures on the real clock',
  'tests/project-memory.test.ts': 'the 2026-10-02 instants are memory/answer timestamps that updateProjectMemoryFromWork only sorts; its 24 h merge window runs on Date.now() against mergedAt values also derived from Date.now()',
  'tests/ready-scope-widening.test.ts': 'the 2026-10-06 `at` values stamp exhaustion fixtures and feed foldInterventions as its explicit clock; new Date() is only the clock for DB-backed ledger rows the engine stamped itself',
  'tests/recovery.test.ts': 'the 2000-01-01 expiresAt forces an attempt lapse that stays lapsed, and 2026-09-18 is the injected SigV4 signing clock; Date.now() builds deadlines and snapshot instants on the real clock only',
  'tests/registry-discovery.test.ts': 'the 2030-01-01 `clock0` drives runCycle and the snapshot through `() => at.value`, so the master-session cycles never read the real clock; Date.now() only stamps discovered credentials\' expiry',
  'tests/release-candidate.test.ts': 'the 2026-10-01 instants are explicit `now` arguments to cut/promote/validate, already more than the 4 h UAT window in the past, so deployToUat\'s default new Date() never reads them as pending',
  'tests/resource-observation.test.ts': '2026-09-23 and 2026-10-07 are explicit clocks handed to reconcile/claim/settle, reclaimResources and readResources; Date.now() only stamps records and clocks the live-ledger tests on the real clock',
  'tests/resource-reading-instants.test.ts': 'the 2026-10-08 snapshot, session and reflog instants are replayed against the explicit `now`/`clock` of the same snapshot; the one Date.now() case builds its own relative start and reflog',
  'tests/retro-synthesis.test.ts': 'the 2026-09-30 signals are judged against `now = at(0)` handed explicitly to detectRecurringCauses and stamped into events; Date.now() only bounds the test\'s own waits and stamps failures',
  'tests/revert-recheck.test.ts': 'the 2026-09-20/21 instants are past PR, review and landing timestamps plus the fixed status `now`; evaluate\'s new Date() only judges gates of items whose timestamps all lie behind it',
  'tests/review-convergence-recurrence.test.ts': 'the 2026-10-03 verdict, window and fault instants are replayed as explicit clocks to reconcileAutoDispatch, reconcileReviewConflict and launchReview; new Date() only stamps items and mint expiry',
  'tests/review-followups.test.ts': '2026-09-24 verdict/thread instants are ordered only against each other; 2026-09-30 stamps pendingFollowUps on items that are not machine-filed, so overdueTriage never ages them; Date.now() stamps the rest',
  'tests/review-ledger-cap.test.ts': 'the 2026-09-23 `at()` ledger instants are past, so those records already read settled or expired on the real clock and stay so; records that must be live get tokenExpiresAt from Date.now()',
  'tests/review-ledger-lock.test.ts': 'the 2026-10-05 submittedAt is a past verdict literal that reconcile records without comparing it to a clock; the gh stub\'s submitted_at and the item timestamps come from Date.now()',
  'tests/review-provider.test.ts': 'the 2026-01-01 request/verdict instants are judged against `now = 2026-01-01T00:06Z` handed explicitly to observeAgentReview; new Date() only stamps work() items and clocks their gate evaluation',
  'tests/review-rounds.test.ts': 'the 2026-09-24 instants stamp settled prior rounds and the reviewer binding, which the round logic orders by head rather than by clock; new Date() stamps the live item and the launch observedAt',
  'tests/review-thread-resolution.test.ts': 'the 2026-09-23/24 instants stamp threads, verdicts and legacy records that the resolution judges by listing and mutual order, never against a clock; Date.now()/new Date() stamp live items and mint expiry',
  'tests/reviewer.test.ts': 'the 2026-09-23 thread createdAt and 2026-09-18 submittedAt are parsed fixture fields passed through unchanged; the real clock only bounds observation age and token expiry via offsets from Date.now()',
  'tests/rework-interventions.test.ts': '2026-10-05 only bounds recorded requestedAt strings and 2026-10-12 is the explicit `now` handed to detectPatterns; new Date() clocks the DB-backed fold whose rows the engine stamped itself',
  'tests/role-concurrency.test.ts': 'the 2026-09-21 `clock` is handed explicitly to roleConcurrency and to the requested() fixtures of that test; the other tests stamp items, verdicts and mint expiry from the real clock alone',
  'tests/runner-attestor.test.ts': 'the 2026-09-16 interval is a forged startedAt/finishedAt the attestation must reject whatever the date; the grant deadline is Date.now()+10 min on the real clock',
  'tests/runner-executor.test.ts': 'the 2026-09-16 clock is handed explicitly to executeAttempt and lies before the Date.now()+10 min grant deadline on any day; the expiry case uses a Date.now()-1 s deadline instead',
  'tests/runtime-limit-menu.test.ts': 'the 2026-10-09 `now` is explicit and the Oct 10/12 resets carry no year, so parseResetTime rolls them forward past any real Date.now(); the integration cycle clocks from Date.now()+skew',
  'tests/runtime-screens.test.ts': 'the 2026-09-25 `clock` is the ScreenPane\'s virtual start clock, advanced only by wait() and handed via bounds(); Date.now()/new Date() stamp the credential expiry and the dispatch observedAt',
  'tests/scope-approver-routine.test.ts': 'the 2031-03-01 instants are judged only by the pure scopeRoutineDecision against its explicit `now` of the same minute; Date.now() clocks the DB-backed items the engine stamped itself',
  'tests/scope-directory-collapse.test.ts': 'the 2031-03-01 lease and refusal instants meet only the explicit now Date.parse(\'2031-03-01T10:00:00Z\') given ',
  'tests/scope-request-carry.test.ts': 'the 2026-10-07 start is past and handed explicitly to scopeRequestOutcome (Date.now is mocked to it for the wa',
  'tests/scope-request-new-file.test.ts': 'the 2031-03-01 lease and refusal instants meet only the explicit now Date.parse(\'2031-03-01T10:00:00Z\') given ',
  'tests/session-cwd.test.ts': 'the 2030-01-01 iso() instants are judged against the stub snapshot\'s own now iso(0) (lease expiry, fault ages,',
  'tests/session-liveness-launch-window.test.ts': 'the 2026-10-05 instants are past and every judgement of them takes that test\'s explicit clock; the Date.now()-',
  'tests/session-liveness-model.test.ts': 'the 2026-09-24 and 2026-10-08 fixture instants are past and handed explicitly as now to observeSessions/sessio',
  'tests/session-liveness.test.ts': 'boundAt 2026-09-01 is config fixture and the 2026-09-21 instants are explicit past now/at arguments; the Date.',
  'tests/session-reconcile.test.ts': 'the 2026-09-23 request instants are past and judged only against the explicit now Date.parse(\'2026-09-23T07:36',
  'tests/soak-approver-idle-stall.test.ts': 'item() stamps its work with new Date() only inside the soak test, after mock.timers installed the 2026-10-09 clock',
  'tests/soak-approver-pane-rebind.test.ts': 'item() stamps its work with new Date() only inside the soak tests, after mock.timers installed the 2026-10-09 clock',
  'tests/soak-checkout-restore.test.ts': 'the 2030-01-01 simulated clock is the loop\'s injected now and every request/journal instant derives from it; D',
  'tests/speed-metric.test.ts': 'the 2026-10-07 delivery and timeline fixtures are measured against the explicit now constant; pipelineSpeedSum',
  'tests/stale-rework-requests.test.ts': 'the 2030-01-01 clock is the loop\'s injected now beside the snapshot\'s now iso(0); the Date.now()-based pause t',
  'tests/stalled-actions.test.ts': 'the 2026-09-21 clock is passed explicitly to claim/settle/reconcile; the 2026-01-01 window and 2026-02-01 merg',
  'tests/stalled-gate-faults.test.ts': 'the 2026-10-01/02 instants are past fixture ats whose stall reading (actionStall) reads row history, not the c',
  'tests/status-conflict-probe-bounded.test.ts': 'the 2030-01-01 stamps are work/cache fixture fields and the explicit status now; nothing dates them against th',
  'tests/submit-head.test.ts': 'the 2026-10-08 observation at and the 12:30 evaluate now are past and handed explicitly to observeHead/evaluat',
  'tests/sudo-form-capture.test.ts': 'the 2026-10-07 tick clock is handed explicitly as now to the browser flow; Date.now() only fakes a form timest',
  'tests/supervised-local.test.ts': 'boundAt and the 2026-10-08 fixture instants are past and handed explicitly as seen/now to the registry, evalua',
  'tests/system.test.ts': 'Every 2000-01-01 expiry is written to force a lease, evidence or observation lapse that stays lapsed on any later day; the 2099 Date proxy serves one test\'s clock-skew check',
  'tests/test-case-repository.test.ts': 'artifact createdAt 2026-09-01 is provenance fixture nothing dates against the clock; new Date()/Date.now() sta',
  'tests/test-isolation.test.ts': 'the 2026-09-24 pause resets are judged against the injected now () => clock of that test; the live command\'s r',
  'tests/throughput-admission.test.ts': 'the 2026-10-07 base and the 2026-09-28 GY-468 span are past and every measurement takes an explicit now or clo',
  'tests/throughput-owner-standing.test.ts': 'the 2026-10-07 base is past and every measurement takes an explicit now/clock; the Date.now() cycles drive a s',
  'tests/timeline-backfill.test.ts': 'the 2026-09-01 attempt instants are pure mergeTimeline inputs no clock judges; Date.now() stamps live DB deliv',
  'tests/timing-baseline-companion.test.ts': 'the 2026-09-30 and 2026-10-04 scope-request ats are past refusal fixtures judged on plannedFiles, not the cloc',
  'tests/trial-merge.test.ts': 'the 2030-03-01 start is both the loop\'s injected now and its snapshot\'s now, so the fixture\'s stamps are judge',
  'tests/unattended-cycle.test.ts': 'the 2031-03-01 clockStart is the loop\'s injected now and every verdict/lease instant and loopLiveness call tak',
  'tests/unresolved-threads.test.ts': 'the 2026-09-23/24 instants are past PR fixtures and explicit now values for evaluate/routineDecision; the new ',
  'tests/upgrade-slot-restart.test.ts': 'the 2026-10-07 now is past and handed explicitly to the registry, report and snapshot; slot down time is measu',
  'tests/validation.test.ts': 'the 2000-01-01 expiresAt/deadline/expires_at writes are past and only force an already-lapsed expiry; Date.now',
  'tests/worker-push-credential.test.ts': 'the 2030-01-01 clock is the loop\'s injected now and the snapshot\'s now iso(0), so held() leases are judged aga',
  'tests/zero-touch-onboarding.test.ts': 'the 2026-10-07 clock is the scenario\'s injected now and advances only by its own sleeps; new Date() only stamp',
};
