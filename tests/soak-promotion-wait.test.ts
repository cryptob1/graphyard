import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Work } from '../src/model.js';
import type { ActionRow } from '../src/model/actions.js';
import { claimAction, settleAction } from '../src/model/actions.js';
import { actionRetryMaxMs, actionRetryMinMs, actionStallThreshold } from '../src/model/action-progress.js';
import { promotionWaitBoundMs, promotionWaitClause } from '../src/model/action-kinds.js';
import { defaultPromoteEveryMinutes, promotionCandidatesListed, promotionCycle, promotionHandoffMs, type PromotionReads } from '../src/daemon/deployment.js';
import { emptyDaemonState, writeDaemonState, type PromotionState } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master.js';
import { runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import type { InvariantCheck } from '../src/model/invariants.js';
import { stalledActionAttention } from '../src/cli/stalled-actions.js';
import { classifyAttention } from '../src/model/fault-classes.js';
import { trackFaults } from '../src/model/fault-record.js';
import { controlPlaneHandlers } from '../src/executor.js';
// @ts-expect-error The standalone executor is a dependency-free entry point script.
import { controlPlaneEffects } from '../scripts/graphyard-executor.mjs';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1831, GY-1966: the promotion wait over simulated days. Each delivered item's verify-deployment
 * row is retried, attempt after attempt, while the release that serves its merge is still being
 * made; the wait is per item and per attempt, so this suite runs it at scale. Every minute the
 * loop's real promotion step (promotionCycle) reads a simulated GitHub — main moving with each
 * merge, release candidates dispatched, validating, promoting or failing and re-cut behind the
 * moving main — and records its state on the real cursor (writeDaemonState). The executor, built
 * as the shipped one is (controlPlaneEffects over the cursor, controlPlaneHandlers'
 * verify-deployment), claims and settles each row through the real action queue (claimAction,
 * settleAction), and the loop's attention path (stalledActionAttention, classifyAttention,
 * trackFaults) files what it would file. Production deploys each promotion minutes after the
 * workflow records it, and every candidate runs an advisory soak that outlives its validation,
 * failed candidates' included. Two quiet stretches end on a failing candidate, so the merges it
 * carried have nothing in flight. The same days run without the promotion read, as the base ran
 * them.
 *
 * Invariants: every row ends delivered or stalled within the promotion wait bound of the pipeline's
 * last demonstrated movement (a candidate cut or a release production started serving — the
 * movement restarts the row's unchanged run, GY-1966) and never later than two bounds after its
 * merge; a row whose release was served within the bound files no instance; a row left on a
 * pipeline whose validation window has closed stands plain, stalls, and files as the release
 * machinery's production instance, never a per-item stalled-action (GY-1966); while a failed
 * candidate's window stands the row names the wait, and past it never does; an attempt made after
 * a new cut names the new movement, never the attempt-before's (the rework of GY-1966: the
 * movement is the pipeline's newest, so the recorded promotion pins nothing); each row's attempts
 * are bounded; the cursor stays bounded; once merges resume every row is delivered; an attempt
 * while production is still deploying a recorded promotion names the wait. Instants are epoch
 * milliseconds, never a wall-clock reading.
 */

const minute = 60_000, hour = 60 * minute, t0 = 1_760_000_000_000, iso = (ms: number) => new Date(ms).toISOString();
const sha = (label: string) => createHash('sha1').update(label).digest('hex');
const intervalMs = minute, validationMs = 20 * minute, mergeEveryMs = 17 * minute, soakMs = 50 * minute;
/** Production deploys a promotion this long after the workflow records it, cycling through a quick, an ordinary and a slow deploy. */
const deployLags = [3 * minute, 8 * minute, 15 * minute];
const days = 2, mergingUntil = days * 24 * hour - 3 * hour, endsAt = days * 24 * hour;
/** The quiet stretches: no merge lands, and every candidate dispatched in the hour before one closes fails. */
const quiet = [[9 * hour, 13 * hour], [30 * hour, 35 * hour]] as const;
const inQuiet = (into: number) => quiet.some(([from, to]) => into >= from && into < to);
const quietFails = (into: number) => quiet.some(([from, to]) => into >= from - hour && into < to);
/**
 * A row is delivered or stalled at most this long after the pipeline's last demonstrated movement
 * (its newest candidate cut, or the last release production started serving — the movement
 * restarts the row's unchanged run, GY-1966), or after its merge when no movement bears on it: the
 * wait's bound, then — the wait over without a delivery — a plain run of the stall threshold's
 * failures at the backoff ceiling (plus the claims' minutes).
 */
const settleBoundMs = promotionWaitBoundMs + actionStallThreshold * actionRetryMaxMs + 2 * minute;

/** A delivered item as the plane lists it, with the fields master status reads. */
const delivered = (key: string, mergeSha: string, at: number) => ({
  id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item'] }],
  policy: { checks: ['test'], review: true }, plannedFiles: [], revision: 1, policyRevision: 1, createdAt: iso(at), updatedAt: iso(at), stage: 'done', stageEnteredAt: iso(at),
  ready: true, epoch: 1, lease: null, workspaces: [], submission: null, candidate: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null,
  blocker: null, violations: [], gates: [], delivery: { mergeSha, mergedAt: iso(at), authorizationRevision: 1 } });

interface Row { key: string; merge: string; mergedAt: number; deliveredAt: number | null; stalledAt: number | null; attemptsAtEnd: number | null; servedAt: number | null; filed: number
  /** The wait's movement this row's last wait-naming failure named, with the dispatch count then — the rework of GY-1966 checks a new cut changes it. */
  lastWait: { cuts: number; movement: string } | null }

/** The movement a wait-named failure carries, between the wait clause and its closing parenthesis (GY-1966). */
const movementOf = (reason: string) => reason.includes(promotionWaitClause)
  ? reason.slice(reason.indexOf(promotionWaitClause) + promotionWaitClause.length).trim().replace(/^\(/, '').replace(/\)$/, '') : null;

/**
 * `loop`: the review of GY-1966's rework — the same days through the real coordination loop. Each
 * minute runCycle runs with the day's promotion reads and the delivered items' snapshot: its own
 * promotion step records the cursor it persists (writeDaemonState, as `master run` persists it),
 * and its own faults step lists the stalled rows (buildMasterStatus over stalledActionAttention),
 * classifies and records them on the loop's fault record, and judges the system invariants, which
 * must hold after every cycle. The executor then drains the queue as above.
 */
async function simulate(waits: boolean, loop = false) {
  const mainline = [sha('root')], index = new Map([[mainline[0], 0]]);
  const contains = (ancestor: string, descendant: string) => index.has(ancestor) && index.has(descendant) ? index.get(ancestor)! <= index.get(descendant)! : null;
  let now = t0;
  const dispatches: { at: number; cut: string; id: string; fails: boolean; concluded: boolean; prs: number }[] = [];
  let promoted: { sha: string; at: number; lag: number } | null = null, promotions = 0;
  const production = { sha: mainline[0], changes: [] as number[] };
  const violations: string[] = [];
  const reads: PromotionReads = {
    ledger: async () => {
      const tip = mainline.at(-1)!, promotedSha = promoted?.sha ?? mainline[0];
      return { mainSha: tip, promotedSha, promotedAt: promoted ? iso(promoted.at) : null, behind: index.get(tip)! - index.get(promotedSha)!,
        candidates: dispatches.slice(-promotionCandidatesListed).reverse().map(run => ({ id: run.id, sha: run.cut, cutAt: iso(run.at), prs: run.prs, queued: index.get(tip)! - index.get(run.cut)! })) };
    },
    runs: async () => dispatches.filter(run => now - run.at >= 30_000).reverse()
      .map(run => ({ status: now < run.at + validationMs ? 'in_progress' : 'completed', createdAt: iso(run.at), event: 'workflow_dispatch', headSha: run.cut })),
    soaks: async () => dispatches.filter(run => now - run.at >= 2 * minute).reverse()
      .map(run => ({ sha: run.cut, status: now < run.at + soakMs ? 'in_progress' : 'completed', conclusion: now < run.at + soakMs ? null : 'success', createdAt: iso(run.at + 2 * minute), url: null })),
    dispatch: async () => {
      const tip = mainline.at(-1)!, last = dispatches.at(-1);
      if (last && now < last.at + validationMs) violations.push(`+${Math.round((now - t0) / minute)} min: dispatched while ${last.id} validates`);
      dispatches.push({ at: now, cut: tip, id: `rc-${dispatches.length + 1}`, fails: (dispatches.length % 4 === 3 && now - t0 < mergingUntil - 2 * hour) || quietFails(now - t0), concluded: false, prs: index.get(tip)! - index.get(last?.cut ?? mainline[0])! });
    },
  };

  const root = await temporaryDirectory('gy-1831-soak-root');
  execFileSync('git', ['init', '-q', root]);
  const credentials = await temporaryDirectory('gy-1831-soak-credentials');
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard-soak.example', credentialFile: `${credentials}/coordinator.token`, cliPath: '/outside/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'soak-host', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [],
    run: { intervalSeconds: intervalMs / 1000, promoteEveryMinutes: defaultPromoteEveryMinutes } });
  // The checkout's object store: `refs/remotes/origin/main` is the tip the failed observation fetched.
  const run = async (command: string, args: string[]) => {
    const [, , ...rest] = args;
    if (command !== 'git' || rest[0] !== 'merge-base') throw new Error(`the executor's promotion read runs nothing but a local merge-base: ${command} ${args.join(' ')}`);
    const resolve = (ref: string) => ref === 'refs/remotes/origin/main' ? mainline.at(-1)! : ref;
    const answer = contains(resolve(rest[2]), resolve(rest[3]));
    if (answer) return '';
    throw Object.assign(new Error(answer === null ? 'fatal: not a valid commit' : 'not an ancestor'), { status: answer === null ? 128 : 1 });
  };
  const works: Work[] = [], rows = new Map<string, Row>(), logs: string[] = [];
  const open = () => works.filter(work => work.actionQueue!.actions.length);
  const effects = controlPlaneEffects({ master: {}, daemon: await import('../src/master-daemon.js'), reviewer: {}, producer: {}, executor: {} } as never, {
    root, current: () => config, run, log: (line: string) => logs.push(line), clock: () => now,
    snapshot: async () => ({ work: open(), now: iso(now) }),
    mutate: async (path: string) => { const key = works.find(work => path === `work/${work.id}/deployment`)?.key; if (key) rows.get(key)!.deliveredAt = now; return {}; },
  });
  /** Production's endpoint, as the executor and the loop both read it. */
  const observe = (delivered: Work[]) => {
    const serving = delivered.filter(work => contains(work.delivery!.mergeSha, production.sha));
    return { source: 'endpoint', sha: production.sha, at: iso(now), reason: null, deployed: serving.map(work => work.key), pending: delivered.filter(work => !serving.includes(work)).map(work => work.key) } as never;
  };
  const handler = controlPlaneHandlers(() => config, {
    ...effects, ...(waits ? {} : { promotionWaitSuffix: undefined }),
    observeDeployment: async (delivered: Work[]) => observe(delivered),
  })['verify-deployment']!;
  const executor = { id: 'soak-executor', host: 'soak-host', principal: 'coordinator' };

  let promotion: PromotionState | null = null, merges = 0, attempts = 0, handoffs = 0, strandedSoaking = 0, movementChanges = 0, retainedChanges = 0;
  const record = { instances: [] as never[], open: {} as Record<string, string>, failing: {} as Record<string, string> };
  // The loop's own cursor and the effects `master run` hands runCycle here: the day's promotion reads, the snapshot of delivered
  // items, production's endpoint, the cursor persisted where the executor reads it. The plane's deployment record is not
  // modelled: a row is delivered when the executor's verify-deployment settles it.
  const daemon: DaemonState = { ...emptyDaemonState(config) } as DaemonState, seenInstances = new Set<string>();
  let invariantChecks = 0, cycles = 0;
  const loopEffects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: open(), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async (items: Work[]) => observe(items),
    recordDeployment: async () => {}, requestSmoke: () => {}, decisions: async () => ({ decisions: [] }),
    decide: async (work: Work, action: string) => { violations.push(`the loop decided ${action} on ${work.key}`); throw new Error('nothing is decided on this day'); },
    persist: async (state: DaemonState) => { await writeDaemonState(config, state); },
    promotion: reads,
    // The plane answers, so the faults step reads what master status adds after buildMasterStatus; of that report this day
    // raises only its stalled-action lines (stalledActionAttention, as master status derives them over the same snapshot).
    controlPlane: async () => ({ build: { commit: sha('plane') } }),
    reportedAttention: async (work: Work[], _status: unknown, observed: { now: string }) => ({ items: stalledActionAttention({ work, now: observed.now }) }),
  } as unknown as DaemonEffects;
  const filed: { subject: string; at: number; kind: string; text: string }[] = [];
  for (; now <= t0 + endsAt; now += intervalMs) {
    const into = now - t0;
    // Main moves with each merge; the merged item's verify-deployment row is requested at once, as next-action requests it.
    if (into > 0 && into < mergingUntil && into % mergeEveryMs < intervalMs && !inQuiet(into)) {
      const merge = sha(`merge-${++merges}`), key = `GY-${merges}`;
      index.set(merge, mainline.length); mainline.push(merge);
      const row = { id: `verify-${key}`, kind: 'verify-deployment', work: `id-${key}`, key, inputs: { kind: 'verify-deployment', mergeSha: merge, mergedAt: iso(now), state: 'done' },
        gate: 'merge', refusal: null, reason: `${key} merged as ${merge.slice(0, 12)} and no deployment carrying it has been observed`, binding: `delivery:${merge}`,
        requestedBy: 'graphyard', requestedAt: iso(now), state: 'pending', claim: null, attempts: 0, history: [] } as unknown as ActionRow;
      works.push({ ...delivered(key, merge, now), actionQueue: { actions: [row], history: [] } } as unknown as Work);
      rows.set(key, { key, merge, mergedAt: now, deliveredAt: null, stalledAt: null, attemptsAtEnd: null, servedAt: null, filed: 0, lastWait: null });
    }
    // The pipeline: a run concludes at the end of its validation, promoting its cut unless it fails; production serves a promotion a few minutes later.
    for (const run of dispatches) if (!run.concluded && now >= run.at + validationMs) {
      run.concluded = true;
      if (!run.fails && (!promoted || index.get(run.cut)! > index.get(promoted.sha)!)) promoted = { sha: run.cut, at: run.at + validationMs, lag: deployLags[promotions++ % deployLags.length] };
    }
    if (promoted && now >= promoted.at + promoted.lag && production.sha !== promoted.sha) {
      production.sha = promoted.sha; production.changes.push(now);
      for (const row of rows.values()) if (row.servedAt === null && contains(row.merge, production.sha)) row.servedAt = now;
    }
    // The loop: its promotion step, recorded on its cursor — the real cycle on the loop day.
    if (loop) {
      await runCycle(config, daemon, loopEffects, () => now); cycles++;
      promotion = daemon.promotion ?? null;
      for (const check of daemon.invariants.report as InvariantCheck[]) { invariantChecks++; if (!check.holds) violations.push(`+${into / minute} min: ${check.line}`); }
      for (const instance of daemon.faults.instances) if (!seenInstances.has(instance.id)) {
        seenInstances.add(instance.id);
        filed.push({ subject: instance.subject, at: now, kind: instance.kind, text: instance.text });
        if (rows.has(instance.subject)) rows.get(instance.subject)!.filed++;
        else violations.push(`+${into / minute} min: the loop filed ${instance.kind} on ${instance.subject}: ${instance.text}`);
      }
    } else {
      promotion = (await promotionCycle(promotion, reads, { now, everyMinutes: defaultPromoteEveryMinutes, intervalMs })).state;
      await writeDaemonState(config, { ...emptyDaemonState(config), promotion });
    }
    if ((promotion?.candidates?.length ?? 0) > promotionCandidatesListed) violations.push(`+${into / minute} min: the cursor lists ${promotion!.candidates!.length} candidates`);
    // The executor: every claimable row, claimed and settled through the queue.
    for (let claim = claimAction(open(), executor, new Date(now), { kinds: ['verify-deployment'] }); claim; claim = claimAction(open(), executor, new Date(now), { kinds: ['verify-deployment'] })) {
      attempts++;
      const outcome = await Promise.resolve().then(() => handler(claim.row, executor)).then(() => ({ result: 'done' as const, reason: 'observed' }), (error: Error) => ({ result: 'failed' as const, reason: error.message }));
      const row = rows.get(claim.work.key)!;
      if (outcome.result === 'failed' && contains(row.merge, production.sha)) violations.push(`${row.key}: failed while production serves its merge: ${outcome.reason}`);
      if (outcome.reason.includes(promotionWaitClause) && !waits) violations.push(`${row.key}: named the promotion wait with no promotion read`);
      // The deployment handoff: promoted, not served yet — the pipeline's pace, so the failure names the wait.
      const handoff = !!promoted && contains(row.merge, promoted.sha) === true && now - promoted.at < promotionHandoffMs;
      if (waits && outcome.result === 'failed' && handoff && !outcome.reason.includes(promotionWaitClause)) violations.push(`${row.key}: failed plainly while production deploys the promotion carrying it: ${outcome.reason}`);
      // Quiet: the newest candidate cut main's tip and failed, nothing carries the merge, and its soak may still run.
      const last = dispatches.at(-1);
      const stranded = !!last && last.concluded && last.fails && last.cut === mainline.at(-1) && !handoff && contains(row.merge, production.sha) !== true;
      // GY-1966: while the failed candidate's validation window stands the machinery is mid-cycle and
      // the failure names the wait; past it the pipeline has stopped moving and the failure stands plain.
      const inCycle = !!last && now < last.at + promotionWaitBoundMs;
      if (waits && stranded && inCycle && !outcome.reason.includes(promotionWaitClause)) violations.push(`${row.key}: stood plain while its failed candidate's validation window stood`);
      if (waits && stranded && !inCycle && outcome.reason.includes(promotionWaitClause)) violations.push(`${row.key}: named the promotion wait after the pipeline had stopped moving`);
      if (handoff && contains(row.merge, production.sha) !== true) handoffs++;
      if (stranded && inCycle) strandedSoaking++;
      // The rework of GY-1966: the wait names the pipeline's newest movement, so an attempt made
      // after a new cut names the new movement and the row's run of identical failures restarts
      // there. The same movement beside two attempts with a cut between them means a recorded
      // promotion or a stale candidate is pinning the text — B1, the defect that refiled GY-1904.
      if (waits && outcome.result === 'failed') {
        const movement = movementOf(outcome.reason);
        if (movement !== null) {
          if (row.lastWait && row.lastWait.cuts < dispatches.length) {
            if (row.lastWait.movement === movement) violations.push(`${row.key}: named ${movement} again after a new cut`);
            else {
              movementChanges++;
              // B1's state: the cursor retains an earlier promotion, and a cut made after it moved the wait.
              if (promotion?.promotedSha && promotion.promotedAt && Date.parse(promotion.promotedAt) < dispatches.at(-1)!.at) retainedChanges++;
            }
          }
          row.lastWait = { cuts: dispatches.length, movement };
        }
      }
      settleAction(claim.work, claim.row.id, { executor: executor.id, principal: executor.principal }, outcome.result, outcome.reason, new Date(now));
      if (outcome.result === 'done') {
        row.attemptsAtEnd ??= claim.row.attempts;
        claim.work.actionQueue!.history.push(claim.row); claim.work.actionQueue!.actions = [];
      }
    }
    // The loop's attention: what it lists as stalled is what it records as a fault.
    const attention = stalledActionAttention({ work: open(), now: iso(now) });
    for (const entry of attention) { const row = rows.get(entry.subject)!; if (row.stalledAt === null) { row.stalledAt = now; row.attemptsAtEnd ??= works.find(work => work.key === entry.subject)!.actionQueue!.actions[0].attempts; } }
    if (!loop) for (const instance of trackFaults(record, classifyAttention(attention), iso(now))) {
      filed.push({ subject: instance.subject, at: now, kind: instance.kind, text: instance.text });
      if (rows.has(instance.subject)) rows.get(instance.subject)!.filed++;
    }
  }
  return { rows: [...rows.values()], filed, violations, logs, attempts, dispatches, changes: production.changes, handoffs, strandedSoaking, movementChanges, retainedChanges, cycles, invariantChecks, daemon };
}

/** The days' invariants, whichever drives the loop's side: the component steps or the real cycle. */
function assertDays(day: Awaited<ReturnType<typeof simulate>>) {
  const { rows, filed, violations, logs, dispatches } = day;
  const at = (ms: number) => `+${Math.round((ms - t0) / minute)} min`;
  if (process.env.SOAK_TRACE) console.error(JSON.stringify({ rows: rows.length, attempts: day.attempts, dispatches: dispatches.map(run => `${run.id}@${at(run.at)}${run.fails ? ' fails' : ''}`), filed: filed.map(entry => `${entry.subject}@${at(entry.at)}`) }));
  assert.deepEqual(violations, [], 'no row fails once production serves its merge, no dispatch while a candidate validates, and the cursor stays bounded');
  assert.deepEqual(logs, [], 'the cursor was readable all day');
  assert.ok(day.handoffs >= 10, `attempts fell inside a deployment handoff and named the wait: ${day.handoffs}`);
  assert.ok(day.strandedSoaking >= 1, `attempts fell on a failed candidate whose validation window stood and named the wait: ${day.strandedSoaking}`);
  assert.ok(day.movementChanges >= 10, `attempts after a new cut name the new movement: ${day.movementChanges} cut-straddling attempt pairs agreed on the new movement`);
  assert.ok(rows.length >= 120, `merges landed all day: ${rows.length}`);
  assert.ok(dispatches.filter(run => run.fails).length >= 10 && dispatches.filter(run => !run.fails).length >= 30, `candidates promoted and failed and were re-cut: ${dispatches.length}`);

  // Delivered or stalled within the bound, whatever the pipeline did. The pipeline's demonstrated
  // movements — a candidate cut, a release production started serving — restart the row's unchanged
  // run (GY-1966), so the bound runs from the merge or the last such movement, whichever is later.
  for (const row of rows) {
    const end = Math.min(row.deliveredAt ?? Infinity, row.stalledAt ?? Infinity);
    const cuts = day.dispatches.map(run => run.at).filter(at => at < end);
    const from = Math.max(row.mergedAt, ...day.changes.filter(change => change < end), ...(cuts.length ? [cuts[cuts.length - 1]] : []));
    assert.ok(end - from <= settleBoundMs, `${row.key} merged ${at(row.mergedAt)}, last pipeline movement ${at(from)}, ended ${Number.isFinite(end) ? at(end) : 'never'}: within ${settleBoundMs / minute} min`);
    assert.ok(end - row.mergedAt <= settleBoundMs + promotionWaitBoundMs, `${row.key} merged ${at(row.mergedAt)} ended ${at(end)}: never more than two bounds after its merge`);
  }
  // A release served within the bound is the pipeline's ordinary pace: no stall, no filing, delivered at its next attempt.
  const paced = rows.filter(row => row.servedAt !== null && row.servedAt - row.mergedAt < promotionWaitBoundMs);
  assert.ok(paced.length >= rows.length * 0.8, `most merges rode a promoting candidate within the bound: ${paced.length} of ${rows.length}`);
  assert.deepEqual(paced.filter(row => row.stalledAt !== null || row.filed).map(row => `${row.key} merged ${at(row.mergedAt)} served ${at(row.servedAt!)} stalled ${row.stalledAt && at(row.stalledAt)}`), [], 'a wait the pipeline ended within the bound files nothing');
  for (const row of paced) assert.ok(row.deliveredAt! - row.servedAt! <= actionRetryMaxMs + minute, `${row.key} is delivered within one retry of being served`);
  assert.ok(rows.some(row => row.servedAt !== null && row.servedAt - row.mergedAt > validationMs * 2 && row.stalledAt === null), 'a merge carried past a failed candidate by the re-cut behind it waited without stalling');

  // The quiet stretches: the failed candidate's window closed on a pipeline nothing moves, so the merges it
  // carried stall and file as the release machinery's, then deliver once merges resume.
  const stranded = rows.filter(row => quiet.some(([from, to]) => row.mergedAt - t0 < from && (row.servedAt ?? Infinity) - t0 >= to));
  assert.ok(stranded.length >= 2, `merges were stranded on each quiet pipeline: ${stranded.map(row => row.key)}`);
  for (const row of stranded) {
    const kinds = filed.filter(entry => entry.subject === row.key).map(entry => entry.kind);
    assert.ok(row.stalledAt !== null && row.filed >= 1, `${row.key}, stranded on a stopped pipeline, stalls and files`);
    assert.ok(kinds.includes('production'), `${row.key} files as the release machinery's (GY-1966): ${[...new Set(kinds)].join(', ') || 'nothing'}`);
    assert.ok(!kinds.includes('stalled-action'), `${row.key} is not filed as a per-item stalled-action over a pipeline-held wait`);
    assert.ok(row.deliveredAt !== null, `${row.key} is delivered once merges resume and a candidate carries it`);
  }
  assert.deepEqual(filed.filter(entry => entry.text.includes(promotionWaitClause) && entry.at - rows.find(row => row.key === entry.subject)!.mergedAt < promotionWaitBoundMs).map(entry => entry.subject), [], 'no instance names the wait inside its bound');

  // Bounded: the attempts a row makes before it ends, and every row delivered by the day's end.
  const most = Math.max(...rows.map(row => row.attemptsAtEnd ?? 0));
  // The ceiling is what the widening backoff fits into the two-bound limit asserted above, plus the claim at each end.
  let ceiling = 1;
  for (let spent = 0, delay = actionRetryMinMs; spent + delay <= settleBoundMs + promotionWaitBoundMs; spent += delay, delay = Math.min(delay * 2, actionRetryMaxMs)) ceiling++;
  assert.ok(most <= ceiling, `a row makes at most ${ceiling} attempts, the backoff's fill of two bounds, before it is delivered or stalled: ${most}`);
  assert.ok(day.attempts <= rows.length * 20, `attempts over the days stay bounded per row: ${day.attempts} for ${rows.length} rows`);
  assert.deepEqual(rows.filter(row => row.deliveredAt === null).map(row => row.key), [], 'every row is delivered by the end of the days');
}

test('unit:soak-invariants-hold — GY-1831 and GY-1966: two simulated days of merges riding release candidates that promote, fail and are re-cut behind a moving main, and two quiet stretches: every verify-deployment row ends delivered or stalled within the promotion wait bound of the pipeline\'s last movement, a row its release served within the bound files no instance, a row left on a stopped pipeline files as the release machinery\'s, attempts stay bounded and every row is delivered once merges resume', { timeout: 600_000 }, async () => {
  assertDays(await simulate(true));
});

test('unit:soak-invariants-hold — GY-1966 through the real loop: the same two days with runCycle running every minute — its promotion step persisting the cursor the executor reads, after an earlier promotion is retained and while later candidates are dispatched, fail and are re-cut — and its own faults step filing what it lists: every attempt after a new cut names the new movement, every row ends within the bound of the pipeline\'s last movement, a stopped pipeline\'s rows file as the release machinery\'s and stay bounded, nothing else is filed, and every system invariant holds after every cycle', { timeout: 900_000 }, async () => {
  const day = await simulate(true, true);
  assertDays(day);
  assert.ok(day.cycles >= days * 24 * 60, `the loop cycled every minute of the days: ${day.cycles}`);
  assert.ok(day.invariantChecks >= day.cycles, `the loop judged the system invariants every cycle: ${day.invariantChecks} checks over ${day.cycles} cycles`);
  assert.ok(day.retainedChanges >= 10, `attempts after a cut made since the cursor's retained promotion named the cut, not the promotion: ${day.retainedChanges}`);
  const machinery = day.filed.filter(entry => entry.kind === 'production');
  assert.ok(machinery.length >= 2 && machinery.length <= day.rows.length, `a stopped pipeline's rows filed as the release machinery's, bounded by the rows: ${machinery.length}`);
});

test('unit:soak-invariants-hold — GY-1831: the same days without the promotion read, as the base ran them, stall and file the rows the pipeline was still carrying — the shape that filed GY-1827, GY-1828 and GY-1830', { timeout: 600_000 }, async () => {
  const base = await simulate(false), candidate = await simulate(true);
  assert.deepEqual(base.violations, []);
  const paced = (rows: Row[]) => rows.filter(row => row.servedAt !== null && row.servedAt - row.mergedAt < promotionWaitBoundMs);
  const baseFiled = paced(base.rows).filter(row => row.filed), candidateFiled = paced(candidate.rows).filter(row => row.filed);
  assert.ok(baseFiled.length >= paced(base.rows).length / 2, `at the base, most rows the pipeline delivered within the bound filed a stalled-action instance: ${baseFiled.length} of ${paced(base.rows).length}`);
  assert.deepEqual(candidateFiled.map(row => row.key), [], 'at the candidate none did');
  assert.deepEqual(base.rows.filter(row => row.deliveredAt === null).map(row => row.key), [], 'the base delivers them too, only later and after filing');
});
