import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assessCut, cutDue, type CutCommit } from '../src/daemon/candidate-cut.js';
import { candidateSettings, candidateSettingsSchema, defaultCandidateEveryMerges, defaultCandidateIdleMinutes } from '../src/master/merge-writer-settings.js';
import { masterRunSchema } from '../src/master/profiles.js';
import { noLocalPortsReason, promotionCycle, promotionFrozenReason, promotionMode, promotionReads, promotionWorkflow, type PromotionLedger, type PromotionReads } from '../src/daemon/deployment.js';
import { localPromotionCycle, localPromotionIdle, runLocalCandidate, settleLocalPromotion, type LocalCandidate, type LocalReleasePorts, type LocalValidation } from '../src/daemon/promotion-local.js';
import { lastJson, localValidateArguments, readCaseTags, readVerificationMaps } from '../src/daemon/release-ports.js';
import { promotionStateSchema, type PromotionState } from '../src/daemon/state.js';
import type { MasterConfig } from '../src/master.js';
import type { RevertOutcome, RevertTarget } from '../src/release-revert.js';

// GY-1526: in control-plane mode the loop cuts release candidates itself — at 10 merges after the
// newest cut or once one merge has waited 15 minutes — and runs them through UAT to production or to
// the related-item revert with no workflow dispatched; in github mode the dispatch is unchanged.

const start = Date.parse('2030-05-01T12:00:00Z');
const minute = 60_000;
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
/** Main's first-parent history newest first: `ages` are each merge's minutes before `start`, newest first. */
const history = (...ages: number[]): CutCommit[] => ages.map((age, index) => ({ sha: sha(`merge-${index}-${age}`), at: iso(start - age * minute) }));
const defaults = candidateSettings({});

test('unit:candidate-cut-due — cutDue is true at 10 or more first-parent merges after the newest cut, or at one merge 15 or more minutes old with no cut since, and false otherwise; run.candidates.everyMerges and run.candidates.idleMinutes override both', () => {
  assert.deepEqual(defaults, { everyMerges: 10, idleMinutes: 15 });
  assert.equal(defaultCandidateEveryMerges, 10); assert.equal(defaultCandidateIdleMinutes, 15);
  const cut = { candidates: [{ id: '20300501T100000Z', sha: sha('cut'), cutAt: iso(start - 120 * minute) }] };
  // Nine fresh merges after the cut: neither threshold is met.
  const nine = [...history(1, 2, 3, 4, 5, 6, 7, 8, 9), { sha: sha('cut'), at: iso(start - 120 * minute) }, ...history(200)];
  assert.equal(cutDue(cut, nine, start, defaults), false, 'nine merges, the oldest nine minutes old, are not due');
  assert.match(assessCut(cut, nine, start, defaults).reason, /9 merge\(s\) landed on main after candidate 20300501T100000Z; the next candidate is cut at 10 merges or once one has waited 15 minutes/);
  // The tenth merge makes the count.
  const ten = [{ sha: sha('tenth'), at: iso(start) }, ...nine];
  assert.equal(cutDue(cut, ten, start, defaults), true, 'ten merges after the cut are due');
  assert.match(assessCut(cut, ten, start, defaults).reason, /10 merge\(s\) landed on main after candidate 20300501T100000Z, at or past the 10-merge cut/);
  // One merge that has waited 15 minutes is due on its own; at 14 it is not. The age is the commit time, never the loop's reads.
  const lone = (age: number) => [{ sha: sha('lone'), at: iso(start - age * minute) }, { sha: sha('cut'), at: iso(start - 120 * minute) }];
  assert.equal(cutDue(cut, lone(14), start, defaults), false);
  assert.equal(cutDue(cut, lone(15), start, defaults), true, 'a single merge fifteen minutes old is due');
  assert.match(assessCut(cut, lone(15), start, defaults).reason, /has waited 15 minute\(s\), at or past the 15-minute idle cut/);
  assert.equal(cutDue(cut, lone(15), start - minute, defaults), false, 'a minute earlier the same merge is not due yet');
  // The merges counted are those after the newest cut: a merge older than the cut is never counted, and a quiet main after the cut is nothing to cut.
  assert.equal(cutDue(cut, [{ sha: sha('cut'), at: iso(start - 120 * minute) }, ...history(300, 400)], start, defaults), false, 'merges before the cut do not count');
  assert.match(assessCut(cut, [{ sha: sha('cut'), at: iso(start - 120 * minute) }], start, defaults).reason, /No merge has landed on main after candidate 20300501T100000Z; nothing to cut/);
  // With no cut recorded every merge in the history counts, and an idle merge is due at once at fifteen minutes.
  assert.equal(cutDue({ candidates: [] }, history(16), start, defaults), true);
  assert.equal(cutDue({ candidates: null }, history(1, 2), start, defaults), false);
  assert.equal(cutDue({ candidates: [] }, [], start, defaults), false, 'an empty history is never due: never cut on idle with zero merges');
  // A cut whose SHA the history read no longer reaches counts everything read, as the release cut itself does.
  assert.equal(cutDue({ candidates: [{ id: 'old', sha: sha('unreachable'), cutAt: iso(start - 9000 * minute) }] }, history(1, 2, 3, 4, 5, 6, 7, 8, 9, 10), start, defaults), true);
  // The overrides: three merges or thirty idle minutes.
  const tuned = candidateSettings(masterRunSchema.parse({ intervalSeconds: 20, candidates: { everyMerges: 3, idleMinutes: 30 } }));
  assert.deepEqual(tuned, { everyMerges: 3, idleMinutes: 30 });
  assert.equal(cutDue(cut, [...history(1, 2, 3), { sha: sha('cut'), at: iso(start - 120 * minute) }], start, tuned), true, 'three merges are due under everyMerges 3');
  assert.equal(cutDue(cut, lone(20), start, tuned), false, 'twenty idle minutes are not due under idleMinutes 30');
  assert.equal(cutDue(cut, lone(30), start, tuned), true);
  assert.equal(cutDue(cut, lone(20), start, defaults), true, 'the same merge is due under the default fifteen');
  // The schema is strict and bounded, and lives beside run.mergeWriter.
  assert.throws(() => candidateSettingsSchema.parse({ everyMerges: 0 }));
  assert.throws(() => candidateSettingsSchema.parse({ idleMinutes: 15, cadence: 'x' }));
  assert.throws(() => masterRunSchema.parse({ intervalSeconds: 20, candidates: { everyMerges: 1000 } }));
  assert.deepEqual(candidateSettings(masterRunSchema.parse({ intervalSeconds: 20 })), defaults);
});

// ---- The local ports ---------------------------------------------------------------------------------

const MAIN = sha('main-tip'), PROMOTED = sha('promoted'), CUT = sha('cut-sha'), REVERT = sha('revert-sha');
const candidate: LocalCandidate = { id: '20300501T120000Z', sha: CUT, cutAt: iso(start), items: [{ key: 'GY-2', mergeSha: sha('merge-2'), pr: 2 }, { key: 'GY-1', mergeSha: sha('merge-1'), pr: 1 }] };
const passed: LocalValidation = { record: { result: 'passed', suites: [{ name: 'e2e', passed: true, detail: 'ok' }], e2e: null, followUp: null, deployedSha: CUT }, followUp: null };
const failed: LocalValidation = { record: { result: 'failed', suites: [{ name: 'e2e', passed: false, detail: 'sign-in failed' }], followUp: 'GY-900', deployedSha: CUT,
  e2e: { runId: 'rc-20300501T120000Z', sha: CUT, blocking: ['sign-in'], cases: [{ case: 'sign-in', verdict: 'failed', required: true, attempts: 2, failingStep: { index: 1, name: 'open the Work view', reason: 'no heading' } }] } }, followUp: 'GY-900' };
const flaky: LocalValidation = { record: { ...failed.record, e2e: { ...failed.record.e2e!, cases: [{ ...failed.record.e2e!.cases[0], verdict: 'flaky' }] } }, followUp: 'GY-901' };

/** Local ports answering from memory, recording every call in order. */
function fakeLocal(options: { validation?: LocalValidation; cut?: Awaited<ReturnType<LocalReleasePorts['cut']>>; history?: CutCommit[]; served?: string | null; revert?: RevertOutcome; promote?: Awaited<ReturnType<LocalReleasePorts['promote']>> } = {}) {
  const calls: string[] = [], due: boolean[] = [];
  // Like the real port, the fake cuts only when told the rule is due; not due, it answers a resumable candidate or nothing.
  const local: LocalReleasePorts = {
    settings: defaults,
    history: async () => { calls.push('history'); return options.history ?? history(20); },
    cut: async isDue => { calls.push('cut'); due.push(isDue); return options.cut ?? (isDue ? { cut: true, candidate } : { cut: false, reason: 'not due' }); },
    uat: async id => { calls.push(`uat:${id}`); return { sha: CUT }; },
    validate: async id => { calls.push(`validate:${id}`); return options.validation ?? passed; },
    promote: async id => { calls.push(`promote:${id}`); return options.promote ?? { promoted: true, sha: CUT }; },
    verify: async sha => { calls.push(`verify:${sha.slice(0, 6)}`); return { served: options.served === undefined ? sha : options.served, verified: (options.served === undefined ? sha : options.served) === sha }; },
    revertInputs: async () => { calls.push('revertInputs'); return { items: [{ key: 'GY-2', mergeSha: sha('merge-2'), files: ['src/server/routes/work.ts'] }, { key: 'GY-1', mergeSha: sha('merge-1'), files: ['web/app.ts'] }], maps: [{ path: 'verification/server.md', paths: ['src/server/**'], sections: { Tests: 't', Drive: 'd', Invariants: 'i', Gotchas: 'g' } }], contract: { outcomes: [{ id: 'sign-in', cases: ['sign-in'] }], cases: [{ id: 'sign-in', tags: ['browser', 'server'] }] } }; },
    revert: async target => { calls.push(`revert:${target.key}`); return options.revert ?? { outcome: 'reverted', revertSha: REVERT, baseTip: MAIN, observedTip: REVERT, pushes: 1 }; },
  };
  return { local, calls, due };
}
function stubReads(ledger: PromotionLedger, local: LocalReleasePorts | null, merger: 'github' | 'control-plane' | (() => Promise<'github' | 'control-plane'>) = 'control-plane') {
  const state = { ledger, dispatches: 0, runsRead: 0 };
  const reads: PromotionReads = { ledger: async () => state.ledger, runs: async () => { state.runsRead++; return []; }, dispatch: async () => { state.dispatches++; },
    merger: typeof merger === 'function' ? merger : async () => merger, local };
  return { state, reads };
}
const ledger = (fields: Partial<PromotionLedger> = {}): PromotionLedger => ({ mainSha: MAIN, promotedSha: PROMOTED, promotedAt: iso(start - 60 * minute), behind: 2, candidates: [{ id: '20300501T100000Z', sha: PROMOTED, cutAt: iso(start - 120 * minute), prs: 2, queued: 2 }], ...fields });
const options = (now: number, frozen?: { sha: string; since: string } | null) => ({ now, everyMinutes: 10, intervalMs: 20_000, ...(frozen !== undefined ? { frozen, watchedTip: MAIN } : {}) });
/** One local run through cut → validate → promote/revert, waiting out the in-flight cycles the budget would otherwise span. */
const cycle = async (previous: PromotionState | null, reads: PromotionReads, now: number, frozen?: { sha: string; since: string } | null) => {
  const result = reads.local
    ? await settleLocalPromotion(previous, reads as PromotionReads & { local: LocalReleasePorts }, options(now, frozen))
    : await promotionCycle(previous, reads, options(now, frozen));
  return { ...result, state: promotionStateSchema.parse(result.state) };
};

test('unit:promotion-local-ports — under a control-plane merger promotionCycle runs the candidate through the local cut, uat, validate, promote and verify ports, reads no workflow runs and dispatches nothing; a failed required case runs the revert, a flaky one and a non-E2E failure do not; a resumed candidate skips the cut; the gap and the cut rule throttle; no ports means a named reason', async () => {
  // A passing candidate: cut → uat → validate → promote → verify, in one call, with the state stamped like a dispatch.
  const green = fakeLocal();
  const { state: stub, reads } = stubReads(ledger(), green.local);
  let result = await cycle(null, reads, start);
  assert.equal(result.dispatched, true);
  assert.deepEqual(green.calls, ['history', 'cut', `uat:${candidate.id}`, `validate:${candidate.id}`, `promote:${candidate.id}`, `verify:${CUT.slice(0, 6)}`]);
  assert.equal(stub.dispatches, 0, 'no workflow is dispatched'); assert.equal(stub.runsRead, 0, 'no workflow runs are read');
  assert.match(result.state.reason!, /^Cut candidate 20300501T120000Z at [0-9a-f]{12}: Promoted candidate 20300501T120000Z \([0-9a-f]{12}\) to production, which serves it$/);
  assert.deepEqual([result.state.cutSha, result.state.candidateAtDispatch, result.state.inFlight, result.state.lastDispatchAt], [CUT, candidate.id, false, iso(start)]);
  assert.equal(result.run?.promoted, true);
  // The gap: within everyMinutes of the last cut nothing is read or cut.
  const again = fakeLocal();
  result = await cycle(result.state, { ...reads, local: again.local }, start + 5 * minute);
  assert.deepEqual(again.calls, []); assert.match(result.state.reason!, /The last candidate was cut 5 minute\(s\) ago; the next is due no sooner than 10 minute\(s\) after it/);
  // Past the gap, a cut not due reads the history and asks the port only for a resumable candidate — told the rule is not due, it cuts nothing.
  const idle = fakeLocal({ history: history(1, 2) });
  result = await cycle(result.state, { ...reads, local: idle.local }, start + 11 * minute);
  assert.deepEqual(idle.calls, ['history', 'cut']); assert.deepEqual(idle.due, [false], 'the port is told the cut is not due'); assert.equal(result.dispatched, false);
  assert.deepEqual(green.due, [true], 'the passing run above asked for a due cut');
  assert.match(result.state.reason!, /2 merge\(s\) landed on main after candidate 20300501T100000Z; the next candidate is cut at 10 merges or once one has waited 15 minutes/);
  assert.equal(result.state.nextDueAt, iso(start + 11 * minute), 'with merges waiting the cut is due later');
  // The cut rule is read once a run-read window: the next cycle inside it neither reads nor cuts.
  const quiet = fakeLocal();
  result = await cycle(result.state, { ...reads, local: quiet.local }, start + 11 * minute + 20_000);
  assert.deepEqual(quiet.calls, []);
  // A failed required E2E case: no promote, no verify, the revert runs with the target the maps select; production stays on the previous release.
  const red = fakeLocal({ validation: failed });
  result = await cycle(null, stubReads(ledger(), red.local).reads, start);
  assert.deepEqual(red.calls, ['history', 'cut', `uat:${candidate.id}`, `validate:${candidate.id}`, 'revertInputs', 'revert:GY-2']);
  assert.match(result.state.reason!, /failed required E2E case sign-in at step "open the Work view" \(outcome sign-in\); verification map verification\/server\.md matches it and its globs cover GY-2's merge delta \(src\/server\/routes\/work\.ts\), so GY-2's merge [0-9a-f]{12} is reverted: reverted as [0-9a-f]{12} on [0-9a-f]{12} and GY-2 reopened for rework; production stays on the previous release; the next cut starts after the revert/);
  assert.equal(result.run?.revert?.target.key, 'GY-2'); assert.equal(result.run?.promoted, false);
  // A refused revert is one attempt: its refusal is the reason, the follow-up stands, and no second item is tried.
  const refused = fakeLocal({ validation: failed, revert: { outcome: 'refused', reason: 'revert refused: the revert conflicts in src/server/routes/work.ts' } });
  result = await cycle(null, stubReads(ledger(), refused.local).reads, start);
  assert.deepEqual(refused.calls.filter(call => call.startsWith('revert:')), ['revert:GY-2']);
  assert.match(result.state.reason!, /failed required E2E case sign-in at step "open the Work view"; the revert of GY-2's merge [0-9a-f]{12} was refused \(revert refused: the revert conflicts in src\/server\/routes\/work\.ts\); production stays on the previous release and the follow-up stands/);
  // A flaky required case stays on the holds path: nothing is reverted.
  const flake = fakeLocal({ validation: flaky });
  result = await cycle(null, stubReads(ledger(), flake.local).reads, start);
  assert.deepEqual(flake.calls, ['history', 'cut', `uat:${candidate.id}`, `validate:${candidate.id}`]);
  assert.match(result.state.reason!, /failed UAT \(e2e\); production stays on the previous release and follow-up GY-901 names the failure; the next cut starts after it/);
  // A failure no case explains (endpoints) files the follow-up alone.
  const endpoints = fakeLocal({ validation: { record: { result: 'failed', suites: [{ name: 'endpoints', passed: false, detail: '/ answered 503' }], e2e: null, followUp: 'GY-902', deployedSha: CUT }, followUp: 'GY-902' } });
  result = await cycle(null, stubReads(ledger(), endpoints.local).reads, start);
  assert.deepEqual(endpoints.calls, ['history', 'cut', `uat:${candidate.id}`, `validate:${candidate.id}`]);
  assert.match(result.state.reason!, /failed UAT \(endpoints\); production stays on the previous release and follow-up GY-902/);
  // A candidate the ledger holds without a verdict is resumed from UAT, not cut past, whether or not a cut is due.
  const resumed = fakeLocal({ history: history(1), cut: { cut: false, resume: candidate } });
  result = await cycle(null, stubReads(ledger(), resumed.local).reads, start);
  assert.deepEqual(resumed.calls, ['history', 'cut', `uat:${candidate.id}`, `validate:${candidate.id}`, `promote:${candidate.id}`, `verify:${CUT.slice(0, 6)}`]);
  assert.match(result.state.reason!, /^Resumed candidate 20300501T120000Z: Promoted candidate 20300501T120000Z/); assert.equal(result.run?.resumed, true);
  // A port that throws is a failure with the stamps kept, so it backs off and is resumed at the next read.
  const broken = fakeLocal(); broken.local.uat = async () => { throw new Error('UAT serves candidate X, whose validation has no verdict yet'); };
  result = await cycle(null, stubReads(ledger(), broken.local).reads, start);
  assert.match(result.failure!, /Cut candidate 20300501T120000Z \([0-9a-f]{12}\) failed before a verdict was recorded; it is resumed at the next read: UAT serves candidate X/);
  assert.equal(result.state.cutSha, CUT, 'the cut is stamped so the next attempt resumes rather than re-cuts');
  assert.equal(result.state.inFlight, false, 'a failed validation clears inFlight so the next cycle can resume');
  // Nothing to promote, off, or a tip the watch has not classified: no port runs.
  const none = fakeLocal();
  result = await cycle(null, stubReads(ledger({ mainSha: PROMOTED }), none.local).reads, start);
  assert.deepEqual(none.calls, []); assert.match(result.state.reason!, /Production runs the base branch tip; nothing to cut or promote/);
  const off = await promotionCycle(null, stubReads(ledger(), none.local).reads, { now: start, everyMinutes: 0 });
  assert.deepEqual(none.calls, []); assert.match(off.state.reason!, /Promotion by the loop is off/);
  // Control-plane mode with no local ports names what the environment must set; a merger that cannot be read runs github mode.
  const unwired = stubReads(ledger(), null);
  result = await cycle(null, unwired.reads, start);
  assert.equal(result.state.reason, noLocalPortsReason); assert.equal(unwired.state.dispatches, 0);
  assert.equal(await promotionMode({ merger: async () => { throw new Error('HTTP 503'); } }), 'github');
  assert.equal(await promotionMode({}), 'github');
  // runLocalCandidate on its own: a promotion production has not picked up yet says so, and a refused promotion names the refusal.
  const slow = fakeLocal({ served: PROMOTED });
  assert.match((await runLocalCandidate(slow.local, candidate, false)).detail, /to production, which still serves [0-9a-f]{12}; the deployment observation confirms it when it lands/);
  const held = fakeLocal({ promote: { promoted: false, refusals: ['Production already runs newer candidate X'] } });
  assert.match((await runLocalCandidate(held.local, candidate, false)).detail, /passed UAT but was not promoted: Production already runs newer candidate X/);
  // The real ports' helpers: the validate command the loop runs, the last JSON a command prints, and the maps and case tags of this checkout.
  const args = localValidateArguments('20300501T120000Z', 'https://uat.example.test');
  assert.deepEqual(args.slice(0, 7), ['release', 'validate', '20300501T120000Z', '--url', 'https://uat.example.test', '--wait', '1200']);
  assert.ok(args.includes('--api') && args.filter(arg => arg === '--suite').length === 3 && args.some(arg => arg.startsWith('browser=')) && args.some(arg => arg.startsWith('e2e=')) && args.some(arg => arg.startsWith('zero-touch=')), 'the workflow\'s own suites, less the container and chart jobs');
  assert.deepEqual(lastJson('suite output\n{"not":"this"}\n{"record":{"result":"passed"},\n"followUp":null}\n'), { record: { result: 'passed' }, followUp: null });
  assert.throws(() => lastJson('nothing here'), /printed no JSON result/);
  const root = new URL('..', import.meta.url).pathname;
  assert.ok(readVerificationMaps(root).some(map => map.path === 'verification/server.md'), 'the checkout\'s maps are read');
  assert.ok(readCaseTags(root).some(entry => entry.id === 'sign-in' && entry.tags.length > 0), 'the case tags are read');
});

test('unit:candidate-freeze-honoured — with state.mainWatch.frozen set the local cycle runs no cut, UAT deploy, promote or revert, and the promotion reason names the frozen sha; lifted, the next cycle runs them; a freeze that lands after validation still stops promote and revert', async () => {
  const frozen = { sha: sha('foreign'), since: iso(start - 10 * minute) };
  const local = fakeLocal({ validation: failed });
  const { state: stub, reads } = stubReads(ledger(), local.local);
  const held = await cycle(null, reads, start, frozen);
  assert.deepEqual(local.calls, [], 'no port runs under the freeze');
  assert.equal(held.dispatched, false); assert.equal(stub.dispatches, 0);
  assert.equal(held.state.reason, promotionFrozenReason(frozen));
  assert.ok(held.state.reason!.includes(frozen.sha), 'the reason names the frozen commit');
  assert.equal(held.state.nextDueAt, null, 'nothing is due while frozen');
  // The freeze also holds the direct run: localPromotionCycle itself reads it before any port.
  const direct = await localPromotionCycle(null, { ...reads, local: local.local }, { now: start, everyMinutes: 10, intervalMs: 20_000, frozen, watchedTip: MAIN });
  assert.deepEqual(local.calls, []); assert.equal(direct.state.reason, promotionFrozenReason(frozen));
  // Lifted, the cut runs and the failed case reverts.
  const lifted = await cycle(held.state, reads, start + minute, null);
  assert.deepEqual(local.calls, ['history', 'cut', `uat:${candidate.id}`, `validate:${candidate.id}`, 'revertInputs', 'revert:GY-2']);
  assert.equal(lifted.dispatched, true); assert.equal(lifted.state.inFlight, false);
  // A freeze that lands while validation is in flight (or after it settles) stops promote and revert; the reason names the sha.
  const mid = fakeLocal({ validation: failed });
  const midReads = stubReads(ledger(), mid.local).reads as PromotionReads & { local: LocalReleasePorts };
  const cut = await localPromotionCycle(null, midReads, { now: start, everyMinutes: 10, intervalMs: 20_000, frozen: null, watchedTip: MAIN });
  assert.equal(cut.state.inFlight, true, 'the cut stamps inFlight before the long validation');
  assert.deepEqual(mid.calls.filter(call => call.startsWith('promote') || call.startsWith('revert')), [], 'promote/revert wait for a later cycle');
  await localPromotionIdle(mid.local);
  const frozenAfter = await localPromotionCycle(cut.state, midReads, { now: start + minute, everyMinutes: 10, intervalMs: 20_000, frozen, watchedTip: MAIN });
  assert.equal(frozenAfter.state.inFlight, true, 'the validated candidate stays in flight under the freeze');
  assert.equal(frozenAfter.state.reason, promotionFrozenReason(frozen));
  assert.ok(frozenAfter.state.reason!.includes(frozen.sha));
  assert.deepEqual(mid.calls.filter(call => call.startsWith('promote') || call.startsWith('revert:') || call === 'revertInputs'), [], 'no promote or revert while frozen');
  const unfrozen = await localPromotionCycle(frozenAfter.state, midReads, { now: start + 2 * minute, everyMinutes: 10, intervalMs: 20_000, frozen: null, watchedTip: MAIN });
  assert.equal(unfrozen.state.inFlight, false);
  assert.ok(mid.calls.includes('revert:GY-2'), 'lifted, the revert runs');
  // A tip the watch has not classified waits too, naming the tip.
  const unseen = fakeLocal();
  const waiting = await promotionCycle(null, stubReads(ledger(), unseen.local).reads, { now: start, everyMinutes: 10, intervalMs: 20_000, frozen: null, watchedTip: sha('older-tip') });
  assert.deepEqual(unseen.calls, []); assert.match(waiting.state.reason!, /The main watch has not classified the base branch tip [0-9a-f]{12} yet; the cut waits for its verdict/);
});

test('unit:promotion-github-snapshot — under a github merger (or none) the dispatch is unchanged: the runs are read and `gh workflow run release-candidate.yml --repo R --ref BASE -f promote=true` is run, and the local ports never are', async () => {
  const calls: { command: string; args: string[] }[] = [];
  const run = (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === 'git' && args.includes('rev-parse')) return `${MAIN}\n`;
    if (command === 'git' && args.includes('for-each-ref') && args.includes('--count=1')) return JSON.stringify({ id: '20300501T100000Z', sha: PROMOTED, at: iso(start - 60 * minute) });
    if (command === 'git' && args.includes('rev-list')) return '2\n';
    if (command === 'git' && args.includes('for-each-ref')) return '';
    if (command === 'git') return '';
    if (command === 'gh' && args[0] === 'run') return '[]';
    return '';
  };
  const config = { repository: 'owner/repo', baseBranch: 'main', run: { intervalSeconds: 20 } } as unknown as MasterConfig;
  const local = fakeLocal();
  // Snapshot of the dispatch call, exactly as GY-1488 left it, with the local ports present but a github merger.
  const reads = promotionReads(config, '/repo', run, true, false, { merger: async () => 'github', local: local.local })!;
  const result = await promotionCycle(null, reads, { now: start, everyMinutes: 10, intervalMs: 20_000 });
  assert.equal(result.dispatched, true, result.state.reason ?? '');
  assert.deepEqual(calls.filter(call => call.command === 'gh').map(call => call.args), [
    ['run', 'list', '--repo', 'owner/repo', '--workflow', promotionWorkflow, '--limit', '50', '--json', 'status,createdAt,event,headSha'],
    ['workflow', 'run', 'release-candidate.yml', '--repo', 'owner/repo', '--ref', 'main', '-f', 'promote=true'],
  ]);
  assert.deepEqual(local.calls, [], 'the local ports are not touched in github mode');
  assert.match(result.state.reason!, /^Dispatched release-candidate\.yml with promote=true to carry [0-9a-f]{12} to production$/);
  // Without a merger read at all the drive is github's, as it was before GY-1526.
  const legacy = promotionReads(config, '/repo', run, true, false)!;
  assert.equal(legacy.merger, undefined); assert.equal(legacy.local, undefined);
  const before = calls.length;
  await promotionCycle(null, legacy, { now: start, everyMinutes: 10, intervalMs: 20_000 });
  assert.ok(calls.slice(before).some(call => call.command === 'gh' && call.args[0] === 'workflow'), 'the legacy reads dispatch the workflow');
  // Without the workflow file github mode has nothing to dispatch; control-plane mode needs only the local ports.
  assert.equal(promotionReads(config, '/repo', run, false, false), null);
  assert.equal(promotionReads(config, '/repo', run, false, false, { local: null }), null);
  assert.ok(promotionReads(config, '/repo', run, false, false, { merger: async () => 'control-plane', local: local.local }), 'the local ports stand without the workflow');
  // Under a control-plane merger the same reads run the local ports and never gh.
  const controlPlane = promotionReads(config, '/repo', run, true, false, { merger: async () => 'control-plane', local: local.local })!;
  const ghBefore = calls.filter(call => call.command === 'gh').length;
  const switched = await settleLocalPromotion(null, controlPlane as PromotionReads & { local: LocalReleasePorts }, { now: start, everyMinutes: 10, intervalMs: 20_000 });
  assert.equal(calls.filter(call => call.command === 'gh').length, ghBefore, 'no gh call under control-plane');
  assert.equal(switched.dispatched, true); assert.deepEqual(local.calls.slice(0, 2), ['history', 'cut']);
  assert.match(switched.state.reason!, /^Cut candidate/);
  assert.equal(switched.state.inFlight, false);
});

test('unit:promotion-local-inflight — a cut stamps PromotionState.inFlight across cycles until UAT settles; a budget-deferred validation reports the candidate in flight and clears the flag only after promote or revert', async () => {
  let releaseValidate: () => void;
  const gate = new Promise<void>(resolve => { releaseValidate = resolve; });
  const slow = fakeLocal();
  const validate = slow.local.validate;
  slow.local.validate = async id => { await gate; return validate(id); };
  const reads = stubReads(ledger(), slow.local).reads as PromotionReads & { local: LocalReleasePorts };
  const cut = await localPromotionCycle(null, reads, { now: start, everyMinutes: 10, intervalMs: 20_000, frozen: null, watchedTip: MAIN });
  assert.equal(cut.dispatched, true);
  assert.equal(cut.state.inFlight, true, 'inFlight is set before validation returns');
  assert.equal(cut.state.candidateAtDispatch, candidate.id);
  assert.match(cut.state.reason!, /UAT validation is in flight/);
  for (let waited = 0; !slow.calls.includes(`uat:${candidate.id}`) && waited < 50; waited++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.deepEqual(slow.calls, ['history', 'cut', `uat:${candidate.id}`], 'validate has started but not returned');
  // A later cycle while validation still runs keeps inFlight and starts no second cut.
  const waiting = await localPromotionCycle(cut.state, reads, { now: start + 20_000, everyMinutes: 10, intervalMs: 20_000, frozen: null, watchedTip: MAIN });
  assert.equal(waiting.state.inFlight, true);
  assert.equal(slow.calls.filter(call => call === 'cut').length, 1, 'no second cut while in flight');
  assert.match(waiting.state.reason!, /is in validation/);
  releaseValidate!();
  await localPromotionIdle(slow.local);
  const finished = await localPromotionCycle(waiting.state, reads, { now: start + minute, everyMinutes: 10, intervalMs: 20_000, frozen: null, watchedTip: MAIN });
  assert.equal(finished.state.inFlight, false, 'inFlight clears only after the run settles');
  assert.equal(finished.run?.promoted, true);
  assert.ok(slow.calls.includes(`promote:${candidate.id}`));
});
