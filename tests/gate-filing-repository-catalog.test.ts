import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, runGate } from '../src/batch-gate.js';
import { batchGatePorts, gateFiledItem, pinningProof } from '../src/daemon/cycle-batch-gate.js';
import { controlPlaneUpgradeItem } from '../src/daemon/control-plane.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { commands } from '../src/engine/commands/schemas.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3568: a gate filing in a managed repository binds that repository's own E2E case, never
// Graphyard's create-work-item, so the known red it names can be accepted where it was filed.

const managed = 'hello-huck/huck';
const filing = (key: string) => gateFiledItem({ key, title: `Known red on main: ${key.slice(key.indexOf(':') + 1)}`, description: 'Red.' }, 'main', managed);

test('unit:gate-filing-repository-catalog — a filing outside Graphyard binds the gated repository\'s own case: an e2e check itself, any other check a new case named like the pinning proof; Graphyard\'s filings still bind create-work-item', () => {
  const repaired = 'manual:batch-gate-repaired';
  // An e2e check binds the failing case itself, which the repository's catalog already holds.
  assert.deepEqual(filing('known-red:e2e:sign-in').criteria[1]!.proofs, [repaired, 'e2e:sign-in']);
  // Any other check binds a new case named like the pinning proof, which the fix adds.
  assert.deepEqual(filing('known-red:test:secret-scan').criteria[1]!.proofs, [repaired, 'e2e:test-secret-scan-pinned']);
  assert.deepEqual(filing('flake:test:tests/board-queue.test.ts').criteria[1]!.proofs, [repaired, 'e2e:board-queue-pinned']);
  assert.deepEqual(filing('diagnostic:build').criteria[1]!.proofs, [repaired, 'e2e:build-pinned']);
  assert.equal(pinningProof('known-red:test:tests/board-queue.test.ts'), 'unit:board-queue-pinned', 'the new case is named like the pinning proof');
  assert.equal(filing('known-red:test:secret-scan').criteria[1]!.text, 'The batch gate passes again and a new E2E case test-secret-scan-pinned passes', 'the criterion says what the case is');
  assert.equal(filing('known-red:e2e:sign-in').criteria[1]!.text, 'The batch gate passes again and the E2E case sign-in passes again');
  // Graphyard's own filings stay unchanged.
  const own = gateFiledItem({ key: 'known-red:test:tests/board-queue.test.ts', title: 'Known red on main: test:tests/board-queue.test.ts', description: 'Red.' }, 'main', 'cryptob1/Graphyard');
  assert.deepEqual(own.criteria[1]!.proofs, [repaired, 'e2e:create-work-item']);
  assert.equal(own.criteria[1]!.text, 'The batch gate passes again and creating a work item still works');
  // The control plane's own faults are filed to Graphyard and keep create-work-item.
  const record = { failedStep: 'health', verified: 'a'.repeat(40) } as Parameters<typeof controlPlaneUpgradeItem>[0];
  assert.deepEqual(controlPlaneUpgradeItem(record).criteria[1]!.proofs, ['manual:control-plane-current', 'e2e:create-work-item']);
  // The gate's own port passes the gated repository through.
  const filed: { criteria: { proofs: string[] }[] }[] = [];
  const reads = {
    baseBranch: 'main', now: Date.now, git: async () => '', gate: { root: '/gate', repository: managed },
    createWork: async (item: { criteria: { proofs: string[] }[] }) => { filed.push(item); return { key: 'GY-1' }; },
  } as unknown as MergeWriterReads & { git: NonNullable<MergeWriterReads['git']> };
  batchGatePorts(reads, []).file({ key: 'diagnostic:build', title: 'Diagnostic failure on main: build', description: 'Red.' });
  assert.equal(filed.length, 1);
  assert.deepEqual(filed[0]!.criteria[1]!.proofs, [repaired, 'e2e:build-pinned']);
});

const repository = managed;
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();

test('e2e:gate-filing-repository-catalog — a known red the gate files in a managed repository passes create\'s E2E rule with a case that repository can hold', async () => {
  // A managed repository whose catalog holds one case, with one merge past the verified base.
  const base = await temporaryDirectory('gate-filing-catalog');
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), coordinator = join(base, 'coordinator');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  await writeFile(join(pusher, 'README.md'), 'base\n');
  await writeFile(join(pusher, 'graphyard.json'), '{}');
  await mkdir(join(pusher, 'e2e/cases'), { recursive: true });
  await writeFile(join(pusher, 'e2e/cases/fixture-red.json'), JSON.stringify({ id: 'fixture-red', title: 'A fixture case', target: 'any', required: false, steps: [] }));
  git(pusher, 'add', '.');
  git(pusher, 'commit', '-q', '-m', 'base');
  const verified = git(pusher, 'rev-parse', 'HEAD');
  git(pusher, 'checkout', '-q', '-b', 'item-1');
  await mkdir(join(pusher, 'src'), { recursive: true });
  await writeFile(join(pusher, 'src/f1.ts'), 'ok\n');
  git(pusher, 'add', '.');
  git(pusher, 'commit', '-q', '-m', 'change 1');
  git(pusher, 'checkout', '-q', 'main');
  git(pusher, 'merge', '-q', '--no-ff', '-m', 'Merge GY-1: change 1', 'item-1');
  git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const tip = git(pusher, 'rev-parse', 'HEAD');
  git(base, 'clone', '-q', origin, coordinator);

  // Both a test check and the catalog case fail on the tip and on the verified commit: known reds.
  const filings: { item: ReturnType<typeof gateFiledItem>; key: string }[] = [];
  const reads = {
    baseBranch: 'main', now: () => Date.parse('2030-04-01T00:00:00Z'),
    fetch: async () => { git(coordinator, 'fetch', '-q', 'origin', 'main'); return git(coordinator, 'rev-parse', 'origin/main'); },
    git: async (args: readonly string[]) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env }),
    trial: async () => ({ build: 'pass', tests: { passed: 1, failed: ['tests/slow.test.ts'], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {},
      e2e: [{ proof: 'e2e:fixture-red', executed: 1, failed: 1, missing: false, failingStep: null, output: [] }] }),
    createWork: async (item: ReturnType<typeof gateFiledItem>, key: string) => { filings.push({ item, key }); return { key: 'GY-101' }; },
    gate: { root: coordinator, repository },
  } as unknown as MergeWriterReads & { git: NonNullable<MergeWriterReads['git']> };
  // A catalog the diagnostics measured cheap runs whole, so its catalog-only case is a check too.
  const outcome = await runGate(batchGatePorts(reads, []), { ...bootstrapGate(repository, verified), catalogMs: 60_000 });
  assert.equal(outcome.outcome, 'verified', JSON.stringify(outcome));
  assert.deepEqual(filings.map(entry => entry.key).sort(), ['known-red:e2e:fixture-red', 'known-red:test:tests/slow.test.ts'], 'each known red is filed once');

  const catalog = git(coordinator, 'ls-tree', '--name-only', `${tip}:e2e/cases`).split('\n').filter(Boolean).map(name => name.slice(0, -'.json'.length));
  assert.ok(catalog.includes('fixture-red'), 'the repository holds the failing case');

  // The test check binds a new case the repository can hold: create's own parse accepts the filing.
  const testFiling = filings.find(entry => entry.key === 'known-red:test:tests/slow.test.ts')!.item;
  assert.deepEqual(testFiling.criteria[1]!.proofs, ['manual:batch-gate-repaired', 'e2e:slow-pinned']);
  assert.ok(!catalog.includes('slow-pinned'), 'the case is new: the fix adds it to the repository');
  commands.create.parse({ ...testFiling, reason: 'Filed by the batch gate on main' });
  // The e2e check binds the failing case itself, which the repository's catalog holds.
  const redFiling = filings.find(entry => entry.key === 'known-red:e2e:fixture-red')!.item;
  assert.deepEqual(redFiling.criteria[1]!.proofs, ['manual:batch-gate-repaired', 'e2e:fixture-red']);
  commands.create.parse({ ...redFiling, reason: 'Filed by the batch gate on main' });
});
