import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessPromotion, assessUat, candidateTagPrefix, cut, deployToUat, digestPromotionRefusal, deployToUatAsync, ledgerStatus, productionBranch, promote, promoteAsync,
  recordCandidateBuild, uatBranch, uatDeployTagPrefix, uatTagPrefix, uatValidationWindowMs, validate, validateAndRecord,
  type AsyncGit, type CandidateBuild, type Git, type Ledger, type ReleaseCandidate, type Suite, type UatDeployRecord, type UatRecord,
} from '../src/release-candidate.js';
import type { Manifest } from '../src/delivery.js';
import { verifyPromotedDigests } from '../src/production-delivery.js';

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
const recordingSuite = (name: string, passed: boolean): Suite => ({ name, run: async () => ({ name, passed, detail: passed ? 'ok' : `${name} failed` }) });

/**
 * The candidate ledger in memory: `for-each-ref` reads the tag records, every other command answers
 * empty unless a handler names it, and every call is kept so the tests can name what was pushed —
 * a digest promotion may push nothing at all, because moving a deploy branch is what triggers a rebuild.
 */
function ledgerGit(ledger: Partial<Ledger>, handlers: Record<string, (args: string[]) => string> = {}) {
  const calls: string[][] = [];
  const git: Git = args => {
    calls.push(args);
    if (handlers[args[0]]) return handlers[args[0]](args);
    if (args[0] === 'for-each-ref') {
      const prefix = args[3].slice('refs/tags/'.length);
      const key = prefix.startsWith('rc-production/') ? 'production' : prefix.startsWith(candidateTagPrefix) ? 'candidates' : prefix.startsWith(uatTagPrefix) ? 'uat' : prefix.startsWith(uatDeployTagPrefix) ? 'uatDeploys' : 'soak';
      return ((ledger[key] ?? []) as { id: string }[]).map(record => `${prefix}${record.id}\0${JSON.stringify(record, null, 2)}`).join('\0\0\n');
    }
    return '';
  };
  const asyncGit: AsyncGit = async args => git(args);
  return {
    git, calls, asyncGit,
    tags: () => calls.filter(args => args[4] === 'tag' && args[5] === '-a').map(args => JSON.parse(args[args.indexOf('-m') + 1])),
    pushes: () => calls.filter(args => args[0] === 'push').map(args => args.join(' ')),
  };
}

test('unit:candidate-promotes-recorded-digests — a candidate records one build registration with each service\'s digest; UAT results and promotion name those digests; promotion with a digest deployer deploys exactly them and never moves a branch, and a caller without one keeps sha promotion', async () => {
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
  assert.deepEqual(digestRepo.tags().find(record => record.id === candidate.id).digests, built.artifacts, 'the production record names the digests it deployed');

  // The loop's async port promotes by digest the same way.
  const asyncRepo = ledgerGit({ candidates: [candidate], uat: [passedUat] });
  let asyncDeploys = 0;
  const asyncPromoted = await promoteAsync(asyncRepo.asyncGit, candidate.id, { base: 'main', push: false, now, deployDigests: async () => { asyncDeploys++; } });
  assert.equal(asyncPromoted.mode, 'digest');
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
  assert.deepEqual(uatRepo.pushes(), [`push origin refs/tags/${uatDeployTagPrefix}${candidate.id}/19700101T000000000Z`], 'the digest deploy publishes its record — the trace a branch move would leave — and pushes nothing else');

  // Without a digest deployer the adapter keeps sha promotion: the branch move names no mode.
  const shaRepo = ledgerGit({ candidates: [candidate], uat: [passedUat] });
  const shaPromoted = promote(shaRepo.git, candidate.id, { base: 'main', push: false, now });
  assert.deepEqual(shaPromoted, { promoted: true, candidate: candidate.id, sha: tip, branch: productionBranch });
  assert.ok(shaRepo.pushes().some(push => push.includes(`refs/heads/${productionBranch}`)), 'sha promotion moves release/production');

  // Status reports which way each candidate promotes and what ran in production.
  const status = ledgerStatus({ candidates: [candidate], uat: [passedUat], uatDeploys: [], production: [{ id: candidate.id, sha: tip, at: iso, digests: built.artifacts }], soak: [] });
  assert.equal(status[0].promotion, 'digest');
  assert.deepEqual(status[0].build?.digests, built.artifacts);
  assert.deepEqual(status[0].productionDigests, built.artifacts);
  assert.equal(ledgerStatus({ candidates: [{ ...candidate, build: undefined }], uat: [], uatDeploys: [], production: [], soak: [] })[0].promotion, 'sha', 'a candidate without a build is reported as sha promotion');
});

test('unit:production-digest-verified — production verification compares every recorded running digest with the promoted digest, fails naming the service on any other digest, passes when all match, and reports a promotion without digests as sha-promoted', () => {
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

const digestServed = (candidate: ReleaseCandidate, at: string): UatDeployRecord => ({ id: candidate.id, sha: candidate.sha, at, digests: built.artifacts });

/* The in-flight validation guard review finding: a digest UAT deploy must not replace UAT under a
 * validation that has no verdict yet — its own or a sha deploy's — and must leave the record a
 * branch move would leave, so later deploys see the validation in flight. */
test('unit:uat-digest-deploy-guarded — a digest UAT deploy records what it serves as rc-uat-deploy/ID and honors the same in-flight validation guard as the branch move', () => {
  const later = { ...candidate, id: '20261001T130000Z', sha: 'd'.repeat(40) };

  // Deploying by digest writes and publishes the record a branch move would otherwise leave.
  const first = ledgerGit({ candidates: [later, candidate] });
  let deploys = 0;
  const deployed = deployToUat(first.git, candidate.id, 'main', now, () => { deploys++; });
  assert.equal(deployed.mode, 'digest');
  assert.equal(deploys, 1);
  assert.deepEqual(first.tags().find(entry => entry.id === candidate.id), digestServed(candidate, iso), 'the record names the candidate and the digests it put into UAT');
  assert.ok(first.pushes().some(push => push.includes(`refs/tags/${uatDeployTagPrefix}${candidate.id}`)), 'the record is published, so every later deploy sees the validation in flight');
  assert.ok(first.pushes().every(push => !push.includes('refs/heads/')), 'a digest deploy still moves no branch');

  // Another digest deploy while that validation has no verdict yet is refused before the deployer runs.
  const guard = ledgerGit({ candidates: [later, candidate], uatDeploys: [digestServed(candidate, iso)] });
  assert.throws(() => deployToUat(guard.git, later.id, 'main', new Date(uatValidationWindowMs - 60_000), () => { deploys++; }),
    new RegExp(`UAT serves candidate ${candidate.id}'s recorded digests .*no verdict yet`));
  assert.equal(deploys, 1, 'the refused deploy never reaches the deployer: the running validation is not broken');

  // A sha deploy is refused by the same guard: moving the branch would replace UAT all the same.
  const shaBlocked = ledgerGit({ candidates: [later, candidate], uatDeploys: [digestServed(candidate, iso)] });
  assert.throws(() => deployToUat(shaBlocked.git, later.id, 'main', now), /recorded digests.*no verdict yet/);
  assert.ok(shaBlocked.pushes().every(push => !push.includes(`refs/heads/${uatBranch}`)), 'nothing was pushed');

  // And the digest deploy is refused while a sha-deployed candidate's validation runs.
  const branchGuard = ledgerGit({ candidates: [later, candidate] }, { 'ls-remote': () => `${tip}\trefs/heads/${uatBranch}` });
  assert.throws(() => deployToUat(branchGuard.git, later.id, 'main', now, () => { deploys++; }), /moving release\/uat now would fail it/);
  assert.equal(deploys, 1);

  // A verdict lifts the refusal: the newest record then names what UAT serves now.
  const judged = ledgerGit({ candidates: [later, candidate], uat: [passedUat], uatDeploys: [digestServed(candidate, iso)] });
  const redeployed = deployToUat(judged.git, later.id, 'main', now, () => { deploys++; });
  assert.equal(redeployed.mode, 'digest');
  assert.equal(deploys, 2);
  assert.deepEqual(judged.tags().find(entry => entry.id === later.id), digestServed(later, iso), 'the newest record now names the candidate UAT serves');

  // A validation whose window passed without a verdict no longer blocks, exactly as for branch moves.
  const expired = ledgerGit({ candidates: [later, candidate], uatDeploys: [digestServed(candidate, iso)] });
  assert.equal(deployToUat(expired.git, later.id, 'main', new Date(uatValidationWindowMs + 60_000), () => { deploys++; }).mode, 'digest', 'an abandoned validation is waited out, not forever');
  assert.equal(deploys, 3);
});

/* The wedged-lease review finding: a digest promotion moves no branch, so the newest production
 * record can name a SHA the branch never held — a later sha promotion leasing on it is rejected
 * forever. It leases on the branch's last sha-mode position instead. */
test('unit:sha-promotion-leases-past-digest-promotions — a sha promotion after digest promotions leases on the branch\'s last sha-mode position, so the digest records never wedge it', () => {
  const branchSha = '1'.repeat(40), digestSha = '2'.repeat(40), nextSha = '3'.repeat(40);
  const bySha: ReleaseCandidate = { id: '20261001T120000Z', sha: branchSha, cutAt: iso, trigger: 'manual', since: null, items: [] };
  const byDigest: ReleaseCandidate = { ...candidate, id: '20261001T130000Z', sha: digestSha };
  const next: ReleaseCandidate = { id: '20261001T140000Z', sha: nextSha, cutAt: iso, trigger: 'manual', since: null, items: [] };
  const uatFor = (entry: ReleaseCandidate): UatRecord => ({ id: entry.id, sha: entry.sha, result: 'passed', deployedSha: entry.sha, at: iso, suites: [{ name: 'endpoints', passed: true, detail: 'ok' }], followUp: null, ...(entry.build ? { digests: built.artifacts } : {}) });
  const repo = ledgerGit({
    candidates: [next, byDigest, bySha],
    uat: [uatFor(next), uatFor(byDigest)],
    production: [{ id: byDigest.id, sha: digestSha, at: iso, digests: built.artifacts }, { id: bySha.id, sha: branchSha, at: iso }],
  });
  const promoted = promote(repo.git, next.id, { base: 'main', push: false, now });
  assert.deepEqual(promoted, { promoted: true, candidate: next.id, sha: nextSha, branch: productionBranch }, 'the sha promotion is not refused or rejected because digests were promoted before it');
  const branchPush = repo.pushes().find(push => push.includes(`refs/heads/${productionBranch}`));
  assert.ok(branchPush, 'the sha promotion moves release/production');
  assert.ok(branchPush.includes(`--force-with-lease=refs/heads/${productionBranch}:${branchSha}`), `the lease names the branch's last sha-mode position (${branchSha.slice(0, 8)}…), not the digest record's SHA (${digestSha.slice(0, 8)}…), which the branch never held`);
  assert.ok(!branchPush.includes(digestSha));
  assert.ok(!('digests' in repo.tags().find(entry => entry.id === next.id)), 'a sha promotion still records no digests');
});

/* The digest-bound UAT review finding: a digest promotion deploys the recorded build, so a UAT
 * record that names no digests (taken by SHA, or without them) never validated those artifacts. */
test('unit:digest-promotion-needs-digest-uat — promotion by digest is refused unless the UAT record names the recorded build\'s digests, and nothing is deployed', async () => {
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
 * deploy of it throw after the deployer ran; and records read by refname order by candidate ID,
 * not by when UAT took them. */
test('unit:uat-digest-redeploy-records-again — redeploying a candidate by digest records a new rc-uat-deploy/ID/AT record, and the guard judges the latest-deployed record', () => {
  const later = { ...candidate, id: '20261001T130000Z', sha: 'd'.repeat(40) };
  const repo = ledgerGit({ candidates: [later, candidate] });
  let deploys = 0;
  deployToUat(repo.git, candidate.id, 'main', now, () => { deploys++; });
  deployToUat(repo.git, candidate.id, 'main', new Date(60_000), () => { deploys++; });
  assert.equal(deploys, 2);
  const tags = repo.calls.filter(args => args[4] === 'tag' && args[5] === '-a').map(args => args[6]);
  assert.deepEqual(tags, [`${uatDeployTagPrefix}${candidate.id}/19700101T000000000Z`, `${uatDeployTagPrefix}${candidate.id}/19700101T000100000Z`], 'each deploy records its own tag, so a redeploy never collides');

  // The older candidate redeployed after the later one serves UAT now; its pending validation is fenced
  // even though the later candidate's record sorts first by refname.
  const fenced = ledgerGit({ candidates: [later, candidate], uatDeploys: [digestServed(later, iso), digestServed(candidate, new Date(60_000).toISOString())] });
  assert.throws(() => deployToUat(fenced.git, later.id, 'main', new Date(120_000), () => { deploys++; }), new RegExp(`UAT serves candidate ${candidate.id}'s recorded digests`));
  assert.equal(deploys, 2);
});
