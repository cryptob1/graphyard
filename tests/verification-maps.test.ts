import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { docsWords } from '../src/model/documentation.js';
import { documentationGlobMatches } from '../src/model/documentation-glob.js';
import {
  parseVerificationMap, readVerificationMaps, selectVerificationMaps, verificationDigestWordBudget, verificationMapDigest, verificationMapWordLimit, type VerificationMap,
} from '../src/verification-maps.js';
import { workerPrompt } from '../src/master/dispatch.js';
import { reviewPrompt } from '../src/reviewer.js';
import { emptyProjectMemory, projectMemoryDigest, recordDecisionInMemory } from '../src/model/project-memory.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const checkedIn = readdirSync(join(root, 'verification')).filter(name => name.endsWith('.md')).map(name => `verification/${name}`);

test('unit:verification-maps-true — store, server and master maps each open with Paths:, hold the four sections, stay within 250 words, and name only globs and tests/ paths the tree holds', () => {
  for (const area of ['store', 'server', 'master']) assert.ok(checkedIn.includes(`verification/${area}.md`), `verification/${area}.md is checked in`);
  for (const path of checkedIn) {
    const text = readFileSync(join(root, path), 'utf8');
    assert.match(text.split('\n')[0], /^Paths: \S/, `${path} opens with a Paths: line`);
    const map = parseVerificationMap(path, text);
    assert.ok(map, `${path} parses with Tests, Drive, Invariants and Gotchas sections`);
    assert.ok(docsWords(text) <= verificationMapWordLimit, `${path} has ${docsWords(text)} words; the limit is ${verificationMapWordLimit}`);
    for (const glob of map.paths) assert.ok(tracked.some(file => documentationGlobMatches(glob, file)), `${path}: glob ${glob} matches no file on the tree`);
    const named = [...text.matchAll(/\btests\/[\w./-]*\w/g)].map(match => match[0]);
    assert.ok(named.length, `${path} names the tests that guard its area`);
    for (const file of named) assert.ok(existsSync(join(root, file)), `${path} names ${file}, which does not exist`);
  }
});

const map = (path: string, paths: string[], words = 5): VerificationMap => ({
  path, paths,
  sections: { Tests: `${path}-tests ${'t '.repeat(words)}`.trim(), Drive: `${path}-drive`, Invariants: `${path}-invariants`, Gotchas: `${path}-gotchas` },
});

test('unit:verification-map-selection — maps are selected by plannedFiles globs, directory scopes match globs beneath them, and the role digest is bounded to 3 whole maps and 600 words', () => {
  const store = map('verification/store.md', ['src/store/**']), server = map('verification/server.md', ['src/server/**', 'src/server.ts']), master = map('verification/master.md', ['src/master/**']);
  assert.deepEqual(selectVerificationMaps([store, server, master], ['src/store/locks.ts']).map(entry => entry.path), ['verification/store.md']);
  assert.deepEqual(selectVerificationMaps([store, server, master], ['src/store/']).map(entry => entry.path), ['verification/store.md'], 'a directory scope matches a glob beneath it');
  assert.deepEqual(selectVerificationMaps([map('verification/tables.md', ['src/store/tables/*.ts'])], ['src/store/']).length, 1);
  assert.deepEqual(selectVerificationMaps([store, server, master], ['src/server.ts', 'src/server/auth.ts', 'src/store/locks.ts']).map(entry => entry.path), ['verification/server.md', 'verification/store.md'], 'most-touched first');
  assert.deepEqual(selectVerificationMaps([store, server, master], ['web/main.tsx', 'docs/']), []);

  const worker = verificationMapDigest([store], ['src/store/locks.ts'], 'worker');
  for (const section of ['Tests:', 'Drive:', 'Invariants:', 'Gotchas:']) assert.ok(worker.includes(section), `worker gets ${section}`);
  const reviewer = verificationMapDigest([store], ['src/store/locks.ts'], 'reviewer');
  assert.ok(reviewer.includes('Invariants: verification/store.md-invariants') && reviewer.includes('Gotchas: verification/store.md-gotchas'));
  assert.ok(!reviewer.includes('Tests:') && !reviewer.includes('Drive:'), 'reviewer gets Invariants and Gotchas only');
  assert.equal(verificationMapDigest([store], ['web/main.tsx'], 'worker'), '');

  // Four touched maps: three are inlined whole, the fourth is named by path.
  const four = ['a', 'b', 'c', 'd'].map(name => map(`verification/${name}.md`, [`src/${name}/**`]));
  const capped = verificationMapDigest(four, four.map((_, i) => `src/${'abcd'[i]}/x.ts`), 'worker');
  for (const name of ['a', 'b', 'c']) assert.ok(capped.includes(`verification/${name}.md-gotchas`));
  assert.ok(!capped.includes('verification/d.md-tests') && /not inlined[^]*verification\/d\.md/.test(capped));

  // Over 600 words: a map that does not fit is named, never cut mid-section.
  const large = ['a', 'b', 'c'].map(name => map(`verification/${name}.md`, [`src/${name}/**`], 240));
  const bounded = verificationMapDigest(large, ['src/a/x.ts', 'src/b/x.ts', 'src/c/x.ts'], 'worker');
  assert.ok(docsWords(bounded) <= verificationDigestWordBudget, `${docsWords(bounded)} words`);
  assert.ok(bounded.includes('verification/a.md-gotchas') && bounded.includes('verification/b.md-gotchas'));
  assert.ok(!bounded.includes('verification/c.md-tests') && /not inlined[^]*verification\/c\.md/.test(bounded), 'the map that did not fit is named by path');
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const sample = (paths: string) => `Paths: ${paths}\n\n## Tests\n\n- tests/x.test.ts\n\n## Drive\n\nrun it\n\n## Invariants\n\nhold it\n\n## Gotchas\n\nmind it\n`;

test('unit:verification-maps-read-from-base — maps are read from origin/BASE with ls-tree and show, never the working tree; a malformed map or an unreadable base yields no section', async () => {
  const repo = await temporaryDirectory('verification-maps');
  git(repo, 'init', '--quiet', '-b', 'main');
  await mkdir(join(repo, 'verification', 'nested'), { recursive: true });
  await writeFile(join(repo, 'verification', 'store.md'), sample('src/store/**'));
  await writeFile(join(repo, 'verification', 'broken.md'), 'no paths line\n## Tests\nx\n');
  await writeFile(join(repo, 'verification', 'nested', 'deep.md'), sample('src/deep/**'));
  git(repo, 'add', '-A'); git(repo, 'commit', '--quiet', '-m', 'maps');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  // The working tree moves on; only the base is read.
  await writeFile(join(repo, 'verification', 'store.md'), sample('src/elsewhere/**'));
  await writeFile(join(repo, 'verification', 'local.md'), sample('src/local/**'));

  const calls: string[][] = [];
  const run = (command: string, args: string[], options?: { cwd?: string }) => { calls.push([command, ...args]); return execFileSync(command, args, { cwd: options?.cwd, encoding: 'utf8' }); };
  const maps = await readVerificationMaps(repo, 'main', run);
  assert.deepEqual(maps.map(entry => [entry.path, entry.paths]), [['verification/store.md', ['src/store/**']]], 'the malformed and nested maps are left out');
  assert.ok(calls.every(([command, sub]) => command === 'git' && (sub === 'ls-tree' || sub === 'show')));
  assert.ok(calls.some(call => call.includes('refs/remotes/origin/main:verification/store.md')));

  assert.deepEqual(await readVerificationMaps(repo, 'missing'), [], 'an unreadable base reads as no maps');
  assert.deepEqual(await readVerificationMaps(repo, 'main', () => { throw new Error('git failed'); }), []);
  assert.equal(parseVerificationMap('verification/x.md', sample('src/x/**').replace('## Drive\n\nrun it\n\n', '')), null, 'a map missing a section is malformed');
  assert.equal(parseVerificationMap('verification/x.md', `# Title\n${sample('src/x/**')}`), null, 'a map not opening with Paths: is malformed');
});

test('unit:verification-maps-in-prompts — worker and reviewer requests inline the digest right after the project-memory digest; an item no map matches gets a byte-identical request', () => {
  const maps = [parseVerificationMap('verification/store.md', sample('src/store/**'))!];
  const config = { cliPath: '/bin/graphyard.mjs' }, profile = { principal: 'graphyard-claude-2' };
  const work = { key: 'GY-1495', title: 'Maps', plannedFiles: ['src/store/locks.ts'] };
  const before = workerPrompt(config, work, profile, 1, null, null, 'a'.repeat(40), null);
  const withMaps = workerPrompt(config, work, profile, 1, null, null, 'a'.repeat(40), null, maps);
  const digest = verificationMapDigest(maps, work.plannedFiles, 'worker');
  assert.ok(digest && withMaps.includes(digest));
  assert.equal(withMaps.replace(digest, ''), before);
  const memory = emptyProjectMemory('2026-10-07T00:00:00Z');
  recordDecisionInMemory(memory, { id: 'd', key: 'GY-1', action: 'scope', reason: 'Widen to src/a.ts', state: 'applied', approvedBy: 'approver-1', at: '2026-10-07T00:00:00Z' });
  const memoryDigest = projectMemoryDigest(memory, 'worker', { baseSha: 'a'.repeat(40) });
  assert.ok(workerPrompt(config, work, profile, 1, null, memory, 'a'.repeat(40), null, maps).includes(`${memoryDigest}${digest}`), 'the digest directly follows the project-memory digest');
  const unmatched = { ...work, plannedFiles: ['web/main.tsx'] };
  assert.equal(workerPrompt(config, unmatched, profile, 1, null, null, 'a'.repeat(40), null, maps), workerPrompt(config, unmatched, profile, 1, null, null, 'a'.repeat(40), null));

  const binding = { key: 'GY-1495', pr: 1, sha: 'b'.repeat(40), baseSha: 'a'.repeat(40), policyRevision: 1 };
  const repository = { repository: 'owner/project' };
  const plain = reviewPrompt(repository, binding);
  const reviewed = reviewPrompt(repository, binding, undefined, undefined, undefined, undefined, undefined, null, null, null, null, { maps, plannedFiles: work.plannedFiles });
  const reviewerDigest = verificationMapDigest(maps, work.plannedFiles, 'reviewer');
  assert.ok(reviewerDigest && reviewed.includes(`gh pr diff 1 --repo owner/project. ${reviewerDigest}`), 'the digest follows the memory section');
  assert.equal(reviewed.replace(reviewerDigest, ''), plain);
  assert.equal(reviewPrompt(repository, binding, undefined, undefined, undefined, undefined, undefined, null, null, null, null, { maps, plannedFiles: ['web/main.tsx'] }), plain);
});
