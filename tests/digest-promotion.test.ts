import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AsyncGit, CandidateBuild, DeploymentOutcome, DeploymentRecord, Git, Ledger, ReleaseCandidate, Suite, UatRecord } from '../src/release-candidate.js';
import type { Manifest } from '../src/delivery.js';
import type { ShellRun } from '../src/release-digests.js';

/**
 * The modules under test, imported inside each test: `graphyard verify` runs this file against the
 * base's sources, where src/release-digests.ts does not exist, and each proof must then fail as its
 * own test case rather than abort the file at import.
 */
const load = async () => ({
  ...await import('../src/release-candidate.js'), ...await import('../src/release-digests.js'), ...await import('../src/production-delivery.js'),
  ...await import('../src/daemon/release-ports.js'), ...await import('../src/master.js'),
});
const deploymentTagPrefix = 'rc-deploy/', deploymentOutcomeTagPrefix = 'rc-deployed/';

// GY-1844: a release candidate is built once and its exact artifact digests are what UAT tests and
// production promotes and verifies. Cutting records one build registration (each service's digest)
// on the candidate; the UAT result names the digests it tested; promotion with a digest-capable
// deployer deploys exactly the recorded digests and never rebuilds (a rebuild can differ: base
// image, dependency resolution, build inputs); production verification compares every recorded
// running digest with the promoted digest and fails naming the service. A caller or adapter
// without digest deploys keeps sha promotion, reported as such in status.

const now = new Date(0);
const iso = now.toISOString();
const tip = 'c'.repeat(40);
const sha256 = (digit: string) => `sha256:${digit.repeat(64)}`;
const built: CandidateBuild = {
  registration: { id: 'graphyard-builder', revision: 2 },
  sourceSha: tip,
  buildInputsDigest: sha256('e'),
  artifacts: [{ service: 'api', digest: sha256('a') }, { service: 'web', digest: sha256('b') }],
  provenanceUrl: 'https://ci.example.test/builds/812',
};
const candidate: ReleaseCandidate = { id: '20261001T120000Z', sha: tip, cutAt: iso, trigger: 'manual', since: null, items: [], build: built };
const passedUat: UatRecord = { id: candidate.id, sha: tip, result: 'passed', deployedSha: tip, at: iso, suites: [{ name: 'endpoints', passed: true, detail: 'ok' }], followUp: null, digests: built.artifacts };
const emptyLedger: Ledger = { candidates: [], uat: [], production: [], soak: [], deployments: [], deployed: [] };
const generationOf = (environment: 'uat' | 'production') => (entry: ReleaseCandidate, generation: number, mode: 'digest' | 'sha', at = iso): DeploymentRecord =>
  ({ environment, generation, id: entry.id, sha: entry.sha, at, mode, ...(mode === 'digest' ? { digests: built.artifacts } : {}) });
const productionGeneration = generationOf('production'), uatGeneration = generationOf('uat');
const settledAs = (entry: ReleaseCandidate, generation: number, result: DeploymentOutcome['result'], environment: 'uat' | 'production' = 'production'): DeploymentOutcome =>
  ({ environment, generation, id: entry.id, result, at: iso });
/** UAT put to serve `entry`'s recorded digests as generation `generation`, settled. */
const digestServed = (entry: ReleaseCandidate, generation: number, at = iso) => ({ deployments: [uatGeneration(entry, generation, 'digest', at)], deployed: [settledAs(entry, generation, 'succeeded', 'uat')] });
const recordingSuite = (name: string, passed: boolean): Suite => ({ name, run: async () => ({ name, passed, detail: passed ? 'ok' : `${name} failed` }) });

/** Which ledger list a tag (or a `for-each-ref` prefix) belongs to. */
const ledgerKey = (tag: string): keyof Ledger => tag.startsWith('rc-production/') ? 'production' : tag.startsWith('rc/') ? 'candidates' : tag.startsWith('rc-uat/') ? 'uat'
  : tag.startsWith(deploymentTagPrefix) ? 'deployments' : tag.startsWith(deploymentOutcomeTagPrefix) ? 'deployed' : 'soak';
/**
 * The candidate ledger in memory: `for-each-ref` reads the tag records, a written tag joins them (so
 * a second deploy sees the first's generation), every other command answers empty unless a handler
 * names it, and every call is kept so the tests can name what was pushed — a digest promotion moves
 * no branch, because moving a deploy branch is what triggers a rebuild.
 */
function ledgerGit(ledger: Partial<Ledger>, handlers: Record<string, (args: string[]) => string> = {}) {
  const calls: string[][] = [];
  const lists: Partial<Record<keyof Ledger, unknown[]>> = Object.fromEntries(Object.entries(ledger).map(([key, list]) => [key, [...(list as unknown[])]]));
  const git: Git = args => {
    calls.push(args);
    if (handlers[args[0]]) return handlers[args[0]](args);
    if (args[0] === 'for-each-ref') {
      const prefix = args[3].slice('refs/tags/'.length);
      return ((lists[ledgerKey(prefix)] ?? []) as { id: string }[]).map(record => `${prefix}${record.id}\0${JSON.stringify(record, null, 2)}`).join('\0\0\n');
    }
    if (args[4] === 'tag' && args[5] === '-a') (lists[ledgerKey(args[6])] ??= []).push(JSON.parse(args[args.indexOf('-m') + 1]));
    return '';
  };
  const asyncGit: AsyncGit = async args => git(args);
  return {
    git, calls, asyncGit,
    tags: () => calls.filter(args => args[4] === 'tag' && args[5] === '-a').map(args => JSON.parse(args[args.indexOf('-m') + 1])),
    tagNames: () => calls.filter(args => args[4] === 'tag' && args[5] === '-a').map(args => args[6]),
    pushes: () => calls.filter(args => args[0] === 'push').map(args => args.join(' ')),
  };
}

test('unit:candidate-promotes-recorded-digests — a candidate records one build registration with each service\'s digest; UAT results and promotion name those digests; promotion with a digest deployer deploys exactly them and never moves a branch, and a caller without one keeps sha promotion', async () => {
  const { assessPromotion, assessUat, cut, deployToUat, deployToUatAsync, ledgerStatus, productionBranch, promote, promoteAsync, recordCandidateBuild, uatBranch, validate, validateAndRecord } = await load();
  // Cutting a candidate builds its artifacts once and the registration rides the candidate's tag.
  let builds = 0;
  const repo = ledgerGit({}, { 'rev-parse': () => tip, log: () => `${tip}\0GY-900: the change\0\x1e` });
  const cutResult = cut(repo.git, { base: 'main', trigger: 'manual', now, push: false, build: () => { builds++; return built; } });
  assert.ok(cutResult.cut);
  assert.equal(builds, 1, 'the candidate is built once, at its exact SHA');
  assert.deepEqual(cutResult.candidate.build, built);
  const recorded = repo.tags().find(record => record.id === cutResult.candidate.id);
  assert.deepEqual(recorded.build, built, 'the tag record carries the build registration with each service\'s digest');
  // The registration belongs to the candidate's exact SHA and to well-formed digests.
  assert.throws(() => recordCandidateBuild(candidate, { ...built, sourceSha: 'a'.repeat(40) }), /is .+, not the built/);
  assert.throws(() => recordCandidateBuild(candidate, { ...built, artifacts: [{ service: 'api', digest: sha256('a') }, { service: 'api', digest: sha256('f') }] }), /name api twice/);
  assert.throws(() => recordCandidateBuild(candidate, { ...built, artifacts: [{ service: 'api', digest: 'deadbeef' }] }), /digest must be sha256:<64 hex digits>/);

  // The UAT result is recorded against the digests it tested.
  assert.deepEqual(assessUat(candidate, { deployedSha: tip, suites: [{ name: 'endpoints', passed: true, detail: 'ok' }], now, digests: built.artifacts }).digests, built.artifacts);
  const uatFetch = (async () => new Response(JSON.stringify({ ok: true, commit: tip }))) as typeof fetch;
  const validated = await validate(candidate, 'https://uat.example.test', [recordingSuite('endpoints', true)], { timeoutMs: 1000, fetcher: uatFetch, now: () => now, digests: built.artifacts });
  assert.equal(validated.result, 'passed');
  assert.deepEqual(validated.digests, built.artifacts);
  const recordedUat = await validateAndRecord(ledgerGit({ candidates: [candidate] }).asyncGit, candidate.id, 'https://uat.example.test', [recordingSuite('endpoints', true)], { base: 'main', push: false, timeoutMs: 1000, now: () => now, fetcher: uatFetch, digests: built.artifacts });
  assert.deepEqual(recordedUat.record.digests, built.artifacts, 'the recorded UAT verdict names the digests it tested');

  // A UAT record taken against other digests does not validate the recorded build for promotion.
  const drifted: UatRecord = { ...passedUat, digests: [{ service: 'api', digest: sha256('d') }, { service: 'web', digest: sha256('b') }] };
  assert.match(assessPromotion(candidate, drifted, null).refusals.join(' '), /not its recorded build/);
  assert.equal(assessPromotion(candidate, passedUat, null).promotable, true);
  assert.equal(assessPromotion(candidate, { ...passedUat, digests: undefined }, null).promotable, true, 'a sha-promotion UAT record keeps promoting');

  // Promotion with a digest deployer deploys exactly the recorded digests and pushes nothing: moving a branch is what triggers a rebuild.
  const digestRepo = ledgerGit({ candidates: [candidate], uat: [passedUat] });
  let received: Manifest | null = null, receivedCount = 0;
  const promoted = promote(digestRepo.git, candidate.id, { base: 'main', push: false, now, deployDigests: (digests, sha) => { received = digests; receivedCount++; assert.equal(sha, tip); } });
  assert.deepEqual(promoted, { promoted: true, candidate: candidate.id, sha: tip, branch: productionBranch, mode: 'digest', digests: built.artifacts });
  assert.equal(receivedCount, 1, 'the deployer is called once');
  assert.deepEqual(received, built.artifacts, 'the deployer received exactly the recorded build digests');
  assert.deepEqual(digestRepo.pushes(), [], 'promotion never triggers a rebuild: no branch move, nothing pushed');
  const generation = digestRepo.tags().find(record => record.environment === 'production' && record.mode);
  assert.deepEqual(generation, { environment: 'production', generation: 1, id: candidate.id, sha: tip, at: iso, mode: 'digest', digests: built.artifacts }, 'the production generation names the digests it deployed, published before the deployer ran');

  // The loop's async port promotes by digest the same way.
  const asyncRepo = ledgerGit({ candidates: [candidate], uat: [passedUat] });
  let asyncDeploys = 0;
  const asyncPromoted = await promoteAsync(asyncRepo.asyncGit, candidate.id, { base: 'main', push: false, now, deployDigests: async () => { asyncDeploys++; } });
  assert.equal(asyncPromoted.promoted && asyncPromoted.mode, 'digest');
  assert.equal(asyncDeploys, 1);
  const asyncDeployed = await deployToUatAsync(asyncRepo.asyncGit, candidate.id, 'main', now, async () => { asyncDeploys++; });
  assert.deepEqual(asyncDeployed, { candidate: candidate.id, sha: tip, branch: uatBranch, mode: 'digest', digests: built.artifacts });
  assert.equal(asyncDeploys, 2);

  // Deploying to UAT by digest deploys the recorded digests, moves no branch, and records what it serves.
  const uatRepo = ledgerGit({ candidates: [candidate] });
  let uatDeploys = 0;
  const uatResult = deployToUat(uatRepo.git, candidate.id, 'main', now, () => { uatDeploys++; });
  assert.deepEqual(uatResult, { candidate: candidate.id, sha: tip, branch: uatBranch, mode: 'digest', digests: built.artifacts });
  assert.equal(uatDeploys, 1);
  assert.deepEqual(uatRepo.pushes(), [`push origin refs/tags/${deploymentTagPrefix}uat/00000001`, `push origin refs/tags/${deploymentOutcomeTagPrefix}uat/00000001`], 'the digest deploy publishes its generation — the trace a branch move would leave — and its outcome, and moves no branch');

  // Without a digest deployer the adapter keeps sha promotion: the branch move names no mode.
  const shaRepo = ledgerGit({ candidates: [candidate], uat: [passedUat] });
  const shaPromoted = promote(shaRepo.git, candidate.id, { base: 'main', push: false, now });
  assert.deepEqual(shaPromoted, { promoted: true, candidate: candidate.id, sha: tip, branch: productionBranch });
  assert.ok(shaRepo.pushes().some(push => push.includes(`refs/heads/${productionBranch}`)), 'sha promotion moves release/production');

  // Status reports how each candidate was actually promoted, from its production generation, and what ran in production.
  const status = ledgerStatus({ ...emptyLedger, candidates: [candidate], uat: [passedUat], production: [{ id: candidate.id, sha: tip, at: iso }], deployments: [productionGeneration(candidate, 1, 'digest')], deployed: [settledAs(candidate, 1, 'succeeded')] });
  assert.equal(status[0].promotion, 'digest');
  assert.deepEqual(status[0].build?.digests, built.artifacts);
  assert.deepEqual(status[0].productionDigests, built.artifacts);
  assert.equal(ledgerStatus({ ...emptyLedger, candidates: [{ ...candidate, build: undefined }] })[0].promotion, null, 'a candidate not promoted yet names no promotion');
  assert.equal(ledgerStatus({ ...emptyLedger, candidates: [{ ...candidate, build: undefined }], production: [{ id: candidate.id, sha: tip, at: iso }] })[0].promotion, 'sha', 'a promotion recorded before generations moved the branch');
});

test('unit:production-digest-verified — production verification compares every recorded running digest with the promoted digest, fails naming the service on any other digest, passes when all match, and reports a promotion without digests as sha-promoted', async () => {
  const { verifyPromotedDigests } = await load();
  const promoted = { sha: tip, digests: [{ service: 'api', digest: sha256('a') }, { service: 'web', digest: sha256('b') }] };
  const running = [{ service: 'api', instance: 'api-1', digest: sha256('a') }, { service: 'web', instance: 'web-1', digest: sha256('b') }];
  assert.deepEqual(verifyPromotedDigests(promoted, running), { mode: 'digest', verified: true, mismatches: [] }, 'every instance running the promoted digest verifies');

  // An instance running anything else fails the verification naming the service.
  const drifted = verifyPromotedDigests(promoted, [...running, { service: 'api', instance: 'api-2', digest: sha256('f') }]);
  assert.equal(drifted.verified, false);
  assert.deepEqual(drifted.mismatches.map(mismatch => mismatch.service), ['api']);
  assert.match(drifted.mismatches[0].detail, /instance api-2 of api runs sha256:f{64} instead of the promoted sha256:a{64}/);

  // A service with no recorded instance digest is unverified, and names the service.
  const unobserved = verifyPromotedDigests(promoted, [{ service: 'api', instance: 'api-1', digest: sha256('a') }, { service: 'web', instance: 'web-1', digest: null }]);
  assert.equal(unobserved.verified, false);
  assert.deepEqual(unobserved.mismatches.map(mismatch => mismatch.service).sort(), ['web']);
  assert.match(unobserved.mismatches[0].detail, /web-1 of web runs no recorded digest/);
  const gone = verifyPromotedDigests(promoted, [{ service: 'api', instance: 'api-1', digest: sha256('a') }]);
  assert.equal(gone.verified, false);
  assert.deepEqual(gone.mismatches.map(mismatch => mismatch.service), ['web']);
  assert.match(gone.mismatches[0].detail, /no running instance of web reported a digest/);

  // An adapter that cannot deploy by digest promotes by commit: reported as sha-promoted, nothing to compare.
  assert.deepEqual(verifyPromotedDigests({ sha: tip }, running), { mode: 'sha-promoted', verified: true, mismatches: [] });
  assert.equal(verifyPromotedDigests({ sha: tip, digests: [] }, running).mode, 'sha-promoted');
  assert.equal(verifyPromotedDigests({ sha: tip, digests: null }, running).mode, 'sha-promoted');
});


/* The in-flight validation guard review finding: a digest UAT deploy must not replace UAT under a
 * validation that has no verdict yet — its own or a sha deploy's — and must leave the record a
 * branch move would leave, so later deploys see the validation in flight. */
test('unit:uat-digest-deploy-guarded — a digest UAT deploy records what it serves as a UAT deployment generation and honors the same in-flight validation guard as the branch move', async () => {
  const { deployToUat, uatBranch, uatValidationWindowMs } = await load();
  const later = { ...candidate, id: '20261001T130000Z', sha: 'd'.repeat(40) };

  // Deploying by digest writes and publishes the generation a branch move would otherwise leave.
  const first = ledgerGit({ candidates: [later, candidate] });
  let deploys = 0;
  const deployed = deployToUat(first.git, candidate.id, 'main', now, () => { deploys++; });
  assert.equal(deployed.mode, 'digest');
  assert.equal(deploys, 1);
  assert.deepEqual(first.tags().find(entry => entry.id === candidate.id), uatGeneration(candidate, 1, 'digest'), 'the generation names the candidate and the digests it put into UAT');
  assert.ok(first.pushes().some(push => push.includes(`refs/tags/${deploymentTagPrefix}uat/00000001`)), 'the generation is published, so every later deploy sees the validation in flight');
  assert.ok(first.pushes().every(push => !push.includes('refs/heads/')), 'a digest deploy still moves no branch');

  // Another digest deploy while that validation has no verdict yet is refused before the deployer runs.
  const guard = ledgerGit({ candidates: [later, candidate], ...digestServed(candidate, 1) });
  assert.throws(() => deployToUat(guard.git, later.id, 'main', new Date(uatValidationWindowMs - 60_000), () => { deploys++; }),
    new RegExp(`UAT serves candidate ${candidate.id}'s recorded digests .*no verdict yet`));
  assert.equal(deploys, 1, 'the refused deploy never reaches the deployer: the running validation is not broken');

  // A sha deploy is refused by the same guard: moving the branch would replace UAT all the same.
  const shaBlocked = ledgerGit({ candidates: [later, candidate], ...digestServed(candidate, 1) });
  assert.throws(() => deployToUat(shaBlocked.git, later.id, 'main', now), /recorded digests.*no verdict yet/);
  assert.ok(shaBlocked.pushes().every(push => !push.includes(`refs/heads/${uatBranch}`)), 'nothing was pushed');

  // And the digest deploy is refused while a sha-deployed candidate's validation runs.
  const branchGuard = ledgerGit({ candidates: [later, candidate] }, { 'ls-remote': () => `${tip}\trefs/heads/${uatBranch}` });
  assert.throws(() => deployToUat(branchGuard.git, later.id, 'main', now, () => { deploys++; }), /moving release\/uat now would fail it/);
  assert.equal(deploys, 1);

  // A verdict lifts the refusal: the newest generation then names what UAT serves now.
  const judged = ledgerGit({ candidates: [later, candidate], uat: [passedUat], ...digestServed(candidate, 1) });
  const redeployed = deployToUat(judged.git, later.id, 'main', now, () => { deploys++; });
  assert.equal(redeployed.mode, 'digest');
  assert.equal(deploys, 2);
  assert.deepEqual(judged.tags().find(entry => entry.id === later.id), uatGeneration(later, 2, 'digest'), 'the next generation now names the candidate UAT serves');

  // A validation whose window passed without a verdict no longer blocks, exactly as for branch moves.
  const expired = ledgerGit({ candidates: [later, candidate], ...digestServed(candidate, 1) });
  assert.equal(deployToUat(expired.git, later.id, 'main', new Date(uatValidationWindowMs + 60_000), () => { deploys++; }).mode, 'digest', 'an abandoned validation is waited out, not forever');
  assert.equal(deploys, 3);
});

/* The wedged-lease review finding: a digest promotion moves no branch, so the newest production
 * record can name a SHA the branch never held — a later sha promotion leasing on it is rejected
 * forever. It leases on the branch's last sha-mode position instead. */
test('unit:sha-promotion-leases-past-digest-promotions — a sha promotion after digest promotions leases on the branch\'s last sha-mode position, so the digest generations never wedge it', async () => {
  const { productionBranch, promote } = await load();
  const branchSha = '1'.repeat(40), digestSha = '2'.repeat(40), nextSha = '3'.repeat(40);
  const bySha: ReleaseCandidate = { id: '20261001T120000Z', sha: branchSha, cutAt: iso, trigger: 'manual', since: null, items: [] };
  const byDigest: ReleaseCandidate = { ...candidate, id: '20261001T130000Z', sha: digestSha };
  const next: ReleaseCandidate = { id: '20261001T140000Z', sha: nextSha, cutAt: iso, trigger: 'manual', since: null, items: [] };
  const uatFor = (entry: ReleaseCandidate): UatRecord => ({ id: entry.id, sha: entry.sha, result: 'passed', deployedSha: entry.sha, at: iso, suites: [{ name: 'endpoints', passed: true, detail: 'ok' }], followUp: null, ...(entry.build ? { digests: built.artifacts } : {}) });
  const production = [{ id: byDigest.id, sha: digestSha, at: iso }, { id: bySha.id, sha: branchSha, at: iso }];
  const leaseOf = (ledger: Partial<Ledger>) => {
    const repo = ledgerGit({ candidates: [next, byDigest, bySha], uat: [uatFor(next), uatFor(byDigest)], production, ...ledger });
    const promoted = promote(repo.git, next.id, { base: 'main', push: false, now });
    assert.deepEqual(promoted, { promoted: true, candidate: next.id, sha: nextSha, branch: productionBranch }, 'the sha promotion is not refused or rejected because digests were promoted before it');
    const branchPush = repo.pushes().find(push => push.includes(`refs/heads/${productionBranch}`));
    assert.ok(branchPush, 'the sha promotion moves release/production');
    assert.ok(!branchPush.includes(digestSha), 'never on the digest generation\'s SHA, which the branch never held');
    assert.deepEqual(repo.tags().find(entry => entry.id === next.id && entry.mode), productionGeneration(next, 3, 'sha'), 'a sha promotion records a sha generation with no digests');
    return branchPush;
  };
  // Generations name the last branch move.
  assert.ok(leaseOf({ deployments: [productionGeneration(byDigest, 2, 'digest'), productionGeneration(bySha, 1, 'sha')], deployed: [settledAs(byDigest, 2, 'succeeded'), settledAs(bySha, 1, 'succeeded')] })
    .includes(`--force-with-lease=refs/heads/${productionBranch}:${branchSha}`));
  // A sha promotion recorded before generations existed still names it, past the digest generation.
  assert.ok(leaseOf({ deployments: [productionGeneration(byDigest, 2, 'digest')], deployed: [settledAs(byDigest, 2, 'succeeded')] })
    .includes(`--force-with-lease=refs/heads/${productionBranch}:${branchSha}`));
});

/* The digest-bound UAT review finding: a digest promotion deploys the recorded build, so a UAT
 * record that names no digests (taken by SHA, or without them) never validated those artifacts. */
test('unit:digest-promotion-needs-digest-uat — promotion by digest is refused unless the UAT record names the recorded build\'s digests, and nothing is deployed', async () => {
  const { digestPromotionRefusal, promote, promoteAsync } = await load();
  const shaOnlyUat: UatRecord = { ...passedUat, digests: undefined };
  assert.match(digestPromotionRefusal(candidate, shaOnlyUat) ?? '', /names no digests/);
  assert.equal(digestPromotionRefusal(candidate, passedUat), null);
  assert.equal(digestPromotionRefusal({ ...candidate, build: undefined }, shaOnlyUat), null, 'a candidate without a build has no digests to bind');
  let deploys = 0;
  const repo = ledgerGit({ candidates: [candidate], uat: [shaOnlyUat] });
  const refused = promote(repo.git, candidate.id, { base: 'main', push: false, now, deployDigests: () => { deploys++; } });
  assert.equal(refused.promoted, false);
  assert.match(refused.refusals!.join(' '), /names no digests/);
  const asyncRefused = await promoteAsync(ledgerGit({ candidates: [candidate], uat: [shaOnlyUat] }).asyncGit, candidate.id, { base: 'main', push: false, now, deployDigests: async () => { deploys++; } });
  assert.equal(asyncRefused.promoted, false);
  assert.equal(deploys, 0, 'nothing UAT never named is deployed');
  assert.deepEqual(repo.pushes(), [], 'and no record is written or pushed');
  // Without a digest deployer the same record keeps sha promotion: it validated the SHA.
  assert.equal(promote(ledgerGit({ candidates: [candidate], uat: [shaOnlyUat] }).git, candidate.id, { base: 'main', push: false, now }).promoted, true);
});

/* The redeploy review finding: a tag never moves, so one record per candidate made a second digest
 * deploy of it throw after the deployer ran; and the guard must judge what UAT was put to serve
 * last, not the record that sorts first by candidate ID. */
test('unit:uat-digest-redeploy-records-again — redeploying a candidate by digest takes the next UAT generation, and the guard judges the newest generation', async () => {
  const { deployToUat } = await load();
  const later = { ...candidate, id: '20261001T130000Z', sha: 'd'.repeat(40) };
  const repo = ledgerGit({ candidates: [later, candidate] });
  let deploys = 0;
  deployToUat(repo.git, candidate.id, 'main', now, () => { deploys++; });
  deployToUat(repo.git, candidate.id, 'main', new Date(60_000), () => { deploys++; });
  assert.equal(deploys, 2);
  assert.deepEqual(repo.tagNames(), [`${deploymentTagPrefix}uat/00000001`, `${deploymentOutcomeTagPrefix}uat/00000001`, `${deploymentTagPrefix}uat/00000002`, `${deploymentOutcomeTagPrefix}uat/00000002`],
    'each deploy takes its own generation, so a redeploy never collides');

  // The older candidate redeployed after the later one serves UAT now; its pending validation is fenced
  // even though the later candidate's ID sorts first.
  const fenced = ledgerGit({ candidates: [later, candidate], deployments: [uatGeneration(later, 1, 'digest'), uatGeneration(candidate, 2, 'digest')], deployed: [settledAs(later, 1, 'succeeded', 'uat'), settledAs(candidate, 2, 'succeeded', 'uat')] });
  assert.throws(() => deployToUat(fenced.git, later.id, 'main', new Date(120_000), () => { deploys++; }), new RegExp(`UAT serves candidate ${candidate.id}'s recorded digests`));
  assert.equal(deploys, 2);
});

/* The concurrency review findings (UAT and production): two deploys reading the same ledger must
 * not both reach their external effect, and an older deploy must not finish after a newer one began.
 * Every deploy, by digest or branch move, takes the environment's next generation before its effect. */
test('unit:deploy-generations-fence-concurrent-deploys — a deploy whose generation another published first is refused before any effect, an unsettled generation refuses the next deploy, the deployer is handed its generation, and a failed effect is settled failed', async () => {
  const { deployToUat, deploymentFenceWindowMs, promote, promoteAsync } = await load();
  const later = { ...candidate, id: '20261001T130000Z', sha: 'd'.repeat(40) };
  const laterUat: UatRecord = { ...passedUat, id: later.id, sha: later.sha, deployedSha: later.sha };
  // Two promotions read the same ledger; the first publishes generation 1, so the second's publish is refused.
  const published = new Set<string>();
  const racing = () => ledgerGit({ candidates: [later, candidate], uat: [laterUat, passedUat] }, {
    push: args => { const tag = args[2]; if (published.has(tag)) throw new Error(`! [rejected] ${tag} (already exists)`); published.add(tag); return ''; },
  });
  const effects: string[] = [];
  const winner = racing(), loser = racing();
  await promoteAsync(winner.asyncGit, later.id, { base: 'main', push: true, now, deployDigests: async (_digests, _sha, fence) => { effects.push(`${later.id}@${fence.environment}#${fence.generation}`); } });
  await assert.rejects(promoteAsync(loser.asyncGit, candidate.id, { base: 'main', push: true, now, deployDigests: async () => { effects.push(candidate.id); } }),
    /Another deploy took production deployment generation 1 first, so candidate 20261001T120000Z was not deployed/);
  assert.deepEqual(effects, [`${later.id}@production#1`], 'only the generation\'s owner deployed, and the deployer was handed that generation');
  // The same fence holds for sha promotions: the refused one never moves the branch.
  const shaLoser = racing();
  assert.throws(() => promote(shaLoser.git, candidate.id, { base: 'main', push: true, now }), /Another deploy took production deployment generation 1/);
  assert.ok(shaLoser.pushes().every(push => !push.includes('refs/heads/')), 'the refused sha promotion moved no branch');
  // And for UAT, in both modes.
  published.clear();
  const uatWinner = racing(), uatLoser = racing();
  deployToUat(uatWinner.git, later.id, 'main', now, () => { effects.push('uat'); });
  assert.throws(() => deployToUat(uatLoser.git, later.id, 'main', now), /Another deploy took uat deployment generation 1/);
  assert.ok(uatLoser.pushes().every(push => !push.includes('refs/heads/')));

  // A generation still in flight refuses the next deploy, digest or sha, until it settles or its window passes.
  const inFlight = { candidates: [later, candidate], uat: [laterUat, passedUat], deployments: [productionGeneration(later, 1, 'digest')] };
  assert.throws(() => promote(ledgerGit(inFlight).git, candidate.id, { base: 'main', push: false, now: new Date(60_000), deployDigests: () => { effects.push('late'); } }), /generation 1 \(candidate 20261001T130000Z by digest.*\) has no outcome yet/);
  assert.throws(() => promote(ledgerGit(inFlight).git, candidate.id, { base: 'main', push: false, now: new Date(60_000) }), /has no outcome yet/);
  assert.equal(promote(ledgerGit(inFlight).git, candidate.id, { base: 'main', push: false, now: new Date(deploymentFenceWindowMs + 1), deployDigests: () => { effects.push('after-window'); } }).promoted, true, 'an abandoned generation is waited out, not forever');
  assert.equal(effects.at(-1), 'after-window');

  // A failed effect settles its generation failed and is rethrown; what production runs is then the generation before it.
  const failing = ledgerGit({ candidates: [later, candidate], uat: [laterUat, passedUat] });
  assert.throws(() => promote(failing.git, later.id, { base: 'main', push: false, now, deployDigests: () => { throw new Error('provider refused generation 1'); } }), /provider refused/);
  const outcome = failing.tags().find(entry => entry.result);
  assert.deepEqual(outcome, { environment: 'production', generation: 1, id: later.id, result: 'failed', at: iso, detail: 'provider refused generation 1' });
  assert.ok(!failing.tags().some(entry => !entry.environment && entry.id === later.id), 'a failed deployment writes no production record');
});

/* The mode-change and status review findings: each deployment records its actual mode and digests,
 * so a candidate retried by another mode is described as what production now runs. */
test('unit:promotion-records-actual-mode — a candidate sha-promoted then retried by digest (and back) records each generation\'s actual mode; status and verification follow the newest', async () => {
  const { ledgerStatus, promote, verifyProductionDigests } = await load();
  const repo = ledgerGit({ candidates: [candidate], uat: [passedUat] });
  promote(repo.git, candidate.id, { base: 'main', push: false, now });
  const read = (): Ledger => { const git = repo.git; return { ...emptyLedger, ...Object.fromEntries((['candidates', 'uat', 'production', 'soak', 'deployments', 'deployed'] as const).map(key => [key, JSON.parse(`[${git(['for-each-ref', '--sort=-refname', '', `refs/tags/${{ candidates: 'rc/', uat: 'rc-uat/', production: 'rc-production/', soak: 'rc-soak/', deployments: deploymentTagPrefix, deployed: deploymentOutcomeTagPrefix }[key]}`]).split('\0\0\n').filter(Boolean).map(entry => entry.split('\0')[1]).join(',')}]`)])) }; };
  assert.equal(ledgerStatus(read())[0].promotion, 'sha', 'the sha fallback of a candidate with a recorded build is reported as sha');
  assert.ok(!('productionDigests' in ledgerStatus(read())[0]));
  assert.equal((await verifyProductionDigests(read())).mode, 'sha-promoted');

  promote(repo.git, candidate.id, { base: 'main', push: false, now: new Date(60_000), deployDigests: () => {} });
  const generations = read().deployments.filter(entry => entry.environment === 'production').sort((a, b) => a.generation - b.generation).map(entry => [entry.generation, entry.mode]);
  assert.deepEqual(generations, [[1, 'sha'], [2, 'digest']], 'the digest retry of an already-promoted candidate records its own generation');
  assert.equal(ledgerStatus(read())[0].promotion, 'digest');
  assert.deepEqual(ledgerStatus(read())[0].productionDigests, built.artifacts);
  const unobserved = await verifyProductionDigests(read());
  assert.equal(unobserved.verified, false, 'a digest generation with nothing observing the instances is not verified');
  assert.match(unobserved.mismatches[0].detail, /GRAPHYARD_INSTANCE_DIGESTS is not set/);

  promote(repo.git, candidate.id, { base: 'main', push: false, now: new Date(120_000) });
  assert.equal(ledgerStatus(read())[0].promotion, 'sha', 'and back to sha: the old digest evidence no longer describes production');
  assert.equal((await verifyProductionDigests(read())).mode, 'sha-promoted');
  assert.equal(read().production.length, 1, 'the candidate\'s production record is still written once');
});

/* The wiring review findings: the supported release entry points — the CLI's and the loop's local
 * ports — build at cut, deploy recorded digests and verify instance digests through the repository's
 * command adapter. */
test('unit:release-callers-use-digest-adapter — the command adapter builds once at cut, deploys exactly the manifest under its generation, and the loop\'s ports promote by digest and verify production\'s instance digests', async () => {
  const { commandDigestAdapter, localReleasePorts, masterConfigSchema, uatDigestSuite } = await load();
  const commands: { command: string; env: Record<string, string> }[] = [];
  let running: { service: string; instance: string; digest: string }[] = built.artifacts.map(entry => ({ service: entry.service, instance: `${entry.service}-1`, digest: entry.digest }));
  const shell: ShellRun = async (command, env) => {
    commands.push({ command, env });
    if (command === 'build') return `building…\n${JSON.stringify(built)}\n`;
    if (command === 'instances') return `${JSON.stringify(running)}\n`;
    return 'deployed\n';
  };
  const environment = { GRAPHYARD_RELEASE_BUILD: 'build', GRAPHYARD_DEPLOY_DIGESTS: 'deploy', GRAPHYARD_INSTANCE_DIGESTS: 'instances' };
  const adapter = commandDigestAdapter(environment, shell);
  assert.ok(adapter.build && adapter.deploy && adapter.instances);
  assert.deepEqual(commandDigestAdapter({}, shell), {}, 'without the commands every port is absent and every deploy keeps sha promotion');
  assert.deepEqual(await adapter.build!({ id: candidate.id, sha: tip, items: [] }), built);
  assert.deepEqual(commands[0].env, { GRAPHYARD_CANDIDATE_ID: candidate.id, GRAPHYARD_CANDIDATE_SHA: tip });
  await adapter.deploy!(built.artifacts, tip, { environment: 'production', generation: 7 });
  assert.deepEqual(commands[1].env, { GRAPHYARD_DEPLOY_ENVIRONMENT: 'production', GRAPHYARD_DEPLOY_GENERATION: '7', GRAPHYARD_CANDIDATE_SHA: tip, GRAPHYARD_DEPLOY_MANIFEST: JSON.stringify(built.artifacts) });
  const suite = await uatDigestSuite(built.artifacts, adapter.instances!).run('https://uat.example.test', candidate);
  assert.equal(suite.passed, true);
  assert.equal(commands.at(-1)!.env.GRAPHYARD_DEPLOY_ENVIRONMENT, 'uat', 'UAT\'s digest suite asks the adapter for UAT\'s instances');

  // The loop's local ports, over the in-memory ledger: every git call answered by it, every shell command recorded.
  const repo = ledgerGit({ candidates: [candidate], uat: [passedUat] }, { 'ls-remote': () => '' });
  const sh: string[] = [];
  const run = async (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    if (command === 'git') return repo.git(args);
    sh.push(args[1]);
    if (args[1] === 'instances') return JSON.stringify(running);
    assert.equal(options?.env?.GRAPHYARD_DEPLOY_MANIFEST, JSON.stringify(built.artifacts), 'the loop deploys exactly the recorded manifest');
    return '';
  };
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy', retrials: 2 } } });
  const ports = localReleasePorts(config, '/checkout', run, { base: '/managed', record: async () => ({}), now: () => 0,
    environment: { GRAPHYARD_UAT_URL: 'https://uat.example.test', GRAPHYARD_PRODUCTION_URL: 'https://app.example.test', ...environment } })!;
  assert.deepEqual(await ports.promote(candidate.id), { promoted: true, sha: tip });
  assert.deepEqual(sh, ['deploy'], 'the loop promoted through the digest deployer');
  assert.ok(repo.pushes().every(push => !push.includes('refs/heads/')), 'and moved no branch: nothing rebuilds');
  const served = (async () => new Response(JSON.stringify({ ok: true, commit: tip }))) as typeof fetch;
  const realFetch = globalThis.fetch;
  globalThis.fetch = served;
  try {
    assert.deepEqual(await ports.verify(tip), { served: tip, verified: true }, 'every instance runs the promoted digest');
    running = [...running, { service: 'web', instance: 'web-2', digest: sha256('f') }];
    assert.deepEqual(await ports.verify(tip), { served: tip, verified: false }, 'one instance on another digest fails production verification at the same SHA');
  } finally { globalThis.fetch = realFetch; }
});
