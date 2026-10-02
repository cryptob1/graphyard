import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ejectionReason } from '../src/merge-queue.js';
import { carriedItems, classifyScope, inPlannedScope, queuedRegressions, regressionRefusals, shippedBy } from '../src/regression-guard.js';
import type { Observation, ScopeFile, Work } from '../src/model.js';

// GY-871, 2026-09-27: GY-472 (candidate f72abb4a2b48, built on GY-509's speculative tip 28a7a04b)
// passed the build gate once GY-863 landed and entered the merge queue, and was then ejected on
// every cycle with "Landing speculative tip ... would revert work outside its planned files" naming
// GY-509's files. The two checks disagreed: regressionRefusals (the build gate) drops findings that
// carriedBy attributes to another item's commits on the head (carriedItems), while
// queuedRegressions (the ejection check) classified the same scopeFiles with no carried filter.
// The queue now applies the same exclusion, so no item passes build only to be ejected for the
// same files, and the two checks agree on every out-of-plan file.

const at = '2026-09-27T12:00:00.000Z';
const sha = (digit: string) => digit.repeat(40);
const main = sha('b');
const CI = [1];

/** A file on a head as GitHub lists it against its bound base: this head changed it, the base holds another version. */
const changed = (path: string, overrides: Partial<ScopeFile> = {}): ScopeFile =>
  ({ path, status: 'modified', sha: sha('d'), baseSha: sha('e'), additions: 3, deletions: 1, binary: false, ...overrides });

interface ItemShape {
  key: string; head: string; baseSha: string; planned: string[]; files: string[]; sequence: number | null;
  scopeFiles?: ScopeFile[]; landing?: Observation['landing'];
}

function item(shape: ItemShape, extra: Partial<Work> = {}): Work {
  const candidate = { sha: shape.head, baseSha: shape.baseSha, pr: shape.key.charCodeAt(3), branch: `graphyard/${shape.key.toLowerCase()}-1`, author: 'worker' };
  const observation: Observation = {
    candidate, checks: [{ name: 'test', result: 'success', appId: 1 }], reviews: [{ reviewer: 'reviewer', sha: shape.head, state: 'APPROVED', submittedAt: at }],
    merged: false, mergeSha: null, mergeable: true, protected: true, files: shape.files,
    scopeFiles: shape.scopeFiles ?? shape.files.map(path => changed(path)), landing: shape.landing ?? { base: main, files: shape.files.map(path => changed(path)) },
    at, prState: 'open', draft: false, baseTip: main, baseTree: sha('e'), baseTipContained: true,
  };
  return {
    id: shape.key.toLowerCase(), key: shape.key, title: shape.key, description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: shape.planned, stage: 'merge', revision: 4, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, candidate,
    workspaces: [{ host: 'machine-a', path: `/tmp/${shape.key}`, epoch: 1, owner: 'worker', branch: candidate.branch }],
    submission: { epoch: 1, pr: candidate.pr }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    queue: shape.sequence === null ? null : { sequence: shape.sequence, enqueuedAt: at, policyRevision: 1, speculation: null },
    queueSequence: shape.sequence ?? 0, queueHistory: [], observation, ...extra,
  } as unknown as Work;
}

test('unit:queue-ejection-excuses-carried-files — a queued item whose head carries another item\'s speculative-tip commits is not ejected over their files, while an uncarried out-of-plan file still ejects', () => {
  // GY-509-analog: an open item whose speculative tip 4444… sits in the other head's history; the
  // landing check names it in landing.foreign, so its files are attributed to it, not to this change.
  const predecessorTip = sha('4');
  const predecessor = item({ key: 'GY-P', head: predecessorTip, baseSha: main, planned: ['src/pred.ts'], files: ['src/pred.ts'], sequence: 1 });
  // GY-472-analog: queued, its head carries GY-P's commits (so src/pred.ts differs from its bound
  // base), and its planned scope holds only its own file.
  const queued = item({
    key: 'GY-Q', head: sha('7'), baseSha: sha('9'), planned: ['src/own.ts'], files: ['src/own.ts', 'src/pred.ts'], sequence: 2,
    scopeFiles: [changed('src/own.ts'), changed('src/pred.ts')],
    landing: { base: main, files: [changed('src/own.ts'), changed('src/pred.ts')], foreign: [{ key: 'GY-P', pr: predecessor.candidate!.pr, head: predecessorTip }] },
  });
  const all = [predecessor, queued];

  // The build gate's own judgement: the file belongs to GY-P, whose unlanded commits this head carries.
  assert.deepEqual(carriedItems(queued, queued.observation!, all), [predecessor]);
  const gate = regressionRefusals(queued, queued.observation!, all);
  assert.equal(gate.length, 1, gate.join(' | '));
  assert.match(gate[0], /^Carried from another item's tip: 1 file .* belongs to GY-P/);
  assert.doesNotMatch(gate.join('\n'), /^Out-of-scope regression|^Landing regression/m);

  // The ejection check excuses the same file: no regressions, no ejection, the entry stays queued.
  assert.deepEqual(queuedRegressions(queued, queued.observation!, all), []);
  assert.equal(ejectionReason(queued, CI, all), null);

  // The same excuse where only the landing comparison shows the file: against the bound base it
  // matches, and where the entry would land the carried file is still GY-P's, not this change's.
  const matched = item({
    key: 'GY-M', head: sha('8'), baseSha: sha('9'), planned: ['src/own.ts'], files: ['src/own.ts', 'src/pred.ts'], sequence: 2,
    scopeFiles: [changed('src/own.ts'), changed('src/pred.ts', { sha: sha('e') })],
    landing: { base: main, files: [changed('src/own.ts'), changed('src/pred.ts')], foreign: [{ key: 'GY-P', pr: predecessor.candidate!.pr, head: predecessorTip }] },
  });
  const landed = regressionRefusals(matched, matched.observation!, all);
  assert.equal(landed.length, 1, landed.join(' | '));
  assert.match(landed[0], /^Carried from another item's tip: /);
  assert.deepEqual(queuedRegressions(matched, matched.observation!, all), []);
  assert.equal(ejectionReason(matched, CI, all), null);

  // An uncarried out-of-plan file is still this change's own regression: it ejects, naming the file.
  const uncarried = item({
    key: 'GY-U', head: sha('7'), baseSha: sha('9'), planned: ['src/own.ts'], files: ['src/own.ts', 'src/stranger.ts'], sequence: 2,
    scopeFiles: [changed('src/own.ts'), changed('src/stranger.ts')],
    landing: { base: main, files: [changed('src/own.ts'), changed('src/stranger.ts')] },
  });
  const stranger = regressionRefusals(uncarried, uncarried.observation!, all);
  assert.match(stranger.join('\n'), /^Out-of-scope regression: src\/stranger\.ts: differs from the base branch tip/m, stranger.join(' | '));
  const reason = ejectionReason(uncarried, CI, all);
  assert.match(reason!, /^Landing speculative tip 777777777777 on 999999999999 would revert work outside its planned files: src\/stranger\.ts: differs from the base branch tip \(\+3 −1\) \(no delivered work item claims this path\)$/);
});

test('unit:build-gate-and-queue-agree-on-scope — over generated findings the ejection check reports an out-of-plan file exactly when the build gate refuses it as this change\'s own', () => {
  const generated = ['docs/README.md', 'src/gen.ts'];

  // A seeded generator over findings of every kind: uncarried, carried, generated, unverified,
  // plus reverted, deleted and binary conclusions and the in-scope control. A covered path is
  // excused only while a foreign unlanded item carries it and no delivery claims it; a path a
  // delivery shipped is the candidate reverting it, whatever tip it rides on.
  let seed = 20260927;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];

  let checked = 0;
  for (let round = 0; round < 60; round++) {
    const kind = pick(['uncarried', 'carried', 'generated', 'unverified', 'reverted', 'deleted', 'binary'] as const);
    const path = `${kind === 'generated' ? generated[round % generated.length] : pick(['src/stranger.ts', 'src/other.ts'])}#${round}`;
    const finding: Partial<ScopeFile> = kind === 'unverified' ? { baseSha: undefined }
      : kind === 'reverted' ? { additions: 0, deletions: 9 }
      : kind === 'deleted' ? { status: 'removed', sha: null }
      : kind === 'binary' ? { binary: true, additions: 0, deletions: 0 }
      : {};
    const carriers = kind === 'carried' ? (random() < 0.5 ? ['GY-C1'] : ['GY-C1', 'GY-C2']).map((key, index) =>
      item({ key, head: sha(String(3 + index)), baseSha: main, planned: [path], files: [path], sequence: 1 })) : [];
    const foreign = carriers.map(carrier => ({ key: carrier.key, pr: carrier.candidate!.pr, head: carrier.candidate!.sha }));
    const delivered = kind === 'carried' && random() < 0.3
      ? { ...item({ key: 'GY-D', head: sha('f'), baseSha: main, planned: [path], files: [path], sequence: null }), stage: 'done' } as Work : null;
    const queued = item({
      key: 'GY-Q', head: sha('7'), baseSha: sha('9'), planned: ['src/own.ts'], files: ['src/own.ts', path], sequence: 2,
      scopeFiles: [changed('src/own.ts'), changed(path, finding)],
      landing: foreign.length ? { base: main, foreign } : { base: main },
    });
    const all = [...carriers, ...(delivered ? [delivered] : []), queued];
    const observation = queued.observation!;
    const reported = queuedRegressions(queued, observation, all, generated).map(entry => entry.text);
    const refusals = regressionRefusals(queued, observation, all, generated);

    // The gate's own-file judgement, from the shared classification: a file refuses when its
    // finding is a concluded refusal that no carried item owns. A file the observation could not
    // compare is not a reported conclusion: it holds the build gate and ejects nothing.
    const carried = carriedItems(queued, observation, all);
    const carriedOwns = (file: string) => !carried.length || shippedBy(file, all).length ? []
      : carried.filter(entry => inPlannedScope(entry.plannedFiles ?? [], file) || (entry.observation?.files ?? []).includes(file)).map(entry => entry.key);
    const gateRefuses = (file: string) => {
      const classified = classifyScope(queued.plannedFiles, observation.scopeFiles ?? [], generated).find(entry => entry.path === file);
      return !!classified && classified.path !== 'src/own.ts' && classified.refused && classified.kind !== 'unverified' && !carriedOwns(classified.path).length;
    };
    const queueReports = (file: string) => reported.some(text => text.startsWith(`${file}:`));

    for (const file of [path, 'src/own.ts']) {
      checked++;
      assert.equal(queueReports(file), gateRefuses(file), `${round}: ${file} — gate refuses [${refusals.join(' | ')}], queue reports [${reported.join(' | ')}]`);
      if (queueReports(file)) assert.ok(refusals.some(line => line.includes(`${file}: `)), `${round}: the gate must name ${file} itself`);
      else assert.doesNotMatch(refusals.join('\n'), new RegExp(`^Out-of-scope regression: ${file.replace(/[.#$]/g, '\\$&')}: (?!not compared)`, 'm'), `${round}: the gate must not refuse ${file} as this change's own`);
    }
    // The two stay in step on the ejection itself: with clean checks, review and proofs, an entry
    // is ejected exactly when a regression is reported, and the reason names every reported file.
    const reason = ejectionReason(queued, CI, all);
    assert.equal(!!reason, reported.length > 0, `${round}: ejection [${reason}] against regressions [${reported.join(' | ')}]`);
    if (reason) for (const text of reported) assert.ok(reason!.includes(text), `${round}: the ejection must name every regression: ${reason}`);
    // An uncompared file holds the build gate and ejects nothing, exactly as documented.
    if (kind === 'unverified') {
      assert.ok(refusals.some(line => line.startsWith(`Out-of-scope regression: ${path}: not compared`)), `${round}: the uncompared file holds the build gate`);
      assert.equal(reason, null, `${round}: an uncompared file ejects nothing`);
    }
  }
  assert.ok(checked >= 120, `the property must be checked per file, saw ${checked}`);
});
