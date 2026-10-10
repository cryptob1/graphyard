import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Loaded inside each case, so a tree without this change fails these cases rather than the file.
const modules = async () => ({ ...await import('../src/model.js'), ...await import('../src/model/approval.js'), ...await import('../src/model/bootstrap.js'), ...await import('../src/model/landability.js'), ...await import('../src/reviewer.js'), ...await import('../src/master-verification.js'), ...await import('../src/cli/planned-files-intent.js') });

// unit:post-deploy-criteria (GY-1660) — a criterion only the live install can satisfy after merge
// and deploy deadlocked reviewer and worker (GY-1652 AC-3, GY-1657 AC-1..4). It is refused at
// create and requirements revision unless declared with a manual:post-deploy/ proof; a declared
// one is judged on the head's pre-merge evidence and checked by master verify-deployment on the
// serving release, which files a follow-up naming the delivered item when it fails.

// The live-observation criteria that deadlocked, as they were written.
const gy1652 = { id: 'AC-3', text: "'master status' on the live install reports harnessDrift null after a loop cycle running this remedy", proofs: ['manual:harness-drift-cleared'] };
const gy1657 = { id: 'AC-2', text: 'After the paths are clean, the master loop restarts through graphyard-master.service without the dirty-checkout refusal', proofs: ['integration:dirty-checkout-escalation-clears'] };
const restarted = { id: 'AC-3', text: 'The restarted loop serves a commit newer than e09c849886c3', proofs: ['integration:coordinator-serves-current-release'] };
const intent = (criteria: { id: string; text: string; proofs: string[] }[]) => ({ title: 'Item', criteria });

test('unit:post-deploy-criteria — an undeclared live-install observation is refused at create, naming the criterion', async () => {
  const { createSchema, liveObservationPhrase, postDeployCriterionRefusal } = await modules();
  for (const criterion of [gy1652, gy1657, restarted]) {
    assert.ok(liveObservationPhrase(criterion), `${criterion.text} is a live observation`);
    const parsed = createSchema.safeParse(intent([{ id: 'AC-1', text: 'A unit test covers it', proofs: ['unit:covered'] }, criterion]));
    assert.equal(parsed.success, false);
    const message = parsed.error!.issues.map(issue => issue.message).join('\n');
    assert.match(message, new RegExp(`^${criterion.id} \\(`));
    assert.match(message, /manual:post-deploy\/NAME/);
  }
  assert.match(postDeployCriterionRefusal([gy1652, { ...restarted, id: 'AC-4' }])!, /^AC-3 \("live install"\), AC-4 \("restarted loop"\) are live-install or post-deploy observations/);
});

test('unit:post-deploy-criteria — the refusal holds on every requirements path: the shared criterion schema, a direct revision and a requirements decision', async () => {
  const { criterionSchema, decisionInputs } = await modules();
  for (const criterion of [gy1652, gy1657, restarted]) {
    const refused = criterionSchema.safeParse(criterion);
    assert.equal(refused.success, false, `${criterion.id} is refused by the criterion schema every requirements input uses`);
    assert.match(refused.error!.issues.map(issue => issue.message).join('\n'), /manual:post-deploy\/NAME/);
    const decision = decisionInputs.requirements.safeParse({ expectedPolicyRevision: 1, criteria: [criterion], dependencies: [], plannedFiles: [], exclusiveResources: [], producerProofs: [] });
    assert.equal(decision.success, false, 'an approved master decide requirements cannot carry it either');
    assert.equal(decisionInputs.requirements.safeParse({ expectedPolicyRevision: 1, criteria: [{ ...criterion, proofs: ['manual:post-deploy/observed'] }], dependencies: [], plannedFiles: [], exclusiveResources: [], producerProofs: [] }).success, true);
  }
});

test('unit:post-deploy-criteria — a declared post-deploy verification, a head-anchored observation and ordinary criteria are accepted; a live outcome is caught whatever its proof family', async () => {
  const { createSchema, liveObservationPhrase } = await modules();
  const declared = { ...gy1652, proofs: ['manual:post-deploy/harness-drift-cleared'] };
  assert.equal(createSchema.safeParse(intent([declared])).success, true);
  // A declared criterion may open "After deploy": the GY-188 post-merge refusal yields to the declaration.
  const afterDeploy = { id: 'AC-2', text: 'After deploy, the live install reports the remedy applied', proofs: ['manual:post-deploy/status'] };
  assert.equal(createSchema.safeParse(intent([afterDeploy])).success, true);
  // Undeclared, that wording is still refused, and a declared proof never excuses a post-merge proof name beside it.
  assert.equal(createSchema.safeParse(intent([{ ...afterDeploy, proofs: ['manual:status'] }])).success, false);
  assert.equal(createSchema.safeParse(intent([{ ...afterDeploy, proofs: ['manual:post-deploy/status', 'manual:status-postmerge'] }])).success, false);
  // GY-1652's reworded AC-3 observes this head against the live install: a pre-merge observation.
  const anchored = { id: 'AC-3', text: 'From this head against the live install, `node bin/graphyard.mjs master status` reports harnessDrift null', proofs: ['manual:harness-drift-cleared'] };
  assert.equal(liveObservationPhrase(anchored), null);
  assert.equal(createSchema.safeParse(intent([anchored])).success, true);
  // An integration proven against a stub is a pre-merge exercise.
  assert.equal(liveObservationPhrase({ id: 'AC-1', text: 'Proven before merge against a stubbed deployed release', proofs: ['integration:deploy'] }), null);
  // No proof-family shortcut: a unit-proven wording of a live outcome is a live outcome.
  const unitLive = { id: 'AC-1', text: 'The restarted loop serves the delivered commit', proofs: ['unit:serves'] };
  assert.equal(liveObservationPhrase(unitLive), 'restarted loop');
  assert.equal(createSchema.safeParse(intent([unitLive])).success, false);
  // The wording Graphyard filed for a recurring intervention pattern (GY-1660's own AC-1) is a post-ship
  // outcome: undeclared, it is refused, naming the phrase.
  const shipped = { id: 'AC-1', text: 'The cause of the recurring escalation interventions at the build stage is found and removed: the intervention report shows the escalation rate at the build stage below 3 per 7 days after the change ships, and the linked instances could not recur', proofs: ['manual:intervention-pattern-escalation-build'] };
  assert.equal(liveObservationPhrase(shipped), 'after the change ships');
  assert.equal(createSchema.safeParse(intent([shipped])).success, false);
  assert.equal(createSchema.safeParse(intent([{ id: 'AC-1', text: 'Ordinary behaviour is covered', proofs: ['unit:covered'] }])).success, true);
});

test('unit:post-deploy-criteria — the criterion Graphyard files for a recurring intervention pattern names only what the head can show', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/interventions/patterns.ts', import.meta.url), 'utf8'));
  const template = /criteria: \[\{ id: 'AC-1', text: `([^`]+)`/.exec(source)![1];
  const text = template.replace(/\$\{[^}]+\}/g, 'X');
  const { createSchema, liveObservationPhrase } = await modules();
  assert.equal(liveObservationPhrase({ text }), null, text);
  assert.equal(createSchema.safeParse(intent([{ id: 'AC-1', text, proofs: ['manual:intervention-pattern-escalation-build'] }])).success, true);
});

test('unit:post-deploy-criteria — a declared post-deploy proof gates no merge in any lane', async () => {
  const { laneRequiresProof, requiredProofs, evaluateLandability } = await modules();
  for (const lane of ['low', 'medium', 'high'] as const) assert.equal(laneRequiresProof(lane, 'manual:post-deploy/harness-drift-cleared'), false, lane);
  assert.equal(laneRequiresProof('high', 'manual:harness-drift-cleared'), true);
  // An unobserved change rides the high lane, where every other manual: proof is demanded before merge.
  const reasons = (work: Work) => { const verdict = evaluateLandability(work, [work], new Date()); return verdict.verdict === 'refused' ? verdict.reasons.map(reason => reason.reason).join('\n') : ''; };
  const declared = delivered({ stage: 'acceptance', delivery: undefined }), undeclared = delivered({ stage: 'acceptance', delivery: undefined, criteria: [{ ...gy1652 }] });
  assert.deepEqual(requiredProofs(declared, [declared]).filter(proof => proof.startsWith('manual:post-deploy/')), []);
  assert.ok(requiredProofs(undeclared, [undeclared]).includes('manual:harness-drift-cleared'));
  assert.match(reasons(undeclared), /manual:harness-drift-cleared needs trusted passing evidence/);
  assert.ok(!reasons(declared).includes('manual:post-deploy/'), reasons(declared));
});

test('unit:post-deploy-criteria — master requirements refuses an undeclared live observation before reading the tree or posting', async () => {
  const { derivedIntent } = await modules();
  const directory = await temporaryDirectory('post-deploy-intent');
  const file = join(directory, 'intent.json');
  await writeFile(file, JSON.stringify({ criteria: [gy1657], dependencies: [], plannedFiles: [] }));
  const work = { id: 'a1b2c3d4-0000-4000-8000-000000000001', key: 'GY-7', policyRevision: 1, criteria: [], dependencies: [], plannedFiles: [] };
  const deps = { coordinator: async () => ({ work: [work] }), mutate: async () => assert.fail('nothing is posted'), token: async () => 'token', tree: async () => assert.fail('the tree is not read') };
  await assert.rejects(derivedIntent(directory, { baseBranch: 'main' }, 'requirements', ['GY-7', file, 'revise'], deps), /^Error: AC-2 \("the master loop restarts"\) is a live-install or post-deploy observation/);
  await writeFile(file, JSON.stringify({ title: 'New', criteria: [gy1657] }));
  await assert.rejects(derivedIntent(directory, { baseBranch: 'main' }, 'create', [file, 'file it'], deps), /AC-2 \("the master loop restarts"\)/);
});

test('unit:post-deploy-criteria — the reviewer judges a declared criterion on the head\'s pre-merge evidence and never holds the merge for the live observation', async () => {
  const { postDeployReviewSection, reviewPrompt } = await modules();
  const config = { repository: 'owner/project', cliPath: '/opt/graphyard/bin/graphyard.mjs' };
  const binding = { key: 'GY-7', pr: 9, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1 };
  const ordinary = [{ id: 'AC-1', text: 'A test covers it', proofs: ['unit:covered'] }];
  const declared = [...ordinary, { ...gy1652, proofs: ['manual:post-deploy/harness-drift-cleared'] }];
  assert.equal(postDeployReviewSection(ordinary), '');
  assert.equal(postDeployReviewSection(ordinary.map(({ id, text }) => ({ id, text }))), '');
  const section = postDeployReviewSection(declared);
  assert.match(section, /^AC-3 is a declared post-deploy verification/);
  assert.match(section, /on this head's pre-merge evidence/);
  assert.match(section, /never request changes or hold the merge because the live install or deployed release has not shown it yet/);
  assert.match(section, /master verify-deployment checks it on the serving release after delivery and files a follow-up naming the delivered item when it fails/);
  // GitHub mode and control-plane mode both carry it; an item with none keeps its request byte-identical.
  const plain = reviewPrompt(config, binding, undefined, undefined, ordinary);
  assert.equal(plain, reviewPrompt(config, binding, undefined, undefined, ordinary.map(({ id, text }) => ({ id, text }))));
  assert.ok(!plain.includes('post-deploy verification'));
  assert.ok(reviewPrompt(config, binding, undefined, undefined, declared).includes(section));
  const plane = { head: binding.sha, baseTip: binding.baseSha };
  assert.ok(reviewPrompt(config, binding, undefined, undefined, declared, undefined, undefined, null, null, null, null, null, plane).includes(section));
});

const release = 'c'.repeat(40), mergeSha = 'd'.repeat(40);
function delivered(overrides: Partial<Work> = {}): Work {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return { id: 'e4b2a3c8-1c0e-4d0a-9b4e-1f2a3b4c5d6e', key: 'GY-42', title: 'Harness remedy', description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'A test covers it', proofs: ['unit:covered'] }, { ...gy1652, proofs: ['manual:post-deploy/harness-drift-cleared'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'done', revision: 3, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], candidate: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], delivery: { mergedAt: at, mergeSha, authorizationRevision: 2 }, ...overrides } as Work;
}

test('unit:post-deploy-criteria — master verify-deployment checks a declared criterion on the serving release and files one follow-up naming the delivered item when it fails', async () => {
  const { createSchema, filePostDeployFollowUps, postDeployChecks, verifyDeployment } = await modules();
  const checks = postDeployChecks(delivered(), release);
  assert.equal(checks.length, 1);
  const [owed] = checks;
  assert.equal(owed.result, 'owed'); assert.equal(owed.criterion, 'AC-3');
  const followUp = owed.followUp!;
  assert.equal(followUp.title, `Post-deploy verification of GY-42 AC-3 (harness-drift-cleared) on release ${release.slice(0, 12)}`);
  assert.deepEqual(followUp.input.dependencies, ['e4b2a3c8-1c0e-4d0a-9b4e-1f2a3b4c5d6e']);
  assert.match(followUp.input.description, /^GY-42 was delivered with AC-3 declared a post-deploy verification/);
  // The follow-up's own criterion observes its head against the serving release: accepted, and never itself post-deploy, so it files no further follow-up.
  const parsed = createSchema.parse(followUp.input);
  assert.match(parsed.criteria[0].text, new RegExp(`^From this head against the serving release ${release.slice(0, 12)} that carries GY-42's merge`));
  assert.deepEqual(postDeployChecks(delivered({ criteria: parsed.criteria.map(({ id, text, proofs }) => ({ id, text, proofs })) }), release), []);
  // Passing evidence recorded at the serving release is the observation: nothing is owed.
  const evidence = [{ id: 'e1', proof: 'manual:post-deploy/harness-drift-cleared', sha: release, baseSha: mergeSha, policyRevision: 1, producer: 'p', trusted: true, result: 'pass' as const, executed: 1, skipped: 0, at: new Date().toISOString() }];
  assert.deepEqual(postDeployChecks(delivered({ evidence }), release).map(check => [check.result, check.followUp]), [['observed', null]]);
  assert.equal(postDeployChecks(delivered({ evidence: [{ ...evidence[0], sha: 'e'.repeat(40) }] }), release)[0].result, 'owed', 'evidence at another commit observes nothing on this release');
  // Only evidence the acceptance gate itself would accept observes it: an untrusted, stale-policy, expired, revoked,
  // implementer-produced or failing record at the serving release is no observation, and the follow-up is owed.
  for (const [why, rejected] of [
    ['untrusted', { trusted: false }], ['under an earlier policy', { policyRevision: 0 }], ['expired', { expiresAt: new Date(Date.now() - 1000).toISOString() }],
    ['revoked', { revocation: { at: new Date().toISOString(), by: 'operator', reason: 'wrong' } }], ['from an implementer', { producer: 'graphyard-claude-2' }], ['failing', { result: 'fail' }],
  ] as const) {
    const checked = postDeployChecks(delivered({ evidence: [{ ...evidence[0], ...rejected } as never], workspaces: [{ owner: 'graphyard-claude-2' }] as never }), release);
    assert.equal(checked[0].result, 'owed', `${why} evidence observes nothing`);
  }
  // Two declared proofs of one criterion owe two distinct follow-ups.
  const twice = postDeployChecks(delivered({ criteria: [{ ...gy1652, proofs: ['manual:post-deploy/drift', 'manual:post-deploy/status'] }] }), release);
  assert.equal(new Set(twice.map(check => check.followUp!.title)).size, 2);

  // Through verifyDeployment: the record is written, then the follow-up filed once with an idempotency key.
  const now = Date.now();
  const work = [delivered()];
  const records: unknown[] = [], filed: { input: any; requestId: string }[] = [];
  const effects = {
    snapshot: async () => ({ work, now: new Date(now).toISOString() }),
    observe: async () => ({ source: 'endpoint' as const, sha: release, at: new Date(now).toISOString(), reason: null, deployed: ['GY-42'], pending: [] }),
    // A launcher checkout of another repository emits nothing: the served merge is the whole check.
    release: () => ({ sha: 'f'.repeat(40), clean: true, repository: 'other/repo', reason: null }),
    emit: async () => assert.fail('nothing is emitted'), repository: 'owner/project', now: () => now,
    record: async (_work: Work, data: unknown) => { records.push(data); },
    file: async (input: any, requestId: string) => { filed.push({ input, requestId }); return { key: 'GY-43' }; },
  };
  const verified = await verifyDeployment(work[0], effects);
  assert.equal(verified.result, 'verified', verified.refusals.join('; '));
  assert.equal(records.length, 1);
  assert.deepEqual(verified.postDeploy, [{ criterion: 'AC-3', proof: 'manual:post-deploy/harness-drift-cleared', result: 'owed', followUp: 'GY-43' }]);
  assert.equal(filed.length, 1);
  assert.equal(filed[0].requestId, `post-deploy:${work[0].id}:AC-3:manual:post-deploy/harness-drift-cleared:${release}`);
  // Verified again once the follow-up exists: it is named, never filed twice.
  work.push({ ...delivered(), id: 'f0000000-0000-4000-8000-000000000043', key: 'GY-43', title: followUp.title, stage: 'ready' } as Work);
  work[0].delivery!.deployment = { sha: release, mergeSha, source: 'endpoint', observedAt: new Date(now).toISOString() } as never;
  const again = await verifyDeployment(work[0], effects);
  assert.equal(again.recorded, 'existing');
  assert.deepEqual(again.postDeploy.map(check => check.followUp), ['GY-43']);
  assert.equal(filed.length, 1);
  // Filed one after another: two owed proofs of one criterion file two items, each once, with no title read across a stale snapshot.
  const pair = [delivered({ criteria: [{ ...gy1652, proofs: ['manual:post-deploy/drift', 'manual:post-deploy/status'] }] })];
  const paired: string[] = [];
  const both = await filePostDeployFollowUps(pair[0], release, pair, async (input: any) => { paired.push(input.title); return { key: `GY-${50 + paired.length}` }; });
  assert.deepEqual(both.map(check => check.followUp), ['GY-51', 'GY-52']);
  assert.equal(new Set(paired).size, 2);
  // A refused verification checks nothing and files nothing.
  const refused = await verifyDeployment(work[0], { ...effects, observe: async () => ({ source: 'unavailable' as const, sha: null, at: new Date(now).toISOString(), reason: 'no endpoint', deployed: [], pending: [] }) });
  assert.equal(refused.result, 'refused');
  assert.deepEqual(refused.postDeploy, []);
  assert.equal(filed.length, 1);
});
