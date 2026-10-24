// Concern: the control-plane merge executor (GY-1524) — the serial queue, one merge's steps against the ledger, the leased deploy-key push and the reconcile of intents a crash left open.
import type { Work } from '../model.js';
import { riskOf } from '../model/risk-class.js';
import { mergeLedgerKinds, type MergeLedgerState } from '../model/merge-ledger.js';
import { trialFailurePrefix } from '../model/rework-ground.js';
import { parseFailedTests } from '../model/base-failure.js';
import { leadingProof } from '../model/flake-ledger.js';
import type { TrialFlaked } from '../model/merge-ledger.js';
import { defaultChildRun, type ChildRun } from '../child-runner.js';
import { runTrial, trialAttempts, TrialCleanupError, ansiEscape, type RunTrialInput, type TrialNoVerdict, type TrialNoVerdictOutcome, type TrialPhase, type TrialPhaseDurations, type TrialRun } from './trial.js';
import { previewFailureReason, type PreviewVerdict } from './preview.js';
import type { ItemPreview, PreviewSiteFile } from '../project-previews.js';

/**
 * A proof's cases in a TAP stream, attributed by title prefix, as `graphyard verify` counts them
 * (cli/verify.ts `countProofCases`, which this mirrors: the CLI module is not imported into the loop).
 */
export function countProofCases(tap: string, proof: string) {
  const title = new RegExp(`^${proof.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
  let executed = 0, failed = 0, skipped = 0;
  for (const line of tap.split('\n')) {
    const match = line.match(/^\s*(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/);
    if (!match || !title.test(match[2]!)) continue;
    if (match[3]) skipped++; else { executed++; if (match[1] === 'not ok') failed++; }
  }
  return { executed, failed, skipped };
}

// ---- The queue -----------------------------------------------------------------------------------

/**
 * When the item's current head was handed in. The pipeline timeline's resubmission or submission
 * when the snapshot carries it; the loop's coordination view drops that timeline, so there the
 * moment this very head was first observed (`headObserved`, set when the candidate changed) stands
 * in, then the candidate's creation, then the stage entry.
 */
export function submittedAtOf(item: Pick<Work, 'stageEnteredAt' | 'candidate' | 'headObserved'>): number {
  const pipeline = (item as { pipeline?: { submittedAt?: string | null; resubmittedAt?: string | null } }).pipeline;
  const observed = item.headObserved && item.candidate && item.headObserved.sha.toLowerCase() === item.candidate.sha.toLowerCase() ? item.headObserved.at : null;
  for (const at of [pipeline?.resubmittedAt, pipeline?.submittedAt, observed, item.candidate?.createdAt, item.stageEnteredAt]) if (at && Number.isFinite(Date.parse(at))) return Date.parse(at);
  return 0;
}

/** One queued control-plane candidate, oldest submission first. */
export interface QueuedMerge { key: string; id: string; head: string; submittedAt: string; waitingMs: number }
export interface MergeQueue {
  /** The candidate the writer merges next, or null: nothing is due, or an open intent blocks the queue. */
  next: Work | null;
  /** Every candidate due a merge, oldest first (`next` leading it), or none while an open intent blocks the queue: what a batch takes from (GY-2088). */
  due: Work[];
  queue: QueuedMerge[];
  /** The item whose open intent (or unreconciled push) holds the queue until it is reconciled; null when none does. */
  blockedBy: string | null;
}
const open = (state: MergeLedgerState) => state.state === 'intent' || state.state === 'pushed';
const gate = (item: Work, name: string) => item.gates.find(entry => entry.name === name)?.passed === true;

const createdAtOf = (item: Pick<Work, 'createdAt'>) => Date.parse(item.createdAt) || 0;
/** A hotfix (an item titled `Hotfix: …`) is merged before every other queued head, so a fix to a bottleneck never waits out the queue. */
export const isHotfix = (item: Pick<Work, 'title'>) => /^hotfix:/i.test(item.title ?? '');
/** The item the loop's base-failure step files for a failing base test (`baseFailureItem`'s title): it unblocks every held head, so it goes first too. */
export const isBaseRepair = (item: Pick<Work, 'title'>) => /^base branch \S+ fails .+ test: /i.test(item.title ?? '');
const mergesFirst = (item: Pick<Work, 'title'>) => isHotfix(item) || isBaseRepair(item);
/**
 * The trial-failure refusal the item's own record holds for its exact candidate head, or null: the
 * one fact that takes a head out of the queue (`mergeQueue`'s `trial failed` drop, GY-1524 AC-3)
 * and the ground of the rework releasing the head requires. The queue and the writer's rework debt
 * read the same record, so a head the queue drops is always a head whose rework is asked for
 * (requestPendingReworks re-derives the debt from here, GY-2166: the settlement that first owed a
 * refusal's rework lives only in memory, and the restart that kept the ledger lost it).
 */
export function trialRefusalHeld(candidate: Work['candidate'], state: MergeLedgerState | null | undefined): { reason: string } | null {
  const head = candidate?.sha.toLowerCase();
  return state && head && state.state === 'refused' && state.head === head
    && state.refusal?.kind === 'merge' && state.refusal.reason.startsWith(trialFailurePrefix)
    ? { reason: state.refusal.reason } : null;
}
/**
 * The control-plane candidates owed a merge, hotfixes and base-failure repairs first then the oldest item (by `createdAt`, ties by submission) first: submitted (a candidate the
 * control plane observed itself, GY-1523), not done, not returned to a worker, with the `build`
 * and `review` gates passed as the control plane served them: its review gate fails a sensitive delta until its
 * approval, and passes a normal one reviewed after merge (GY-1525). A head the writer's own
 * trial already refused (`trial failed`, GY-1524 AC-3) waits for its rework rather than a second
 * trial; one refused `base moved N times` is queued again. An item whose ledger holds an open intent
 * or an unreconciled push blocks the whole queue: `reconcileIntents` settles it before any new merge,
 * so never more than one merge is in flight.
 */
export function mergeQueue(work: readonly Work[], ledger: Readonly<Record<string, MergeLedgerState>>, now: number): MergeQueue {
  const blocking = Object.values(ledger).find(open);
  const owed = work.filter(item => {
    const candidate = item.candidate;
    if (item.stage === 'done' || !item.submission || !candidate || item.observation?.source !== 'control-plane' || item.reworkRequested || item.observation?.merged) return false;
    if (!gate(item, 'build')) return false;
    // The served review gate is the control plane's verdict under the deployment's policy, never this process's
    // own reading of graphyard.json, which an unapplied edit or an older checkout makes diverge (GY-1843).
    if (!gate(item, 'review')) return false;
    const state = ledger[item.key];
    if (trialRefusalHeld(candidate, state)) return false;
    if (state && state.head === candidate.sha.toLowerCase() && state.state === 'reconciled') return false;
    // GY-1834: a head held for a base failure waits `baseFailureHoldMs` before it is trialled again on whatever the tip then is.
    if (state && state.head === candidate.sha.toLowerCase() && state.state === 'refused' && state.refusal?.reason.startsWith(baseFailurePrefix) && state.intentAt && now - Date.parse(state.intentAt) < baseFailureHoldMs) return false;
    return true;
  // The oldest item first, by when it was filed, not by its latest submission: lead time runs from release, so a head
  // redone after a refusal goes ahead of newer work instead of rejoining at the back.
  }).sort((a, b) => Number(mergesFirst(b)) - Number(mergesFirst(a)) || createdAtOf(a) - createdAtOf(b) || submittedAtOf(a) - submittedAtOf(b) || a.key.localeCompare(b.key));
  const queue = owed.map(item => { const at = submittedAtOf(item); return { key: item.key, id: item.id, head: item.candidate!.sha.toLowerCase(), submittedAt: new Date(at).toISOString(), waitingMs: Math.max(0, now - at) }; });
  return { next: blocking ? null : owed[0] ?? null, due: blocking ? [] : owed, queue, blockedBy: blocking?.key ?? null };
}
/** The oldest-submitted candidate due a merge (hotfixes and base-failure repairs first), or null while nothing is due or an open intent blocks the queue (AC-1). */
export const nextToMerge = (work: readonly Work[], ledger: Readonly<Record<string, MergeLedgerState>>, now: number) => mergeQueue(work, ledger, now).next;

// ---- The ledger events the executor records --------------------------------------------------------

/** The per-proof outcome of a trial: how many of the proof's cases ran on the merge commit, and how many failed. */
export type ProofCounts = Record<string, { executed: number; failed: number }>;
/** The trial's verdict with the files it ran and the counts of every proof the item's criteria name. */
export interface MergeTrialRun extends TrialRun {
  files: string[]; proofs: ProofCounts; /** The trial checkout left behind when its removal failed (trial.ts TrialCleanupError); the verdict stands. */ leftover?: string;
  /**
   * GY-1834: the failing test files that passed on their immediate rerun of the same merge commit,
   * and the failing test names the first run reported that the rerun did not, none of them one of
   * the item's proofs: the verdict's failures are the rerun's.
   */
  flaked?: { files: string[]; tests: string[] };
  /**
   * GY-1834: the files still failing after the rerun that fail on the base tip (the tip the merge was made on) too,
   * with the test names the base run reported and the cases that failed the rerun: the failure is the base's
   * only when every such case fails on the base too (`failureIsBase`), not merely its file.
   */
  base?: { tip: string; files: string[]; tests: string[]; cases: string[];
    /** GY-2954: the crashed process the base run's output names — the run's database died under it — bounded. */ crash?: string;
    /** GY-2954: the first failing case's assertion text in the base run's TAP, bounded. */ assertion?: string };
}
/** GY-1834: the flake a trial record carries, bounded as the record's schema bounds it: every name `parseFailedTests` keeps (≤ 500 characters) fits. */
export const trialFlaked = (flaked: { files: readonly string[]; tests: readonly string[] }, at: string): TrialFlaked =>
  ({ files: flaked.files.slice(0, 100), tests: flaked.tests.slice(0, 100), at });
/** What `POST /api/work/:id/merge-record` takes: one of the five steps, with its ledger payload. */
export type MergeRecordEvent =
  | { kind: 'intent'; head: string; baseTip: string; mergeSha: string; risk: string; at: string }
  | { kind: 'trial'; head: string; baseTip: string; mergeSha: string; outcome: 'verdict'; build: 'pass' | 'fail'; tests: TrialRun['tests']; files: string[]; proofs: ProofCounts; durationMs: number;
    /** Each phase's time (GY-1832), and the attempts before the verdict that reached none, oldest first. */ phases?: TrialPhaseDurations; attempts: TrialNoVerdict[];
    /** The preview's verdict (GY-1718), when the passing trial was previewed. */ preview?: PreviewVerdict;
    /** GY-1834: the trial's flake, kept on the item's merge ledger so the flake ledger reads it after any restart. */ flaked?: TrialFlaked }
  /**
   * A trial that reached no verdict on its retry either (GY-1832): its final outcome, the phase and
   * reason, the phases' times and every attempt. It carries no proofs, so the ledger fold keeps no
   * trial for it; the intent it leaves open is refused and the head queued again by the next cycle.
   */
  | { kind: 'trial'; head: string; baseTip: string; mergeSha: string; outcome: TrialNoVerdictOutcome; phase: TrialPhase; reason: string; phases: TrialPhaseDurations; attempts: TrialNoVerdict[]; durationMs: number }
  | { kind: 'pushed'; mergeSha: string; pushedAt: string }
  | { kind: 'reconciled'; mergeSha: string; observedTip: string }
  | { kind: 'refused'; head: string; reason: string };
/**
 * GY-1902: an item preview's record (project-previews.ts), written through the same coordinator
 * route and record port as the ledger's steps; it moves no merge state and is no ledger event, so
 * it stays outside `MergeRecordEvent` and rides the port as `previewRecordEvent` makes it.
 */
export interface PreviewRecordEvent { kind: 'preview'; preview: ItemPreview; site?: PreviewSiteFile[] }
export const previewRecordEvent = (preview: ItemPreview, site?: PreviewSiteFile[]) => ({ kind: 'preview', preview, ...(site ? { site } : {}) } satisfies PreviewRecordEvent) as unknown as MergeRecordEvent;
const previewEvent = (event: MergeRecordEvent): PreviewRecordEvent | null => (event as { kind: string }).kind === 'preview' ? event as unknown as PreviewRecordEvent : null;
/** The ledger kind each recorded step writes; `trial` is the executor's own record beside the ledger, which the fold ignores. */
export const mergeRecordKinds = { ...mergeLedgerKinds, trial: 'merge.trial' } as const;
/**
 * GY-1852: the attempt a record belongs to: an id the loop persists before the attempt's first
 * write, and the write's place in it. A retry of that write replays its exact first input under the
 * same key; any new attempt has a new id, so no key is ever sent again with other input.
 */
export interface MergeAttempt { id: string; write: number }
/**
 * The idempotency key one step keeps across retries. Under an attempt (GY-1852) it is the item, the
 * attempt id, the write's place in it and the step. Without one (a caller that names none) it is the
 * item, the step and the commits it names; an intent, trial or refusal also names the ledger it
 * started from (its event count, GY-1718).
 */
export const mergeRecordKey = (work: Pick<Work, 'id'> & { mergeLedger?: Pick<MergeLedgerState, 'events'> | null; mergeAttempt?: MergeAttempt | null }, event: MergeRecordEvent) => {
  // A preview's record is keyed by the preview and its state: a retry replays it, a later state is a new write.
  const preview = previewEvent(event);
  if (preview) return `preview-record:${work.id}:${preview.preview.id}:${preview.preview.state}`;
  if (work.mergeAttempt) return `merge-record:${work.id}:${work.mergeAttempt.id}:${work.mergeAttempt.write}:${event.kind}`;
  if (event.kind === 'pushed' || event.kind === 'reconciled') return `merge-record:${work.id}:${event.kind}:${event.mergeSha}`;
  const attempt = work.mergeLedger?.events ? `#${work.mergeLedger.events}` : '';
  return `merge-record:${work.id}:${event.kind}:${event.head}:${'baseTip' in event ? event.baseTip : 'refused'}${attempt}`;
};
/** Whether a record write failed because the server already holds its key with other input: replaying it can never succeed. */
export const keyReusedRefusal = (error: unknown) => /Idempotency key reused with different input/.test(error instanceof Error ? error.message : String(error));

/** The refusal a failed trial records: the conflicting paths, the failing build step, or the failing test files (AC-3). */
export function trialFailureReason(trial: { conflict?: readonly string[]; run?: Pick<TrialRun, 'build' | 'tests' | 'failingCase' | 'timedOut'> | null }): string | null {
  if (trial.conflict?.length) return `${trialFailurePrefix}: the merge conflicts in ${trial.conflict.slice(0, 20).join(', ')}`;
  const run = trial.run;
  if (!run) return `${trialFailurePrefix}: the trial reached no verdict`;
  if (run.build === 'fail') return `${trialFailurePrefix}: build step npm run build`;
  if (run.tests.failed.length) {
    // GY-2960: a repository check names its failing files; timed-out-only failures say so, else the first case rides after the files.
    const files = run.tests.failed.slice(0, 20).join(', ');
    if (run.timedOut) return `${trialFailurePrefix}: tests ${files} timed out`;
    if (run.failingCase) return `${trialFailurePrefix}: tests ${files}: ${run.failingCase}`;
    return `${trialFailurePrefix}: tests ${files}`;
  }
  return null;
}
/**
 * GY-1834: the refusal of a head whose every failing test file fails on the base tip too. It grounds
 * no rework (it does not start `trialFailurePrefix`) and leaves the head queued, held
 * `baseFailureHoldMs`; the loop's base-failure step files the fix item from it.
 */
export const baseFailurePrefix = 'base failure';
export const baseFailureHoldMs = 30 * 60_000;
/** Up to 20 of `entries` joined by `separator` within `budget` characters: whole entries only, the first cut to the budget when it alone exceeds it. */
function boundedList(entries: readonly string[], separator: string, budget: number): string {
  const kept: string[] = [];
  let length = 0;
  for (const entry of entries.slice(0, 20)) {
    const next = length + (kept.length ? separator.length : 0) + entry.length;
    if (next > budget) break;
    kept.push(entry); length = next;
  }
  return kept.length || !entries.length ? kept.join(separator) : entries[0]!.slice(0, budget);
}
/**
 * How much of the crashed-process line and the assertion text the reason carries: enough to read
 * the cause, small enough that the files and tests keep their share of the 2,000 characters.
 */
const crashDetailBound = 240;
/**
 * The line in a base run's output that names the process whose crash took the run's database down
 * (GY-2954): systemd-coredump's `Process <pid> (postgres) of user 1000 dumped core` as the journal
 * words it, or the database's own PANIC — a journal or log timestamp ahead of it does not ride,
 * nor any line that merely starts `Process 123`. Null when the output names none: the base failed
 * its cases some other way.
 */
export function crashedProcessLine(output: string | null | undefined): string | null {
  for (const raw of (output ?? '').split('\n')) {
    const line = raw.replace(ansiEscape, '').replace(/^\S+\s+\d+\s+\d+:\d+:\d+\s+\S+\s+/, '').replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*/, '').trim();
    const at = line.search(/\bProcess \d+ \([^)]*\) of user \d+ dumped core\b|\bPANIC:/);
    if (at >= 0) return line.slice(at).slice(0, crashDetailBound);
  }
  return null;
}
/**
 * The first failing case's assertion text in a base run's TAP: the `error:` or `message:` field of
 * the first `not ok` entry that is no file-level failure, bounded (GY-2954). Null when the TAP
 * names none.
 */
export function firstFailingAssertion(tap: string): string | null {
  const lines = tap.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const entry = /^not ok \d+ - (.+?)(?:\s+#\s+(?:TODO|SKIP)\b.*)?$/i.exec(lines[index]!.replace(ansiEscape, '').trim());
    if (!entry || /^tests\/[\w./-]+\.test\.ts$/.test(entry[1]!)) continue;
    for (let next = index + 1; next < lines.length && lines[next]!.trim() !== '...'; next++) {
      const raw = lines[next]!.replace(ansiEscape, '');
      const field = /^\s*(?:error|message): (.*?)\s*$/.exec(raw);
      if (!field) continue;
      const inline = field[1]!.replace(/^'(.*)'$/, '$1');
      if (inline && inline !== '|-' && inline !== '|') return inline.replace(/\\'/g, "'").slice(0, crashDetailBound);
      // A block scalar (`error: |-` or `|`): node's TAP reporter writes multi-line assertion messages
      // that way, the text on the lines indented past the field's own — the first non-empty is it.
      const indent = raw.length - raw.trimStart().length;
      for (let block = next + 1; block < lines.length; block++) {
        const line = lines[block]!.replace(ansiEscape, '');
        if (!line.trim()) continue;
        if (line.length - line.trimStart().length <= indent) break;
        return line.trim().slice(0, crashDetailBound);
      }
    }
  }
  return null;
}
/** The reason's segment introducing the base run's own report (GY-2954), which `parseBaseFailureReason` cuts the tests at. */
const baseFailureDetailLead = ' — base run: ';
const crashDetailLead = 'crashed process: ';
const assertionDetailLead = 'first failing case: ';
/**
 * The reason stays within 2,000 characters by bounding its file and test lists, never by cutting
 * the whole string: the base tip and the `too` that `parseBaseFailureReason` reads always survive.
 * The base run's own report rides after the tests, each part labeled for what it is — the crashed
 * process line only when the run's output names a crash, the first failing case's assertion only
 * when the TAP names one (GY-2954) — and the lists make room for them.
 */
export const baseFailureReason = (base: { tip: string; files: readonly string[]; tests: readonly string[]; crash?: string | null; assertion?: string | null }) => {
  const detail = [base.crash ? `${crashDetailLead}${base.crash}` : null, base.assertion ? `${assertionDetailLead}${base.assertion}` : null].filter(Boolean).join('; ');
  const budget = detail ? 550 : 900;
  const files = boundedList(base.files, ', ', budget), tests = boundedList(base.tests, '; ', budget);
  return `${baseFailurePrefix}: tests ${files} fail on the base tip ${base.tip} too${tests ? `: ${tests}` : ''}${detail ? `${baseFailureDetailLead}${detail}` : ''}`;
};
/** The base tip, failing files and test names a `baseFailureReason` names, with the labeled crash and assertion detail when it rides, or null for any other reason. */
export function parseBaseFailureReason(reason: string): { tip: string; files: string[]; tests: string[]; crash?: string; assertion?: string } | null {
  const match = /^base failure: tests (.+?) fail on the base tip ([0-9a-f]{40}) too(?:: (.*))?$/s.exec(reason);
  if (!match) return null;
  const all = match[3] ?? '', at = all.indexOf(baseFailureDetailLead);
  const tests = at < 0 ? all : all.slice(0, at);
  const detail = at < 0 ? '' : all.slice(at + baseFailureDetailLead.length);
  const atAssertion = detail.indexOf(`; ${assertionDetailLead}`);
  const crash = detail.startsWith(crashDetailLead)
    ? atAssertion < 0 ? detail.slice(crashDetailLead.length) : detail.slice(crashDetailLead.length, atAssertion)
    : undefined;
  const assertion = atAssertion < 0
    ? detail.startsWith(assertionDetailLead) ? detail.slice(assertionDetailLead.length) : undefined
    : detail.slice(atAssertion + `; ${assertionDetailLead}`.length);
  return { tip: match[2]!, files: match[1]!.split(', '), tests: tests ? tests.split('; ') : [], ...(crash ? { crash } : {}), ...(assertion ? { assertion } : {}) };
}
/**
 * GY-1834: whether a trial's failure is the base's: build and merge passed, every failing test file
 * failed again on its rerun and on the base tip, and every case that failed the rerun failed on the
 * base tip too: a file whose rerun fails case A while the base fails only case B of it is the head's.
 * A failing proof file never is: it is always the head's.
 */
export const failureIsBase = (run: Pick<MergeTrialRun, 'build' | 'tests' | 'base'>) =>
  run.build === 'pass' && run.tests.failed.length > 0 && !!run.base && run.tests.failed.every(file => run.base!.files.includes(file))
  && run.base.cases.length > 0 && run.base.cases.every(test => run.base!.tests.includes(test));

/** The refusal of a head whose push the base tip moved under `times` times (AC-3); it leaves the head queued. */
export const baseMovedReason = (times: number) => `base moved ${times} times`;
/** The refusal of a push the remote rejected while the base tip stood still: not a moved tip, so no re-trial; the head stays queued for a later cycle. */
export const unmovedTipReason = (base: string, baseTip: string) => `push rejected though ${base} still stood at ${baseTip.slice(0, 12)}`;
/** The refusal of an intent a crash left open whose merge commit the base does not hold: the head is queued again (AC-5). */
export const unpushedIntentReason = (mergeSha: string, base: string) => `intent ${mergeSha.slice(0, 12)} was never pushed: ${base} does not hold it, so the head is queued again`;

// ---- The push --------------------------------------------------------------------------------------

/** The SSH command the push child runs: the deploy key alone, no agent identities, new hosts accepted on first contact. */
export const deployKeySshCommand = (deployKeyFile: string) => `ssh -i ${deployKeyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
/**
 * The variables the push child inherits, and nothing else (AC-2): what `git` and `ssh` need to find
 * their binaries, the known-hosts file and a locale. An allowlist, not a denylist: a credential
 * under any other name (GIT_ASKPASS, AWS_SECRET_ACCESS_KEY, GH_ENTERPRISE_TOKEN, …) never reaches it.
 */
export const pushInheritedVariables = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR'] as const;
/**
 * The push child's environment (AC-2): the allowlisted variables above, git's global and system
 * configuration off, no terminal prompt, and the one credential, the deploy key, as GIT_SSH_COMMAND.
 */
export function pushEnvironment(deployKeyFile: string, environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept = Object.fromEntries(pushInheritedVariables.flatMap(name => typeof environment[name] === 'string' ? [[name, environment[name]!] as const] : []));
  return { ...kept, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: deployKeySshCommand(deployKeyFile) };
}
/** `git push origin --force-with-lease=refs/heads/BASE:<baseTip> <mergeSha>:refs/heads/BASE`: the merge commit lands only on the tip it was tested on. */
export const pushArgs = (base: string, baseTip: string, mergeSha: string) => ['push', 'origin', `--force-with-lease=refs/heads/${base}:${baseTip}`, `${mergeSha}:refs/heads/${base}`];
/**
 * Whether a failed push was rejected because the tip moved under its lease: git words exactly that
 * `! [rejected] … (stale info)`. A remote's own refusal (`! [remote rejected] … (protected branch
 * hook declined)`), a non-fast-forward without a lease or a transport failure is no stale lease,
 * and never enters the re-trial path (AC-3).
 */
export const staleLeaseRejection = (output: string) => /\bstale info\b/i.test(output);

/**
 * GY-2940: a failed push whose message stops at `Command failed: git … push …` gains git's stderr
 * (first 300 chars), so the 'failed before it was recorded' line the loop records and logs names
 * the cause. The error is thrown as it came — same object, its stdout, stderr and status intact —
 * with only the message extended; one that already carries the stderr, or a push with none, is
 * left alone.
 */
export function pushFailureWithStderr(error: unknown): Error {
  const failed = error as { message?: unknown; stderr?: unknown };
  const stderr = typeof failed.stderr === 'string' ? failed.stderr.trim().slice(0, 300) : '';
  if (error instanceof Error && stderr && typeof failed.message === 'string' && !failed.message.includes(stderr)) error.message = `${failed.message}: ${stderr}`;
  return error instanceof Error ? error : new Error(String(error));
}

/** Whether the base branch's first-parent history holds `sha`, exactly and unbounded (AC-5): trial.ts's walk, which the trial merge shares. */
export { firstParentHolds } from './trial.js';

// ---- The trial on the merged tree ------------------------------------------------------------------

/** The unit and integration proofs the item's criteria name: the ones whose cases a test file can carry. */
export const criterionProofs = (work: Pick<Work, 'criteria'>) => [...new Set(work.criteria.flatMap(criterion => criterion.proofs.filter(proof => /^(unit|integration):/.test(proof))))];

/**
 * Every test file in the merge commit whose source names one of `proofs`, read from the object store
 * (`git grep` at the commit), so the trial runs the criterion→test bindings whatever the affected
 * selection says. No match is no file, never an error.
 */
export async function proofTestFiles(run: ChildRun, root: string, mergeSha: string, proofs: readonly string[], options?: { timeoutMs?: number }): Promise<string[]> {
  if (!proofs.length) return [];
  let out: string;
  try { out = String(await run('git', ['-C', root, 'grep', '-l', '-F', ...proofs.flatMap(proof => ['-e', proof]), mergeSha, '--', 'tests/*.test.ts'], options?.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs })); }
  catch (error) {
    // Exit 1 is no match; anything else is a read the trial cannot do without.
    if ((error as { status?: number | null }).status === 1) return [];
    throw error;
  }
  return [...new Set(out.split('\n').map(line => line.trim()).filter(Boolean).map(line => line.slice(line.indexOf(':') + 1)).filter(path => /^tests\/[\w./-]+\.test\.ts$/.test(path)))].sort();
}

export interface MergeTrialInput extends RunTrialInput {
  /** The item's `unit:`/`integration:` proof ids, counted per proof from the TAP stream. */
  proofs: readonly string[];
  /** The test files those proofs' cases live in (`proofTestFiles`), run beside the affected selection. */
  proofFiles: readonly string[];
  /** GY-1834: false skips the rerun of failing files and their run on the base tip; on by default. */
  attribute?: boolean;
  /** The tip the merge was made on, where the base run of GY-1834 runs: a fast-forwarded head's first parent is its own earlier commit, never the tip. Absent, the merge commit's first parent. */
  baseTip?: string;
  /**
   * How to discover more of them, run in each attempt's selection phase until one answers (GY-1832),
   * so a read that fails or times out is that attempt's no-verdict, timed and retried like any host failure.
   */
  discoverProofFiles?: (options: { timeoutMs?: number }) => Promise<readonly string[]>;
}
const runner = 'tests/helpers/run-tests.ts';
const listed = (out: string) => out.split('\n').map(line => line.trim()).filter(line => /^tests\/[\w./-]+\.test\.ts$/.test(line));
const childOutput = (error: unknown) => { const failed = error as { stdout?: unknown; stderr?: unknown }; return `${typeof failed.stdout === 'string' ? failed.stdout : ''}${typeof failed.stderr === 'string' ? failed.stderr : ''}`; };

/**
 * The trial (trial.ts `runTrial`) on the merge commit, with the test selection
 * widened to the files carrying the item's proofs and the run reported as TAP, so the verdict counts
 * each proof's executed and failed cases (AC-2). The child runner is decorated, never the trial:
 * the affected selection (`scripts/ci-tests.mjs affected`, or the `select` fallback an older merge
 * needs) gains the proof files it lacks, and every shard's test run gets the TAP reporter on stdout,
 * which `runTrial` still reads its failing files from; the proofs are counted over all the shards.
 */
export async function runMergeTrial(input: MergeTrialInput): Promise<MergeTrialRun> {
  const inner = input.run ?? defaultChildRun;
  let tap = '', files: string[] = [], only: string[] | null = null;
  const widened = (out: string, proofFiles: readonly string[]) => {
    // GY-1834: a rerun, or the run on the base tip, runs exactly the failing files.
    if (only) return `${only.join('\n')}\n`;
    const have = listed(out);
    // A `full:` selection that lists nothing hands over to `select`; the files are added to that run instead.
    if (!have.length && /^full:/.test(out.trimStart())) return out;
    const extra = proofFiles.filter(path => !have.includes(path));
    files = [...have, ...extra];
    return extra.length ? `${out.replace(/\s+$/, '')}\n${extra.join('\n')}\n` : out;
  };
  // The trial's shards run beside each other (GY-1832), so their TAP streams are joined: each proof's
  // cases are counted over every shard, as one runner process would count them. A retried trial runs
  // in a fresh checkout, and only the attempt that answered is counted: each attempt starts its TAP
  // and files afresh, even one that stops before its tests run, and a runner child of an earlier attempt adds nothing.
  let epoch = 0, discovered: readonly string[] | null = input.discoverProofFiles ? null : input.proofFiles;
  // A discovery that fails is a host failure of the selection (its `cause` set), never a failing selection: the attempt ends with no verdict and is retried.
  const proofFiles = async (options: { timeoutMs?: number } | undefined) => {
    if (discovered || !input.discoverProofFiles) return discovered ?? input.proofFiles;
    try { const found = await input.discoverProofFiles({ timeoutMs: options?.timeoutMs }); return discovered = [...new Set([...input.proofFiles, ...found])]; }
    catch (error) {
      const failed = error as { message?: string; timedOut?: boolean; stdout?: unknown; stderr?: unknown };
      throw Object.assign(new Error(`could not discover the proof test files: ${String(failed.message ?? error)}`), { status: null, signal: null, timedOut: failed.timedOut, stdout: failed.stdout, stderr: failed.stderr, cause: `could not discover the proof test files: ${String(failed.message ?? error).slice(0, 300)}` });
    }
  };
  const capture = async (invoke: () => ReturnType<ChildRun>) => {
    const own = epoch;
    try { const out = String(await invoke()); if (own === epoch) tap += `${out}\n`; return out; }
    catch (error) { if (own === epoch) tap += `${childOutput(error)}\n`; throw error; }
  };
  const run: ChildRun = async (command, args, options) => {
    if (command === 'node' && args[0] === 'scripts/ci-tests.mjs' && (args[1] === 'affected' || args[1] === 'select')) { const files = await proofFiles(options); return widened(String(await inner(command, args, options)), files); }
    const at = command === 'node' ? args.indexOf(runner) : -1;
    if (at >= 0) {
      return capture(() => inner(command, [...args.slice(0, at + 1), '--test-reporter=tap', '--test-reporter-destination=stdout', ...args.slice(at + 1)], options));
    }
    // GY-2960: a repository check's npm test/typecheck output is the TAP the base-failure attribution reads for cases.
    if (command === 'npm' && (args[0] === 'test' || (args[0] === 'run' && (args[1] === 'test' || args[1] === 'typecheck')))) {
      return capture(() => inner(command, args, options));
    }
    return inner(command, args, options);
  };
  const counted = (): ProofCounts => Object.fromEntries(input.proofs.map(proof => { const { executed, failed } = countProofCases(tap, proof); return [proof, { executed, failed }]; }));
  let verdict: TrialRun, leftover: string | undefined;
  const onAttempt = (index: number) => { epoch++; tap = ''; files = []; input.onAttempt?.(index); };
  try { verdict = await runTrial({ ...input, run, onAttempt }); }
  catch (error) {
    // A checkout that would not go is reported beside the verdict it reached, not in place of it.
    if (error instanceof TrialCleanupError && error.verdict) { verdict = error.verdict; leftover = error.message; }
    else throw error;
  }
  const first: MergeTrialRun = { ...verdict, files, proofs: counted(), ...(leftover ? { leftover } : {}) };
  if (input.attribute === false) return first;
  // A rerun's attempts start their TAP afresh like the trial's, so each run reads only its own answering attempt.
  const rerunAttempt = () => { epoch++; tap = ''; };
  // The proof files the selection discovered are held like those the input named.
  return attributeFailures(first, tap, { ...input, proofFiles: discovered ?? input.proofFiles }, inner, async (sha, failing) => {
    only = failing;
    try { const rerun = await runTrial({ ...input, mergeSha: sha, changedFiles: failing, run, onAttempt: rerunAttempt }); return { run: rerun, tap }; }
    catch (error) { return error instanceof TrialCleanupError && error.verdict ? { run: error.verdict, tap } : null; }
  });
}

/**
 * GY-2960: base-tip check results reused for every head that fails the same tip (and files) during
 * this process — the repository-check path has no per-file selection, so the same tip's run answers
 * every head that hits it. Only a usable verdict is stored; a null or build-failure miss is retried
 * on the next candidate so a transient checkout/install/runner failure cannot pin a false head blame.
 */
const baseTipCheckCache = new Map<string, { run: TrialRun; tap: string }>();
/** Clears the base-tip check cache (tests that mock the same tip with different outcomes). */
export const clearBaseTipCheckCache = () => baseTipCheckCache.clear();
/**
 * GY-1834: who a trial's failing test files are charged to. A proof file in which one of the item's
 * proof cases failed is never set aside: it stays failing, and so does every proof file of a run
 * that named no failing case. Every failing file is run once more on the same merge commit; a file
 * that passes there is a flake, the verdict is the rerun's, and the cases that failed only once,
 * none of them the item's proofs, are the flake the trial record carries to the flake ledger. Unless
 * a file is held or the rerun failed a proof case, files that fail again are run on the base tip (`input.baseTip`, else the merge commit's first parent);
 * those that fail there too, with every case the rerun failed failing there too, are the base's (`failureIsBase`). Nothing is skipped: a file that fails
 * on the head and passes on the base stays the head's failure, and a rerun or base run that could
 * not reach a verdict attributes nothing.
 *
 * GY-2960: whole-repository checks re-run the entire check (no per-file selection). A rerun may fail
 * files the first run never named; those stay on the verdict so an empty intersection cannot clear a
 * still-failing head (trialFailureReason ignores runnerExit).
 */
export async function attributeFailures(first: MergeTrialRun, firstTap: string, input: MergeTrialInput, git: ChildRun,
  retest: (sha: string, files: string[]) => Promise<{ run: TrialRun; tap: string } | null>): Promise<MergeTrialRun> {
  const failed = first.tests.failed.filter(file => /^tests\/[\w./-]+\.test\.ts$/.test(file));
  if (first.build !== 'pass' || !failed.length || failed.length !== first.tests.failed.length) return first;
  const own = (test: string) => { const proof = leadingProof(test); return !!proof && input.proofs.includes(proof); };
  // A runner's file-level line (`not ok N - tests/x.test.ts`) names the file, not a case: only cases are named.
  // GY-2960: a repository check may leave its cases only on the verdict's logTail when TAP was not injected.
  const casesOf = (tap: string, fallback = '') => parseFailedTests(tap || fallback).filter(name => !/^tests\/[\w./-]+\.test\.ts$/.test(name));
  const named = casesOf(firstTap, first.logTail);
  // A proof file is held only for a failing proof case of the item in it (or when the run named no case at all):
  // an unrelated case failing beside the proofs, in that file or another proof file, is attributed like any other file's.
  // A failing proof case whose file the TAP does not name holds every failing proof file.
  const fileOf = caseFiles(firstTap, failed), ownFiles = named.filter(own).map(test => fileOf.get(test));
  const held = !named.length || ownFiles.includes(undefined) ? failed.filter(file => input.proofFiles.includes(file))
    : failed.filter(file => ownFiles.includes(file));
  // Every file held, or every case named one of the item's proofs: the failure is the head's as it stands. The rerun is
  // still owed when a case that is none of the item's proofs failed beside them, so its flake is filed while the head stays held.
  if ((held.length === failed.length || named.some(own)) && !named.some(test => !own(test))) return first;
  // Every failing file reruns, held ones too, so the rerun names each case that failed only once.
  const rerun = await retest(input.mergeSha, failed).catch(() => null);
  if (!rerun || rerun.run.build !== 'pass') return first;
  const again = new Set(casesOf(rerun.tap, rerun.run.logTail));
  // A file whose rerun fails one of the item's proofs is the head's too: it is never the base's.
  const ownAgain = [...again].some(own);
  // Original files that still fail, plus any new failure the whole-check rerun observed (selection
  // reruns cannot introduce files outside `failed`; repository checks can).
  const still = [
    ...failed.filter(file => !held.includes(file) && rerun.run.tests.failed.includes(file)),
    ...rerun.run.tests.failed.filter(file => !failed.includes(file) && !held.includes(file)),
  ];
  const flakedFiles = failed.filter(file => !held.includes(file) && !still.includes(file));
  const flakedTests = named.filter(test => !again.has(test) && !own(test));
  let result: MergeTrialRun = { ...first, tests: { ...first.tests, failed: [...held, ...still], passed: first.tests.passed + flakedFiles.length } };
  if (flakedFiles.length || flakedTests.length) {
    result.flaked = { files: flakedFiles, tests: flakedTests };
    if (!still.length && !held.length) result = { ...result, runnerExit: rerun.run.runnerExit ?? 0 };
  }
  if (!still.length || held.length || ownAgain) return result;
  let tip: string;
  try { tip = input.baseTip ?? String(await git('git', ['-C', input.root, 'rev-parse', `${input.mergeSha}^1`])).trim().toLowerCase(); }
  catch { return result; }
  if (!/^[0-9a-f]{40}$/.test(tip)) return result;
  // GY-2960: the same base tip's check is reused for every head that fails it during this process.
  const cacheKey = `${tip}:${still.slice().sort().join(',')}`;
  let onBase = baseTipCheckCache.get(cacheKey);
  if (onBase === undefined) {
    const attempted = await retest(tip, still).catch(() => null);
    // A miss or non-verdict is not cached: the next candidate retries after the host recovers.
    if (!attempted || attempted.run.build !== 'pass') return result;
    baseTipCheckCache.set(cacheKey, attempted);
    onBase = attempted;
  }
  const files = still.filter(file => onBase.run.tests.failed.includes(file));
  // Attributed by case, not by file: every case the rerun failed must fail on the base tip too, and a rerun that named no case attributes nothing.
  const cases = [...again], onBaseTests = casesOf(onBase.tap, onBase.run.logTail).filter(test => !own(test));
  if (!files.length || !cases.length || !cases.every(test => onBaseTests.includes(test))) return result;
  // GY-2954: the refusal carries the base run's own report, so the next operator reads the reason instead of the journal.
  const crash = crashedProcessLine(onBase.run.logTail) ?? crashedProcessLine(onBase.tap);
  const assertion = firstFailingAssertion(onBase.tap);
  return { ...result, base: { tip, files, tests: onBaseTests, cases, ...(crash ? { crash } : {}), ...(assertion ? { assertion } : {}) } };
}

/**
 * The test file each failing case of `tap` ran in, of `files`: the case follows its file's
 * `# Subtest:` opener, at any indent, until the next file's. A case named in two files maps to neither.
 */
function caseFiles(tap: string, files: readonly string[]): Map<string, string | undefined> {
  const map = new Map<string, string | undefined>();
  let file: string | undefined;
  for (const line of tap.split('\n')) {
    const opener = /^\s*# Subtest: (.+?)\s*$/.exec(line)?.[1];
    if (opener !== undefined) { const match = files.find(path => opener === path || opener.endsWith(`/${path}`)); if (match) file = match; continue; }
    const name = /^\s*not ok \d+ - (.+?)(\s+#\s+(?:TODO|SKIP)\b.*)?$/i.exec(line);
    if (!name || name[2] || !file) continue;
    const test = name[1].trim();
    map.set(test, map.has(test) && map.get(test) !== file ? undefined : file);
  }
  return map;
}

// ---- One merge, step by step against the ledger ------------------------------------------------------

/** The trial merge of one head onto one tip: the commit to land (the head itself when it fast-forwards the tip, else its merge commit) and the files it changes against the tip, or the conflicting paths. */
export type MergeOutcomeOfTrial = { mergeSha: string; files: string[] } | { conflict: string[] };
/** Everything `mergeOne` and `reconcileIntents` touch outside the process: git in the coordinator checkout, the deploy-key push, and the coordinator's ledger. */
export interface MergePorts {
  baseBranch: string;
  /** How many times a rejected push is re-trialled on the new tip (`run.mergeWriter.retrials`). */
  retrials: number;
  now(): number;
  /** Fetches the base branch into the checkout (the head is already in its object store, GY-1523); answers the base tip. */
  fetch(): Promise<string>;
  /** The trial merge of `head` onto `baseTip` in the object store (trial.ts `trialMerge`): a commit, or the conflict; `item` names the merge commit's subject. */
  merge(head: string, baseTip: string, item?: { key: string; title?: string | null }): Promise<MergeOutcomeOfTrial>;
  /** The build and tests on `mergeSha` (`runMergeTrial`), `files` being what the merge changes against `baseTip`, with the item's proofs counted. */
  trial(mergeSha: string, files: readonly string[], item: Pick<Work, 'key' | 'criteria'>, baseTip?: string): Promise<MergeTrialRun>;
  /**
   * GY-1718: the preview of a passing trial's `mergeSha` (preview.ts `runPreview`), the repository's
   * required and uat cases run against it served; null when the merge needs none (`previewSkip`).
   * Absent, nothing is previewed.
   */
  preview?(mergeSha: string, files: readonly string[], item: Pick<Work, 'key'>): Promise<PreviewVerdict | null>;
  /** The leased push of `mergeSha` onto `baseTip`; `rejected` when the remote reported a stale lease (`staleLeaseRejection`), any other failure thrown. */
  push(mergeSha: string, baseTip: string): Promise<'pushed' | 'rejected'>;
  /** Whether the base branch's first-parent history holds `sha`, as last fetched. */
  holds(sha: string): Promise<boolean>;
  /**
   * GY-1927: the automatic-merging hold standing over the item's candidate, read afresh from the
   * plane (`GET /api/auto-merge?work=ID`), or null. Asked before a merge opens and again just
   * before its push, so a merge selected from an older snapshot lands nothing once the hold is
   * recorded. Absent, nothing is held here (the plane still refuses an intent under a hold).
   */
  hold?(item: Pick<Work, 'id' | 'key'>): Promise<string | null>;
  /** Records one step on the coordinator (`POST /api/work/:id/merge-record`), idempotent under `mergeRecordKey`, under the attempt `item` names (GY-1852). */
  record(item: Pick<Work, 'id' | 'key'> & { mergeAttempt?: MergeAttempt | null }, event: MergeRecordEvent): Promise<unknown>;
}
export type MergeOutcome =
  | { outcome: 'merged'; mergeSha: string; baseTip: string; observedTip: string; pushes: number }
  | { outcome: 'refused'; reason: string; trial: MergeTrialRun | null; conflict: string[]; preview?: PreviewVerdict | null }
  | { outcome: 'requeued'; reason: string; pushes: number }
  | { outcome: 'reconciled'; mergeSha: string; observedTip: string };

/**
 * One merge (AC-2): intent → trial → push → pushed → fetch → reconciled, each step recorded on
 * the ledger and so idempotent against it. The item's ledger state is read first: a head already
 * pushed, or an open intent whose merge commit the base holds, is only fetched and reconciled,
 * never pushed again. Otherwise the head is trial-merged onto the fetched tip, the intent is
 * recorded before anything runs, the trial runs on the exact merge commit with the proof files
 * included, a passing trial is previewed (GY-1718: its required and uat cases run against the merge
 * commit served, the verdict recorded with the trial), and the merge commit is pushed with a lease
 * on the tip it was tested on. A rejected push
 * re-reads the tip: one that moved is re-trialled on the new tip, at most `retrials` times (AC-3);
 * one that stood still was rejected for another cause and is refused `unmovedTipReason`, queued
 * for a later cycle rather than re-trialled. A failed trial, a failing required case on the preview
 * or a conflict is refused naming what failed, and the rework that refusal grounds is the loop's to
 * request; a preview that timed out or could not run is refused leaving the head queued, as a trial
 * timeout does.
 */
export async function mergeOne(ports: MergePorts, item: Work): Promise<MergeOutcome> {
  const candidate = item.candidate;
  if (!candidate || !item.submission) throw new Error(`${item.key} has no submitted candidate to merge`);
  const head = candidate.sha.toLowerCase(), state = item.mergeLedger;
  const at = () => new Date(ports.now()).toISOString();
  const settle = async (mergeSha: string): Promise<MergeOutcome> => {
    const observedTip = await ports.fetch();
    await ports.record(item, { kind: 'reconciled', mergeSha, observedTip });
    return { outcome: 'reconciled', mergeSha, observedTip };
  };
  // Idempotency against the ledger: what an earlier process recorded is finished, not repeated.
  if (state && state.head === head && state.mergeSha && (state.state === 'pushed' || state.state === 'intent')) {
    await ports.fetch();
    if (await ports.holds(state.mergeSha)) {
      if (state.state === 'intent') await ports.record(item, { kind: 'pushed', mergeSha: state.mergeSha, pushedAt: at() });
      return settle(state.mergeSha);
    }
    if (state.state === 'pushed') throw new Error(`${item.key}: ${state.mergeSha.slice(0, 12)} is recorded pushed but ${ports.baseBranch} does not hold it`);
  }
  // GY-1927: a head the automatic-merging hold stands over opens no merge; it stays queued for the decision that releases it.
  const held = async () => ports.hold ? ports.hold(item) : null;
  const opening = await held();
  if (opening) return { outcome: 'requeued', reason: opening, pushes: 0 };
  let pushes = 0, baseTip = await ports.fetch();
  for (let attempt = 0; attempt <= ports.retrials; attempt++) {
    const merged = await ports.merge(head, baseTip, item);
    if ('conflict' in merged) {
      const reason = trialFailureReason({ conflict: merged.conflict })!;
      await ports.record(item, { kind: 'refused', head, reason });
      return { outcome: 'refused', reason, trial: null, conflict: merged.conflict };
    }
    // The head itself when it fast-forwards the tip (trial.ts `trialMerge`): the ledger then names the head as the merge commit.
    const { mergeSha } = merged;
    // The intent first (AC-2): a crash from here on is reconciled against the base, never repeated blindly.
    await ports.record(item, { kind: 'intent', head, baseTip, mergeSha, risk: riskOf(item).risk, at: at() });
    let run: MergeTrialRun;
    try { run = await ports.trial(mergeSha, merged.files, item, baseTip); }
    catch (error) {
      // No verdict after the retry (GY-1832): the trial's record is its final outcome, never left pending.
      const attempts = trialAttempts(error), last = attempts.at(-1)!;
      await ports.record(item, { kind: 'trial', head, baseTip, mergeSha, outcome: last.outcome, phase: last.phase, reason: last.reason, phases: last.phases, attempts,
        durationMs: Math.round(Object.values(last.phases).reduce((sum, value) => sum + value, 0)) });
      throw error;
    }
    // GY-1834: a failure every file of which fails on the base tip too is the base's: held, never reworked.
    const baseHeld = failureIsBase(run) ? baseFailureReason(run.base!) : null;
    const trialFailure = baseHeld ?? trialFailureReason({ run });
    // A preview that throws (a host failure, not the merge's) is recorded and refused as one that could not run, never left as an open intent.
    const preview = !trialFailure && ports.preview ? await ports.preview(mergeSha, merged.files, item).catch((error: unknown): PreviewVerdict =>
      ({ result: 'error', mergeSha, cases: [], failed: [], detail: (error instanceof Error ? error.message : String(error)).slice(0, 900), durationMs: 0 })) : null;
    // GY-1834: a flake rides on the trial record, refused or not, so it is durable before anything else happens.
    const flaked = run.flaked ? trialFlaked(run.flaked, at()) : null;
    await ports.record(item, { kind: 'trial', head, baseTip, mergeSha, outcome: 'verdict', build: run.build, tests: run.tests, files: run.files, proofs: run.proofs, durationMs: run.durationMs,
      ...(run.phases ? { phases: run.phases } : {}), attempts: run.retried ?? [], ...(preview ? { preview } : {}), ...(flaked ? { flaked } : {}) });
    const failure = trialFailure ?? previewFailureReason(preview, trialFailurePrefix);
    if (failure) {
      await ports.record(item, { kind: 'refused', head, reason: failure });
      if (baseHeld || preview?.result === 'timeout' || preview?.result === 'error') return { outcome: 'requeued', reason: failure, pushes };
      return { outcome: 'refused', reason: failure, trial: run, conflict: [], ...(preview ? { preview } : {}) };
    }
    // The landing boundary (GY-1927): a hold recorded while the trial ran refuses the push, so nothing lands under it.
    const landing = await held();
    if (landing) {
      await ports.record(item, { kind: 'refused', head, reason: landing });
      return { outcome: 'requeued', reason: landing, pushes };
    }
    pushes += 1;
    const pushed = await ports.push(mergeSha, baseTip);
    if (pushed === 'pushed') {
      await ports.record(item, { kind: 'pushed', mergeSha, pushedAt: at() });
      const observedTip = await ports.fetch();
      await ports.record(item, { kind: 'reconciled', mergeSha, observedTip });
      return { outcome: 'merged', mergeSha, baseTip, observedTip, pushes };
    }
    // Rejected: the re-trial path is only for a tip that moved (AC-3), confirmed by re-reading it, never for a remote's refusal of the same tip.
    const movedTo = await ports.fetch();
    if (movedTo === baseTip) {
      const reason = unmovedTipReason(ports.baseBranch, baseTip);
      await ports.record(item, { kind: 'refused', head, reason });
      return { outcome: 'requeued', reason, pushes };
    }
    baseTip = movedTo;
  }
  const reason = baseMovedReason(pushes);
  await ports.record(item, { kind: 'refused', head, reason });
  return { outcome: 'requeued', reason, pushes };
}

export type ReconcileOutcome = { key: string; mergeSha: string; outcome: 'reconciled' | 'requeued' };
/**
 * Before any new merge (AC-5): every intent with no `pushed` record, and every push no
 * reconciliation followed, is settled against the base branch as fetched now. A merge commit the
 * base's first-parent history holds was pushed: it is recorded pushed (when it was not) and
 * reconciled, delivering the item without a second push. One the base does not hold was never
 * pushed: it is refused `unpushedIntentReason`, which leaves the head queued for a fresh merge.
 */
export async function reconcileIntents(ports: MergePorts, work: readonly Work[], ledger: Readonly<Record<string, MergeLedgerState>>): Promise<ReconcileOutcome[]> {
  const pending = Object.values(ledger).filter(state => open(state) && state.mergeSha && state.head);
  if (!pending.length) return [];
  const observedTip = await ports.fetch();
  const outcomes: ReconcileOutcome[] = [];
  for (const state of pending) {
    const item = work.find(entry => entry.key === state.key);
    if (!item) continue;
    const mergeSha = state.mergeSha!;
    if (await ports.holds(mergeSha)) {
      if (state.state === 'intent') await ports.record(item, { kind: 'pushed', mergeSha, pushedAt: new Date(ports.now()).toISOString() });
      await ports.record(item, { kind: 'reconciled', mergeSha, observedTip });
      outcomes.push({ key: state.key, mergeSha, outcome: 'reconciled' });
    } else {
      await ports.record(item, { kind: 'refused', head: state.head!, reason: unpushedIntentReason(mergeSha, ports.baseBranch) });
      outcomes.push({ key: state.key, mergeSha, outcome: 'requeued' });
    }
  }
  return outcomes;
}
