// Concern: the recurring-intervention scan — when it runs, and the work item it opens for a kind at a stage that keeps recurring.
import { createHash } from 'node:crypto';
import type { Engine } from '../engine.js';
import type { Principal, Work } from '../model.js';
import { interventionKindLabel, type InterventionPattern, type InterventionPolicy } from '../model/interventions.js';
import { boundedSnapshot } from '../store/bounded-snapshot.js';
import { readInterventionLedger } from './ledger.js';
import { foldInterventions } from './fold.js';
import { detectPatterns, windowStart } from './report.js';

/**
 * Whether the server runs the pattern scan (GY-1372). On by default (GY-1381): the scan reads the
 * policy window through the (kind, created_at) index on the report pool and runs beside the
 * reconciliation tick, never in it (`startPatternScan`), so it no longer holds the tick as it did
 * on 2026-09-23. `GRAPHYARD_INTERVENTION_PATTERNS=0` turns it off. The interventions report
 * carries this state, so master status reads it rather than assuming.
 */
export const interventionScanVariable = 'GRAPHYARD_INTERVENTION_PATTERNS';
export const interventionScan = (env: NodeJS.ProcessEnv = process.env) => ({ enabled: env[interventionScanVariable]?.trim() !== '0', variable: interventionScanVariable });

/** How often the server runs the pattern scan: once a minute, as it did inside the tick. */
export const patternScanIntervalMs = 60_000;

/**
 * Run the pattern scan on its own timer beside the reconciliation tick (GY-1381), as the
 * production watch runs: the tick never awaits it, so a slow scan delays only the next scan and
 * never a claim, a heartbeat or an observation. One scan runs at a time; a scan still running when
 * the next is due is not doubled. The setting is read each time, so `=0` takes effect at once.
 */
export function startPatternScan(scan: () => Promise<void>, options: { intervalMs?: number; env?: NodeJS.ProcessEnv; failed?: (error: unknown) => void } = {}) {
  let running: Promise<void> | null = null, stopped = false;
  const run = () => {
    if (running || stopped || !interventionScan(options.env).enabled) return running;
    running = scan().catch(error => options.failed?.(error)).finally(() => { running = null; });
    return running;
  };
  const timer = setInterval(run, options.intervalMs ?? patternScanIntervalMs);
  timer.unref?.();
  return { stop: async () => { stopped = true; clearInterval(timer); await running; }, run, get running() { return running !== null; } };
}

/** The control plane acting as itself when it opens work from feedback; the ledger names it as every other control-plane write is named. */
export const controlPlaneActor: Principal = { id: 'graphyard', role: 'admin', sessionKind: 'ai' };
const minutes = (value: number) => `${Math.round(value / 60_000)} min`;

/**
 * A recurring intervention becomes work without a human noticing it (AC-3): a kind at a stage
 * that crossed the threshold inside the window opens one item naming the pattern, its frequency,
 * the items it affected and the attention it cost, and linking the instances as evidence. While
 * that item is open nothing is opened again for the pattern; instances an item already links
 * never count towards a second one.
 */
export async function openPatternItems(engine: Engine, policy: InterventionPolicy, options: { now?: string; actor?: Principal; limit?: number } = {}) {
  const snapshot = await boundedSnapshot(engine.store.reportPool);
  const now = options.now ?? snapshot.now;
  // Detection reads the policy window of the ledger and nothing older (GY-422).
  const { rows, truncated } = await readInterventionLedger(engine.store.reportPool, { limit: options.limit, since: windowStart(now, policy.windowDays) });
  const folded = foldInterventions(rows, snapshot.work, now);
  const opened: Work[] = [];
  for (const pattern of detectPatterns(folded.interventions, snapshot.work, policy, now)) {
    if (pattern.item || pattern.unlinked.length < policy.threshold) continue;
    const instances = pattern.unlinked;
    const items = [...new Set(instances.map(entry => entry.work?.key).filter((key): key is string => !!key))];
    const waitedMs = instances.reduce((total, entry) => total + entry.waitedMs, 0);
    const label = interventionKindLabel[pattern.kind], where = pattern.stage ? `the ${pattern.stage} stage` : 'no stage';
    const origin: InterventionPattern = { kind: pattern.kind, stage: pattern.stage, window: { from: pattern.from, to: now, days: policy.windowDays }, threshold: policy.threshold, count: instances.length, waitedMs, items,
      instances: instances.map(entry => ({ id: entry.id, work: entry.work?.key ?? null, requestedAt: entry.requestedAt, resolvedAt: entry.resolvedAt, waitedMs: entry.waitedMs, sources: entry.sources.slice(0, 20) })), detectedAt: now };
    const description = [
      `Graphyard opened this item itself: ${instances.length} ${label} interventions were needed at ${where} between ${pattern.from} and ${now} (threshold ${policy.threshold} in ${policy.windowDays} days). Every intervention is an admission that the product asked a person or a coordinator to do its job; this one recurs.`,
      `Frequency: ${instances.length} in ${policy.windowDays} days, ${(instances.length / policy.windowDays).toFixed(2)} per day. Attention cost: ${minutes(waitedMs)} waited in total, ${minutes(waitedMs / instances.length)} per intervention.`,
      `Items affected: ${items.length ? items.join(', ') : 'none named'}.`,
      'Instances (the evidence; each is read from the ledger rows it names):',
      ...instances.map(entry => `- ${entry.id}: ${entry.work?.key ?? 'no item'} — blocked ${entry.blocked}; waited ${minutes(entry.waitedMs)}${entry.resolvedBy ? `; resolved by ${entry.resolvedBy}` : '; still open'}${entry.resolution ? ` (${entry.resolution})` : ''}; ledger ${entry.sources.map(source => `${source.kind}#${source.seq}`).join(', ')}`),
      'Find what makes this intervention necessary and remove it, so the product handles the case itself.',
    ].join('\n\n');
    const stageSlug = pattern.stage ?? 'none';
    const key = `intervention-pattern:${pattern.kind}:${stageSlug}:${createHash('sha256').update(instances.map(entry => entry.id).sort().join(',')).digest('hex').slice(0, 32)}`;
    const work = await engine.execute(options.actor ?? controlPlaneActor, 'create', null, {
      title: `Recurring ${label} interventions at ${where}: ${instances.length} in ${policy.windowDays} days`.slice(0, 200), description: description.slice(0, 20000), type: 'bug', priority: 1,
      criteria: [{ id: 'AC-1', text: `The cause of the recurring ${label} interventions at ${where} is found and removed: the intervention report shows the ${pattern.kind} rate at ${where} below ${policy.threshold} per ${policy.windowDays} days after the change ships, and the linked instances could not recur`, proofs: [`manual:intervention-pattern-${pattern.kind}-${stageSlug}`] }],
      origin: { pattern: origin }, reason: `Recurring ${label} interventions at ${where} crossed the threshold (${instances.length} ≥ ${policy.threshold} in ${policy.windowDays} days)`,
    }, key);
    opened.push(work);
    snapshot.work.push(work);
  }
  return { opened, truncated };
}
