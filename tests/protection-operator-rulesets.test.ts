import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyOperatorRulesetAdd, applyProtection, protectionPlan, readProtection, restoreRulesetSnapshot, retireOperatorRulesetCheck, rulesetBody, rulesetDigest, rulesetGovernsBranch, type GhAnswer } from '../src/protection.js';
import { applyInstall, buildPlan, installRequestFromArgs, prepareInstall } from '../src/install/index.js';
import { installDirectory } from '../src/install/secrets.js';
import type { Work } from '../src/model.js';
import { githubResponses, harness, GRAPHYARD_APP_ID, REPOSITORY } from './install-harness.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1926: a base branch governed only by operator rulesets. Classic protection answers 404
// "Branch not protected" there, and Graphyard must never write classic protection: it adds its two
// App-bound checks to the one operator ruleset requiring checks, snapshotting, verifying and rolling
// back, and leaves every other ruleset — and every other field of that one — as the operator wrote it.

const APP = 1234, CI = 15368, SHA = 'a'.repeat(40);
const config = { repository: 'owner/project', baseBranch: 'main', githubAppId: APP };
const work = { id: 'w1', key: 'GY-1', stage: 'build', policy: { checks: ['ci'], review: true, reviewProvider: 'agent' } } as unknown as Work;
const GRAPHYARD = [{ context: 'Graphyard / merge', integration_id: APP }, { context: 'graphyard/landable', integration_id: APP }];

/** The two rulesets seen on the onboarding migration: main's (strict, no bypass) and staging's (one always-bypass role). */
const mainRuleset = () => ({ id: 22322922, name: 'main', target: 'branch', source_type: 'Repository', source: REPOSITORY, enforcement: 'active', bypass_actors: [],
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, node_id: 'RRS_main', created_at: 'then', updated_at: 'then', current_user_can_bypass: 'never',
  rules: [{ type: 'deletion' }, { type: 'non_fast_forward' },
    { type: 'pull_request', parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false, allowed_merge_methods: ['merge', 'squash'] } },
    { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, do_not_enforce_on_create: false, required_status_checks: [{ context: 'ci', integration_id: CI }, { context: 'work-context', integration_id: CI }, { context: 'guard', integration_id: CI }] } }] });
const stagingRuleset = () => ({ id: 22322921, name: 'staging', target: 'branch', source_type: 'Repository', source: REPOSITORY, enforcement: 'active',
  bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }], conditions: { ref_name: { include: ['refs/heads/staging'], exclude: [] } },
  rules: [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'ci', integration_id: CI }, { context: 'work-context', integration_id: CI }] } }] });
/** An unrelated operator ruleset on main that requires no checks. */
const signingRuleset = () => ({ id: 22322930, name: 'signed commits', target: 'branch', source_type: 'Repository', source: REPOSITORY, enforcement: 'active', bypass_actors: [],
  conditions: { ref_name: { include: ['refs/heads/main', 'refs/heads/release/*'], exclude: [] } }, rules: [{ type: 'required_signatures' }] });

/**
 * GitHub for one repository whose base has no classic protection: its rulesets (PUT replaces the
 * writable fields), effective rules derived from them, pull requests and check runs. `onPut` can
 * rewrite what a PUT stores, the way a concurrent edit or a lossy write would.
 */
function fakeGitHub(rulesets: any[] = [mainRuleset(), stagingRuleset(), signingRuleset()]) {
  const state = {
    rulesets: new Map(rulesets.map(ruleset => [ruleset.id, structuredClone(ruleset)])), classic: null as any, classicAnswer: null as GhAnswer | null,
    pulls: new Map<number, any>([[42, { number: 42, head: { sha: SHA }, base: { ref: 'main' } }]]), runs: [] as any[], movesHead: false, pullReads: 0,
    calls: [] as string[][], writes: [] as { path: string; body: any }[], onPut: null as null | ((id: number, body: any, count: number) => any),
  };
  const ok = (value: unknown): GhAnswer => ({ stdout: JSON.stringify(value), stderr: '', code: 0 });
  const missing = (stderr = 'gh: Not Found (HTTP 404)'): GhAnswer => ({ stdout: '', stderr, code: 1 });
  const effective = () => [...state.rulesets.values()].filter(ruleset => rulesetGovernsBranch(ruleset, 'main', 'main')).flatMap(ruleset => ruleset.rules.map((rule: any) => ({ ...rule, ruleset_source_type: 'Repository', ruleset_id: ruleset.id })));
  const answer = (args: string[], input?: string): GhAnswer => {
    state.calls.push(args);
    const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET', path = args.find(arg => arg.startsWith('repos/'))!;
    if (method !== 'GET') state.writes.push({ path: `${method} ${path}`, body: input ? JSON.parse(input) : null });
    if (path.endsWith('/branches/main/protection')) return method !== 'GET' ? missing('classic protection must never be written here') : state.classicAnswer ?? (state.classic ? ok(state.classic) : missing('gh: Branch not protected (HTTP 404)'));
    if (path === 'repos/owner/project') return method === 'GET' ? ok({ full_name: REPOSITORY, default_branch: 'main', owner: { type: 'Organization' }, allow_auto_merge: false }) : missing();
    if (path.startsWith('repos/owner/project/rulesets?')) {
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1), size = Number(/per_page=(\d+)/.exec(path)?.[1] ?? 30);
      return ok([...state.rulesets.values()].slice((page - 1) * size, page * size).map(({ id, name, target, enforcement, source_type }) => ({ id, name, target, enforcement, source_type })));
    }
    const ruleset = /^repos\/owner\/project\/rulesets\/(\d+)$/.exec(path);
    if (ruleset) {
      const id = Number(ruleset[1]), current = state.rulesets.get(id);
      if (!current) return missing();
      if (method === 'PUT') {
        const body = JSON.parse(input!), count = state.writes.filter(write => write.path === `PUT ${path}`).length;
        state.rulesets.set(id, { ...current, ...(state.onPut ? state.onPut(id, body, count) : body) });
      }
      return ok(state.rulesets.get(id));
    }
    if (path === 'repos/owner/project/rules/branches/main') return ok(effective());
    const pull = /^repos\/owner\/project\/pulls\/(\d+)$/.exec(path);
    if (pull) {
      const found = state.pulls.get(Number(pull[1]));
      if (found && state.movesHead && state.pullReads++ > 0) return ok({ ...found, head: { sha: 'b'.repeat(40) } });
      return found ? ok(found) : missing();
    }
    if (path.startsWith(`repos/owner/project/commits/${SHA}/check-runs`)) return ok({ total_count: state.runs.length, check_runs: state.runs });
    return missing(`unexpected gh ${args.join(' ')}`);
  };
  const run = (_command: string, args: string[], input?: string) => {
    const result = answer(args, input);
    if (result.code !== 0) throw Object.assign(new Error(`Command failed: gh ${args.join(' ')}\n${result.stderr}`), { stderr: result.stderr, status: result.code });
    return result.stdout;
  };
  const gh = async (args: string[], options: { input?: string } = {}) => answer(args, options.input);
  const puts = () => state.writes.filter(write => write.path.startsWith('PUT '));
  return { state, run, gh, puts };
}
const snapshotsDirectory = () => temporaryDirectory('ruleset-snapshots');
const run = (name: string, appId: number, conclusion = 'success', id = 1) => ({ id, name, status: 'completed', conclusion, app: { id: appId } });

test('unit:protection-reads-operator-rulesets — a classic 404 is no classic protection; the plan names every governing ruleset in full and proposes no classic write', async () => {
  const github = fakeGitHub();
  const current = readProtection(config, github.run);
  const plan: any = protectionPlan(current, config, [work], undefined, []);
  assert.equal(plan.governance, 'operator-ruleset');
  assert.match(plan.classicProtection, /none \(GitHub answered 404 Branch not protected\)/);
  // Every active ruleset whose conditions include main, as full documents; staging's ruleset does not govern main.
  assert.deepEqual(plan.operatorRulesets.map((ruleset: any) => ruleset.id), [22322922, 22322930]);
  assert.deepEqual(plan.operatorRulesets[0], { id: 22322922, name: 'main', enforcement: 'active',
    requiredStatusChecks: [{ context: 'ci', integrationId: CI }, { context: 'work-context', integrationId: CI }, { context: 'guard', integrationId: CI }],
    strict: true, conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, bypassActors: [] });
  assert.deepEqual(plan.operatorRulesets[1].requiredStatusChecks, []);
  assert.ok(Array.isArray(plan.effectiveRules) && plan.effectiveRules.some((rule: any) => rule.type === 'required_status_checks' && rule.ruleset_id === 22322922), 'the branch\'s effective rules are read');
  assert.deepEqual(plan.target, { id: 22322922, name: 'main' });
  assert.deepEqual(plan.changes, [
    `operator ruleset 22322922 (main) required check Graphyard / merge: missing to required from App ${APP}`,
    `operator ruleset 22322922 (main) required check graphyard/landable: missing to required from App ${APP}`]);
  assert.deepEqual(plan.blockers, []);
  assert.ok(!plan.changes.some((change: string) => /classic|review|conversation|queue|auto_merge/.test(change)), 'no classic protection, review, queue or auto-merge change is proposed');
  assert.ok(plan.advisories.some((advisory: string) => /strict/.test(advisory)), 'the operator\'s strict policy is named and left as it is');
  assert.deepEqual(github.state.writes, [], 'planning writes nothing');

  // Any other non-2xx classic answer still refuses, naming it.
  const forbidden = fakeGitHub();
  forbidden.state.classicAnswer = { stdout: '', stderr: 'gh: Must have admin rights to Repository. (HTTP 403)', code: 1 };
  assert.throws(() => readProtection(config, forbidden.run), /HTTP 403/);
  // With no classic protection, an unread rulesets listing refuses instead of reading as no rulesets.
  const unlisted = fakeGitHub();
  const listingFails = (_command: string, args: string[], input?: string) => { if (args.some(arg => arg.includes('/rulesets?'))) throw Object.assign(new Error('gh: Server Error (HTTP 500)'), { stderr: 'gh: Server Error (HTTP 500)' }); return unlisted.run(_command, args, input); };
  assert.throws(() => readProtection(config, listingFails), /no classic protection, and GitHub did not answer its rulesets listing \(gh: Server Error \(HTTP 500\)\)/);
  // A ruleset document that cannot be read refuses, naming it.
  const unreadable = fakeGitHub();
  const documentFails = (_command: string, args: string[], input?: string) => args.includes('repos/owner/project/rulesets/22322930') ? (() => { throw Object.assign(new Error('gh: Server Error (HTTP 500)'), { stderr: 'gh: Server Error (HTTP 500)' }); })() : unreadable.run(_command, args, input);
  assert.throws(() => readProtection(config, documentFails), /GitHub did not answer ruleset 22322930 of owner\/project/);
  // With an operator ruleset governing main, a failed effective-rules read refuses, naming GitHub's answer.
  const noRules = fakeGitHub();
  const rulesFail = (_command: string, args: string[], input?: string) => args.includes('repos/owner/project/rules/branches/main') ? (() => { throw Object.assign(new Error('gh: Forbidden (HTTP 403)'), { stderr: 'gh: Forbidden (HTTP 403)' }); })() : noRules.run(_command, args, input);
  assert.throws(() => readProtection(config, rulesFail), /Operator ruleset\(s\) 22322922 \(main\), 22322930 \(signed commits\) govern owner\/project@main, and GitHub did not answer its effective rules \(gh: Forbidden \(HTTP 403\)\)/);
  // A failed repository read leaves ~DEFAULT_BRANCH unresolved, so it refuses rather than planning the classic path.
  const noRepository = fakeGitHub();
  const repositoryFails = (_command: string, args: string[], input?: string) => args.includes('repos/owner/project') ? (() => { throw Object.assign(new Error('gh: Server Error (HTTP 500)'), { stderr: 'gh: Server Error (HTTP 500)' }); })() : noRepository.run(_command, args, input);
  assert.throws(() => readProtection(config, repositoryFails), /GitHub did not answer the repository owner\/project \(gh: Server Error \(HTTP 500\)\), so whether operator ruleset\(s\) 22322922 \(main\), which target ~DEFAULT_BRANCH, govern main is unknown/);
  // The async read the writes and the installer use agrees.
  const { readOperatorRulesets } = await import('../src/protection.js');
  assert.deepEqual((await readOperatorRulesets(github.gh, REPOSITORY, 'main')).rulesets.map(ruleset => ruleset.id), [22322922, 22322930]);
  const failing = fakeGitHub();
  const failingGh = async (args: string[]) => args.some(arg => arg.includes('/rulesets?')) ? { stdout: '', stderr: 'gh: Server Error (HTTP 500)', code: 1 } : failing.gh(args);
  await assert.rejects(readOperatorRulesets(failingGh, REPOSITORY, 'main'), /GitHub did not answer page 1 of the rulesets of owner\/project/);
  // A classic-protected branch with no operator ruleset plans exactly as before.
  const classic = fakeGitHub([stagingRuleset()]);
  classic.state.classic = { required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: APP }, { context: 'graphyard/landable', app_id: APP }] }, enforce_admins: { enabled: true },
    required_pull_request_reviews: { required_approving_review_count: 0, require_last_push_approval: false, dismiss_stale_reviews: true } };
  const classicPlan: any = protectionPlan(readProtection(config, classic.run), config, [work], undefined, []);
  assert.equal(classicPlan.governance, undefined);
  assert.equal(classicPlan.landableCheck, true);
});

test('unit:protection-adds-graphyard-checks-to-operator-ruleset — --apply adds exactly the two App-bound checks to the one ruleset requiring checks, after a snapshot, and writes nothing the second time', async () => {
  const github = fakeGitHub(), snapshots = await snapshotsDirectory();
  try {
    const before = mainRuleset();
    const applied: any = await applyProtection(config, [work], github.run, [], { snapshots, now: 1_000 });
    assert.equal(applied.applied, true); assert.equal(applied.consistent, true); assert.equal(applied.ruleset, 22322922);
    // One write: the PUT of main's ruleset, equal to its document with only the two entries added.
    assert.deepEqual(github.state.writes.map(write => write.path), ['PUT repos/owner/project/rulesets/22322922']);
    const expected = rulesetBody(before);
    expected.rules = expected.rules.map((rule: any) => rule.type === 'required_status_checks' ? { ...rule, parameters: { ...rule.parameters, required_status_checks: [...rule.parameters.required_status_checks, ...GRAPHYARD] } } : rule);
    assert.deepEqual(github.state.writes[0].body, expected);
    assert.equal(github.state.writes[0].body.rules.find((rule: any) => rule.type === 'required_status_checks').parameters.strict_required_status_checks_policy, true, 'strict stays as the operator set it');
    // The unrelated and the non-base rulesets are unchanged and never read for writing.
    assert.deepEqual(github.state.rulesets.get(22322921), stagingRuleset());
    assert.deepEqual(github.state.rulesets.get(22322930), signingRuleset());
    for (const id of [22322921, 22322930]) assert.ok(!github.state.writes.some(write => write.path.endsWith(`/${id}`)));
    // The snapshot holds the fresh full GET document and its digest.
    const files = await readdir(snapshots);
    assert.equal(files.length, 1); assert.match(files[0], /^ruleset-22322922-/);
    const snapshot = JSON.parse(await readFile(join(snapshots, files[0]), 'utf8'));
    assert.deepEqual(snapshot.document, before); assert.equal(snapshot.digest, rulesetDigest(before)); assert.equal(snapshot.rulesetId, 22322922);
    assert.equal(applied.snapshot, join(snapshots, files[0]));

    // Twice: nothing is written the second time.
    const again: any = await applyProtection(config, [work], github.run, [], { snapshots, now: 2_000 });
    assert.equal(again.applied, false); assert.equal(github.state.writes.length, 1); assert.equal((await readdir(snapshots)).length, 1);
    assert.match(again.result, /already requires Graphyard \/ merge and graphyard\/landable from App 1234; nothing was written/);

    // Zero or several qualifying rulesets refuse, naming each candidate, and write nothing.
    const none = fakeGitHub([signingRuleset(), stagingRuleset()]);
    await assert.rejects(applyProtection(config, [work], none.run, [], { snapshots, now: 3_000 }), /No operator ruleset governing main requires status checks \(governing: 22322930 \(signed commits\)\)/);
    const several = fakeGitHub([mainRuleset(), { ...stagingRuleset(), id: 22322923, name: 'main extra', conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } } }]);
    await assert.rejects(applyOperatorRulesetAdd(several.gh, { ...config, snapshots, now: 3_000 }), /Several operator rulesets require status checks on main: 22322922 \(main\), 22322923 \(main extra\)/);
    assert.deepEqual([...none.state.writes, ...several.state.writes], []);
  } finally { await rm(snapshots, { recursive: true, force: true }); }
});

test('unit:protection-ruleset-write-verifies-and-rolls-back — a re-read that differs from the snapshot plus the two entries puts the snapshot back and verifies its digest', async () => {
  const snapshots = await snapshotsDirectory();
  try {
    // GitHub stores a different body than was sent (a bypass actor appears): the add rolls back.
    const lossy = fakeGitHub();
    lossy.state.onPut = (_id, body, count) => count === 1 ? { ...body, bypass_actors: [{ actor_id: 9, actor_type: 'Team', bypass_mode: 'always' }] } : body;
    await assert.rejects(applyOperatorRulesetAdd(lossy.gh, { ...config, snapshots, now: 1_000 }),
      /did not verify: ruleset 22322922 reads back .*not the snapshot with only Graphyard \/ merge@1234 and graphyard\/landable@1234 added; rolled ruleset 22322922 back to .*ruleset-22322922-.*; it reads back digest [0-9a-f]{64}, equal to the snapshot's [0-9a-f]{64}/);
    assert.deepEqual(lossy.puts().length, 2, 'the write and the rollback');
    assert.deepEqual(lossy.state.writes[1].body, rulesetBody(mainRuleset()), 'the rollback PUTs the saved document');
    assert.equal(rulesetDigest(lossy.state.rulesets.get(22322922)), rulesetDigest(mainRuleset()));
    assert.deepEqual(lossy.state.rulesets.get(22322921), stagingRuleset());

    // A rollback that does not restore the snapshot says so: both results are reported.
    const stuck = fakeGitHub();
    stuck.state.onPut = (_id, body) => ({ ...body, enforcement: 'evaluate' });
    await assert.rejects(applyOperatorRulesetAdd(stuck.gh, { ...config, snapshots, now: 2_000 }), /did not verify: .*; rolled ruleset 22322922 back .* NOT equal to the snapshot's/);

    // The ruleset reads back right but the branch's effective rules differ by more than the add: rolled back too.
    // Each rewrite keeps both Graphyard entries, so only the before/after diff can catch it.
    const effectiveAfterWrite = (rewrite: (rules: any[]) => any[]) => {
      const github = fakeGitHub();
      const gh = async (args: string[], options: { input?: string } = {}) => {
        const answer = await github.gh(args, options);
        return args.includes('repos/owner/project/rules/branches/main') && github.puts().length === 1 ? { ...answer, stdout: JSON.stringify(rewrite(JSON.parse(answer.stdout))) } : answer;
      };
      return { github, gh };
    };
    const editChecks = (rules: any[], edit: (parameters: any) => any) => rules.map(rule => rule.type === 'required_status_checks' && rule.ruleset_id === 22322922 ? { ...rule, parameters: edit(rule.parameters) } : rule);
    const cases: [string, (rules: any[]) => any[]][] = [
      ['an existing required check dropped', rules => editChecks(rules, parameters => ({ ...parameters, required_status_checks: parameters.required_status_checks.filter((check: any) => check.context !== 'guard') }))],
      ['strict switched off', rules => editChecks(rules, parameters => ({ ...parameters, strict_required_status_checks_policy: false }))],
      ['a rule\'s provenance changed', rules => rules.map(rule => rule.type === 'deletion' ? { ...rule, ruleset_id: 1 } : rule)],
      ['every rule gone', () => []],
    ];
    for (const [name, rewrite] of cases) {
      const { github, gh } = effectiveAfterWrite(rewrite);
      await assert.rejects(applyOperatorRulesetAdd(gh, { ...config, snapshots, now: 3_000 }), /the effective rules of the base differ from those read before the write by more than Graphyard \/ merge@1234 and graphyard\/landable@1234 added: .*; rolled ruleset 22322922 back .* equal to the snapshot's/, name);
      assert.equal(github.puts().length, 2, `${name}: the write and the rollback`);
      assert.equal(rulesetDigest(github.state.rulesets.get(22322922)), rulesetDigest(mainRuleset()), name);
    }
    // Effective rules that do not show the target's checks before the write refuse with nothing written.
    const unseen = fakeGitHub();
    const unseenGh = async (args: string[], options: { input?: string } = {}) => args.includes('repos/owner/project/rules/branches/main') ? { stdout: '[]', stderr: '', code: 0 } : unseen.gh(args, options);
    await assert.rejects(applyOperatorRulesetAdd(unseenGh, { ...config, snapshots, now: 3_500 }), /do not show ruleset 22322922's required checks, so a write to it cannot be verified; nothing was written/);
    assert.deepEqual(unseen.state.writes, []);

    // A document answered without its bypass actors is never written: a PUT of it would clear them.
    const partial = fakeGitHub([{ ...mainRuleset(), bypass_actors: undefined }]);
    await assert.rejects(applyOperatorRulesetAdd(partial.gh, { ...config, snapshots, now: 4_000 }), /without its bypass actors, conditions or rules/);
    assert.deepEqual(partial.state.writes, []);
  } finally { await rm(snapshots, { recursive: true, force: true }); }
});

test('unit:protection-retires-only-proven-check — --retire removes one named non-Graphyard check only once both Graphyard checks stand and every staying check succeeded on the proof head', async () => {
  const snapshots = await snapshotsDirectory();
  try {
    const github = fakeGitHub();
    const retire = (check: string, now: number) => retireOperatorRulesetCheck(github.gh, { ...config, snapshots, now, check: { context: check.split('@')[0], integration_id: Number(check.split('@')[1]) }, proof: 42 });
    // Before Graphyard's checks are required, nothing may be retired.
    await assert.rejects(retire(`guard@${CI}`, 1), /does not yet require Graphyard \/ merge and graphyard\/landable from App 1234/);
    await applyOperatorRulesetAdd(github.gh, { ...config, snapshots, now: 2 });
    const writes = github.state.writes.length;
    // Graphyard's own checks are never retired.
    await assert.rejects(retire(`Graphyard / merge@${APP}`, 3), /Graphyard \/ merge is one of Graphyard's own checks/);
    // A check the ruleset does not require is refused.
    await assert.rejects(retire(`lint@${CI}`, 3), /does not require lint@15368/);
    // Every staying check, and both Graphyard checks, must read success on the proof's exact head.
    github.state.runs = [run('ci', CI, 'success', 1), run('work-context', CI, 'success', 2), run('Graphyard / merge', APP, 'success', 3)];
    await assert.rejects(retire(`guard@${CI}`, 3), /graphyard\/landable@1234 has no run/);
    github.state.runs.push(run('graphyard/landable', 999, 'success', 4));
    await assert.rejects(retire(`guard@${CI}`, 3), /graphyard\/landable@1234 has no run/, 'a run from another App is not the Graphyard check');
    github.state.runs.push(run('graphyard/landable', APP, 'success', 5), run('ci', CI, 'failure', 6));
    await assert.rejects(retire(`guard@${CI}`, 3), /ci@15368 reads completed\/failure/, 'the latest run decides');
    github.state.runs.push(run('ci', CI, 'success', 7));
    github.state.movesHead = true; github.state.pullReads = 0;
    await assert.rejects(retire(`guard@${CI}`, 3), /head moved/);
    github.state.movesHead = false;
    assert.equal(github.state.writes.length, writes, 'no refusal wrote anything');

    // The write binds to the fresh document: a check the operator adds after discovery must be proven too.
    const original = structuredClone(github.state.rulesets.get(22322922));
    const amend = (change: (checks: any[]) => any[]) => {
      let armed = true;
      const gh = async (args: string[], options: { input?: string } = {}) => {
        if (armed && args.includes('repos/owner/project/pulls/42')) {
          armed = false;
          const ruleset = github.state.rulesets.get(22322922);
          ruleset.rules = ruleset.rules.map((rule: any) => rule.type === 'required_status_checks' ? { ...rule, parameters: { ...rule.parameters, required_status_checks: change(rule.parameters.required_status_checks) } } : rule);
        }
        return github.gh(args, options);
      };
      return retireOperatorRulesetCheck(gh, { ...config, snapshots, now: 4, check: { context: 'guard', integration_id: CI }, proof: 42 });
    };
    await assert.rejects(amend(checks => [...checks, { context: 'lint', integration_id: CI }]), /the latest run of lint@15368 has no run/);
    github.state.rulesets.set(22322922, structuredClone(original));
    await assert.rejects(amend(checks => checks.filter(check => check.context !== 'graphyard/landable')), /does not yet require graphyard\/landable from App 1234/);
    github.state.rulesets.set(22322922, structuredClone(original));
    assert.equal(github.state.writes.length, writes, 'a document changed before the write is never written');

    // The effective rules after the write must lack exactly the retired entry, or the snapshot goes back.
    const kept = async (args: string[], options: { input?: string } = {}) => {
      const answer = await github.gh(args, options);
      return args.includes('repos/owner/project/rules/branches/main') && github.puts().length === writes + 1 ? { ...answer, stdout: JSON.stringify(JSON.parse(answer.stdout).map((rule: any) => rule.type === 'required_status_checks' ? { ...rule, parameters: { ...rule.parameters, required_status_checks: [...rule.parameters.required_status_checks, { context: 'guard', integration_id: CI }] } } : rule)) } : answer;
    };
    await assert.rejects(retireOperatorRulesetCheck(kept, { ...config, snapshots, now: 5, check: { context: 'guard', integration_id: CI }, proof: 42 }), /guard@15368 removed: .*; rolled ruleset 22322922 back .* equal to the snapshot's/);
    assert.deepEqual(rulesetBody(github.state.rulesets.get(22322922)), rulesetBody(original));
    github.state.writes.length = writes;

    const retired: any = await retire(`guard@${CI}`, 6);
    assert.equal(retired.retired, `guard@${CI}`); assert.deepEqual(retired.proof, { pullRequest: 42, head: SHA });
    const written = github.state.writes.slice(writes);
    assert.deepEqual(written.map(write => write.path), ['PUT repos/owner/project/rulesets/22322922']);
    assert.deepEqual(written[0].body.rules.find((rule: any) => rule.type === 'required_status_checks').parameters.required_status_checks,
      [{ context: 'ci', integration_id: CI }, { context: 'work-context', integration_id: CI }, ...GRAPHYARD]);
    assert.deepEqual(written[0].body.rules.filter((rule: any) => rule.type !== 'required_status_checks'), mainRuleset().rules.filter(rule => rule.type !== 'required_status_checks'));
    assert.ok(existsSync(retired.snapshot));
    assert.deepEqual(github.state.rulesets.get(22322921), stagingRuleset());
    assert.ok(!github.state.writes.some(write => write.path.includes('/protection')), 'classic protection is never touched');
  } finally { await rm(snapshots, { recursive: true, force: true }); }
});

test('unit:protection-restores-ruleset-snapshot — --restore puts a saved snapshot back to its ruleset and verifies the digest', async () => {
  const snapshots = await snapshotsDirectory();
  try {
    const github = fakeGitHub();
    const added: any = await applyOperatorRulesetAdd(github.gh, { ...config, snapshots, now: 1 });
    assert.notEqual(rulesetDigest(github.state.rulesets.get(22322922)), rulesetDigest(mainRuleset()));
    const restored = await restoreRulesetSnapshot(github.gh, config, added.snapshot);
    assert.deepEqual(restored, { restored: true, verified: true, ruleset: 22322922, snapshot: added.snapshot, digest: rulesetDigest(mainRuleset()) });
    assert.deepEqual(rulesetBody(github.state.rulesets.get(22322922)), rulesetBody(mainRuleset()));
    assert.deepEqual(github.state.writes.map(write => write.path), ['PUT repos/owner/project/rulesets/22322922', 'PUT repos/owner/project/rulesets/22322922']);
    assert.deepEqual(github.state.rulesets.get(22322921), stagingRuleset());

    // A snapshot edited after it was taken, or one for another repository, refuses before writing.
    const text = await readFile(added.snapshot, 'utf8');
    const tampered = join(snapshots, 'tampered.json'), foreign = join(snapshots, 'foreign.json');
    await writeFile(tampered, text.replace('"strict_required_status_checks_policy": true', '"strict_required_status_checks_policy": false'));
    await writeFile(foreign, JSON.stringify({ ...JSON.parse(text), repository: 'other/project' }));
    const writes = github.state.writes.length;
    await assert.rejects(restoreRulesetSnapshot(github.gh, config, tampered), /does not match its own digest/);
    await assert.rejects(restoreRulesetSnapshot(github.gh, config, foreign), /is for other\/project, not owner\/project/);
    assert.equal(github.state.writes.length, writes);
    // A restore GitHub does not store faithfully is reported, not claimed.
    github.state.onPut = (_id, body) => ({ ...body, enforcement: 'disabled' });
    await assert.rejects(restoreRulesetSnapshot(github.gh, config, added.snapshot), /reads back digest [0-9a-f]{64}, not the snapshot's/);
  } finally { await rm(snapshots, { recursive: true, force: true }); }
});

/** The installer's gh against the same fake, with the harness's own answers for everything else. */
function installResponses(github: ReturnType<typeof fakeGitHub>, published = true) {
  const defaults = githubResponses({ installed: false, protection: null, deliveries: [], hookConfig: null });
  github.state.runs = published ? [run('Graphyard / merge', GRAPHYARD_APP_ID, 'success', 1)] : [];
  const answer = (line: string, input?: string) => {
    const args = line.replace(/^gh /, '').split(' ');
    const path = args.find(arg => arg.startsWith('repos/')) ?? '';
    if (path.includes('/commits/main/check-runs')) return JSON.stringify({ check_runs: [{ name: 'ci', app: { id: CI } }, ...(published ? [{ name: 'Graphyard / merge', app: { id: GRAPHYARD_APP_ID } }] : [])] });
    if (path.startsWith('repos/owner/project/') && !path.includes('/commits/') || path === 'repos/owner/project') {
      if (line.includes('PATCH repos/owner/project ')) { github.state.writes.push({ path: 'PATCH repos/owner/project', body: null }); return '{}'; }
      return github.gh(args, { input });
    }
    const fallback = defaults.find(entry => line.includes(entry.match));
    if (!fallback) return '';
    return typeof fallback.result === 'function' ? (fallback.result as any)(line, input) : fallback.result;
  };
  return [{ match: 'gh api', result: answer }];
}
const graphyardFor = (appId: number) => GRAPHYARD.map(entry => ({ ...entry, integration_id: appId }));

test('unit:install-preserves-operator-rulesets — install plans and applies the ruleset add, never classic protection, refuses by name, and its restore points at master protection --restore', async () => {
  // Apply: no classic protection is read as an error, recorded or written; the ruleset gains exactly the two checks.
  const github = fakeGitHub();
  const fixture = await harness({ provider: 'railway', extraResponses: installResponses(github) as any });
  try {
    const session = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'railway' }, fixture.deps);
    const plan: any = await buildPlan(session);
    const step = plan.actions.find((action: any) => action.id === 'github.protection');
    assert.match(step.title, /to the required checks of operator ruleset 22322922 \(main\) on main.*classic protection is never written while an operator ruleset governs main/);
    assert.ok(!plan.preflight.some((item: any) => !item.ok && /ruleset|protection/i.test(item.name)), JSON.stringify(plan.preflight));
    // The classic 404 is never described as an unprotected branch the plan protects.
    const gate = plan.preflight.find((item: any) => item.name === 'Branch protection');
    assert.match(gate.detail, /main has no classic protection; operator ruleset\(s\) 22322922 \(main\), 22322930 \(signed commits\) govern it/);
    assert.doesNotMatch(gate.detail, /not protected yet/);
    assert.ok(!plan.drift.some((entry: any) => entry.action === 'github.protection'), 'no classic protection drift is planned');
    const summary: any = await applyInstall(session, plan);
    assert.match(summary.protection, /operator ruleset 22322922 \(main\) now requires Graphyard \/ merge and graphyard\/landable/);
    const writes = github.state.writes.filter(write => write.path !== 'PATCH repos/owner/project');
    assert.deepEqual(writes.map(write => write.path), ['PUT repos/owner/project/rulesets/22322922']);
    assert.deepEqual(writes[0].body.rules.find((rule: any) => rule.type === 'required_status_checks').parameters.required_status_checks,
      [{ context: 'ci', integration_id: CI }, { context: 'work-context', integration_id: CI }, { context: 'guard', integration_id: CI }, ...graphyardFor(GRAPHYARD_APP_ID)]);
    assert.ok(!github.state.calls.some(call => call.includes('--method') && call.some(arg => arg.endsWith('/protection') || arg.includes('/protection/'))), 'classic protection is never written');
    assert.ok(!existsSync(join(installDirectory('owner-project', fixture.configHome), 'protection-record.json')), 'no classic protection record is taken');
    assert.equal((await readdir(join(fixture.root, '.graphyard', 'protection-snapshots'))).length, 1);
    assert.deepEqual(github.state.rulesets.get(22322921), stagingRuleset());
    assert.deepEqual(github.state.rulesets.get(22322930), signingRuleset());

    // --restore-protection, straight after this install and with no classic record, reports in plan and
    // apply that operator rulesets are restored only through master protection --restore, and writes nothing.
    const writesBefore = github.state.writes.length;
    for (const mode of ['plan', 'apply'] as const) {
      const restoreSession = await prepareInstall(fixture.root, installRequestFromArgs(['--repo', REPOSITORY, '--restore-protection', `--${mode}`]).request, fixture.deps, mode);
      const restorePlan: any = await buildPlan(restoreSession);
      const reported: any = mode === 'plan' ? restorePlan : await applyInstall(restoreSession, restorePlan);
      assert.equal(reported.branch, 'main'); assert.deepEqual(reported.changes, []); assert.equal(reported.recordedAt, null);
      assert.deepEqual(reported.operatorRulesets.rulesets, [{ id: 22322922, name: 'main' }, { id: 22322930, name: 'signed commits' }]);
      assert.equal(reported.operatorRulesets.restored, false);
      assert.match(reported.operatorRulesets.note, /restored only through graphyard master protection --restore SNAPSHOT/);
      if (mode === 'apply') assert.equal(reported.restored, false);
    }
    assert.equal(github.state.writes.length, writesBefore);

    // With a classic record too, its plan still carries the note.
    const directory = installDirectory('owner-project', fixture.configHome);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'protection-record.json'), JSON.stringify({ format: 'graphyard-protection-record-v1', repository: REPOSITORY, branch: 'main', recordedAt: 'recorded', protection: null, allowAutoMerge: false, mergeQueueRuleset: null }));
    const restoreSession = await prepareInstall(fixture.root, installRequestFromArgs(['--repo', REPOSITORY, '--restore-protection', '--plan']).request, fixture.deps, 'plan');
    const restorePlan: any = await buildPlan(restoreSession);
    assert.match(restorePlan.operatorRulesets.note, /restored only through graphyard master protection --restore SNAPSHOT/);
  } finally { await fixture.cleanup(); }

  // A first install, before the App has published its check on main: install stops naming the ruleset and the refusal, writing nothing.
  const unpublished = fakeGitHub();
  const first = await harness({ provider: 'railway', extraResponses: installResponses(unpublished, false) as any });
  try {
    const session = await prepareInstall(first.root, { repository: REPOSITORY, provider: 'railway' }, first.deps);
    const plan: any = await buildPlan(session);
    await assert.rejects(applyInstall(session, plan), /main is governed by operator ruleset\(s\) 22322922 \(main\), 22322930 \(signed commits\), so the installer writes no classic protection there, and adding Graphyard's checks was refused: App \d+ has not yet published Graphyard \/ merge on main/);
    assert.deepEqual(unpublished.state.writes.filter(write => write.path !== 'PATCH repos/owner/project'), []);
  } finally { await first.cleanup(); }

  // Refused: two rulesets carry checks for main, so the plan stops naming both, and apply writes nothing.
  const several = fakeGitHub([mainRuleset(), { ...stagingRuleset(), id: 22322923, name: 'main extra', conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } } }]);
  const refused = await harness({ provider: 'railway', extraResponses: installResponses(several) as any });
  try {
    const session = await prepareInstall(refused.root, { repository: REPOSITORY, provider: 'railway' }, refused.deps);
    const plan: any = await buildPlan(session);
    const gate = plan.preflight.find((item: any) => item.name === 'Branch protection' && !item.ok);
    assert.match(gate.detail, /main is governed by operator ruleset\(s\) 22322922 \(main\), 22322923 \(main extra\).*Several operator rulesets require status checks on main/);
    await assert.rejects(applyInstall(session, plan), /Several operator rulesets require status checks on main: 22322922 \(main\), 22322923 \(main extra\)/);
    assert.deepEqual(several.state.writes.filter(write => write.path !== 'PATCH repos/owner/project'), []);
  } finally { await refused.cleanup(); }
});
