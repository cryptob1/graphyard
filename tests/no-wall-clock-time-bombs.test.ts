import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1694: tests/shared-identity-followups.test.ts held an account until 2026-10-11T05:00Z, a reset
// written as Date.UTC(2026, 9, 11, 5), and judged the hold with Date.now() in its fake control plane
// and in the roles under test. From 05:00Z every required CI run failed on a test nobody touched.
// Such a test is a time bomb: an absolute calendar instant still ahead of the clock (its fuse) that
// the test also reads the wall clock against, in a scope that never stubs Date. This file finds them.
//
// The rule, per scope — the module, or one top-level test body together with the module:
//   1. the scope constructs an absolute calendar instant: Date.UTC(YYYY, …), new Date('YYYY-…') or
//      Date.parse('YYYY-…') (an ISO date literal becomes an instant where it is parsed);
//   2. that instant lies ahead of the clock the lint runs on — an instant already past cannot cross
//      the clock again, so the verdict it took part in is settled (it fails now, as GY-1694 did, or it
//      holds for good) — and it is not the clock the test hands to the code under test: an instant
//      passed as an argument, as a `now`/`clock` property or as a thunk is the sanctioned fixed clock
//      of docs-less tests, not data the real clock is measured against;
//   3. the scope also reads the wall clock to judge: Date.now() or new Date() other than an immediate
//      ISO stamp, an elapsed-time measurement or a Math.ceil(Date.now() / 1000) header;
//   4. and neither the scope nor the module stubs Date (clock.install, mock.timers.enable or an
//      assignment to globalThis.Date).
// An allowance names a fixture that itself documents, in a comment, why its absolute date is safe;
// an allowance for a file without that comment, or for a file that no longer trips the rule, fails.

const self = relative(process.cwd(), fileURLToPath(import.meta.url)).split('\\').join('/');
/** Files allowed to keep a future instant beside a wall-clock reading, each by the comment the fixture documents its safety with. */
export const allowances: Record<string, string> = {};

const instant = /Date\.UTC\(\s*((?:19|20)\d\d)(?:\s*,\s*(\d{1,2}))?(?:\s*,\s*(\d{1,2}))?(?:\s*,\s*(\d{1,2}))?|new Date\(\s*['"`]((?:19|20)\d\d-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z?)?)|Date\.parse\(\s*['"`]((?:19|20)\d\d-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z?)?)/;
const wallClock = /\bDate\.now\(\)|new Date\(\s*\)/;
const notJudging = /new Date\(\s*(?:\)|Date\.now\(\)[^()]*\))\.toISOString\(\)|Math\.(?:ceil|floor|round)\(\s*Date\.now\(\)|(?:const|let)\s+(?:started|start|before|began|t0|deadline)\s*=\s*Date\.now\(\)|Date\.now\(\)\s*-\s*(?:started|start|before|began|t0)\b|Date\.now\(\)\s*>=?\s*deadline/g;
const stubsDate = /\bclock\.install\(|\bmock\.timers\.enable\(|\b(?:globalThis|global)\.Date\s*=[^=]/;
const opensTest = /^(?:test|describe|it|suite)(?:\.\w+)?\(/, closesTest = /^\}\)?;?\s*$/;
const declares = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)|,\s*([A-Za-z_$][\w$]*)\s*=[^=>]/g;
const asClock = /(?:^|[^\w$])(?:now|clock)\s*:\s*$|[(,]\s*(?:\(\)\s*=>\s*)?$/, wrapper = /new Date\(\s*$/;

/** The code of a line: nothing for a comment line, and a trailing `// …` dropped. */
const code = (line: string) => { const text = line.trimStart(); return text.startsWith('//') || text.startsWith('*') || text.startsWith('/*') ? '' : line.replace(/\s\/\/\s.*$/, ''); };
/** The instant a match constructs, in ms since the epoch. */
const instantOf = (match: RegExpExecArray) => match[1] ? Date.UTC(Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 1), Number(match[4] ?? 0)) : Date.parse(/T/.test(match[5] ?? match[6]) ? (match[5] ?? match[6]).replace(/Z?$/, 'Z') : `${match[5] ?? match[6]}T00:00:00Z`);
/** Whether `name` is handed to the code under test as its clock somewhere in `text`: an argument, a `now`/`clock` property or a thunk. */
const handedAsClock = (name: string, text: string) => new RegExp(`[(,]\\s*(?:\\(\\)\\s*=>\\s*)?${name}\\s*[,)+-]|=>\\s*${name}\\s*(?:[,;)\\]}]|$)|\\b(?:now|clock)\\s*:\\s*(?:\\(\\)\\s*=>\\s*)?${name}\\b`, 'm').test(text);

/**
 * The names a scope derives its clock from `names` under, transitively: `let clock = start`, `const now = () => clock`,
 * `const end = start + 2 * day`. A declaration that embeds a name in an object literal or a call (`{ until: resetsAt }`,
 * `new Date(start + offset).toISOString()`) is data built from the instant, not the clock, and is not followed.
 */
function clockNames(names: readonly string[], lines: readonly { text: string }[]): string[] {
  const bound = new Set(names);
  for (let pass = 0; pass < 4; pass++) for (const { text } of lines) {
    if (!/^\s*(?:export\s+)?(?:const|let|var)\s/.test(text)) continue;
    for (const declaration of text.split(/[,;](?![^(]*\))/)) {
      const equals = declaration.indexOf('='); if (equals < 0) continue;
      const name = /([A-Za-z_$][\w$]*)\s*$/.exec(declaration.slice(0, equals))?.[1], value = declaration.slice(equals + 1).trim();
      if (name && [...bound].some(source => new RegExp(`^(?:\\(\\)\\s*=>\\s*)?${source}(?:\\s*[+-][^{}()]*)?$`).test(value))) bound.add(name);
    }
  }
  return [...bound];
}

interface Scope { name: string; lines: { number: number; text: string }[]; stubbed: boolean }
export interface TimeBomb { file: string; instant: number; wallClock: number; at: string; scope: string }

function scopesOf(source: string): Scope[] {
  const module: Scope = { name: 'module scope', lines: [], stubbed: false }, scopes = [module];
  let current: Scope | null = null;
  source.split('\n').forEach((raw, index) => {
    if (opensTest.test(raw)) { current = { name: raw.trim().slice(0, 72), lines: [], stubbed: false }; scopes.push(current); }
    const scope = current ?? module, text = code(raw);
    scope.lines.push({ number: index + 1, text });
    if (stubsDate.test(text)) scope.stubbed = true;
    if (current && closesTest.test(raw)) current = null;
  });
  return scopes;
}

/** The time bombs in one file's source, judged against the clock `now`. */
export function timeBombsIn(file: string, source: string, now: number): TimeBomb[] {
  const [module, ...tests] = scopesOf(source), bombs: TimeBomb[] = [], whole = source.split('\n').map(code).join('\n');
  for (const scope of [module, ...tests]) {
    if (scope.stubbed || module.stubbed) continue;
    const lines = scope === module ? module.lines : [...module.lines, ...scope.lines];
    const judging = lines.filter(line => wallClock.test(line.text.replace(notJudging, 'SAFE')));
    if (!judging.length) continue;
    for (const line of lines) {
      const match = instant.exec(line.text);
      if (!match) continue;
      const at = instantOf(match);
      if (!(at > now)) continue;
      // A module-scope binding any test hands to the code under test is the file's fixed clock; a test's own binding counts within that test.
      const names = [...line.text.matchAll(declares)].map(entry => entry[1] ?? entry[2]), text = module.lines.includes(line) ? whole : lines.map(entry => entry.text).join('\n');
      if (asClock.test(line.text.slice(0, match.index).replace(wrapper, '')) || clockNames(names, lines).some(name => handedAsClock(name, text))) continue;
      bombs.push({ file, instant: line.number, wallClock: judging[0].number, at: new Date(at).toISOString(), scope: scope.name });
    }
  }
  return bombs;
}

async function* sources(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sources(path); else if (/\.(?:ts|mts|mjs|js)$/.test(entry.name)) yield path;
  }
}

/** Every time bomb under `root`, judged at `now`, and the allowances that do not hold. */
export async function timeBombs(root: string, now: number, allowed: Record<string, string> = allowances) {
  const bombs: TimeBomb[] = [], refused: string[] = [];
  for await (const path of sources(root)) {
    const file = relative(process.cwd(), path).split('\\').join('/');
    if (file === self) continue;
    const source = await readFile(path, 'utf8'), found = timeBombsIn(file, source, now);
    if (!(file in allowed)) { bombs.push(...found); continue; }
    if (!found.length) refused.push(`${file}: allowed, but trips the rule no more; drop its allowance`);
    else if (!source.split('\n').some(line => /^\s*(?:\/\/|\*)/.test(line) && line.includes(allowed[file]))) refused.push(`${file}: allowed, but no comment in it documents why its absolute date is safe ("${allowed[file]}")`);
  }
  return { bombs, refused };
}

export const describeBomb = (bomb: TimeBomb) => `${bomb.file}:${bomb.instant} constructs ${bomb.at}, ahead of the clock, and ${bomb.file}:${bomb.wallClock} reads the wall clock to judge in the same scope (${bomb.scope}); derive the instant from the test's fixed now, hand that now to the code under test, or stub Date for the file`;

test('unit:no-wall-clock-time-bombs — no test under tests/ holds an absolute calendar instant still ahead of the clock against Date.now() or new Date() without stubbing Date', async () => {
  const { bombs, refused } = await timeBombs(join(process.cwd(), 'tests'), Date.now());
  assert.deepEqual(bombs.map(describeBomb), [], 'time bombs: each names the instant and the wall-clock reading');
  assert.deepEqual(refused, [], 'every allowance names a fixture that still trips the rule and documents why its date is safe');
});

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
async function fixtures(name: string, files: Record<string, string>) {
  const root = await temporaryDirectory(`time-bombs-${name}`); directories.push(root);
  for (const [path, text] of Object.entries(files)) { await mkdir(join(root, dirname(path)), { recursive: true }); await writeFile(join(root, path), text); }
  return { root, run: (now: number, allowed: Record<string, string> = {}) => timeBombs(join(root, 'tests'), now, allowed), file: (path: string) => relative(process.cwd(), join(root, path)).split('\\').join('/') };
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
const day = 86_400_000, fuse = Date.UTC(2026, 9, 11, 5);

test('unit:no-wall-clock-time-bombs — GY-1694\'s file is named with both lines while its reset is ahead of the clock, and settles once the reset has passed', async () => {
  const { run, file } = await fixtures('gy-1694', { 'tests/followups.test.ts': gy1694 });
  const before = await run(fuse - 2 * day);
  assert.deepEqual(before.bombs.map(bomb => [bomb.file, bomb.instant, bomb.wallClock, bomb.at]), [[file('tests/followups.test.ts'), 3, 7, '2026-10-11T05:00:00.000Z']], 'the reset line and the judging Date.now() line');
  assert.match(describeBomb(before.bombs[0]), /followups\.test\.ts:3 constructs 2026-10-11T05:00:00\.000Z, ahead of the clock, and .*followups\.test\.ts:7 reads the wall clock/);
  assert.equal((await run(fuse - 1)).bombs.length, 1, 'armed until the instant itself');
  assert.deepEqual((await run(fuse)).bombs, [], 'an instant the clock has reached cannot cross it again: the verdict is settled, and visible if it fails');
  assert.deepEqual((await run(fuse - 2 * day)).refused, []);
});

test('unit:no-wall-clock-time-bombs — a stubbed Date, a reset derived from the fixed now, or the instant handed to the code under test as its clock is no time bomb', async () => {
  const stubbed = gy1694.replace(`const spent =`, `clock.install(now);\nconst spent =`);
  const derived = gy1694.replace(`new Date(Date.UTC(2026, 9, 11, 5))`, `new Date(now + 47 * hour + 28 * minute + 32_000)`);
  const perTest = gy1694.replace(`test('unit:role-selection', async () => {`, `test('unit:role-selection', async () => {\n  mock.timers.enable({ apis: ['Date'], now });`);
  const handed = sourceLines(
    `import { test } from 'node:test';`,
    `const clock = Date.parse('2030-01-01T00:00:00Z');`,
    `test('unit:fixed-clock', async () => {`,
    `  const started = Date.now();`,
    `  const now = new Date();`,
    `  assert.equal(nextAction(work, [work], clock), null);`,
    `  assert.ok(Date.now() - started < 5_000);`,
    `});`,
    `test('unit:inline-clock', async () => {`,
    `  const cutAt = new Date().toISOString();`,
    `  const result = cut(repo, { now: new Date('2030-06-01T12:00:00Z'), push: true });`,
    `  const report = executorReport([], registry, new Date());`,
    `});`);
  // A soak's clock: the instant bound to `start`, the clock and its thunk derived from it and handed to the loop, the watchdog timed on the wall clock apart.
  const derivedClock = sourceLines(
    `import { test } from 'node:test';`,
    `function effects(now: () => number, notifications: { at: number }[]) { return { notify: () => notifications.push({ at: Date.now() }), snapshot: async () => ({ now: new Date(now()).toISOString() }) }; }`,
    `test('unit:soak', async () => {`,
    `  const start = Date.parse('2030-01-01T00:00:00Z');`,
    `  let clock = start;`,
    `  const now = () => clock;`,
    `  const end = start + 2 * day;`,
    `  while (clock < end) { await runCycle(config, state, effects(now, notifications), now); clock += minute; }`,
    `});`);
  const stamps = sourceLines(
    `import { test } from 'node:test';`,
    `const expiresAt = new Date(Date.UTC(2031, 0, 1)).toISOString();`,
    `test('unit:stamps-only', async () => {`,
    `  const row = { createdAt: new Date().toISOString(), updatedAt: new Date(Date.now() - 60_000).toISOString(), reset: Math.ceil(Date.now() / 1000) + 3000, expiresAt };`,
    `});`);
  const { run } = await fixtures('safe', { 'tests/stubbed.test.ts': stubbed, 'tests/derived.test.ts': derived, 'tests/per-test.test.ts': perTest, 'tests/handed.test.ts': handed, 'tests/derived-clock.test.ts': derivedClock, 'tests/stamps.test.ts': stamps });
  assert.deepEqual((await run(fuse - 2 * day)).bombs.map(describeBomb), []);
});

test('unit:no-wall-clock-time-bombs — an instant in another test\'s body is that test\'s alone, a module-scope instant reaches every test, and helpers under tests/ are scanned', async () => {
  const separate = sourceLines(
    `import { test } from 'node:test';`,
    `test('unit:fixed', () => { const until = new Date('2030-01-01T00:00:00Z'); assert.equal(judge(work, until), 'held'); });`,
    `test('unit:live', () => { assert.equal(judge(work, new Date()), 'free'); });`);
  const shared = sourceLines(
    `import { test } from 'node:test';`,
    `const until = new Date('2030-01-01T00:00:00Z').toISOString();`,
    `test('unit:fixed', () => { assert.equal(judge({ ...work, until }, Date.parse('2029-01-01T00:00:00Z')), 'held'); });`,
    `test('unit:live', () => { assert.equal(judge({ ...work, until }, Date.now()), 'held'); });`);
  const helper = sourceLines(
    `export const expiresAt = Date.UTC(2031, 5, 2);`,
    `export const fresh = () => expiresAt > Date.now();`);
  const { run, file } = await fixtures('scopes', { 'tests/separate.test.ts': separate, 'tests/shared.test.ts': shared, 'tests/helpers/world.ts': helper });
  const { bombs } = await run(fuse);
  assert.deepEqual(bombs.map(bomb => [bomb.file, bomb.instant, bomb.wallClock, bomb.scope]), [
    [file('tests/helpers/world.ts'), 1, 2, 'module scope'],
    [file('tests/shared.test.ts'), 2, 4, `test('unit:live', () => { assert.equal(judge({ ...work, until }, Date.now()), 'held'); });`.slice(0, 72)],
  ]);
});

test('unit:no-wall-clock-time-bombs — an allowance holds only for a fixture that documents why its absolute date is safe and still trips the rule', async () => {
  const documented = sourceLines(
    `// The recorded reset of 2031-06-02 is the fixture's own: nothing here compares it with the clock, the loop under test reads clock.now().`,
    `export const resetsAt = new Date('2031-06-02T08:00:00Z').toISOString();`,
    `export const observedAt = () => new Date();`);
  const undocumented = documented.split('\n').slice(1).join('\n');
  const settled = documented.replace('2031-06-02T08:00:00Z', '2020-06-02T08:00:00Z');
  const { run, file } = await fixtures('allowances', { 'tests/fixtures/documented.ts': documented, 'tests/fixtures/undocumented.ts': undocumented, 'tests/fixtures/settled.ts': settled });
  const why = 'nothing here compares it with the clock';
  const all = await run(fuse);
  assert.deepEqual(all.bombs.map(bomb => bomb.file), [file('tests/fixtures/documented.ts'), file('tests/fixtures/undocumented.ts')], 'without allowances both future fixtures are bombs; the settled one is not');
  const allowed = await run(fuse, { [file('tests/fixtures/documented.ts')]: why, [file('tests/fixtures/undocumented.ts')]: why, [file('tests/fixtures/settled.ts')]: why });
  assert.deepEqual(allowed.bombs, [], 'an allowed file is not reported as a bomb');
  assert.deepEqual(allowed.refused, [
    `${file('tests/fixtures/settled.ts')}: allowed, but trips the rule no more; drop its allowance`,
    `${file('tests/fixtures/undocumented.ts')}: allowed, but no comment in it documents why its absolute date is safe ("${why}")`,
  ].sort(), 'an allowance without its documentation, or for a settled file, is refused');
  assert.deepEqual(Object.keys(allowances), [], 'this head needs no allowance');
});
