import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Loaded inside each case, so a tree without this change fails these cases rather than the file.
const modules = async () => ({ ...await import('../src/executor.js'), ...await import('../src/model/post-merge-proofs.js'), ...await import('../src/model.js'), ...await import('../src/model/approval.js'), ...await import('../src/model/bootstrap.js'), ...await import('../src/model/landability.js'), ...await import('../src/reviewer.js'), ...await import('../src/master-verification.js'), ...await import('../src/cli/planned-files-intent.js') });

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
  assert.match(postDeployCriterionRefusal([gy1652, { ...restarted, id: 'AC-4' }])!, /^AC-3 \("on the live install"\), AC-4 \("restarted loop"\) are live-install or post-deploy observations/);
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
  // The anchor covers its own clause only: a pre-merge clause cannot exempt a live observation beside it.
  assert.equal(liveObservationPhrase({ id: 'AC-1', text: 'Before merge test the stub; after deployment verify production traffic', proofs: ['unit:x'] }), 'after deployment');
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
  // Production and serving-release wording is a live outcome whatever its proof: refused undeclared, accepted declared.
  for (const [text, phrase] of [
    ['Production reports an escalation rate below 3 per 7 days', 'Production'], ['The escalation rate in production stays below 3 per 7 days', 'production'],
    ['On the serving release the loop reports no harness drift', 'On the serving release'], ['The post-ship rate stays below 3 per 7 days', 'post-ship'],
    ['The live loop journals the remedy', 'live loop'], ['With the loop paused, the coordinator checkout /home/vish/code/graphyard reports no modified paths', '/home/'],
  ]) {
    const live = { id: 'AC-1', text, proofs: ['manual:observed'] };
    assert.equal(liveObservationPhrase(live), phrase, text);
    assert.equal(createSchema.safeParse(intent([live])).success, false, text);
    assert.equal(createSchema.safeParse(intent([{ ...live, proofs: ['manual:post-deploy/observed'] }])).success, true, text);
  }
  // A path or branch named production, and production code, are no deployment.
  for (const text of ['release/production moves to the promoted candidate', 'rc-production/ID records the promotion', 'Production code paths are covered by the unit test'])
    assert.equal(liveObservationPhrase({ text }), null, text);
});

// The linked instances of GY-1660's pattern, as their criteria were written when the item blocked. On the
// base the only write-time rule was GY-188's post-merge refusal, which accepted every one of them, so each
// entered as a pre-merge gate no worker could meet and the item blocked for a person (GY-1652, GY-1657).
const linked = {
  'GY-1652 AC-3': { id: 'AC-3', text: "master status on the live install reports harnessDrift null after a loop cycle running this remedy", proofs: ['manual:harness-drift-cleared'] },
  'GY-1657 AC-1': { id: 'AC-1', text: 'With the loop paused, the coordinator checkout /home/vish/code/graphyard reports no modified and no untracked source paths (git status --porcelain empty at head >= e09c849886c3): each of the 6 dirty paths is committed, stashed or discarded by an operator act.', proofs: ['manual:coordinator-checkout-clean'] },
  'GY-1657 AC-2': { id: 'AC-2', text: 'After the paths are clean, the master loop restarts through graphyard-master.service without the dirty-checkout refusal, and escalation:dirty-checkout records no new failed attempt across at least two consecutive daemon cycles (its attempts count stops climbing past 4).', proofs: ['integration:dirty-checkout-escalation-clears'] },
  'GY-1657 AC-3': { id: 'AC-3', text: 'The restarted loop serves a commit newer than e09c849886c3, so fixes delivered while the fault stood are live in coordinator behaviour.', proofs: ['integration:coordinator-serves-current-release'] },
  'GY-1657 AC-4': { id: 'AC-4', text: 'The two panes pointing at the checkout (agy w1V:pHHY, graphyard-master-graphyard w1V:pN93) are re-attached to the restarted loop or confirmed idle, and no session re-dirties the checkout afterwards (the dirty set stays empty for 24h).', proofs: ['manual:panes-released-or-reattached'] },
};

test('manual:intervention-pattern-escalation-build — GY-1660: each linked build-stage escalation is reproduced against the base rule and cannot recur on the candidate', async () => {
  const { criterionSchema, postMergeProofRefusal, decisionInputs, postDeployReviewSection } = await modules();
  for (const [instance, criterion] of Object.entries(linked)) {
    // Base: the GY-188 rule alone accepted it, so it gated the merge it could only follow.
    assert.equal(postMergeProofRefusal(criterion), null, `${instance} passed the base's write-time rule`);
    // Candidate: undeclared, no create, requirements revision or requirements decision can record it…
    assert.equal(criterionSchema.safeParse(criterion).success, false, `${instance} is refused undeclared`);
    assert.equal(decisionInputs.requirements.safeParse({ expectedPolicyRevision: 1, criteria: [criterion], dependencies: [], plannedFiles: [], exclusiveResources: [], producerProofs: [] }).success, false, instance);
    // …and declared, it is recorded, the reviewer judges it on pre-merge evidence, and it gates no merge.
    const declared = { ...criterion, proofs: [`manual:post-deploy/${criterion.proofs[0].split(':')[1]}`] };
    assert.equal(criterionSchema.safeParse(declared).success, true, `${instance} is accepted declared`);
    assert.match(postDeployReviewSection([declared]), /never request changes or hold the merge/);
  }
});

test('unit:post-deploy-criteria — a recurring intervention pattern keeps its post-ship rate as a declared post-deploy verification beside the regression its head can show', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/interventions/patterns.ts', import.meta.url), 'utf8'));
  const [rate, regression] = [...source.matchAll(/\{ id: '(AC-\d)', text: `([^`]+)`, proofs: \[`([^`]+)`\] \}/g)].map(([, id, text, proof]) => ({ id, text: text.replace(/\$\{[^}]+\}/g, 'X'), proofs: [proof.replace('${postDeployProofPrefix}', 'manual:post-deploy/').replace(/\$\{[^}]+\}/g, 'x')] }));
  const { createSchema, liveObservationPhrase } = await modules();
  // The measured outcome is unchanged: the rate below the threshold after the change ships…
  assert.match(rate.text, /the intervention report shows the X rate at X below X per X days after the change ships, and the linked instances could not recur$/);
  assert.equal(liveObservationPhrase(rate), 'after the change ships');
  // …declared, so it is accepted and gates no merge; undeclared it would be refused.
  assert.deepEqual(rate.proofs, ['manual:post-deploy/intervention-pattern-x-x']);
  assert.equal(createSchema.safeParse(intent([rate, regression])).success, true);
  assert.equal(createSchema.safeParse(intent([{ ...rate, proofs: ['manual:intervention-pattern-x-x'] }])).success, false);
  assert.equal(liveObservationPhrase(regression), null, regression.text);
  assert.deepEqual(regression.proofs, ['manual:intervention-pattern-x-x']);
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
  assert.match(followUp.input.description, new RegExp(`^Post-deploy follow-up: ${followUp.requestId}\n\nGY-42 was delivered with AC-3 declared a post-deploy verification`));
  // An operator-agent creation must carry its reason.
  assert.match(followUp.input.reason, /^GY-42 AC-3's declared post-deploy verification manual:post-deploy\/harness-drift-cleared is unobserved on the serving release/);
  // The follow-up's own criterion observes its head against the serving release: accepted, and never itself post-deploy, so it files no further follow-up.
  // The server's create input is this schema with the operator agent's reason beside it.
  const { reason: _reason, ...created } = followUp.input;
  const parsed = createSchema.parse(created);
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
  // Evidence bound to the delivery only: a record from before the merge, or against another base, is a pre-merge record, never the live observation.
  const premerge = new Date(Date.parse(delivered().delivery!.mergedAt) - 60_000).toISOString();
  assert.equal(postDeployChecks(delivered({ evidence: [{ ...evidence[0], at: premerge }] }), release)[0].result, 'owed', 'evidence recorded before the merge observes nothing');
  assert.equal(postDeployChecks(delivered({ evidence: [{ ...evidence[0], baseSha: 'e'.repeat(40) }] }), release)[0].result, 'owed', 'evidence against another base observes nothing');
  // The latest applicable record decides: a later trusted failure outranks an earlier pass, and a later pass an earlier failure.
  const later = new Date(Date.now() + 1000).toISOString();
  assert.equal(postDeployChecks(delivered({ evidence: [evidence[0], { ...evidence[0], id: 'e2', result: 'fail' as const, at: later }] as never }), release)[0].result, 'owed', 'a later failure is the current observation');
  assert.equal(postDeployChecks(delivered({ evidence: [{ ...evidence[0], id: 'e2', result: 'fail' as const }, { ...evidence[0], at: later }] as never }), release)[0].result, 'observed', 'a later pass is the current observation');
  // Two declared proofs of one criterion owe two distinct follow-ups, even when their names share a prefix longer than any title.
  const long = 'x'.repeat(240);
  const longWork = delivered({ criteria: [{ ...gy1652, proofs: [`manual:post-deploy/${long}-a`, `manual:post-deploy/${long}-b`] }] });
  const twice = postDeployChecks(longWork, release);
  assert.equal(twice[0].followUp!.title, twice[1].followUp!.title, 'the titles are cut alike');
  assert.notEqual(twice[0].followUp!.requestId, twice[1].followUp!.requestId);
  const longFiled: string[] = [];
  const fileLong = async (input: any) => { longFiled.push(input.description); return { key: `GY-${60 + longFiled.length}` }; };
  assert.deepEqual((await filePostDeployFollowUps(longWork, release, [longWork], fileLong)).map(check => check.followUp), ['GY-61', 'GY-62']);
  // Checked again with both filed, each is matched by its own identity and neither is filed again.
  const known = [longWork, ...longFiled.map((description, index) => ({ key: `GY-${61 + index}`, description }))];
  assert.deepEqual((await filePostDeployFollowUps(longWork, release, known, fileLong)).map(check => check.followUp), ['GY-61', 'GY-62']);
  assert.equal(longFiled.length, 2);

  // Through verifyDeployment: the follow-up is filed once with an idempotency key, then the record is written.
  const now = Date.now();
  const work = [delivered()];
  const records: unknown[] = [], filed: { input: any; requestId: string }[] = [];
  const effects = {
    snapshot: async () => ({ work, now: new Date(now).toISOString() }),
    observe: async () => ({ source: 'endpoint' as const, sha: release, at: new Date(now).toISOString(), reason: null, deployed: ['GY-42'], pending: [] }),
    // A launcher checkout of another repository emits nothing: the served merge is the whole check.
    release: () => ({ sha: 'f'.repeat(40), clean: true, repository: 'other/repo', reason: null }),
    emit: async () => assert.fail('nothing is emitted'), repository: 'owner/project', now: () => now,
    record: async (_work: Work, data: unknown) => { assert.equal(filed.length, 1, 'filed before the record'); records.push(data); },
    file: async (input: any, requestId: string) => { filed.push({ input, requestId }); return { key: 'GY-43' }; },
  };
  // A filing that fails leaves the delivery unobserved, so the retry files it.
  await assert.rejects(verifyDeployment(work[0], { ...effects, file: async () => { throw new Error('refused'); } }), /refused/);
  assert.equal(records.length, 0);
  const verified = await verifyDeployment(work[0], effects);
  assert.equal(verified.result, 'verified', verified.refusals.join('; '));
  assert.equal(records.length, 1);
  assert.deepEqual(verified.postDeploy, [{ criterion: 'AC-3', proof: 'manual:post-deploy/harness-drift-cleared', result: 'owed', followUp: 'GY-43' }]);
  assert.equal(filed.length, 1);
  assert.equal(filed[0].requestId, `post-deploy:${work[0].id}:AC-3:manual:post-deploy/harness-drift-cleared:${release}`);
  // Verified again once the follow-up exists: it is named, never filed twice.
  work.push({ ...delivered(), id: 'f0000000-0000-4000-8000-000000000043', key: 'GY-43', title: followUp.title, description: filed[0].input.description, stage: 'ready' } as Work);
  work[0].delivery!.deployment = { sha: release, mergeSha, source: 'endpoint', observedAt: new Date(now).toISOString() } as never;
  const again = await verifyDeployment(work[0], effects);
  assert.equal(again.recorded, 'existing');
  assert.deepEqual(again.postDeploy.map(check => check.followUp), ['GY-43']);
  assert.equal(filed.length, 1);
  // Filed one after another: two owed proofs of one criterion file two items, each once, with no title read across a stale snapshot.
  const pair = [delivered({ criteria: [{ ...gy1652, proofs: ['manual:post-deploy/drift', 'manual:post-deploy/status'] }] })];
  const paired: string[] = [];
  const both = await filePostDeployFollowUps(pair[0], release, pair, async (input: any) => { paired.push(input.description); return { key: `GY-${50 + paired.length}` }; });
  assert.deepEqual(both.map(check => check.followUp), ['GY-51', 'GY-52']);
  assert.equal(new Set(paired).size, 2);
  // A refused verification checks nothing and files nothing.
  const refused = await verifyDeployment(work[0], { ...effects, observe: async () => ({ source: 'unavailable' as const, sha: null, at: new Date(now).toISOString(), reason: 'no endpoint', deployed: [], pending: [] }) });
  assert.equal(refused.result, 'refused');
  assert.deepEqual(refused.postDeploy, []);
  assert.equal(filed.length, 1);
});

test('unit:post-deploy-criteria — the loop\'s verify-deployment files an owed follow-up as the operator agent before recording the observation, and records nothing without one', async () => {
  const { controlPlaneHandlers } = await modules();
  const work = delivered(), calls: string[] = [];
  const unusable = async (): Promise<never> => { throw new Error('not reached'); };
  const handlers = (fileWork?: (input: unknown, requestId: string) => Promise<{ key?: string }>) => controlPlaneHandlers(() => ({}) as never, {
    snapshot: async () => ({ work: [work], now: new Date().toISOString() }),
    // The coordinator credential records the observation and never creates work.
    mutate: async (path: string) => { assert.notEqual(path, 'work', 'the coordinator never creates work'); calls.push(path); return {}; },
    agents: () => [], workerCredentials: async () => ({}), producerCredentials: async () => ({}),
    dispatchWorker: unusable, launchReview: unusable, launchProducer: unusable,
    observeDeployment: async () => ({ source: 'endpoint' as const, sha: release, at: new Date().toISOString(), reason: null, deployed: ['GY-42'], pending: [] }) as never,
    ...(fileWork ? { fileWork } : {}),
  });
  const identity = { host: 'host-1', executor: 'executor-1' } as never;
  const action = { id: 'row-1', work: work.id, key: 'GY-42', kind: 'verify-deployment', inputs: { kind: 'verify-deployment', mergeSha } } as never;
  await assert.rejects(handlers()['verify-deployment']!(action, identity) as unknown as Promise<string>, /AC-3 \(manual:post-deploy\/harness-drift-cleared\) owes its post-deploy follow-up, and this executor has no operator-agent identity/);
  assert.equal(calls.length, 0, 'nothing is recorded while the follow-up is unfiled');
  const result = await handlers(async (input: any, requestId: string) => { calls.push(`file ${requestId}`); assert.ok(input.reason); return { key: 'GY-43' }; })['verify-deployment']!(action, identity) as unknown as Promise<string>;
  assert.deepEqual(calls, [`file post-deploy:${work.id}:AC-3:manual:post-deploy/harness-drift-cleared:${release}`, `work/${work.id}/deployment`]);
  assert.match(String(result), /AC-3 owes its post-deploy observation \(GY-43\)/);
});
