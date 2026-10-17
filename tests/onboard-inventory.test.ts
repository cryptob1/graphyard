import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImportSource } from '../src/model/import-plan.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1847: the read-only import plan behind `graphyard onboard inventory`. Every test runs against
// a fake GitHub listing, and the fake records every call the plan makes: the inventory is held to
// read-only on that record, so a write cannot hide behind a fixture's politeness.

// The change's two modules load inside every case, never at module scope: the file must also load
// against the base-exercise tree, where they are absent, so each case fails at its own import there
// and the exercise records executed, failing cases instead of a file that cannot load (GY-1839).
const planModule = () => import('../src/model/import-plan.js');
const onboardModule = () => import('../src/cli/onboard.js');

const sha = (seed: number) => seed.toString(16).padStart(40, '0');
const REPO = 'owner/repo';
const url = (number: number) => `https://github.test/owner/repo/pull/${number}`;
const behind = { status: 'behind', aheadBy: 0, behindBy: 3, mergeBaseSha: sha(0x31), files: [] };
const diverged = { status: 'diverged', aheadBy: 2, behindBy: 5, mergeBaseSha: sha(0x32), files: [{ filename: 'a.txt', patch: '@@\n+one' }] };

interface World {
  pulls: any[];
  compares: Record<string, any>;
  workflows: any[] | null;
  protections: Record<string, string[] | null>;
  checks: Record<string, any[] | null>;
}

/** One pull request of every disposition, plus the reads each disposition is decided from. */
const world = (): World => ({
  pulls: [
    { number: 1, base: 'main', headBranch: 'feature/one', headSha: sha(1), draft: false, url: url(1), mergeable: true },
    { number: 2, base: 'main', headBranch: 'feature/two', headSha: sha(2), draft: true, url: url(2), mergeable: null },
    { number: 3, base: 'main', headBranch: 'feature/three', headSha: sha(3), draft: false, url: url(3), mergeable: true },
    { number: 4, base: 'main', headBranch: 'feature/four', headSha: sha(4), draft: false, url: url(4), mergeable: true },
    { number: 5, base: 'release', headBranch: 'feature/five', headSha: sha(5), draft: false, url: url(5), mergeable: false },
    { number: 6, base: 'main', headBranch: 'feature/six', headSha: sha(6), draft: true, url: url(6), mergeable: true },
  ],
  compares: { [`main...${sha(3)}`]: behind, [`main...${sha(6)}`]: behind, [`main...${sha(1)}`]: diverged, [`main...${sha(4)}`]: diverged },
  workflows: [
    { name: 'release', path: '.github/workflows/release.yml', triggers: ['release', 'workflow_dispatch'] },
    { name: 'ci', path: '.github/workflows/ci.yml', triggers: ['push', 'pull_request'] },
    { name: 'unreadable', path: '.github/workflows/broken.yml', triggers: null },
  ],
  protections: { main: ['ci', 'typecheck'], release: null },
  checks: {
    [sha(1)]: [{ name: 'ci', result: 'success' }, { name: 'typecheck', result: 'success' }],
    [sha(4)]: [{ name: 'ci', result: 'failure' }, { name: 'typecheck', result: 'success' }],
  },
});

/** The fake GitHub listing: it answers the five reads of `ImportSource` and records each call by name. */
class FakeListing implements ImportSource {
  readonly calls: { method: string; args: unknown[] }[] = [];
  constructor(private readonly world: World) {}
  private record(method: string, args: unknown[]) { this.calls.push({ method, args }); }
  async openPulls(repository: string) { this.record('openPulls', [repository]); return structuredClone(this.world.pulls); }
  async compareBaseHead(repository: string, base: string, head: string) {
    this.record('compareBaseHead', [repository, base, head]);
    return structuredClone(this.world.compares[`${base}...${head}`] ?? null);
  }
  async workflows(repository: string) { this.record('workflows', [repository]); return structuredClone(this.world.workflows); }
  async requiredChecks(repository: string, branch: string) { this.record('requiredChecks', [repository, branch]); return structuredClone(this.world.protections[branch] ?? null); }
  async headChecks(repository: string, head: string) { this.record('headChecks', [repository, head]); return structuredClone(this.world.checks[head] ?? null); }
}

test('unit:onboard-inventory-read-only — every open and draft pull request is reported with its number, base, head branch, exact head sha, draft flag and URL, and one disposition each', async () => {
  const { buildImportPlan } = await planModule();
  const fake = new FakeListing(world());
  const plan = await buildImportPlan(REPO, fake, null);
  assert.equal(plan.repository, REPO);
  assert.equal(plan.mode, 'read-only inventory');
  assert.deepEqual(plan.pulls.map(pull => [pull.number, pull.base, pull.headBranch, pull.headSha, pull.draft, pull.url]), [
    [1, 'main', 'feature/one', sha(1), false, url(1)],
    [2, 'main', 'feature/two', sha(2), true, url(2)],
    [3, 'main', 'feature/three', sha(3), false, url(3)],
    [4, 'main', 'feature/four', sha(4), false, url(4)],
    [5, 'release', 'feature/five', sha(5), false, url(5)],
    [6, 'main', 'feature/six', sha(6), true, url(6)],
  ]);
  const dispositions = Object.fromEntries(plan.pulls.map(pull => [pull.number, pull.disposition]));
  assert.deepEqual(dispositions, { 1: 'adopt', 2: 'hold', 3: 'superseded', 4: 'continue', 5: 'continue', 6: 'superseded' });
  for (const pull of plan.pulls) assert.ok(['continue', 'hold', 'adopt', 'superseded'].includes(pull.disposition), `pull #${pull.number} names exactly one disposition of the four`);
});

test('unit:onboard-inventory-read-only — superseded is proposed only with compare evidence that the base holds every commit of the head', async () => {
  const { buildImportPlan } = await planModule();
  const plan = await buildImportPlan(REPO, new FakeListing(world()), null);
  for (const pull of plan.pulls) {
    if (pull.disposition === 'superseded') {
      assert.ok(pull.containment, `pull #${pull.number} carries its containment evidence`);
      assert.equal(pull.containment!.evidence, 'compare');
      assert.equal(pull.containment!.aheadBy, 0, `pull #${pull.number}'s evidence shows the head ahead of the base by nothing`);
      assert.ok(['behind', 'identical'].includes(pull.containment!.status), `pull #${pull.number}'s evidence is a compare that proves containment`);
    } else {
      assert.equal(pull.containment, undefined, `pull #${pull.number} is not superseded, so it carries no containment evidence`);
    }
  }
  // A diverged head (pull 1) is adoptable, never superseded; a draft whose patch is contained (pull
  // 6) still reads superseded: the evidence outranks the hold.
  assert.equal(plan.pulls.find(pull => pull.number === 1)!.disposition, 'adopt');
  assert.equal(plan.pulls.find(pull => pull.number === 6)!.disposition, 'superseded');
});

test('unit:onboard-inventory-read-only — the fake records no write call of any kind: only the five reads run, and only against the named repository', async () => {
  const { buildImportPlan, importReads } = await planModule();
  const fake = new FakeListing(world());
  await buildImportPlan(REPO, fake, null);
  assert.deepEqual(fake.calls.filter(call => !(importReads as readonly string[]).includes(call.method)), [], 'every recorded call is one of the five reads');
  for (const read of importReads) assert.doesNotMatch(read, /write|post|put|patch|delete|create|merge|close/i, 'the read set itself names no write verb');
  for (const call of fake.calls) assert.equal(call.args[0], REPO, 'every read names the repository the command was given');
  // One compare and one head-check read per pull, one protection read per distinct base, one listing.
  assert.equal(fake.calls.filter(call => call.method === 'openPulls').length, 1);
  assert.equal(fake.calls.filter(call => call.method === 'compareBaseHead').length, 6);
  assert.equal(fake.calls.filter(call => call.method === 'headChecks').length, 6);
  assert.deepEqual(fake.calls.filter(call => call.method === 'requiredChecks').map(call => call.args[1]), ['main', 'release']);
  assert.equal(fake.calls.filter(call => call.method === 'workflows').length, 1);
});

test('unit:onboard-inventory-read-only — each fact is marked detected or unknown, and an unreadable read never blocks a disposition', async () => {
  const { buildImportPlan } = await planModule();
  const plan = await buildImportPlan(REPO, new FakeListing(world()), null);
  const byNumber = Object.fromEntries(plan.pulls.map(pull => [pull.number, pull]));
  const first = byNumber[1];
  assert.deepEqual(first.facts.map(fact => fact.fact), ['mergeability', 'required-checks', 'head-checks']);
  assert.deepEqual(first.facts.map(fact => fact.state), ['detected', 'detected', 'detected']);
  assert.match(first.facts.find(fact => fact.fact === 'required-checks')!.detail, /ci, typecheck/);
  // Pull 2's mergeability was never computed; pull 5's base branch protection and head checks could not be read.
  assert.equal(byNumber[2].facts.find(fact => fact.fact === 'mergeability')!.state, 'unknown');
  assert.equal(byNumber[5].facts.find(fact => fact.fact === 'required-checks')!.state, 'unknown');
  assert.equal(byNumber[5].facts.find(fact => fact.fact === 'head-checks')!.state, 'unknown');
  assert.equal(byNumber[4].facts.find(fact => fact.fact === 'head-checks')!.detail, 'ci=failure, typecheck=success');
  // The failing required check keeps pull 4 from adoption; pull 1's clean ones do not hold it, and
  // pull 5's reported conflict does too.
  assert.equal(byNumber[4].disposition, 'continue');
  assert.equal(byNumber[1].disposition, 'adopt');
  assert.equal(byNumber[5].disposition, 'continue');
});

test('unit:onboard-inventory-read-only — a non-draft pull request is adopted only on a definite no-conflict: mergeability unknown or conflicting continues', async () => {
  const { buildImportPlan } = await planModule();
  const pull = { number: 9, base: 'main', headBranch: 'feature/nine', headSha: sha(9), draft: false, url: url(9) };
  const withMergeable = (mergeable: boolean | null) => ({ ...world(), pulls: [{ ...pull, mergeable }], compares: {}, checks: { [sha(9)]: [{ name: 'ci', result: 'success' }, { name: 'typecheck', result: 'success' }] } });
  const unknown = await buildImportPlan(REPO, new FakeListing(withMergeable(null)), null);
  assert.equal(unknown.pulls[0].disposition, 'continue', 'mergeability GitHub has not computed is no evidence of a clean merge');
  assert.equal(unknown.pulls[0].facts.find(fact => fact.fact === 'mergeability')!.state, 'unknown');
  const conflicting = await buildImportPlan(REPO, new FakeListing(withMergeable(false)), null);
  assert.equal(conflicting.pulls[0].disposition, 'continue');
  assert.match(conflicting.pulls[0].facts.find(fact => fact.fact === 'mergeability')!.detail, /conflict/);
  // A definite no-conflict is still the only mergeability that adopts.
  assert.equal((await buildImportPlan(REPO, new FakeListing(withMergeable(true)), null)).pulls[0].disposition, 'adopt');
});

test('unit:onboard-inventory-read-only — a required check with no reported result, or head checks that could not be read, withholds adoption', async () => {
  const { buildImportPlan } = await planModule();
  const pull = { number: 9, base: 'main', headBranch: 'feature/nine', headSha: sha(9), draft: false, url: url(9), mergeable: true };
  const withChecks = (checks: any[] | null) => ({ ...world(), pulls: [pull], compares: {}, checks: { [sha(9)]: checks } });
  assert.equal((await buildImportPlan(REPO, new FakeListing(withChecks([{ name: 'ci', result: 'success' }])), null)).pulls[0].disposition, 'continue', 'typecheck has not reported');
  assert.equal((await buildImportPlan(REPO, new FakeListing(withChecks(null)), null)).pulls[0].disposition, 'continue', 'unknown head checks are not clean');
});

test('unit:onboard-inventory-read-only — release and deploy workflows are named with their triggers, and unreadable triggers are unknown', async () => {
  const { buildImportPlan } = await planModule();
  const plan = await buildImportPlan(REPO, new FakeListing(world()), null);
  assert.equal(plan.workflows.state, 'detected');
  assert.deepEqual(plan.workflows.items.map(item => [item.path, item.state, item.triggers, item.releaseDeploy]), [
    ['.github/workflows/broken.yml', 'unknown', [], false],
    ['.github/workflows/ci.yml', 'detected', ['push', 'pull_request'], false],
    ['.github/workflows/release.yml', 'detected', ['release', 'workflow_dispatch'], true],
  ]);
  const unreadable = await buildImportPlan(REPO, new FakeListing({ ...world(), workflows: null }), null);
  assert.deepEqual(unreadable.workflows, { state: 'unknown', items: [] });
});

test('unit:onboard-mapping-deterministic — the same mapping and listing give byte-identical JSON on two runs', async () => {
  const { buildImportPlan } = await planModule();
  const mapping = JSON.stringify({ entries: [
    { key: 'HE-123', url: 'https://work.test/HE-123', repository: 'owner/repo', number: 1 },
    { key: 'HE-124', repository: 'OWNER/REPO', number: 3 },
    { key: 'HE-999', url: 'https://work.test/HE-999', repository: 'owner/repo', number: 404 },
  ] });
  const first = await buildImportPlan(REPO, new FakeListing(world()), mapping);
  const second = await buildImportPlan(REPO, new FakeListing(world()), mapping);
  const text = (plan: unknown) => JSON.stringify(plan, null, 2);
  assert.equal(text(first), text(second), 'two runs of the same inputs are byte-identical');
  // The mapping joins case-insensitively (repositories normalize to lowercase), sorted by key.
  assert.deepEqual(first.mapping.entries.map(entry => [entry.key, entry.repository, entry.number, entry.pull?.disposition ?? null]), [
    ['HE-123', 'owner/repo', 1, 'adopt'],
    ['HE-124', 'owner/repo', 3, 'superseded'],
    ['HE-999', 'owner/repo', 404, null],
  ]);
  // A key whose pull request is not open is named as unmatched, never dropped.
  assert.equal(first.mapping.entries.find(entry => entry.key === 'HE-999')!.pull, null);
  // No mapping file at all is an empty, conflict-free join.
  assert.deepEqual((await buildImportPlan(REPO, new FakeListing(world()), null)).mapping, { entries: [], conflicts: [] });
});

test('unit:onboard-mapping-deterministic — the mapping joins the inventory whatever case each side names the repository in', async () => {
  const { buildImportPlan } = await planModule();
  const mapping = JSON.stringify({ entries: [{ key: 'HE-77', repository: 'owner/repo', number: 1 }] });
  const joined = await buildImportPlan('Owner/Repo', new FakeListing(world()), mapping);
  assert.equal(joined.repository, 'Owner/Repo', 'the plan reports the repository exactly as it was given');
  assert.equal(joined.mapping.entries[0].pull!.headSha, sha(1), 'the entry joins across the case difference');
  const again = await buildImportPlan('OWNER/REPO', new FakeListing(world()), mapping);
  assert.equal(JSON.stringify(joined.mapping), JSON.stringify(again.mapping), 'the join is stable across spellings of the same repository');
});

test('unit:onboard-mapping-deterministic — a key mapped to two pull requests, or a pull request mapped by two keys, is a named conflict rather than a resolution', async () => {
  const { buildImportPlan, parseMapping } = await planModule();
  const keyConflict = JSON.stringify({ entries: [
    { key: 'HE-1', repository: 'owner/repo', number: 1 },
    { key: 'HE-1', repository: 'owner/repo', number: 2 },
  ] });
  assert.deepEqual(parseMapping(keyConflict).conflicts,
    [{ kind: 'key-maps-two-prs', key: 'HE-1', targets: [{ repository: 'owner/repo', number: 1 }, { repository: 'owner/repo', number: 2 }] }]);
  assert.deepEqual(parseMapping(JSON.stringify([{ key: 'K1', repository: 'owner/repo', number: 1 }, { key: 'K2', repository: 'owner/repo', number: 1 }])).conflicts,
    [{ kind: 'pr-mapped-by-two-keys', repository: 'owner/repo', number: 1, keys: ['K1', 'K2'] }]);
  // The plan reports the conflict and still completes: nothing is silently resolved or dropped.
  const plan = await buildImportPlan(REPO, new FakeListing(world()), keyConflict);
  assert.equal(plan.mapping.conflicts[0].kind, 'key-maps-two-prs');
  assert.equal(plan.mapping.entries.length, 2);
  // An entry that is not well formed is named, by its index, not dropped.
  assert.deepEqual(parseMapping(JSON.stringify({ entries: [{ key: 'OK', repository: 'owner/repo', number: 1 }, { key: 'BAD', repository: 'owner/repo' }] })).conflicts,
    [{ kind: 'unreadable-entry', index: 1, detail: 'entry 1 of the mapping file is not {key, url?, repository OWNER/REPO, number}' }]);
  assert.throws(() => parseMapping('not json'), /does not parse as JSON/);
  assert.throws(() => parseMapping('{"entries": 3}'), /entries/);
});

test('unit:onboard-inventory-read-only — through the gh client the command only reads: every call is `gh api` with no write flag, on read endpoints only', async () => {
  const { runOnboard } = await onboardModule();
  const restBehind = { status: 'behind', ahead_by: 0, behind_by: 3, merge_base_commit: { sha: sha(0x31) }, files: [] };
  const restDiverged = { status: 'diverged', ahead_by: 2, behind_by: 5, merge_base_commit: { sha: sha(0x32) }, files: [] };
  const releaseYaml = 'name: release\non:\n  release:\n    types: [published]\n  workflow_dispatch:\n';
  // The listing as GitHub's REST answers it — the list shape carries no mergeability — plus the
  // single-pull reads GitHub computes it on, one per pull request.
  const restPulls = [
    { number: 1, state: 'open', draft: false, html_url: url(1), base: { ref: 'main' }, head: { ref: 'feature/one', sha: sha(1) } },
    { number: 2, state: 'open', draft: true, html_url: url(2), base: { ref: 'main' }, head: { ref: 'feature/two', sha: sha(2) } },
    { number: 3, state: 'open', draft: false, html_url: url(3), base: { ref: 'main' }, head: { ref: 'feature/three', sha: sha(3) } },
    { number: 4, state: 'open', draft: false, html_url: url(4), base: { ref: 'main' }, head: { ref: 'feature/four', sha: sha(4) } },
    { number: 5, state: 'open', draft: false, html_url: url(5), base: { ref: 'release' }, head: { ref: 'feature/five', sha: sha(5) } },
    { number: 6, state: 'open', draft: true, html_url: url(6), base: { ref: 'main' }, head: { ref: 'feature/six', sha: sha(6) } },
  ];
  const mergeability: Record<number, boolean | null> = { 1: true, 2: null, 3: true, 4: true, 5: false, 6: true };
  const writeFlags = ['-X', '--method', '-f', '-F', '--field', '--input', '--raw-field'];
  const calls: string[][] = [];
  const exec = async (program: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
    calls.push([program, ...args]);
    const fail = (stderr: string) => ({ stdout: '', stderr, code: 1 });
    if (program !== 'gh' || args[0] !== 'api') return fail(`unexpected call ${program} ${args.join(' ')}`);
    const path = args[1];
    if (writeFlags.some(flag => args.includes(flag))) return fail(`a write flag was sent: ${path}`);
    let body: unknown;
    const singlePull = path.match(/^repos\/owner\/repo\/pulls\/(\d+)$/);
    if (singlePull) body = { number: Number(singlePull[1]), mergeable: mergeability[Number(singlePull[1])] };
    else if (/^repos\/owner\/repo\/pulls\?/.test(path)) body = restPulls;
    else if (/^repos\/owner\/repo\/compare\/main\.\.\./.test(path)) body = [sha(3), sha(6)].some(end => path.endsWith(end)) ? restBehind : restDiverged;
    else if (/^repos\/owner\/repo\/branches\/main\/protection/.test(path)) body = { contexts: [], checks: [{ context: 'ci', app_id: 1 }, { context: 'typecheck', app_id: 1 }] };
    else if (/^repos\/owner\/repo\/branches\/[^/]+\/protection/.test(path)) return fail('protection unreadable');
    else if (/^repos\/owner\/repo\/commits\/[a-f0-9]+\/check-runs\?/.test(path)) body = { check_runs: [{ name: 'ci', conclusion: path.includes(sha(4)) ? 'failure' : 'success', status: 'completed' }, { name: 'typecheck', conclusion: 'success', status: 'completed' }] };
    else if (/^repos\/owner\/repo\/commits\/[^/]+\/status/.test(path)) body = { statuses: [] };
    else if (/^repos\/owner\/repo\/actions\/workflows\?/.test(path)) body = { workflows: [{ name: 'release', path: '.github/workflows/release.yml' }], total_count: 1 };
    else if (/^repos\/owner\/repo\/contents\//.test(path)) body = { encoding: 'base64', content: Buffer.from(releaseYaml).toString('base64') };
    else return fail(`unrouted ${path}`);
    return { stdout: JSON.stringify(body), stderr: '', code: 0 };
  };
  const scratch = await temporaryDirectory('onboard-inventory');
  const printed: unknown[] = [];
  const logged: string[] = [];
  const out = join(scratch, 'plan.json');
  await runOnboard(['inventory', '--repo', REPO, '--out', out, '--json'], { exec, print: value => printed.push(value), log: line => logged.push(line) });
  const plan = printed[0] as any;
  assert.equal(plan.mode, 'read-only inventory');
  assert.deepEqual(plan.pulls.map((pull: any) => [pull.number, pull.disposition, pull.headSha]), [
    [1, 'adopt', sha(1)], [2, 'hold', sha(2)], [3, 'superseded', sha(3)], [4, 'continue', sha(4)], [5, 'continue', sha(5)], [6, 'superseded', sha(6)],
  ]);
  assert.equal(calls.filter(call => /^repos\/owner\/repo\/pulls\/\d+$/.test(call[2])).length, 6, 'mergeability is read per pull request, never taken from the listing');
  assert.equal(plan.pulls.find((pull: any) => pull.number === 5)!.facts.find((fact: any) => fact.fact === 'mergeability')!.detail, 'GitHub reports a conflict with the base branch');
  for (const [index, pull] of plan.pulls.entries()) assert.deepEqual([pull.number, pull.base, pull.headBranch, pull.headSha, pull.draft, pull.url],
    [index + 1, index === 4 ? 'release' : 'main', `feature/${['one', 'two', 'three', 'four', 'five', 'six'][index]}`, sha(index + 1), index === 1 || index === 5, url(index + 1)]);
  assert.equal(plan.workflows.items[0].releaseDeploy, true, 'the release workflow is read from its file and named release/deploy');
  for (const call of calls) {
    assert.deepEqual(call.slice(0, 2), ['gh', 'api'], `every GitHub call is gh api, never anything else: ${call.join(' ')}`);
    assert.ok(!call.some(arg => writeFlags.includes(arg)), `no write flag is sent: ${call.join(' ')}`);
    assert.match(call[2], /^repos\/owner\/repo\/(pulls\?|pulls\/\d+$|compare\/|branches\/[^/]+\/protection|commits\/[^/]+\/(check-runs\?|status)|actions\/workflows\?|contents\/)/, `only read endpoints are asked: ${call[2]}`);
  }
  // The written file holds exactly what was printed, and a rerun is byte-identical — through the
  // client and on disk — with nothing else created.
  const written = await readFile(out, 'utf8');
  assert.equal(written, `${JSON.stringify(plan, null, 2)}\n`);
  const second: unknown[] = [];
  await runOnboard(['inventory', '--repo', REPO, '--out', out], { exec, print: value => second.push(value), log: line => second.push(line) });
  assert.equal(await readFile(out, 'utf8'), written, 'a rerun writes the same bytes');
  assert.match(String(second[0]), /^owner\/repo: 6 open or draft pull requests — 2 continue, 1 hold, 1 adopt, 2 superseded/);
  assert.match(String(second[0]), /release\/deploy workflow \.github\/workflows\/release\.yml \(release, workflow_dispatch\)/);
  assert.match(String(second[0]), new RegExp(`wrote ${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  // A mapping file is read and its conflicts reported through the command too.
  const mappingFile = join(scratch, 'mapping.json');
  await writeFile(mappingFile, JSON.stringify({ entries: [
    { key: 'HE-1', repository: 'owner/repo', number: 1 },
    { key: 'HE-1', repository: 'owner/repo', number: 2 },
  ] }));
  const mapped: unknown[] = [];
  await runOnboard(['inventory', '--repo', REPO, '--mapping', mappingFile, '--json'], { exec, print: value => mapped.push(value), log: line => mapped.push(line) });
  assert.deepEqual((mapped[0] as any).mapping.conflicts, [{ kind: 'key-maps-two-prs', key: 'HE-1', targets: [{ repository: 'owner/repo', number: 1 }, { repository: 'owner/repo', number: 2 }] }]);
});

test('unit:onboard-inventory-read-only — the launcher registers the inventory command, reads no connection file, and refuses an unusable invocation', async () => {
  const { onboardCommands, runOnboard } = await onboardModule();
  assert.deepEqual(onboardCommands.map(command => command.name), ['onboard']);
  const onboard = onboardCommands[0];
  assert.match(onboard.help.join('\n'), /onboard inventory --repo OWNER\/REPO/);
  assert.equal(onboard.readsConnection?.('inventory'), false, 'the inventory never reads the repository connection file');
  const dead = { exec: async () => ({ stdout: '', stderr: '', code: 0 }), print: () => {}, log: () => {} };
  await assert.rejects(() => runOnboard([], dead), /inventory subcommand/);
  await assert.rejects(() => runOnboard(['inventory'], dead), /--repo OWNER\/REPO/);
  await assert.rejects(() => runOnboard(['inventory', '--repo', 'not-a-repo'], dead), /OWNER\/REPO/);
  await assert.rejects(() => runOnboard(['inventory', '--repo', REPO, '--mapping', '/nonexistent/mapping.json'], { ...dead, exec: async () => ({ stdout: '[]', stderr: '', code: 0 }) }), /ENOENT/);
});

test('unit:onboard-inventory-read-only — the registered command forwards the inventory token: `graphyard onboard inventory --repo …` reaches the plan', async () => {
  const { onboardCommands } = await onboardModule();
  const calls: string[][] = [];
  const printed: unknown[] = [];
  const context = { rest: ['inventory', '--repo', REPO, '--json'], print: (value: unknown) => printed.push(value) } as any;
  // The registered handler's dependency parameter takes the place of the local `gh` transport, so
  // the invocation runs end to end against a fake: the subcommand token must survive the dispatch.
  await (onboardCommands[0] as any).run(context, undefined, { exec: async (program: string, args: string[]) => { calls.push([program, ...args]); return { stdout: '[]', stderr: '', code: 0 }; }, print: (value: unknown) => context.print(value), log: () => {} });
  assert.equal((printed[0] as any).repository, REPO, 'the documented invocation reaches the inventory, subcommand token intact');
  assert.deepEqual((printed[0] as any).pulls, []);
  for (const call of calls) assert.deepEqual(call.slice(0, 2), ['gh', 'api'], `the handler only reads: ${call.join(' ')}`);
});

test('unit:onboard-inventory-read-only — the gh adapter maps only what the listing and the compare hold, and workflow `on:` blocks parse in their common forms', async () => {
  const { ghImportSource, workflowTriggers } = await onboardModule();
  const source = ghImportSource(async () => null);
  assert.deepEqual(await source.requiredChecks(REPO, 'main'), null, 'a failed read is unknown, never a guess');
  assert.deepEqual(await source.compareBaseHead(REPO, 'main', sha(1)), null);
  assert.deepEqual(await source.workflows(REPO), null);
  assert.deepEqual(await source.headChecks(REPO, sha(1)), null);
  assert.deepEqual(workflowTriggers('name: ci\non: [push, pull_request]\njobs: {}\n'), ['push', 'pull_request']);
  assert.deepEqual(workflowTriggers('on:\n  push:\n    branches: [main]\n  release:\n    types: [published]\n'), ['push', 'release']);
  assert.deepEqual(workflowTriggers('on: workflow_dispatch\n'), ['workflow_dispatch']);
  assert.deepEqual(workflowTriggers('"on": {deployment, workflow_dispatch}\n'), ['deployment', 'workflow_dispatch']);
  assert.deepEqual(workflowTriggers('on:\n  # a comment\n  push:\n'), ['push']);
  assert.equal(workflowTriggers('name: broken\njobs: {}\n'), null);
  assert.equal(workflowTriggers('on: [push\n'), null);
});

test('unit:onboard-inventory-read-only — a required check still in progress is reported, not silently absent, and reads as not yet clean', async () => {
  const { ghImportSource } = await onboardModule();
  const { checkFailed } = await planModule();
  const runs = { total_count: 3, check_runs: [
    { name: 'ci', conclusion: 'success', status: 'completed', completed_at: '2026-10-16T00:00:00Z' },
    { name: 'ci', status: 'in_progress', started_at: '2026-10-17T00:00:00Z' },
    { name: 'typecheck', status: 'queued', started_at: '2026-10-17T00:00:00Z' },
  ] };
  const source = ghImportSource(async args => (/check-runs/.test(args[0]) ? JSON.stringify(runs) : JSON.stringify({ statuses: [] })));
  // The re-run in progress is ci's latest activity, so it decides, and a queued run is reported
  // rather than dropped: a required check that has not concluded is not a clean one.
  assert.deepEqual(await source.headChecks(REPO, sha(1)), [{ name: 'ci', result: 'in_progress' }, { name: 'typecheck', result: 'queued' }]);
  assert.ok(checkFailed('in_progress') && checkFailed('queued'), 'a pending required check holds adoption');
  assert.ok(!checkFailed('success'));
});
