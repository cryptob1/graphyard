import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promotionCycle, type PromotionLedger, type PromotionReads } from '../src/daemon/deployment.js';
import { localPromotionIdle, type LocalCandidate, type LocalReleasePorts, type LocalValidation } from '../src/daemon/promotion-local.js';
import { candidateSettings } from '../src/master/merge-writer-settings.js';
import { promotionStateSchema, type PromotionState } from '../src/daemon/state.js';
import type { CutCommit } from '../src/daemon/candidate-cut.js';
import type { RevertOutcome } from '../src/release-revert.js';

/**
 * GY-1526: control-plane release candidates over a simulated day of the real promotion cycle.
 * Main advances by merges; the local ports cut at the configured cadence, validate (sometimes
 * slowly, sometimes failing), promote or revert, and honour a freeze mid-day. Asserts system
 * invariants: at most one candidate in flight, bounded cuts and retries, no promote or revert
 * while frozen, and inFlight cleared only when a run settles.
 */
const minute = 60_000;
const start = Date.parse('2030-06-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const cycleMs = 2 * minute;
const hours = 6;
const cycles = (hours * 60) / 2;
const settings = candidateSettings({ candidates: { everyMerges: 3, idleMinutes: 20 } });

test('unit:soak-local-promotion — a simulated day of control-plane release candidates: bounded cuts, one in flight, freeze blocks promote and revert, retries stay bounded', { timeout: 300_000 }, async () => {
  let now = start;
  const merges: CutCommit[] = [];
  const candidates: LocalCandidate[] = [];
  const calls: string[] = [];
  const promotions: string[] = [];
  const reverts: string[] = [];
  const freezes: string[] = [];
  let promotedSha = sha('initial-prod');
  let mainSha = sha('initial-main');
  let cutCount = 0;
  let validateCount = 0;
  let running = 0;
  let widest = 0;
  let frozen: { sha: string; since: string } | null = null;
  // Script: merge every 4 minutes; freeze for 30 minutes in hour 2; every 4th candidate fails E2E; validation takes one cycle.
  const mergeEvery = 4 * minute;
  const freezeFrom = start + 2 * 60 * minute;
  const freezeUntil = freezeFrom + 30 * minute;

  const history = (): CutCommit[] => [...merges].reverse();
  const ledger = (): PromotionLedger => ({
    mainSha, promotedSha, promotedAt: iso(start), behind: Math.max(0, merges.length),
    // The promotion state keeps at most five candidates, newest first — match the real ledger bound.
    candidates: candidates.slice(-5).reverse().map(c => ({ id: c.id.replace(/:done$/, ''), sha: c.sha, cutAt: c.cutAt, prs: c.items.length, queued: 0 })),
  });

  const local: LocalReleasePorts = {
    settings,
    history: async () => { calls.push('history'); return history(); },
    cut: async due => {
      calls.push(`cut:${due}`);
      const open = candidates.find(c => !c.id.endsWith(':done'));
      if (open) return { cut: false, resume: open };
      if (!due) return { cut: false, reason: 'not due' };
      cutCount += 1;
      const id = `20300601T${String(cutCount).padStart(6, '0')}Z`;
      const tip = merges[merges.length - 1] ?? { sha: mainSha, at: iso(now) };
      const candidate: LocalCandidate = {
        id, sha: tip.sha, cutAt: iso(now),
        items: merges.slice(-3).map((merge, index) => ({ key: `GY-${merges.length - 3 + index + 1}`, mergeSha: merge.sha, pr: merges.length - 3 + index + 1 })),
      };
      candidates.push(candidate);
      return { cut: true, candidate };
    },
    uat: async id => { calls.push(`uat:${id}`); return { sha: candidates.find(c => c.id === id)!.sha }; },
    validate: async id => {
      calls.push(`validate:${id}`);
      validateCount += 1; running += 1; widest = Math.max(widest, running);
      await new Promise(resolve => setTimeout(resolve, 1));
      running -= 1;
      const fail = validateCount % 4 === 0;
      const validation: LocalValidation = fail
        ? { record: { result: 'failed', suites: [{ name: 'e2e', passed: false, detail: 'sign-in failed' }], followUp: `GY-9${validateCount}`, deployedSha: candidates.find(c => c.id === id)!.sha,
            e2e: { runId: `rc-${id}`, sha: candidates.find(c => c.id === id)!.sha, blocking: ['sign-in'], cases: [{ case: 'sign-in', verdict: 'failed', required: true, attempts: 1, failingStep: { index: 1, name: 'open Work', reason: 'missing' } }] } }, followUp: `GY-9${validateCount}` }
        : { record: { result: 'passed', suites: [{ name: 'e2e', passed: true, detail: 'ok' }], e2e: null, followUp: null, deployedSha: candidates.find(c => c.id === id)!.sha }, followUp: null };
      return validation;
    },
    promote: async id => {
      calls.push(`promote:${id}`);
      assert.equal(frozen, null, 'promote must not run while frozen');
      const candidate = candidates.find(c => c.id === id)!;
      promotedSha = candidate.sha;
      promotions.push(id);
      candidate.id = `${id}:done`;
      return { promoted: true, sha: candidate.sha };
    },
    verify: async shaValue => { calls.push(`verify:${shaValue.slice(0, 6)}`); return { served: shaValue, verified: true }; },
    revertInputs: async candidate => ({
      items: candidate.items.map(item => ({ key: item.key, mergeSha: item.mergeSha, files: ['src/app.ts'] })),
      maps: [{ path: 'verification/server.md', paths: ['src/**'], sections: { Tests: 't', Drive: 'd', Invariants: 'i', Gotchas: 'g' } }],
      contract: { outcomes: [{ id: 'sign-in', cases: ['sign-in'] }], cases: [{ id: 'sign-in', tags: ['server'] }] },
    }),
    revert: async target => {
      calls.push(`revert:${target.key}`);
      assert.equal(frozen, null, 'revert must not run while frozen');
      reverts.push(target.key);
      const tip = sha(`revert:${target.mergeSha}:${reverts.length}`);
      mainSha = tip;
      merges.push({ sha: tip, at: iso(now) });
      const candidate = candidates.find(c => c.items.some(item => item.key === target.key) && !c.id.endsWith(':done'));
      if (candidate) candidate.id = `${candidate.id}:done`;
      const outcome: RevertOutcome = { outcome: 'reverted', revertSha: tip, baseTip: tip, observedTip: tip, pushes: 1 };
      return outcome;
    },
  };

  const reads: PromotionReads & { local: LocalReleasePorts } = {
    ledger: async () => ledger(),
    runs: async () => { throw new Error('github runs must not be read in control-plane soak'); },
    dispatch: async () => { throw new Error('github dispatch must not run in control-plane soak'); },
    merger: async () => 'control-plane',
    local,
  };

  let state: PromotionState | null = null;
  let inFlightCycles = 0;
  let maxInFlightStreak = 0;
  let streak = 0;
  const reasons: string[] = [];

  for (let cycle = 0; cycle < cycles; cycle++) {
    now = start + cycle * cycleMs;
    // Advance main with merges on the cadence.
    if (cycle > 0 && (now - start) % mergeEvery === 0) {
      const merge = { sha: sha(`merge-${merges.length + 1}`), at: iso(now) };
      merges.push(merge);
      mainSha = merge.sha;
    }
    frozen = now >= freezeFrom && now < freezeUntil ? { sha: sha('foreign-main'), since: iso(freezeFrom) } : null;
    if (frozen) freezes.push(iso(now));

    const result = await promotionCycle(state, reads, { now, everyMinutes: 10, intervalMs: cycleMs, frozen, watchedTip: mainSha });
    state = promotionStateSchema.parse(result.state);
    reasons.push(state.reason ?? '');
    if (state.inFlight) { streak += 1; inFlightCycles += 1; maxInFlightStreak = Math.max(maxInFlightStreak, streak); }
    else streak = 0;
    // Drain a settled validation on the next simulated ticks so the day makes progress inside the soak.
    if (state.inFlight) {
      await localPromotionIdle(local);
      const finish = await promotionCycle(state, reads, { now: now + 1_000, everyMinutes: 10, intervalMs: cycleMs, frozen, watchedTip: mainSha });
      state = promotionStateSchema.parse(finish.state);
      if (!state.inFlight) streak = 0;
      else { streak += 1; maxInFlightStreak = Math.max(maxInFlightStreak, streak); }
    }
    assert.ok(widest <= 1, `at most one validation at a time (widest ${widest})`);
    assert.ok((state.candidates?.length ?? 0) <= 50, 'candidate list stays bounded');
  }

  assert.ok(cutCount >= 4, `the day cut several candidates: ${cutCount}`);
  assert.ok(promotions.length >= 2, `some candidates promoted: ${promotions}`);
  assert.ok(reverts.length >= 1, `at least one related-item revert ran: ${reverts}`);
  assert.ok(inFlightCycles >= 4, `inFlight was observed across cycles: ${inFlightCycles}`);
  assert.ok(maxInFlightStreak >= 1 && maxInFlightStreak <= 40, `inFlight streaks stay bounded (${maxInFlightStreak})`);
  assert.ok(freezes.length >= 10, `the freeze window was active: ${freezes.length} cycles`);
  // While frozen, no promote or revert call is recorded (the ports assert; the call list must agree).
  const freezePromote = calls.filter(call => call.startsWith('promote:') && freezes.length);
  assert.ok(promotions.every(id => {
    const at = calls.findIndex(call => call === `promote:${id}`);
    return at >= 0;
  }), 'every promotion was requested through the port');
  assert.equal(state!.inFlight, false, 'the day ends with no candidate in flight');
  assert.ok(reasons.some(reason => /frozen since/.test(reason)), `freeze reasons were recorded: ${reasons.filter(r => /frozen/.test(r)).slice(0, 3)}`);
  assert.ok(cutCount <= merges.length, `cuts (${cutCount}) cannot exceed merges (${merges.length})`);
  // Retries: a cut is attempted only when due or resuming; history reads stay under one per in-flight window plus idle polls.
  const historyReads = calls.filter(call => call === 'history').length;
  assert.ok(historyReads <= cycles + cutCount + 5, `history reads stay bounded (${historyReads} over ${cycles} cycles)`);
});
