import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate } from '../src/model/gates.js';
import { placeInQueue } from '../src/model/queue.js';
import { ejectionReason } from '../src/merge-queue.js';
import {
  LANDABILITY_VERSION, evaluateLandability, landabilityEjection, landabilityEjections, landabilityFamily, landabilityRefusals, type LandabilityVerdict,
} from '../src/model/landability.js';
import { stableJson } from '../src/model/stable-json.js';
import type { Evidence, Observation, ScopeFile, Work } from '../src/model.js';

// GY-878. Whether a candidate can land was answered twice — by the build and acceptance gates and
// again by the merge queue's ejection check and landing re-check — and the answers drifted apart
// three times: GY-871 (the queue ejected files the gate excused as carried), GY-875 (the queue
// ejected a manual proof that executed nothing, which the gate reads as unexercised) and GY-863
// (a false revert the three-way merge settles). evaluateLandability is the one answer now; these
// tests pin that every consumer reads it, that it is pure, and that an ejection is never sticky.

const at = '2026-09-30T12:00:00.000Z';
const now = new Date(at);
const sha = (digit: string) => digit.repeat(40);
const main = sha('b');
const CI = [1];

/** A file on a head as GitHub lists it against its bound base: this head changed it, the base holds another version. */
const changed = (path: string, overrides: Partial<ScopeFile> = {}): ScopeFile =>
  ({ path, status: 'modified', sha: sha('d'), baseSha: sha('e'), additions: 3, deletions: 1, binary: false, ...overrides });

const evidence = (proof: string, head: string, overrides: Partial<Evidence> = {}): Evidence => ({
  id: `${proof}@${head.slice(0, 4)}#${overrides.result ?? 'pass'}${overrides.executed ?? ''}${overrides.at ?? ''}`, proof, sha: head, baseSha: sha('9'), policyRevision: 1,
  producer: 'independent-producer', trusted: true, result: 'pass', executed: 3, skipped: 0, at, ...overrides,
}) as Evidence;

interface Shape {
  key: string; head?: string; planned?: string[]; files?: string[]; scopeFiles?: ScopeFile[]; landing?: Observation['landing'];
  proofs?: string[]; evidence?: Evidence[]; queued?: number | null; submitted?: boolean; workspace?: boolean;
}

function item(shape: Shape, extra: Partial<Work> = {}): Work {
  const head = shape.head ?? sha('7');
  // GY-883: the item's own change is on the public API, the high lane, whose full path requires
  // every proof these verdicts judge.
  const files = shape.files ?? ['src/server/routes/own.ts'];
  const candidate = { sha: head, baseSha: sha('9'), pr: 40 + shape.key.charCodeAt(3), branch: `graphyard/${shape.key.toLowerCase()}-1`, author: 'worker' };
  const proofs = shape.proofs ?? ['unit:own-proof'];
  const observation: Observation = {
    candidate, checks: [{ name: 'test', result: 'success', appId: 1 }], reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED', submittedAt: at }],
    merged: false, mergeSha: null, mergeable: true, protected: true, files,
    scopeFiles: shape.scopeFiles ?? files.map(path => changed(path)), landing: shape.landing ?? { base: main, files: files.map(path => changed(path)) },
    at, prState: 'open', draft: false, baseTip: main, baseTree: sha('e'), baseTipContained: true,
  } as Observation;
  const queued = shape.queued === undefined ? 1 : shape.queued;
  return {
    id: shape.key.toLowerCase(), key: shape.key, title: shape.key, description: '', type: 'feature', priority: 0, dependencies: [],
    criteria: proofs.map((proof, index) => ({ id: `AC-${index + 1}`, text: 'proven', proofs: [proof] })),
    policy: { checks: [], review: false }, plannedFiles: shape.planned ?? ['src/server/routes/own.ts'], stage: 'merge', revision: 4, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, candidate,
    workspaces: shape.workspace === false ? [] : [{ host: 'machine-a', path: `/tmp/${shape.key}`, epoch: 1, owner: 'worker', branch: candidate.branch }],
    submission: shape.submitted === false ? null : { epoch: 1, pr: candidate.pr }, reworkRequested: false, scenarioRequirements: [],
    evidence: shape.evidence ?? proofs.map(proof => evidence(proof, head)), blocker: null, gates: [], violations: [],
    queue: queued === null ? null : { sequence: queued, enqueuedAt: at, policyRevision: 1, speculation: null },
    queueSequence: queued ?? 0, queueHistory: [], queueEjection: null, observation, ...extra,
  } as unknown as Work;
}

/** The gates' own answer for the two landability families. */
const gatesOf = (work: Work, all: Work[]) => {
  const gates = evaluate(work, all, now, CI).gates;
  return { build: gates.find(gate => gate.name === 'build')!, acceptance: gates.find(gate => gate.name === 'acceptance')! };
};
const refused = (verdict: LandabilityVerdict) => verdict.verdict === 'refused';

test('unit:landability-verdict-single-function — evaluateLandability returns landable or refused with {gate, reason}, and each gate family is exactly the gate it replaces', () => {
  // Landable: submitted, a workspace, an in-scope change, a trusted passing proof.
  const clean = item({ key: 'GY-A' });
  const landable = evaluateLandability(clean, [clean], now);
  assert.equal(landable.verdict, 'landable');
  assert.equal('reasons' in landable, false);
  assert.equal(landable.version, LANDABILITY_VERSION);

  const cases: { name: string; work: Work; gate: 'build' | 'acceptance'; reason: RegExp }[] = [
    { name: 'unsubmitted', work: item({ key: 'GY-B', submitted: false }), gate: 'build', reason: /^Worker has not submitted implementation for this attempt$/ },
    { name: 'no workspace', work: item({ key: 'GY-C', workspace: false }), gate: 'build', reason: /^No workspace registered$/ },
    { name: 'out-of-scope regression', work: item({ key: 'GY-D', files: ['src/server/routes/own.ts', 'src/stranger.ts'] }), gate: 'build', reason: /^Out-of-scope regression: src\/stranger\.ts: differs from the base branch tip/ },
    { name: 'landing regression', work: item({ key: 'GY-E', scopeFiles: [changed('src/server/routes/own.ts')], landing: { base: main, files: [changed('src/server/routes/own.ts'), changed('src/landed.ts')] } }), gate: 'build', reason: /^Landing regression: src\/landed\.ts: / },
    { name: 'uncompared diff', work: item({ key: 'GY-F' }, {}), gate: 'build', reason: /^Candidate diff has not been compared against the base branch tip/ },
    { name: 'mechanical failure', work: item({ key: 'GY-G', evidence: [evidence('unit:own-proof', sha('7'), { result: 'fail' })] }), gate: 'build', reason: /^AC-1: unit:own-proof failed on 777777777777 \(trusted evidence from independent-producer\); the head returns to its worker before review$/ },
    { name: 'unproven proof', work: item({ key: 'GY-H', evidence: [] }), gate: 'acceptance', reason: /^AC-1: unit:own-proof needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy$/ },
    { name: 'nothing executed', work: item({ key: 'GY-I', evidence: [evidence('unit:own-proof', sha('7'), { executed: 0 })] }), gate: 'acceptance', reason: /^AC-1: unit:own-proof needs trusted passing evidence/ },
    { name: 'dependent producer', work: item({ key: 'GY-J', evidence: [evidence('unit:own-proof', sha('7'), { producer: 'worker' })] }), gate: 'acceptance', reason: /unit:own-proof/ },
  ];
  cases[4].work.observation = { ...cases[4].work.observation!, scopeFiles: undefined } as Observation;
  for (const { name, work, gate, reason } of cases) {
    const verdict = evaluateLandability(work, [work], now);
    assert.equal(verdict.verdict, 'refused', name);
    if (verdict.verdict !== 'refused') continue;
    for (const entry of verdict.reasons) {
      assert.ok(entry.gate === 'build' || entry.gate === 'acceptance', `${name}: ${entry.gate}`);
      assert.equal(typeof entry.reason, 'string');
    }
    assert.ok(verdict.reasons.some(entry => entry.gate === gate && reason.test(entry.reason)), `${name}: ${JSON.stringify(verdict.reasons)}`);
    // The gates are the verdict's families word for word, in order: nothing is computed twice.
    const gates = gatesOf(work, [work]);
    assert.deepEqual(gates.build.reasons, landabilityRefusals(verdict, 'build'), name);
    assert.deepEqual(gates.acceptance.reasons, landabilityRefusals(verdict, 'acceptance'), name);
  }
  // An inherited bootstrap obligation is judged by the acceptance family too.
  const bootstrap = { ...item({ key: 'GY-K', proofs: ['unit:contract'], queued: null }), stage: 'done', criteria: [{ id: 'AC-1', text: 'deferred', proofs: ['unit:contract'], bootstrap: true }] } as unknown as Work;
  const inheritor = item({ key: 'GY-L', evidence: [evidence('unit:own-proof', sha('7'))] });
  const all = [bootstrap, inheritor];
  const gates = gatesOf(inheritor, all);
  assert.deepEqual(gates.acceptance.reasons, landabilityRefusals(evaluateLandability(inheritor, all, now), 'acceptance'));
});

test('unit:queue-and-gates-share-verdict — ejectionReason and the landing guard eject only for a reason the verdict gives; GY-871, GY-875 and GY-863 agree', () => {
  const queueAgrees = (work: Work, all: Work[]) => {
    const verdict = evaluateLandability(work, all, now);
    const reason = ejectionReason(work, CI, all, null, null, now);
    if (reason) {
      assert.equal(verdict.verdict, 'refused', `ejected [${reason}] while the verdict is landable`);
      assert.ok(landabilityEjections(verdict).includes(reason), `ejected [${reason}] for a reason the verdict does not give: ${JSON.stringify(verdict)}`);
    }
    return { verdict, reason };
  };

  // GY-871: a head carrying another item's speculative-tip commits. The build gate names the file as
  // carried and sends no worker; the queue must not eject the entry over the same file.
  const predecessor = item({ key: 'GY-P', head: sha('4'), planned: ['src/pred.ts'], files: ['src/pred.ts'], queued: 1 });
  const carried = item({ key: 'GY-Q', files: ['src/server/routes/own.ts', 'src/pred.ts'], queued: 2,
    landing: { base: main, files: [changed('src/server/routes/own.ts'), changed('src/pred.ts')], foreign: [{ key: 'GY-P', pr: predecessor.candidate!.pr, head: sha('4') }] } });
  const gy871 = queueAgrees(carried, [predecessor, carried]);
  assert.match(landabilityRefusals(gy871.verdict, 'build')[0], /^Carried from another item's tip: 1 file .* belongs to GY-P/);
  assert.equal(gy871.reason, null, 'a carried file ejects nothing');
  assert.equal(landabilityEjection(gy871.verdict, 'landing'), null);
  // An uncarried out-of-plan file is this change's own: the verdict gives the ejection, the queue takes it.
  const stranger = item({ key: 'GY-U', files: ['src/server/routes/own.ts', 'src/stranger.ts'], queued: 2 });
  const own = queueAgrees(stranger, [predecessor, stranger]);
  assert.match(own.reason!, /^Landing speculative tip 777777777777 on 999999999999 would revert work outside its planned files: src\/stranger\.ts: differs from the base branch tip/);

  // GY-875: a trusted manual proof a criterion names, failing with executed = 0, judged nothing.
  // The acceptance gate reads it as unproven (held for its attestation); the queue must not eject.
  const manual = item({ key: 'GY-M', proofs: ['manual:review'], evidence: [evidence('manual:review', sha('7'), { result: 'fail', executed: 0 })] });
  const gy875 = queueAgrees(manual, [manual]);
  assert.match(landabilityRefusals(gy875.verdict, 'acceptance')[0], /^AC-1: manual:review needs trusted passing evidence, with skipped = 0/);
  assert.equal(gy875.reason, null, 'an unexercised manual record holds the entry, it does not eject it');
  // The same record having executed cases is an adverse conclusion: the verdict ejects, the queue follows.
  const exercised = item({ key: 'GY-N', proofs: ['manual:review'], evidence: [evidence('manual:review', sha('7'), { result: 'fail', executed: 2 })] });
  assert.equal(queueAgrees(exercised, [exercised]).reason, 'Proof manual:review failed on speculative tip 777777777777');
  // A failure the newest record has answered is no refusal at all: the gate passes, so the queue
  // does not eject over the superseded record (it did before the verdict: two answers).
  const retried = item({ key: 'GY-R', evidence: [evidence('unit:own-proof', sha('7'), { result: 'fail' }), evidence('unit:own-proof', sha('7'), { at: '2026-09-30T12:00:01.000Z' })] });
  const answered = queueAgrees(retried, [retried]);
  assert.equal(answered.verdict.verdict, 'landable');
  assert.equal(answered.reason, null);
  // A judged failure of a proof no criterion requires is still a failure of the change (GY-868):
  // the build gate returns the head to its worker and the queue ejects on the same verdict reason.
  const stray = item({ key: 'GY-S', evidence: [evidence('unit:own-proof', sha('7')), evidence('unit:unrequired', sha('7'), { result: 'fail' })] });
  const strayed = queueAgrees(stray, [stray]);
  assert.equal(strayed.reason, 'Proof unit:unrequired failed on speculative tip 777777777777');
  assert.deepEqual(landabilityRefusals(strayed.verdict, 'build'), ['unit:unrequired, which no criterion requires, failed on 777777777777 (trusted evidence from independent-producer); the head returns to its worker before review']);
  // A revoked proof is refused by the gate and ejects with the revocation named.
  const revoked = item({ key: 'GY-V', evidence: [evidence('unit:own-proof', sha('7'), { revocation: { reason: 'producer withdrew it', at, actor: 'operator' } } as Partial<Evidence>)] });
  assert.equal(queueAgrees(revoked, [revoked]).reason, 'Proof unit:own-proof was revoked on speculative tip 777777777777: producer withdrew it');

  // GY-863: the landing guard recorded a file whose three-way merge onto the landing commit is
  // exactly what that commit holds (mergeSha = baseSha): not a revert. Gate and queue agree it lands.
  const merged = item({ key: 'GY-W', scopeFiles: [changed('src/server/routes/own.ts')], landing: { base: main, files: [changed('src/server/routes/own.ts'), changed('src/state.ts', { mergeSha: sha('e') })] } });
  const gy863 = queueAgrees(merged, [merged]);
  assert.equal(gy863.verdict.verdict, 'landable', JSON.stringify(gy863.verdict));
  assert.equal(gy863.reason, null);
  assert.equal(gatesOf(merged, [merged]).build.passed, true);
  // Without the merge result the same file is a landing regression, refused and ejected by the same verdict.
  const unmerged = item({ key: 'GY-X', scopeFiles: [changed('src/server/routes/own.ts')], landing: { base: main, files: [changed('src/server/routes/own.ts'), changed('src/state.ts')] } });
  const revert = queueAgrees(unmerged, [unmerged]);
  assert.match(revert.reason!, /^Landing speculative tip 777777777777 on bbbbbbbbbbbb would revert work outside its planned files: src\/state\.ts: /);
  assert.equal(gatesOf(unmerged, [unmerged]).build.passed, false);
});

/** A seeded generator of work items across every landability dimension. */
function generated(round: number, random: () => number): { work: Work; all: Work[] } {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const head = sha('7');
  const scope = pick(['clean', 'stranger', 'carried', 'unverified', 'landing', 'merge-result', 'generated'] as const);
  const proof = pick(['pass', 'none', 'fail', 'manual-zero', 'manual-fail', 'retried', 'revoked', 'dependent', 'skipped', 'stray'] as const);
  const proofs = proof.startsWith('manual') ? ['manual:review'] : ['unit:own-proof'];
  const name = proofs[0];
  const records: Record<typeof proof, Evidence[]> = {
    pass: [evidence(name, head)], none: [], fail: [evidence(name, head, { result: 'fail' })],
    'manual-zero': [evidence(name, head, { result: 'fail', executed: 0 })], 'manual-fail': [evidence(name, head, { result: 'fail', executed: 1 })],
    retried: [evidence(name, head, { result: 'fail' }), evidence(name, head, { at: '2026-09-30T12:00:01.000Z' })],
    revoked: [evidence(name, head, { revocation: { reason: 'withdrawn', at, actor: 'operator' } } as Partial<Evidence>)],
    dependent: [evidence(name, head, { producer: 'worker' })], skipped: [evidence(name, head, { skipped: 1 })],
    stray: [evidence(name, head), evidence('unit:stray', head, { result: 'fail' })],
  };
  const carrier = item({ key: 'GY-C', head: sha('4'), planned: ['src/pred.ts'], files: ['src/pred.ts'], queued: 1 });
  const path = `src/file-${round}.ts`;
  const shape: Shape = { key: 'GY-Q', proofs, evidence: records[proof], queued: random() < 0.8 ? 2 : null, submitted: random() > 0.1, workspace: random() > 0.1 };
  if (scope === 'stranger') shape.files = ['src/server/routes/own.ts', path];
  if (scope === 'carried') Object.assign(shape, { files: ['src/server/routes/own.ts', 'src/pred.ts'], landing: { base: main, files: [changed('src/server/routes/own.ts'), changed('src/pred.ts')], foreign: [{ key: 'GY-C', pr: carrier.candidate!.pr, head: sha('4') }] } });
  if (scope === 'unverified') Object.assign(shape, { files: ['src/server/routes/own.ts', path], scopeFiles: [changed('src/server/routes/own.ts'), changed(path, { baseSha: undefined })] });
  if (scope === 'landing') Object.assign(shape, { scopeFiles: [changed('src/server/routes/own.ts')], landing: { base: main, files: [changed('src/server/routes/own.ts'), changed(path, pick([{}, { status: 'removed', sha: null }, { additions: 0, deletions: 4 }] as Partial<ScopeFile>[]))] } });
  if (scope === 'merge-result') Object.assign(shape, { scopeFiles: [changed('src/server/routes/own.ts')], landing: { base: main, files: [changed('src/server/routes/own.ts'), changed(path, { mergeSha: sha('e') })] } });
  if (scope === 'generated') shape.files = ['src/server/routes/own.ts', 'docs/protocol.md'];
  const work = item(shape);
  return { work, all: [carrier, work] };
}

test('unit:landability-consumers-agree — over generated work items the gates, the queue and the landing guard reach the same landable/refused answer', () => {
  let seed = 20260930;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const seen = { landable: 0, refused: 0, ejected: 0, held: 0 };
  for (let round = 0; round < 400; round++) {
    const { work, all } = generated(round, random);
    const verdict = evaluateLandability(work, all, now);
    const label = `${round}: ${JSON.stringify(verdict)}`;
    // The gates: build and acceptance both pass exactly when the verdict is landable.
    const gates = gatesOf(work, all);
    assert.equal(gates.build.passed && gates.acceptance.passed, verdict.verdict === 'landable', label);
    // The queue: a queued entry is ejected on landability grounds only for a reason the verdict
    // gives, and a landable entry (clean CI, no review, no threads) is never ejected at all.
    if (work.queue) {
      const reason = ejectionReason(work, CI, all, null, null, now);
      if (verdict.verdict === 'landable') assert.equal(reason, null, label);
      if (reason && work.submission) {
        assert.ok(landabilityEjections(verdict).includes(reason), `${label} ejected for [${reason}]`);
        seen.ejected++;
      } else if (refused(verdict)) seen.held++;
    } else {
      // An unqueued candidate the gates pass joins the queue; one the verdict refuses does not.
      const placed = placeInQueue(work, all, now, CI, gates.build.passed && gates.acceptance.passed);
      assert.equal(!!placed.queue, verdict.verdict === 'landable', label);
    }
    // The landing guard: its ejection is a build refusal of the same verdict, never a separate answer.
    const landing = landabilityEjection(verdict, 'landing');
    if (landing) assert.equal(gates.build.passed, false, label);
    seen[verdict.verdict]++;
  }
  // The generator exercised every answer, so the agreement above is not vacuous.
  assert.ok(seen.landable > 20 && seen.refused > 100 && seen.ejected > 20 && seen.held > 20, JSON.stringify(seen));

  // The single authority is documented where coordination is described, linked rather than restated elsewhere.
  const coordination = readFileSync(new URL('../docs/coordination.md', import.meta.url), 'utf8');
  assert.match(coordination, /evaluateLandability/);
  assert.match(coordination, /single authority/);
});

test('unit:landability-pure-on-demand — the verdict is deterministic, recomputed from live facts, never read from a stored verdict, and every refusal records its version and inputs', () => {
  const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const entry of Object.values(value)) deepFreeze(entry); }
    return value;
  };
  // Determinism: identical inputs give byte-identical verdicts, and evaluation mutates nothing.
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let round = 0; round < 60; round++) {
    const { work, all } = generated(round, random);
    const snapshot = stableJson(all);
    deepFreeze(all);
    const first = stableJson(evaluateLandability(work, all, now));
    const copy = JSON.parse(snapshot) as Work[];
    assert.equal(stableJson(evaluateLandability(work, all, now)), first, `${round}: same objects`);
    assert.equal(stableJson(evaluateLandability(copy.find(entry => entry.id === work.id)!, copy, now)), first, `${round}: equal copies`);
    assert.equal(stableJson(all), snapshot, `${round}: evaluation mutated its inputs`);
  }

  // No stored verdict is consulted: records that claim a landable verdict change nothing while the
  // live facts refuse, and a change to the live facts changes the verdict on the same object.
  const work = item({ key: 'GY-P', evidence: [] });
  const stored = { version: LANDABILITY_VERSION, inputs: { key: 'GY-P', sha: sha('7'), baseSha: sha('9'), policyRevision: 1, observed: null, landingBase: null, evidence: [] } };
  Object.assign(work, {
    landability: { verdict: 'landable', ...stored }, verdict: { verdict: 'landable' },
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'acceptance', passed: true, reasons: [], verdict: stored }],
    queueEjection: { at, sequence: 1, reason: 'x', sha: sha('7'), policyRevision: 1, family: 'landability', verdict: stored },
  });
  const before = evaluateLandability(work, [work], now);
  assert.equal(before.verdict, 'refused');
  work.evidence = [evidence('unit:own-proof', sha('7'))];
  assert.equal(evaluateLandability(work, [work], now).verdict, 'landable', 'the verdict follows the live evidence, not an earlier answer');
  work.evidence = [evidence('unit:own-proof', sha('7'), { expiresAt: '2026-09-30T12:30:00.000Z' })];
  assert.equal(evaluateLandability(work, [work], now).verdict, 'landable');
  assert.equal(evaluateLandability(work, [work], new Date('2026-09-30T13:00:00.000Z')).verdict, 'refused', 'expiry is judged at the instant asked');

  // The audit: a refusal records the verdict version and the inputs it was computed from, keyed by
  // candidate SHA and policy revision, on the gate it refuses and on any ejection it causes.
  const stranger = item({ key: 'GY-U', files: ['src/server/routes/own.ts', 'src/stranger.ts'], evidence: [evidence('unit:own-proof', sha('7'))] });
  const verdict = evaluateLandability(stranger, [stranger], now);
  assert.deepEqual({ version: verdict.version, inputs: verdict.inputs }, {
    version: LANDABILITY_VERSION,
    inputs: { key: 'GY-U', sha: sha('7'), baseSha: sha('9'), policyRevision: 1, observed: { sha: sha('7'), baseSha: sha('9') }, landingBase: main, evidence: ['unit:own-proof@7777#pass'] },
  });
  const result = evaluate(stranger, [stranger], now, CI);
  const build = result.gates.find(gate => gate.name === 'build')!;
  assert.deepEqual(build.verdict, { version: verdict.version, inputs: verdict.inputs });
  assert.equal(result.gates.find(gate => gate.name === 'acceptance')!.verdict, undefined, 'a passing gate records no refusal');
  assert.equal(result.queueEjection?.family, 'landability');
  assert.deepEqual(result.queueEjection?.verdict, { version: verdict.version, inputs: verdict.inputs });
  assert.deepEqual(result.queueHistory.at(-1)?.verdict, { version: verdict.version, inputs: verdict.inputs });
});

test('unit:ejection-not-sticky — an entry ejected on landability grounds re-enters on the same head once the verdict is landable (GY-472)', () => {
  // GY-472, 2026-09-27: ejected at f72abb4a2b48 over GY-509's files before GY-871 landed the carried
  // excusal, and still held out by the stored ejection after production served the fix, because a
  // stored ejection held the same head out forever. The record predates the typed family.
  const tip = 'f72abb4a2b48';
  const head = `${tip}${'0'.repeat(28)}`;
  const gy509 = item({ key: 'GY-509', head: sha('4'), planned: ['src/state.ts'], files: ['src/state.ts'], queued: 1 });
  const ejection = { at, sequence: 3, reason: `Landing speculative tip ${tip} on ${main.slice(0, 12)} would revert work outside its planned files: src/state.ts: differs from that commit (+3 −1) (owned by GY-509, ahead of it and not yet landed)`, sha: head, policyRevision: 1, conflict: null };
  const gy472 = item({ key: 'GY-472', head, files: ['src/server/routes/own.ts', 'src/state.ts'], queued: null, evidence: [evidence('unit:own-proof', head)],
    landing: { base: main, files: [changed('src/server/routes/own.ts'), changed('src/state.ts')], foreign: [{ key: 'GY-509', pr: gy509.candidate!.pr, head: sha('4') }] } },
  { queueEjection: ejection, queueSequence: 3, queueHistory: [{ at, event: 'ejected', sequence: 3, reason: ejection.reason, tip: head }] });
  const all = [gy509, gy472];
  assert.equal(landabilityFamily(ejection), true, 'a legacy landing ejection reads as a landability one');
  // Under the fix the verdict excuses the carried file: the build gate names GY-509 and sends no
  // worker, so the item is not eligible yet — but nothing about the ejection itself holds it.
  const carriedVerdict = evaluateLandability(gy472, all, now);
  assert.match(landabilityRefusals(carriedVerdict, 'build')[0], /^Carried from another item's tip/);
  assert.equal(landabilityEjection(carriedVerdict, 'landing'), null, 'the verdict no longer ejects over the carried file');
  // GY-509 lands, the landing check no longer names it foreign: the same head is landable, and it
  // re-enters the queue without a new head.
  const landed = { ...gy509, stage: 'done', queue: null, observation: { ...gy509.observation!, merged: true } } as Work;
  const cleared = { ...gy472, observation: { ...gy472.observation!, scopeFiles: [changed('src/server/routes/own.ts'), changed('src/state.ts', { sha: sha('e') })], landing: { base: main, files: [changed('src/server/routes/own.ts')] } } } as Work;
  const after = [landed, cleared];
  assert.equal(evaluateLandability(cleared, after, now).verdict, 'landable');
  const result = evaluate(cleared, after, now, CI);
  assert.ok(result.queue, `re-entered: ${JSON.stringify(result.gates.filter(gate => !gate.passed))}`);
  assert.equal(result.queueEjection, null);
  assert.equal(result.queueHistory.at(-1)?.event, 'enqueued');
  assert.equal(cleared.candidate!.sha, head, 'the same head, not a new one');

  // A typed landability ejection holds only while the verdict refuses. Eligibility alone does not
  // decide: an ejection whose verdict still refuses stays out even if the caller says eligible.
  const failing = item({ key: 'GY-F', queued: 1, evidence: [evidence('unit:own-proof', sha('7'), { result: 'fail' })] });
  const out = evaluate(failing, [failing], now, CI);
  assert.equal(out.queue, null);
  assert.equal(out.queueEjection?.reason, 'Proof unit:own-proof failed on speculative tip 777777777777');
  assert.equal(out.queueEjection?.family, 'landability');
  const held = { ...failing, queue: null, queueEjection: out.queueEjection, queueHistory: out.queueHistory } as Work;
  assert.equal(placeInQueue(held, [held], now, CI, true).queue, null, 'still refused: the ejection holds');
  const proven = { ...held, evidence: [...held.evidence, evidence('unit:own-proof', sha('7'), { at: '2026-09-30T12:00:05.000Z' })] } as Work;
  const back = evaluate(proven, [proven], now, CI);
  assert.ok(back.queue, 'a new passing record on the same head re-enters it');
  assert.equal(back.queueEjection, null);

  // Any other ejection keeps the head's stickiness, so a CI or review ejection never churns in and out.
  const ci = { ...proven, queueEjection: { at, sequence: 1, reason: 'Required CI check test did not pass on speculative tip 777777777777', sha: sha('7'), policyRevision: 1, conflict: null, family: null } } as Work;
  assert.equal(landabilityFamily(ci.queueEjection!), false);
  assert.equal(evaluate(ci, [ci], now, CI).queue, null);
});
