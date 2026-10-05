import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate } from '../src/model/gates.js';
import {
  LANDABILITY_VERSION, evaluateLandability, landabilityRefusals,
} from '../src/model/landability.js';
import { stableJson } from '../src/model/stable-json.js';
import type { Evidence, Observation, ScopeFile, Work } from '../src/model.js';

// GY-878. Whether a candidate can land was answered twice — by the build and acceptance gates and
// again by the merge queue's ejection check and landing re-check — and the answers drifted apart
// three times: GY-871 (the queue ejected files the gate excused as carried), GY-875 (the queue
// ejected a manual proof that executed nothing, which the gate reads as unexercised) and GY-863
// (a false revert the three-way merge settles). evaluateLandability is the one answer now; these
// tests pin that every consumer reads it and that it is pure. GY-1236 removed the queue and its
// ejections, so the gates are its consumers.

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
  proofs?: string[]; evidence?: Evidence[]; submitted?: boolean; workspace?: boolean;
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
  return {
    id: shape.key.toLowerCase(), key: shape.key, title: shape.key, description: '', type: 'feature', priority: 0, dependencies: [],
    criteria: proofs.map((proof, index) => ({ id: `AC-${index + 1}`, text: 'proven', proofs: [proof] })),
    policy: { checks: [], review: false }, plannedFiles: shape.planned ?? ['src/server/routes/own.ts'], stage: 'merge', revision: 4, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, candidate,
    workspaces: shape.workspace === false ? [] : [{ host: 'machine-a', path: `/tmp/${shape.key}`, epoch: 1, owner: 'worker', branch: candidate.branch }],
    submission: shape.submitted === false ? null : { epoch: 1, pr: candidate.pr }, reworkRequested: false, scenarioRequirements: [],
    evidence: shape.evidence ?? proofs.map(proof => evidence(proof, head)), blocker: null, gates: [], violations: [],
    observation, ...extra,
  } as unknown as Work;
}

/**
 * The gates' own answer for the landability families. Since GY-1235 the acceptance family is no
 * gate (proofs gate nothing): only the build gate reads the verdict.
 */
const gatesOf = (work: Work, all: Work[]) => {
  const gates = evaluate(work, all, now, CI).gates;
  return { build: gates.find(gate => gate.name === 'build')!, acceptance: gates.find(gate => gate.name === 'acceptance') };
};

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
    // The build gate is the verdict's build family word for word, in order: nothing is computed
    // twice; the acceptance family gates nothing since GY-1235.
    const gates = gatesOf(work, [work]);
    assert.deepEqual(gates.build.reasons, landabilityRefusals(verdict, 'build'), name);
    assert.equal(gates.acceptance, undefined, name);
  }
});

test('unit:queue-and-gates-share-verdict — the build gate refuses only for a reason the verdict gives; GY-871, GY-875 and GY-863 agree', () => {
  const agrees = (work: Work, all: Work[]) => {
    const verdict = evaluateLandability(work, all, now);
    assert.deepEqual(gatesOf(work, all).build.reasons, landabilityRefusals(verdict, 'build'), JSON.stringify(verdict));
    return verdict;
  };

  // GY-871: a head carrying another item's commits. With no speculative tips (GY-1236) nothing marks
  // them carried: the file is an ordinary out-of-scope regression of this head.
  const predecessor = item({ key: 'GY-P', head: sha('4'), planned: ['src/pred.ts'], files: ['src/pred.ts'] });
  const carried = item({ key: 'GY-Q', files: ['src/server/routes/own.ts', 'src/pred.ts'],
    landing: { base: main, files: [changed('src/server/routes/own.ts'), changed('src/pred.ts')], foreign: [{ key: 'GY-P', pr: predecessor.candidate!.pr, head: sha('4') }] } });
  assert.match(landabilityRefusals(agrees(carried, [predecessor, carried]), 'build').join('\n'), /^Out-of-scope regression: src\/pred\.ts: /m);
  const stranger = item({ key: 'GY-U', files: ['src/server/routes/own.ts', 'src/stranger.ts'] });
  assert.match(landabilityRefusals(agrees(stranger, [predecessor, stranger]), 'build').join('\n'), /^Out-of-scope regression: src\/stranger\.ts: differs from the base branch tip/m);

  // GY-875: a trusted manual proof a criterion names, failing with executed = 0, judged nothing.
  // The verdict reads it as unproven (held for its attestation), never as a failure of the change.
  const manual = item({ key: 'GY-M', proofs: ['manual:review'], evidence: [evidence('manual:review', sha('7'), { result: 'fail', executed: 0 })] });
  const gy875 = agrees(manual, [manual]);
  assert.match(landabilityRefusals(gy875, 'acceptance')[0], /^AC-1: manual:review needs trusted passing evidence, with skipped = 0/);
  assert.deepEqual(landabilityRefusals(gy875, 'build'), [], 'an unexercised manual record returns nothing to the worker');
  // The same record having executed cases is an adverse conclusion: the proof stands unproven, and
  // as a manual attestation it is no mechanical failure that returns the head to its worker.
  const exercised = item({ key: 'GY-N', proofs: ['manual:review'], evidence: [evidence('manual:review', sha('7'), { result: 'fail', executed: 2 })] });
  const gy875Exercised = agrees(exercised, [exercised]);
  assert.match(landabilityRefusals(gy875Exercised, 'acceptance')[0], /^AC-1: manual:review needs trusted passing evidence/);
  assert.deepEqual(landabilityRefusals(gy875Exercised, 'build'), []);
  // A failure the newest record has answered is no refusal at all.
  const retried = item({ key: 'GY-R', evidence: [evidence('unit:own-proof', sha('7'), { result: 'fail' }), evidence('unit:own-proof', sha('7'), { at: '2026-09-30T12:00:01.000Z' })] });
  assert.equal(agrees(retried, [retried]).verdict, 'landable');
  // A judged failure of a proof no criterion requires is still a failure of the change (GY-868).
  const stray = item({ key: 'GY-S', evidence: [evidence('unit:own-proof', sha('7')), evidence('unit:unrequired', sha('7'), { result: 'fail' })] });
  assert.deepEqual(landabilityRefusals(agrees(stray, [stray]), 'build'), ['unit:unrequired, which no criterion requires, failed on 777777777777 (trusted evidence from independent-producer); the head returns to its worker before review']);

  // GY-863: the landing guard recorded a file whose three-way merge onto the landing commit is
  // exactly what that commit holds (mergeSha = baseSha): not a revert. The gate lets it land.
  const merged = item({ key: 'GY-W', scopeFiles: [changed('src/server/routes/own.ts')], landing: { base: main, files: [changed('src/server/routes/own.ts'), changed('src/state.ts', { mergeSha: sha('e') })] } });
  assert.equal(agrees(merged, [merged]).verdict, 'landable');
  assert.equal(gatesOf(merged, [merged]).build.passed, true);
  // Without the merge result the same file is a landing regression the build gate refuses.
  const unmerged = item({ key: 'GY-X', scopeFiles: [changed('src/server/routes/own.ts')], landing: { base: main, files: [changed('src/server/routes/own.ts'), changed('src/state.ts')] } });
  assert.match(landabilityRefusals(agrees(unmerged, [unmerged]), 'build').join('\n'), /^Landing regression: src\/state\.ts: /m);
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
  const carrier = item({ key: 'GY-C', head: sha('4'), planned: ['src/pred.ts'], files: ['src/pred.ts'] });
  const path = `src/file-${round}.ts`;
  const shape: Shape = { key: 'GY-Q', proofs, evidence: records[proof], submitted: random() > 0.1, workspace: random() > 0.1 };
  if (scope === 'stranger') shape.files = ['src/server/routes/own.ts', path];
  if (scope === 'carried') Object.assign(shape, { files: ['src/server/routes/own.ts', 'src/pred.ts'], landing: { base: main, files: [changed('src/server/routes/own.ts'), changed('src/pred.ts')], foreign: [{ key: 'GY-C', pr: carrier.candidate!.pr, head: sha('4') }] } });
  if (scope === 'unverified') Object.assign(shape, { files: ['src/server/routes/own.ts', path], scopeFiles: [changed('src/server/routes/own.ts'), changed(path, { baseSha: undefined })] });
  if (scope === 'landing') Object.assign(shape, { scopeFiles: [changed('src/server/routes/own.ts')], landing: { base: main, files: [changed('src/server/routes/own.ts'), changed(path, pick([{}, { status: 'removed', sha: null }, { additions: 0, deletions: 4 }] as Partial<ScopeFile>[]))] } });
  if (scope === 'merge-result') Object.assign(shape, { scopeFiles: [changed('src/server/routes/own.ts')], landing: { base: main, files: [changed('src/server/routes/own.ts'), changed(path, { mergeSha: sha('e') })] } });
  if (scope === 'generated') shape.files = ['src/server/routes/own.ts', 'docs/protocol.md'];
  const work = item(shape);
  return { work, all: [carrier, work] };
}

test('unit:landability-consumers-agree — over generated work items the gates and the landing guard reach the same landable/refused answer', () => {
  let seed = 20260930;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const seen = { landable: 0, refused: 0 };
  for (let round = 0; round < 800; round++) {
    const { work, all } = generated(round, random);
    const verdict = evaluateLandability(work, all, now);
    const label = `${round}: ${JSON.stringify(verdict)}`;
    // The gates: build passes exactly when the verdict refuses nothing on the build family.
    const gates = gatesOf(work, all);
    assert.equal(gates.build.passed, landabilityRefusals(verdict, 'build').length === 0, label);
    const accepted = landabilityRefusals(verdict, 'acceptance').length === 0;
    assert.equal(gates.build.passed && accepted, verdict.verdict === 'landable', label);
    seen[verdict.verdict]++;
  }
  // The generator exercised every answer, so the agreement above is not vacuous.
  assert.ok(seen.landable > 20 && seen.refused > 100, JSON.stringify(seen));

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
  });
  const before = evaluateLandability(work, [work], now);
  assert.equal(before.verdict, 'refused');
  work.evidence = [evidence('unit:own-proof', sha('7'))];
  assert.equal(evaluateLandability(work, [work], now).verdict, 'landable', 'the verdict follows the live evidence, not an earlier answer');
  work.evidence = [evidence('unit:own-proof', sha('7'), { expiresAt: '2026-09-30T12:30:00.000Z' })];
  assert.equal(evaluateLandability(work, [work], now).verdict, 'landable');
  assert.equal(evaluateLandability(work, [work], new Date('2026-09-30T13:00:00.000Z')).verdict, 'refused', 'expiry is judged at the instant asked');

  // The audit: a refusal records the verdict version and the inputs it was computed from, keyed by
  // candidate SHA and policy revision, on the gate it refuses.
  const stranger = item({ key: 'GY-U', files: ['src/server/routes/own.ts', 'src/stranger.ts'], evidence: [evidence('unit:own-proof', sha('7'))] });
  const verdict = evaluateLandability(stranger, [stranger], now);
  assert.deepEqual({ version: verdict.version, inputs: verdict.inputs }, {
    version: LANDABILITY_VERSION,
    inputs: { key: 'GY-U', sha: sha('7'), baseSha: sha('9'), policyRevision: 1, observed: { sha: sha('7'), baseSha: sha('9') }, landingBase: main, evidence: ['unit:own-proof@7777#pass'] },
  });
  const result = evaluate(stranger, [stranger], now, CI);
  const build = result.gates.find(gate => gate.name === 'build')!;
  assert.deepEqual(build.verdict, { version: verdict.version, inputs: verdict.inputs });
  assert.ok(result.gates.filter(gate => gate.passed).every(gate => gate.verdict === undefined), 'a passing gate records no refusal');
});
