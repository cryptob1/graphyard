/**
 * Timing assertions in required checks (GY-95): telling a required check that failed on a
 * timing-dependent assertion — a latency budget measured on a shared runner — from a regression,
 * from the annotations the CI `test` job publishes for every measurement it recorded.
 */
import { execFileSync } from 'node:child_process';
import { agentOwner, type AttentionItem } from '../master.js';
import { githubActionsAppId } from '../model/ci-proofs.js';
import { latestCheck } from '../merge-queue.js';
import type { Work } from '../model.js';
import type { MasterStatus } from './master-status.js';

/**
 * The title the CI `test` job gives every annotation it publishes for a timing-dependent assertion
 * (tests/helpers/timing.ts, GY-95). A failed budget is a `failure` annotation, a kept one a `notice`;
 * the message is the measurement: `ASSERTION: MEASURE pNN MEASUREDms over N samples (...) against a
 * BUDGETms budget[, X% over]`. The title is the contract between the two; the message is parsed
 * for the numbers and otherwise carried whole.
 */
export const timingAssertionTitle = 'timing assertion';

export interface CheckAnnotation { annotation_level: string; title?: string | null; message: string }
export interface TimingFinding { assertion: string; measure: string; statistic: string; measuredMs: number | null; budgetMs: number | null; passed: boolean; text: string }

/** The timing assertions among a check run's annotations, failed ones first. */
export function timingFindings(annotations: readonly CheckAnnotation[]): TimingFinding[] {
  return annotations.filter(annotation => annotation.title === timingAssertionTitle).map(annotation => {
    const parsed = /^(\S+): (.*?) (p[\d.]+) (\d+)ms over \d+ samples? .*? against a (\d+)ms budget/.exec(annotation.message);
    return { assertion: parsed?.[1] ?? annotation.message.split(':')[0], measure: parsed?.[2] ?? '', statistic: parsed?.[3] ?? '', measuredMs: parsed ? Number(parsed[4]) : null, budgetMs: parsed ? Number(parsed[5]) : null,
      passed: annotation.annotation_level !== 'failure', text: annotation.message };
  }).sort((a, b) => Number(a.passed) - Number(b.passed));
}

/** The check run's annotations, through the same `gh` the master already reads reviews and protection with. */
export function readCheckAnnotations(repository: string, checkId: number, run: (command: string, args: string[]) => string = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })): CheckAnnotation[] {
  const parsed = JSON.parse(run('gh', ['api', `repos/${repository}/check-runs/${checkId}/annotations?per_page=100`]));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * The required check a candidate is held on whose latest run failed and is identifiable: the one
 * whose annotations can say whether the failure was a timing assertion. A check still running, or
 * one the observation could not identify, has no annotations to read.
 */
export function failedRequiredCheck(work: Work, ciAppIds: readonly number[] = [githubActionsAppId]): { name: string; id: number; attempt: number | null } | null {
  const observation = work.observation;
  if (!observation || !work.candidate || observation.candidate.sha !== work.candidate.sha) return null;
  for (const name of work.policy.checks) {
    const latest = latestCheck(observation.checks.filter(check => check.name === name && ciAppIds.includes(check.appId)));
    if (latest && latest.result === 'failure' && latest.id !== undefined) return { name, id: latest.id, attempt: latest.attempt ?? null };
  }
  return null;
}

/** The re-run of exactly the failed job, and what to do when the artefact repeats. */
export const timingRerunCommand = (repository: string, check: { name: string; id: number }) => `gh run rerun --job ${check.id} --repo ${repository} re-runs the failed ${check.name} job on the same head; the next observation re-reads it. A budget missed on three consecutive runs is a regression to route to rework, never a budget to relax`;

/** The refusal line for a required check that failed on a timing assertion: what it measured, against which budget. */
export function timingFailureText(check: { name: string }, findings: readonly TimingFinding[]): string {
  const failed = findings.filter(finding => !finding.passed);
  return `Required CI check ${check.name} failed on ${failed.length === 1 ? 'a timing assertion, which measures' : `${failed.length} timing assertions, which measure`} the runner as much as the system: ${failed.map(finding => finding.text).join('; ')}`;
}

/**
 * Tell a required check that failed on a timing assertion from a regression (GY-95). For every open
 * candidate held on a failed required check whose run is identifiable, the check run's annotations
 * are read; when a timing assertion is among the failures the row's refusal and its attention say so,
 * with the measured value against the budget and the re-run as the next step, instead of the
 * unqualified `Required CI check test has not passed`. Every timing measurement the run published,
 * kept or not, is carried on the row as `timing`. A check that cannot be read leaves the row as it was.
 */
export function nameTimingFailures(status: MasterStatus, work: Work[], repository: string, read: (check: { name: string; id: number }) => CheckAnnotation[] | null, ciAppIds: readonly number[] = [githubActionsAppId]) {
  const rewritten = new Map<string, { previous: string | null; item: AttentionItem }>();
  let added = 0;
  const rows = status.work.map(row => {
    const item = work.find(candidate => candidate.key === row.key);
    const check = item && item.stage !== 'done' ? failedRequiredCheck(item, ciAppIds) : null;
    if (!check) return { ...row, timing: null };
    let annotations: CheckAnnotation[] | null = null;
    try { annotations = read(check); } catch { annotations = null; }
    if (!annotations) return { ...row, timing: null };
    const findings = timingFindings(annotations);
    const timing = { check: check.name, checkId: check.id, attempt: check.attempt, failures: findings.filter(finding => !finding.passed), measurements: findings };
    if (!timing.failures.length) return { ...row, timing };
    const text = timingFailureText(check, findings);
    const attention: AttentionItem = { subject: row.key, text, ...agentOwner('master', timingRerunCommand(repository, check)) };
    const unqualified = `Required CI check ${check.name} has not passed on the current candidate`;
    const refusal = row.refusal?.reason === unqualified ? { gate: row.refusal.gate, reason: text } : row.refusal;
    // An item held on a runner artefact is never left silent: the row gets the attention whether or
    // not it had dwelt long enough for the unqualified refusal to surface.
    if (row.attention === null || row.attention === unqualified) {
      if (row.attention === null) added++;
      rewritten.set(row.key, { previous: row.attention, item: attention });
      const { subject, text: attentionText, ...owner } = attention;
      return { ...row, refusal, attention: attentionText, attentionOwner: owner, timing };
    }
    return { ...row, refusal, timing };
  });
  const attentionItems = status.attentionItems.map(entry => {
    const rewrite = rewritten.get(entry.subject);
    return rewrite && entry.text === rewrite.previous ? rewrite.item : entry;
  });
  for (const [key, rewrite] of rewritten) if (!attentionItems.some(entry => entry.subject === key && entry.text === rewrite.item.text)) attentionItems.push(rewrite.item);
  return { ...status, work: rows, attentionItems, counts: { ...status.counts, attention: status.counts.attention + added },
    timing: { checked: rows.filter(row => row.timing).map(row => row.key), heldOnTiming: rows.filter(row => row.timing?.failures.length).map(row => row.key) } };
}
