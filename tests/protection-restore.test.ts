import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyInstall, buildPlan, installRequestFromArgs, prepareInstall } from '../src/install/index.js';
import { installDirectory } from '../src/install/secrets.js';
import { mergeQueueRulesetName } from '../src/protection.js';
import { allText, appKey, githubResponses, harness, satisfiedProtection, REPOSITORY, WEBHOOK_SECRET, type Harness } from './install-harness.js';

const PROTECTION = `repos/${REPOSITORY}/branches/main/protection`;
/** Where install keeps the record: the install directory, beside the installation's credentials. */
const recordFile = (configHome: string) => join(installDirectory('owner-project', configHome), 'protection-record.json');

/**
 * GitHub as the restore sees it: protection that a PUT replaces (answered back in GET form) and a
 * DELETE removes, the repository's auto-merge setting, and its rulesets. Every write records whether
 * the protection record already existed when it was sent.
 */
function fakeGitHub(initial: { protection?: any; allowAutoMerge?: boolean } = {}) {
  const github = {
    protection: initial.protection ?? null as any, allowAutoMerge: initial.allowAutoMerge ?? false, rulesets: [] as any[],
    recordFile: '', writes: [] as { line: string; recorded: boolean }[],
  };
  const wrap = (value: boolean) => ({ enabled: value });
  const people = (list: string[] = [], key: string) => list.map(name => ({ [key]: name }));
  const asGet = (body: any) => ({
    url: `https://api.github.com/${PROTECTION}`,
    ...(body.required_status_checks ? { required_status_checks: { ...body.required_status_checks, contexts: body.required_status_checks.checks.map((check: any) => check.context) } } : {}),
    enforce_admins: wrap(body.enforce_admins),
    ...(body.required_pull_request_reviews ? { required_pull_request_reviews: { ...body.required_pull_request_reviews,
      ...(body.required_pull_request_reviews.bypass_pull_request_allowances ? { bypass_pull_request_allowances: { users: people(body.required_pull_request_reviews.bypass_pull_request_allowances.users, 'login'), teams: people(body.required_pull_request_reviews.bypass_pull_request_allowances.teams, 'slug'), apps: [] } } : {}) } } : {}),
    ...(body.restrictions ? { restrictions: { users: people(body.restrictions.users, 'login'), teams: people(body.restrictions.teams, 'slug'), apps: people(body.restrictions.apps, 'slug') } } : {}),
    ...Object.fromEntries(['required_conversation_resolution', 'required_linear_history', 'allow_force_pushes', 'allow_deletions', 'block_creations', 'lock_branch', 'allow_fork_syncing'].map(key => [key, wrap(body[key] === true)])),
  });
  const defaults = githubResponses({ installed: false, protection: null, deliveries: [], hookConfig: null });
  const answer = (line: string, input?: string): string | { stdout: string; stderr: string; code: number } => {
    const notFound = { stdout: '', stderr: 'gh: Not Found (HTTP 404)', code: 1 };
    if (line.includes('--method')) github.writes.push({ line, recorded: existsSync(github.recordFile) });
    if (line === `gh api ${PROTECTION}`) return github.protection ? JSON.stringify(github.protection) : { stdout: '', stderr: 'gh: Branch not protected (HTTP 404)', code: 1 };
    if (line.startsWith(`gh api --method PUT ${PROTECTION}`)) { github.protection = asGet(JSON.parse(input!)); return '{}'; }
    if (line === `gh api --method DELETE ${PROTECTION}`) { if (!github.protection) return notFound; github.protection = null; return ''; }
    if (line === `gh api repos/${REPOSITORY}`) return JSON.stringify({ full_name: REPOSITORY, owner: { type: 'User' }, allow_auto_merge: github.allowAutoMerge });
    if (line.startsWith(`gh api --method PATCH repos/${REPOSITORY} `)) { github.allowAutoMerge = line.endsWith('allow_auto_merge=true'); return '{}'; }
    if (line === `gh api repos/${REPOSITORY}/rules/branches/main`) return '[]';
    if (line === `gh api repos/${REPOSITORY}/rulesets?includes_parents=false`) return JSON.stringify(github.rulesets.map(({ id, name }) => ({ id, name })));
    const ruleset = /^gh api (?:--method (\w+) )?repos\/[^/]+\/[^/]+\/rulesets\/(\d+)/.exec(line);
    if (ruleset) {
      const index = github.rulesets.findIndex(entry => entry.id === Number(ruleset[2]));
      if (index < 0) return notFound;
      if (ruleset[1] === 'DELETE') { github.rulesets.splice(index, 1); return ''; }
      if (ruleset[1] === 'PUT') github.rulesets[index] = { id: github.rulesets[index].id, ...JSON.parse(input!) };
      return JSON.stringify(github.rulesets[index]);
    }
    const fallback = defaults.find(entry => line.includes(entry.match));
    if (!fallback) return '';
    return typeof fallback.result === 'function' ? (fallback.result as any)(line, input) : fallback.result;
  };
  return { github, responses: [{ match: 'gh api', result: answer }] };
}

async function install(github: ReturnType<typeof fakeGitHub>, reuse?: Harness) {
  const fixture = await harness({ provider: 'railway', extraResponses: github.responses, ...(reuse ? { root: reuse.root, configHome: reuse.configHome } : {}) });
  github.github.recordFile = recordFile(fixture.configHome);
  const session = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'railway' }, fixture.deps);
  await applyInstall(session, await buildPlan(session));
  return fixture;
}

async function restore(fixture: Harness, mode: 'plan' | 'apply') {
  const { request } = installRequestFromArgs(['--repo', REPOSITORY, '--restore-protection', `--${mode}`]);
  const session = await prepareInstall(fixture.root, request, fixture.deps, mode);
  const plan: any = await buildPlan(session);
  return mode === 'plan' ? plan : await applyInstall(session, plan) as any;
}

test('unit:protection-prior-state-recorded-before-first-apply — the first github.protection apply records the protection it read (none for an unprotected branch) before any write, a second apply keeps the record, and it holds no credential', async () => {
  // An unprotected branch: the record says so, and is on disk before the first GitHub write.
  const fake = fakeGitHub();
  const first = await install(fake);
  try {
    const file = fake.github.recordFile;
    const protectionWrites = fake.github.writes.filter(write => write.line.includes(PROTECTION) || write.line.includes(`repos/${REPOSITORY} `) || write.line.includes('/rulesets'));
    assert.ok(protectionWrites.length >= 2, 'install wrote no protection or auto-merge');
    assert.ok(protectionWrites.every(write => write.recorded), 'a protection write went out before the record existed');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const text = await readFile(file, 'utf8');
    const record = JSON.parse(text);
    assert.equal(record.format, 'graphyard-protection-record-v1');
    assert.deepEqual({ repository: record.repository, branch: record.branch, protection: record.protection, allowAutoMerge: record.allowAutoMerge, mergeQueueRuleset: record.mergeQueueRuleset },
      { repository: REPOSITORY, branch: 'main', protection: null, allowAutoMerge: false, mergeQueueRuleset: null });
    assert.ok(!Number.isNaN(Date.parse(record.recordedAt)));
    for (const secret of [appKey, WEBHOOK_SECRET, 'installation-token-for-tests']) assert.ok(!text.includes(secret), 'the record carries a credential');
    assert.ok(!/token|secret|private_key/i.test(text), 'the record names a credential field');
    assert.ok(allText(first).includes(`--method PUT ${PROTECTION}`));

    // A second apply finds Graphyard's own protection and writes again, but the record stands.
    assert.ok(fake.github.protection && fake.github.allowAutoMerge);
    const writesBefore = fake.github.writes.length;
    const second = await install(fake, first);
    assert.ok(fake.github.writes.slice(writesBefore).some(write => write.line.includes(`--method PUT ${PROTECTION}`)), 'the second apply never reached the protection write');
    assert.equal(await readFile(file, 'utf8'), text, 'a second apply rewrote the protection record');
    await second.cleanup();
  } finally { await first.cleanup(); }

  // A protected branch: its document is recorded exactly as GitHub answered it.
  const served = { ...satisfiedProtection(null, 2), lock_branch: { enabled: true }, restrictions: { users: [{ login: 'release-bot' }], teams: [], apps: [] } };
  const protectedFake = fakeGitHub({ protection: structuredClone(served), allowAutoMerge: false });
  const fixture = await install(protectedFake);
  try {
    const record = JSON.parse(await readFile(protectedFake.github.recordFile, 'utf8'));
    assert.deepEqual(record.protection, served);
    assert.equal(record.allowAutoMerge, false);
  } finally { await fixture.cleanup(); }
});

test('unit:protection-restore-matches-recorded-state — the restore plan lists its writes and writes nothing, the apply writes exactly the recorded payload (or deletes protection for none) and its re-read matches, and no record refuses naming it', async () => {
  // Loaded when the test runs, so a checkout without the restore fails here as a test case.
  const { restorePayload } = await import('../src/install/github.js') as any;
  // No record: plan and apply both refuse, naming the file they looked for, having written nothing.
  const empty = await harness({ provider: 'railway' });
  try {
    const file = recordFile(empty.configHome);
    for (const mode of ['plan', 'apply'] as const) await assert.rejects(restore(empty, mode), (error: Error) => error.message.includes(file) && /No protection record exists/.test(error.message));
    assert.equal(empty.transport.commands.length, 0);
    assert.throws(() => installRequestFromArgs(['--repo', REPOSITORY, '--restore-protection', '--provider', 'railway']), /cannot be combined with --provider/);
    assert.throws(() => installRequestFromArgs(['--repo', REPOSITORY, '--restore-protection', '--plan', '--apply']), /Choose either --plan or --apply/);
  } finally { await empty.cleanup(); }

  // A branch that had protection of its own: install changes it, and a stray Graphyard queue ruleset appears.
  const original = { ...satisfiedProtection(null, 2), required_status_checks: { strict: true, checks: [{ context: 'test', app_id: null }] },
    required_pull_request_reviews: { required_approving_review_count: 2, dismiss_stale_reviews: false, require_code_owner_reviews: true, require_last_push_approval: false, bypass_pull_request_allowances: { users: [{ login: 'octo' }], teams: [{ slug: 'release' }], apps: [] } },
    enforce_admins: { enabled: false }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false }, lock_branch: { enabled: true } };
  const fake = fakeGitHub({ protection: structuredClone(original), allowAutoMerge: false });
  const fixture = await install(fake);
  try {
    fake.github.rulesets.push({ id: 41, name: mergeQueueRulesetName, target: 'branch', enforcement: 'active', bypass_actors: [], conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } }, rules: [{ type: 'merge_queue' }] });
    fake.github.rulesets.push({ id: 42, name: 'Operator rules', target: 'branch', enforcement: 'active', rules: [] });
    assert.notDeepEqual(restorePayload(fake.github.protection), restorePayload(original));

    // The plan lists every write and makes none.
    const writes = fake.github.writes.length;
    const plan = await restore(fixture, 'plan');
    assert.equal(fake.github.writes.length, writes, 'the restore plan wrote to GitHub');
    assert.equal(plan.action, 'restore-protection');
    assert.deepEqual(plan.changes.map((change: any) => change.write), [`PUT ${PROTECTION}`, `PATCH repos/${REPOSITORY} allow_auto_merge=false`, `DELETE repos/${REPOSITORY}/rulesets/41`]);
    assert.equal(plan.record, fake.github.recordFile);

    // The apply sends exactly the recorded payload, reverts auto-merge, removes only Graphyard's ruleset, and verifies.
    const summary = await restore(fixture, 'apply');
    assert.deepEqual({ restored: summary.restored, verified: summary.verified }, { restored: true, verified: true });
    const sent = fake.github.writes.slice(writes);
    assert.deepEqual(sent.map(write => write.line), [`gh api --method PUT ${PROTECTION} --input -`, `gh api --method PATCH repos/${REPOSITORY} -F allow_auto_merge=false`, `gh api --method DELETE repos/${REPOSITORY}/rulesets/41`]);
    const put = fixture.transport.commands.filter(command => command.args.includes('PUT') && command.args.includes(PROTECTION)).at(-1)!;
    assert.deepEqual(JSON.parse(put.input!), restorePayload(original));
    assert.deepEqual(JSON.parse(put.input!).required_pull_request_reviews.bypass_pull_request_allowances, { users: ['octo'], teams: ['release'], apps: [] });
    assert.deepEqual(restorePayload(fake.github.protection), restorePayload(original));
    assert.equal(fake.github.allowAutoMerge, false);
    assert.deepEqual(fake.github.rulesets.map(ruleset => ruleset.id), [42]);
    // Restored: a second plan has nothing left to write.
    assert.deepEqual((await restore(fixture, 'plan')).changes, []);
  } finally { await fixture.cleanup(); }

  // A branch that had none: the restore deletes protection, and the re-read finds none.
  const bare = fakeGitHub();
  const unprotected = await install(bare);
  try {
    assert.ok(bare.github.protection);
    const writes = bare.github.writes.length;
    const plan = await restore(unprotected, 'plan');
    assert.deepEqual(plan.changes.map((change: any) => change.write), [`DELETE ${PROTECTION}`, `PATCH repos/${REPOSITORY} allow_auto_merge=false`]);
    assert.equal(bare.github.writes.length, writes);
    const summary = await restore(unprotected, 'apply');
    assert.equal(summary.verified, true);
    assert.equal(bare.github.protection, null);
    assert.equal(bare.github.allowAutoMerge, false);

    // A record for another branch, or in a format this release does not read, refuses before any read.
    await assert.rejects(prepareInstall(unprotected.root, installRequestFromArgs(['--repo', REPOSITORY, '--restore-protection', '--base-branch', 'develop']).request, unprotected.deps, 'plan'), /is for branch main, not develop/);
    const record = JSON.parse(await readFile(bare.github.recordFile, 'utf8'));
    await writeFile(bare.github.recordFile, JSON.stringify({ ...record, format: 'graphyard-protection-record-v9' }));
    await assert.rejects(restore(unprotected, 'plan'), /format graphyard-protection-record-v9, which this release does not read/);
  } finally { await unprotected.cleanup(); }
});
