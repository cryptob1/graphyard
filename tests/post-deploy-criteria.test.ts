import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Loaded inside each case, so a tree without this change fails these cases rather than the file.
const modules = async () => ({ ...await import('../src/executor.js'), ...await import('../src/model/post-merge-proofs.js'), ...await import('../src/model.js'), ...await import('../src/model/approval.js'), ...await import('../src/model/bootstrap.js'), ...await import('../src/model/landability.js'), ...await import('../src/reviewer.js'), ...await import('../src/master-verification.js'), ...await import('../src/cli/planned-files-intent.js'), ...await import('../src/model/goal-plan.js') });

// unit:post-deploy-criteria (GY-1660) — a criterion only the live install can satisfy after merge
// and deploy deadlocked reviewer and worker (GY-1652 AC-3, GY-1657 AC-1..4). It is refused at
// create and requirements revision unless declared with a manual:post-deploy/ proof; a declared
// one is judged on the head's pre-merge evidence and checked by master verify-deployment on the
// serving release, which reports it owed when it fails.
// GY-1685 widens the wordings read as live (live host, on the installation, the release serving a merge,
// a cycle after the fix) and refuses an item of nothing but declared verifications: the declaration rides
// the item that ships the change.

// The live-observation criteria that deadlocked, as they were written.
const gy1652 = { id: 'AC-3', text: "'master status' on the live install reports harnessDrift null after a loop cycle running this remedy", proofs: ['manual:harness-drift-cleared'] };
const gy1657 = { id: 'AC-2', text: 'After the paths are clean, the master loop restarts through graphyard-master.service without the dirty-checkout refusal', proofs: ['integration:dirty-checkout-escalation-clears'] };
const restarted = { id: 'AC-3', text: 'The restarted loop serves a commit newer than e09c849886c3', proofs: ['integration:coordinator-serves-current-release'] };
const intent = (criteria: { id: string; text: string; proofs: string[] }[]) => ({ title: 'Item', criteria });
// What a head can show before merge: a declared verification is recorded only beside one (GY-1685).
const buildable = { id: 'AC-9', text: 'A unit test covers the change', proofs: ['unit:covered'] };

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
    assert.equal(decisionInputs.requirements.safeParse({ expectedPolicyRevision: 1, criteria: [buildable, { ...criterion, proofs: ['manual:post-deploy/observed'] }], dependencies: [], plannedFiles: [], exclusiveResources: [], producerProofs: [] }).success, true);
  }
});

test('unit:post-deploy-criteria — a declared post-deploy verification, a head-anchored observation and ordinary criteria are accepted; a live outcome is caught whatever its proof family', async () => {
  const { createSchema, liveObservationPhrase } = await modules();
  const declared = { ...gy1652, proofs: ['manual:post-deploy/harness-drift-cleared'] };
  assert.equal(createSchema.safeParse(intent([buildable, declared])).success, true);
  // A declared criterion may open "After deploy": the GY-188 post-merge refusal yields to the declaration.
  const afterDeploy = { id: 'AC-2', text: 'After deploy, the live install reports the remedy applied', proofs: ['manual:post-deploy/status'] };
  assert.equal(createSchema.safeParse(intent([buildable, afterDeploy])).success, true);
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
    assert.equal(createSchema.safeParse(intent([buildable, { ...live, proofs: ['manual:post-deploy/observed'] }])).success, true, text);
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
  assert.match(section, /it is read on the serving release after delivery, and a failure is a follow-up naming the delivered item/);
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

test('unit:post-deploy-criteria — the post-deploy check reads a declared criterion on the serving release and reports it owed when it fails', async () => {
  const { createSchema, postDeployChecks } = await modules();
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
});

// The linked instances of GY-1685's pattern, as their criteria were written when each item blocked, each run below
// against the live-observation rule as the base ships it and against the candidate's. GY-1662 was filed at 17:45Z on
// 2026-10-10, before GY-1660's rule merged at 18:42Z: it blocked at 18:02Z on the reviewer's demand for AC-3's served
// observation, and the remedy the GY-188 refusal recommended, a follow-up item, filed GY-1666 at 18:08Z, whose worker
// could only wait for the serving release and blocked at 19:57Z. GY-1683 was filed at 01:45Z the next day, after the
// rule: AC-5 passed it undeclared and blocked at 02:06Z for a requirements decision no worker may make. `base` is
// what the base rule reads in each text, `phrase` what the candidate reads.
const escalated = {
  'GY-1683 AC-5': { id: 'AC-5', text: 'On the live host at the bound, a master reclaim cycle after the fix reports the /tmp volume above its inode headroom (pressure below=false) while the opencode sessions stay running, and the reclaim record names the classes that took it back.', proofs: ['manual:reclaim-pressure-below-false'], base: null, phrase: 'live host' },
  'GY-1666 AC-1': { id: 'AC-1', text: "On the release serving GY-1662's merge, one master cycle on the installation applies the Claude harness contract without an action:config fault on remedy:harness:claude, and the following master status reports no harness attention row for it", proofs: ['manual:harness-contract-applied-on-install'], base: null, phrase: 'On the release serving' },
  'GY-1662 AC-3': { id: 'AC-3', text: 'After the fix ships and is served, one master cycle on the installation applies the Claude harness contract without an action:config fault on remedy:harness:claude and the following master status reports no harness attention row for it', proofs: ['manual:harness-contract-applied-on-install'], base: 'After the fix ships', phrase: 'After the fix ships' },
};
// GY-1662 AC-1 as filed: what its head could show before merge, beside which AC-3 belonged declared.
const gy1662ac1 = { id: 'AC-1', text: "The loop's remedy:harness:claude apply resolves a checkout that records units (.graphyard/units.json present) and applies the Claude harness contract from the loop's own process without raising the action:config failure; when the resolved checkout records no units the act refuses naming that checkout and the 'graphyard master init' remedy instead of failing opaquely, and the failure does not repeat on the next cycle", proofs: ['unit:harness-apply-checkout-resolution'] };

// The live-observation rule as the base ships it (c531a1d7 src/model/post-merge-proofs.ts, GY-1660 as merged at
// ccc0a314), pinned verbatim so each instance runs against the base rule and the candidate's in one case. GY-1685
// widens the phrases only; the clause split and the head anchor are the base's, unchanged.
const baseLiveObservation = new RegExp([
  /\blive\s+(?:install(?:ation)?|loop|daemon|server|service|deployment|system|environment|release|traffic)\b/, /\bon\s+this\s+installation\b/,
  /\brestarted\s+(?:master\s+)?loop\b/, /\bthe\s+master\s+loop\s+restarts\b/,
  /\b(?:on|in|against|from|by)\s+the\s+(?:deployed|serving|running|live)\s+(?:release|install(?:ation)?|loop|daemon|server|service|control\s+plane|system|deployment)\b/,
  /(?<![\/\w-])production\b(?!\s+(?:code|paths?|branch(?:es)?|builds?|bundles?|dependenc(?:y|ies)|modules?|sources?|files?)\b)/,
  /\b(?:after|once)\s+(?:the\s+(?:change|fix|merge)\s+(?:is\s+|has\s+)?)?(?:deploy(?:ed|ment)?|merged\s+and\s+deployed|ships|shipped|is\s+shipped|goes\s+live)\b/,
  /\bpost[-\s]?ship(?:ping|ped)?\b/, /\bonce\s+the\s+fix\s+is\s+running\b/, /\bobservation\s+after\s+deploy/,
  /(?:^|\s|`)\/home\//,
].map(part => part.source).join('|'), 'i');
const baseHeadAnchored = /\b(?:from|on|at)\s+(?:this|the)\s+(?:pull\s+request's\s+)?head\b|\bthis\s+head(?:'s)?\b|\bthe\s+candidate(?:'s)?\s+head\b|\bbefore\s+merge\b|\bstub(?:bed)?\b/i;
/** `liveObservationPhrase` as the base computes it: the base rule over the base's clause split and anchor. */
function basePhrase(text: string): string | null {
  for (const clause of text.split(/[;\n]|\.\s+/)) {
    const phrase = !baseHeadAnchored.test(clause) && baseLiveObservation.exec(clause)?.[0].trim();
    if (phrase) return phrase;
  }
  return null;
}
const revision = (criteria: { id: string; text: string; proofs: string[] }[]) => ({ expectedPolicyRevision: 1, criteria, dependencies: [], plannedFiles: [], exclusiveResources: [], producerProofs: [] });

test('manual:intervention-pattern-escalation-build — GY-1685: each linked build-stage escalation is reproduced against the base rule and cannot recur on the candidate', async () => {
  const { createSchema, criterionSchema, decisionInputs, liveObservationPhrase, postDeployOnlyRefusal, postMergeProofRefusal, postDeployReviewSection } = await modules();
  // The pinned base rule is GY-1660's: it reads GY-1660's own linked instances as the candidate still does, and reads
  // every wording GY-1660's tests pinned (above) the same way, so a divergence between the two below is GY-1685's.
  for (const criterion of [gy1652, gy1657, restarted]) assert.equal(basePhrase(criterion.text), liveObservationPhrase(criterion), criterion.text);
  for (const text of ['Production reports an escalation rate below 3 per 7 days', 'On the serving release the loop reports no harness drift', 'The post-ship rate stays below 3 per 7 days', 'From this head against the live install, master status reports harnessDrift null', 'release/production moves to the promoted candidate'])
    assert.equal(basePhrase(text), liveObservationPhrase({ text }), text);
  for (const [instance, { base, phrase, ...criterion }] of Object.entries(escalated)) {
    // Base: GY-188's rule (its matching unchanged by GY-1685) accepted every instance, and the base's live-observation
    // rule read what the fixture says. Null is the base's create accepting the criterion undeclared: the shared criterion
    // schema refuses on a phrase alone, so GY-1683 AC-5 and GY-1666 AC-1 entered as pre-merge gates no worker could meet.
    assert.equal(postMergeProofRefusal(criterion), null, `${instance} passed the post-merge rule`);
    assert.equal(basePhrase(criterion.text), base, `${instance} against the base rule`);
    // Candidate: the wording is a live observation…
    assert.equal(liveObservationPhrase(criterion), phrase, `${instance} against the candidate`);
    // …so undeclared, no create, requirements revision or requirements decision can record it…
    assert.equal(criterionSchema.safeParse(criterion).success, false, `${instance} is refused undeclared`);
    assert.equal(createSchema.safeParse(intent([buildable, criterion])).success, false, instance);
    assert.equal(decisionInputs.requirements.safeParse(revision([buildable, criterion])).success, false, instance);
    // …declared beside what the head can show, it is recorded on the item that ships the change and gates no merge…
    const declared = { ...criterion, proofs: [`manual:post-deploy/${criterion.proofs[0].split(':')[1]}`] };
    assert.equal(createSchema.safeParse(intent([buildable, declared])).success, true, `${instance} is accepted declared beside a buildable criterion`);
    assert.match(postDeployReviewSection([declared]), /never request changes or hold the merge/);
    // …and declared alone, as a follow-up item of its own would carry it, it is refused: its worker could only wait.
    assert.match(postDeployOnlyRefusal([declared])!, new RegExp(`^${declared.id} is a declared post-deploy verification`), instance);
    const alone = createSchema.safeParse(intent([declared]));
    assert.equal(alone.success, false, `${instance} alone is no item`);
    assert.match(alone.error!.issues.map(issue => issue.message).join('\n'), new RegExp(`^${declared.id} is a declared post-deploy verification, so no head can build anything this item's review judges before merge`));
  }
  // GY-1662's path. The base reads its AC-3 wording ("After the fix ships") as the candidate does: filed before GY-1660's
  // rule, the criterion was never run through it, and what recurred on the base was the remedy. The GY-188 refusal sent
  // the proof to "a follow-up work item that depends on this one"; the decision that moved AC-3 off GY-1662 passes on
  // both, and the item it produced, GY-1666 as filed, the base read as no observation (null above) and recorded as a
  // worker's build. Declared alone, the base recorded it too: its own test pinned a requirements decision carrying one
  // declared criterion and nothing else as accepted (tests/post-deploy-criteria.test.ts at c531a1d7, line 44), which
  // this change moves beside a buildable criterion.
  const gy1662ac3 = escalated['GY-1662 AC-3'];
  assert.equal(liveObservationPhrase(gy1662ac1), null, 'GY-1662 AC-1 is what its head could show');
  assert.equal(decisionInputs.requirements.safeParse(revision([gy1662ac1])).success, true, 'moving AC-3 off GY-1662 passes on base and candidate alike');
  // Candidate: the decision that keeps AC-3 on GY-1662, declared beside AC-1, is the one path open, and review never holds on it.
  const kept = { id: 'AC-3', text: gy1662ac3.text, proofs: ['manual:post-deploy/harness-contract-applied-on-install'] };
  assert.equal(decisionInputs.requirements.safeParse(revision([gy1662ac1, kept])).success, true, 'AC-3 declared beside AC-1 stays on the item that ships the change');
  assert.equal(decisionInputs.requirements.safeParse(revision([kept])).success, false, 'the follow-up GY-1666 would have carried, declared, is refused');
  assert.equal(createSchema.safeParse(intent([kept])).success, false);
  // The GY-188 refusal no longer sends a post-merge proof to a follow-up item of its own: that is how GY-1666 came to be.
  const message = postMergeProofRefusal({ id: 'AC-1', text: 'The rate is met', proofs: ['manual:rate-met-postmerge'] })!;
  assert.match(message, /declare it a post-deploy verification of this item \(manual:post-deploy\/NAME\)/);
  assert.ok(!message.includes('follow-up work item'), message);
});

test('unit:post-deploy-criteria — the widened wordings read a served loop\'s cycle after the fix as live and a test run after the fix as pre-merge', async () => {
  const { createSchema, liveObservationPhrase } = await modules();
  // The review of 712e79c2: "A unit-test run after the fix passes" was read as live and would have been refused undeclared,
  // another build-stage requirements intervention. Only a master, loop or daemon cycle, run or pass after the fix is the
  // served loop's; a test's run, a test's loop cycle, an install step and a path or table named for the release stay pre-merge.
  for (const text of ['A unit-test run after the fix passes', 'The test run after the change is green', 'The integration pass after the merge records the remedy against the stub', 'Every run after the fix of tests/reclaim.test.ts reports pressure below=false',
    'The loop cycle in the test records the remedy', 'The install step writes units.json', 'After the fix, the function returns the cap', 'A host of fixtures covers it', 'The release serving table lists candidates']) {
    assert.equal(liveObservationPhrase({ text }), null, text);
    assert.equal(createSchema.safeParse(intent([{ id: 'AC-1', text, proofs: ['unit:run'] }])).success, true, text);
  }
  for (const [text, phrase] of [['A master reclaim cycle after the fix reports pressure below=false', 'master reclaim cycle after the fix'], ['One loop cycle after the fix journals the remedy', 'loop cycle after the fix'],
    ['The daemon run after the merge applies the contract', 'daemon run after the merge'], ['A master pass after the change takes the scratch roots back', 'master pass after the change'],
    ['On the release that serves the merge, no harness attention row stands', 'On the release that serves'], ['One master cycle on the installation applies the contract', 'on the installation'], ['The reclaim runs on the live machine', 'live machine']]) {
    assert.equal(liveObservationPhrase({ text }), phrase, text);
    assert.equal(createSchema.safeParse(intent([{ id: 'AC-1', text, proofs: ['manual:observed'] }])).success, false, text);
    assert.equal(createSchema.safeParse(intent([buildable, { id: 'AC-1', text, proofs: ['manual:post-deploy/observed'] }])).success, true, text);
  }
});

test('unit:post-deploy-criteria — an item of nothing but declared post-deploy verifications is refused on every path, naming the item that ships the change', async () => {
  const { createSchema, decisionInputs, derivedIntent, postDeployOnlyRefusal, postDeployChecks, planItemSchema } = await modules();
  const only = [{ id: 'AC-1', text: 'The live loop journals the remedy', proofs: ['manual:post-deploy/journal'] }, { id: 'AC-2', text: 'Production reports the rate', proofs: ['manual:post-deploy/rate'] }];
  assert.match(postDeployOnlyRefusal(only)!, /^AC-1, AC-2 are all declared post-deploy verifications, so no head can build anything this item's review judges before merge and its worker could only wait for the serving release\. Declare the verification on the item that ships the change it observes/);
  assert.match(postDeployOnlyRefusal(only.slice(0, 1))!, /^AC-1 is a declared post-deploy verification/);
  assert.equal(postDeployOnlyRefusal([]), null);
  assert.equal(postDeployOnlyRefusal([buildable, ...only]), null, 'one buildable criterion makes it an item');
  const revision = (criteria: typeof only) => ({ expectedPolicyRevision: 1, criteria, dependencies: [], plannedFiles: [], exclusiveResources: [], producerProofs: [] });
  assert.equal(createSchema.safeParse(intent(only)).success, false);
  assert.equal(decisionInputs.requirements.safeParse(revision(only)).success, false, 'a requirements decision cannot leave an item with only declared verifications');
  assert.equal(decisionInputs.requirements.safeParse(revision([buildable, ...only])).success, true);
  const plan = { ref: 'verify', title: 'Verify', plain: 'Checks the live rate.', outcomes: ['o1'], cases: ['c1'], plannedFiles: ['src/x.ts'], criteria: only };
  assert.equal(planItemSchema.safeParse(plan).success, false, 'a goal plan item of only declared verifications is refused');
  assert.equal(planItemSchema.safeParse({ ...plan, criteria: [buildable, ...only] }).success, true);
  // master create and master requirements refuse it before reading the tree or posting, like an undeclared observation.
  const directory = await temporaryDirectory('post-deploy-only-intent');
  const file = join(directory, 'intent.json');
  const work = { id: 'a1b2c3d4-0000-4000-8000-000000000002', key: 'GY-8', policyRevision: 1, criteria: [], dependencies: [], plannedFiles: [] };
  const deps = { coordinator: async () => ({ work: [work] }), mutate: async () => assert.fail('nothing is posted'), token: async () => 'token', tree: async () => assert.fail('the tree is not read') };
  await writeFile(file, JSON.stringify({ title: 'Verify', criteria: only }));
  await assert.rejects(derivedIntent(directory, { baseBranch: 'main' }, 'create', [file, 'file it'], deps), /^Error: AC-1, AC-2 are all declared post-deploy verifications/);
  await writeFile(file, JSON.stringify({ criteria: only, dependencies: [], plannedFiles: [] }));
  await assert.rejects(derivedIntent(directory, { baseBranch: 'main' }, 'requirements', ['GY-8', file, 'revise'], deps), /^Error: AC-1, AC-2 are all declared post-deploy verifications/);
  // GY-1660's own follow-up stands: the one verify-deployment files is anchored to its head, so it is no declared verification and is accepted.
  const [owed] = postDeployChecks(delivered(), release);
  assert.equal(owed.result, 'owed');
  assert.equal(postDeployOnlyRefusal(owed.followUp!.input.criteria), null);
  assert.equal(createSchema.safeParse(intent(owed.followUp!.input.criteria)).success, true);
});
