import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { demand, type Principal } from './model.js';
import { defaultReportFormat, reportAdapter, type ArtifactKindName, type ReportVerification } from './report-adapters.js';
import type { Attempt, AttemptReport, Environment, Validation, ValidationCandidate, ValidationRequest } from './validation.js';
import type { ReuseDecision } from './evidence-reuse.js';

/**
 * D6 artifact replay and execution analytics.
 *
 * A replay re-runs the pinned report adapter — the deterministic verifier the collector
 * used — over the artifacts Graphyard retained for one attempt, and records what that
 * covered, what it could not cover, whether it agrees with what the collector reported,
 * and what it cost. It authorizes nothing: the artifacts say what a past execution
 * produced, not what the deployment does now, and the collector's other dimensions
 * (target attribution, bundle identity, settlement) are measurements a stored file cannot
 * repeat. Replay records are exported through the same retention and redaction rules as
 * the artifacts themselves: expired artifacts are not read, artifact bytes are never
 * exported, and every string in a record passes the redaction filter.
 */
const replaySchema = z.object({ requestId: z.uuid(), attemptId: z.uuid() }).strict();
export type ReplayCoverage = 'covered' | 'unmeasured' | 'not-covered';
export interface ReplayArtifact { name: string; digest: string; state: string; backend: string; read: boolean; bytes: number; integrity: 'verified' | 'failed' | 'not-read'; reason: string | null }
export interface ReplayRecord {
  id: string; at: string; actor: string; requestId: string; attemptId: string; epoch: number; sequence: number | null; workId: string; proof: string; candidateId: string; sourceSha: string; format: string;
  /** `consistent`/`inconsistent` compare the replayed verdict with the collector's report; `uncompared` means the verifier ran but the attempt recorded no report summary; `unmeasured` means the retained artifacts lack the instrumentation to replay at all. */
  outcome: 'consistent' | 'inconsistent' | 'uncompared' | 'unmeasured';
  coverage: Record<'inventory' | 'behavior' | 'artifactIntegrity' | 'bundleIdentity' | 'targetAttribution' | 'settlement' | 'deploymentHealth', { status: ReplayCoverage; reason: string }>;
  verification: ReportVerification | null; recorded: AttemptReport | null; differences: string[];
  artifacts: ReplayArtifact[];
  cost: { durationMs: number; bytesRead: number; artifactsRead: number; backend: string };
  authorizes: 'nothing'; liveVerification: 'not-established';
  redaction: { artifactBytesExported: false; identities: 'hashed'; strings: 'redacted' };
}
export interface DurationSummary { samples: number; p50Ms: number | null; maxMs: number | null }
export interface AnalyticsGroup {
  proof: string; environment: string; runner: string; attempts: number;
  outcomes: Record<'passed' | 'failed' | 'expired' | 'cancelled' | 'superseded' | 'inFlight', number>;
  observed: Record<'queueMs' | 'acknowledgeMs' | 'executionMs' | 'collectionMs' | 'totalMs', DurationSummary>;
  reported: { durationMs: DurationSummary; cpuSeconds: DurationSummary };
  cost: { observed: { attempts: number; amounts: Record<string, number> }; estimated: { attempts: number; amounts: Record<string, number> }; unavailable: number };
}

const secretPattern = /((?:authorization\s*:\s*)?bearer\s+|(?:token|password|passwd|secret|api[_-]?key|authorization)\s*[=:]\s*)\S+|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s]+@/gi;
/** The redaction rule every exported replay string passes: credential-shaped tokens and URL credentials are masked, and strings are bounded. */
export const redactString = (value: string) => value.replace(secretPattern, (_match, label?: string, scheme?: string) => label ? `${label}[redacted]` : scheme ? `${scheme}[redacted]@` : '[redacted]').slice(0, 2000);
export function redact<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)])) as T;
  return value;
}
const median = (values: number[]): DurationSummary => {
  if (!values.length) return { samples: 0, p50Ms: null, maxMs: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, p50Ms: sorted[Math.floor((sorted.length - 1) / 2)], maxMs: sorted[sorted.length - 1] };
};
const span = (from?: string, to?: string) => from && to ? Math.max(0, Date.parse(to) - Date.parse(from)) : null;

export class ArtifactReplay {
  constructor(readonly validation: Validation) {}
  get store() { return this.validation.store; }
  async replays(cursor?: string) {
    const before = cursor ? z.coerce.number().int().positive().parse(cursor) : null;
    const rows = (await this.store.pool.query('SELECT seq,document FROM validation_replays WHERE $1::bigint IS NULL OR seq<$1 ORDER BY seq DESC LIMIT 51', [before])).rows;
    const replays: ReplayRecord[] = rows.slice(0, 50).map(r => r.document);
    return { replays, nextCursor: rows.length > 50 ? String(rows[49].seq) : null };
  }
  /** Replay one attempt. Audit credentials only: the reader and operator roles, never the runner or collector of the attempt. */
  async replay(actor: Principal, input: unknown) {
    demand(actor.role === 'admin' || actor.role === 'reader', 'An operator or read-only audit credential is required to replay', 403);
    const data = replaySchema.parse(input);
    const v = this.validation;
    const started = Date.now();
    // Authorization and the artifact rows under the lock; bytes are read with it released.
    const authorized = await this.store.transaction(async db => {
      const r = await v.request(db, data.requestId), a = r.attempts.find(a => a.id === data.attemptId);
      demand(a, 'Attempt not found on this request', 404);
      const c = await v.candidate(db, r.candidateId);
      const environment = await v.definition(db, 'environment', c.environment, false) as Environment;
      demand(environment.repository === v.repository, 'Artifact repository scope differs', 403);
      const bundle = await v.definition(db, 'bundle', c.bundle, false) as { reportFormat?: string };
      const rows: { id: string; name: string; digest: string; expires_at: Date; media_type: string; size: string | number | null; state: string; backend: string; location: string | null; bytes: Buffer | null }[] =
        (await db.query('SELECT id,name,digest,expires_at,media_type,size,state,backend,location,bytes FROM validation_artifacts WHERE request_id=$1 AND attempt_id=$2 ORDER BY name', [r.id, a!.id])).rows;
      const now = (await db.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      return { r, a: a!, c, format: bundle.reportFormat ?? defaultReportFormat, rows, now };
    });
    const { r, a, c, format } = authorized;
    const adapter = reportAdapter(format);
    const artifacts: ReplayArtifact[] = [];
    const documents: Partial<Record<ArtifactKindName, unknown>> = {};
    let bytesRead = 0;
    for (const row of authorized.rows) {
      const entry: ReplayArtifact = { name: row.name, digest: row.digest, state: row.state, backend: row.backend, read: false, bytes: 0, integrity: 'not-read', reason: null };
      artifacts.push(entry);
      // Retention applies to replay inputs exactly as to reads: nothing expired or never stored is touched.
      if (row.state !== 'stored' || row.expires_at <= authorized.now) { entry.reason = row.state === 'stored' ? 'Artifact retention expired' : `Artifact is ${row.state}; no bytes were retained`; continue; }
      let bytes: Buffer | null = row.bytes;
      if (row.backend !== 'postgres') {
        if (!v.artifactBackend || v.artifactBackend.kind !== row.backend) { entry.reason = `Artifact is stored in the ${row.backend} backend, which this server is not configured to read`; continue; }
        try { bytes = await v.artifactBackend.get(row.location!); } catch (error) { entry.reason = `Backend read failed: ${error instanceof Error ? error.message : 'unknown'}`; continue; }
      }
      if (!bytes) { entry.reason = 'Artifact bytes are missing from the backend'; continue; }
      entry.read = true; entry.bytes = bytes.length; bytesRead += bytes.length;
      if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== row.digest) { entry.integrity = 'failed'; entry.reason = 'Artifact bytes fail the digest recorded at upload'; continue; }
      entry.integrity = 'verified';
      if (!(row.name in adapter.artifacts)) { entry.reason = `No deterministic verifier replays ${row.name} (${row.media_type}); it is retained but not judged`; continue; }
      try { documents[row.name as ArtifactKindName] = adapter.parse(row.name as ArtifactKindName, bytes).document; }
      catch { entry.reason = `Artifact is not a ${format} ${row.name} document`; }
    }
    const missing = (Object.keys(adapter.artifacts) as ArtifactKindName[]).filter(kind => !(kind in documents));
    const instrumented = missing.length === 0;
    const verification = instrumented ? adapter.verify(documents.inventory, documents.report) : null;
    const recorded = a.report ?? null;
    const differences: string[] = [];
    if (verification && recorded) {
      if (verification.passed !== (recorded.behavior === 'passed' && recorded.inventoryComplete && recorded.executed > 0 && recorded.skipped === 0)) differences.push(`Replayed verdict ${verification.passed ? 'passed' : 'failed'} but the collector reported behavior ${recorded.behavior} with inventory ${recorded.inventoryComplete ? 'complete' : 'incomplete'}`);
      if (verification.executed !== recorded.executed) differences.push(`Replay counts ${verification.executed} executed; the collector reported ${recorded.executed}`);
      if (verification.skipped !== recorded.skipped) differences.push(`Replay counts ${verification.skipped} skipped; the collector reported ${recorded.skipped}`);
      if (verification.inventoryComplete !== recorded.inventoryComplete) differences.push(`Replay finds the inventory ${verification.inventoryComplete ? 'complete' : 'incomplete'}; the collector reported it ${recorded.inventoryComplete ? 'complete' : 'incomplete'}`);
    }
    const unmeasured = !instrumented ? `Retained artifacts lack the instrumentation to replay: ${[...missing.map(kind => artifacts.find(x => x.name === kind)?.reason ? `${kind} — ${artifacts.find(x => x.name === kind)!.reason}` : `${kind} was never retained`)].join('; ')}` : null;
    const coverage: ReplayRecord['coverage'] = {
      inventory: instrumented ? { status: 'covered', reason: `${verification!.executed} executed and ${verification!.skipped} skipped re-derived from the retained ${format} inventory and report` } : { status: 'unmeasured', reason: unmeasured! },
      behavior: instrumented ? { status: 'covered', reason: verification!.passed ? 'Every retained execution passed under the pinned verifier' : verification!.reasons.join('; ') } : { status: 'unmeasured', reason: unmeasured! },
      artifactIntegrity: artifacts.some(x => x.read) ? { status: artifacts.every(x => !x.read || x.integrity === 'verified') ? 'covered' : 'unmeasured', reason: artifacts.every(x => !x.read || x.integrity === 'verified') ? 'Every artifact read matches the digest recorded at upload' : 'An artifact fails its recorded digest' } : { status: 'unmeasured', reason: 'No retained artifact could be read' },
      bundleIdentity: { status: 'not-covered', reason: 'Which bundle and runner image executed was attested at the execution boundary; a stored report cannot re-measure it' },
      targetAttribution: { status: 'not-covered', reason: 'Which artifact served the traffic was measured independently during the run; a replay cannot repeat that measurement' },
      settlement: { status: 'not-covered', reason: 'Settlement was observed by the collector on the execution host; replay observes nothing there' },
      deploymentHealth: { status: 'not-covered', reason: 'A replay judges a past execution; it never establishes current live behavior or deployment health' },
    };
    const record: ReplayRecord = redact({
      id: randomUUID(), at: new Date().toISOString(), actor: actor.id, requestId: r.id, attemptId: a.id, epoch: a.epoch, sequence: a.sequence ?? null, workId: r.workId, proof: r.proof, candidateId: c.id, sourceSha: c.sourceSha, format,
      outcome: !instrumented ? 'unmeasured' : !recorded ? 'uncompared' : differences.length ? 'inconsistent' : 'consistent',
      coverage, verification, recorded, differences: !instrumented ? [] : !recorded ? ['The attempt predates recorded report summaries; nothing to compare against'] : differences, artifacts,
      cost: { durationMs: Date.now() - started, bytesRead, artifactsRead: artifacts.filter(x => x.read).length, backend: v.artifactBackend?.label ?? 'postgres' },
      authorizes: 'nothing', liveVerification: 'not-established', redaction: { artifactBytesExported: false, identities: 'hashed', strings: 'redacted' },
    });
    await this.store.transaction(async (db, now) => {
      record.at = now.toISOString();
      await db.query('INSERT INTO validation_replays(id,request_id,attempt_id,document) VALUES($1,$2,$3,$4)', [record.id, r.id, a.id, JSON.stringify(record)]);
      await v.event(db, actor.id, 'replayed', { replay: record }, r.workId);
    });
    return record;
  }
  /**
   * Cost and duration analytics. Every attempt is grouped by proof, environment and runner
   * registration because those decide the workload; nothing here ranks runners or agents
   * across groups, and cost is reported as observed, estimated or unavailable — never as
   * zero when nobody metered it.
   */
  async analytics() {
    const now = (await this.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    const sequenced: { seq: string; request_id: string; attempt_id: string; work_id: string; proof: string; candidate_id: string }[] = (await this.store.pool.query('SELECT seq,request_id,attempt_id,work_id,proof,candidate_id FROM validation_attempts ORDER BY seq')).rows;
    const requestIds = [...new Set(sequenced.map(s => s.request_id))];
    const requests = new Map<string, ValidationRequest>((await this.store.pool.query('SELECT document FROM validation_requests WHERE id=ANY($1::uuid[])', [requestIds])).rows.map(r => [r.document.id, r.document]));
    const candidates = new Map<string, ValidationCandidate>((await this.store.pool.query('SELECT document FROM validation_candidates WHERE id=ANY($1::uuid[])', [[...new Set(sequenced.map(s => s.candidate_id))]])).rows.map(r => [r.document.id, r.document]));
    const groups = new Map<string, AnalyticsGroup & { samples: Record<string, number[]>; reportedSamples: { durationMs: number[]; cpuSeconds: number[] } }>();
    const outcomeOf = (r: ValidationRequest, a: Attempt): keyof AnalyticsGroup['outcomes'] => a.state === 'completed' ? (a.report ? (a.report.passed ? 'passed' : 'failed') : (r.attempts.at(-1)?.id === a.id && r.result ? (r.result.passed ? 'passed' : 'failed') : 'failed')) : a.state === 'expired' ? 'expired' : a.state === 'cancelled' ? 'cancelled' : a.state === 'superseded' ? 'superseded' : 'inFlight';
    for (const row of sequenced) {
      const r = requests.get(row.request_id), a = r?.attempts.find(a => a.id === row.attempt_id), c = candidates.get(row.candidate_id);
      if (!r || !a || !c) continue;
      const key = `${r.proof}${c.environment.id}${r.runner.id}`;
      let group = groups.get(key);
      if (!group) { group = { proof: r.proof, environment: c.environment.id, runner: r.runner.id, attempts: 0, outcomes: { passed: 0, failed: 0, expired: 0, cancelled: 0, superseded: 0, inFlight: 0 }, observed: { queueMs: median([]), acknowledgeMs: median([]), executionMs: median([]), collectionMs: median([]), totalMs: median([]) }, reported: { durationMs: median([]), cpuSeconds: median([]) }, cost: { observed: { attempts: 0, amounts: {} }, estimated: { attempts: 0, amounts: {} }, unavailable: 0 }, samples: { queueMs: [], acknowledgeMs: [], executionMs: [], collectionMs: [], totalMs: [] }, reportedSamples: { durationMs: [], cpuSeconds: [] } }; groups.set(key, group); }
      group.attempts++; group.outcomes[outcomeOf(r, a)]++;
      const previous = r.attempts[a.epoch - 2];
      const observed = { queueMs: span(previous?.finishedAt ?? (a.epoch === 1 ? r.createdAt : undefined), a.dispatchedAt), acknowledgeMs: span(a.dispatchedAt, a.acknowledgedAt), executionMs: span(a.acknowledgedAt, a.collectingAt), collectionMs: span(a.collectingAt, a.finishedAt), totalMs: span(a.dispatchedAt, a.finishedAt) };
      for (const [name, value] of Object.entries(observed)) if (value !== null) group.samples[name].push(value);
      if (a.measurements?.durationMs !== undefined) group.reportedSamples.durationMs.push(a.measurements.durationMs);
      if (a.measurements?.cpuSeconds !== undefined) group.reportedSamples.cpuSeconds.push(a.measurements.cpuSeconds);
      const cost = a.measurements?.cost;
      if (!cost) group.cost.unavailable++;
      else { const bucket = group.cost[cost.basis]; bucket.attempts++; bucket.amounts[cost.currency] = Math.round(((bucket.amounts[cost.currency] ?? 0) + cost.amount) * 1_000_000) / 1_000_000; }
    }
    const summarised: AnalyticsGroup[] = [...groups.values()].map(({ samples, reportedSamples, ...group }) => ({ ...group,
      observed: { queueMs: median(samples.queueMs), acknowledgeMs: median(samples.acknowledgeMs), executionMs: median(samples.executionMs), collectionMs: median(samples.collectionMs), totalMs: median(samples.totalMs) },
      reported: { durationMs: median(reportedSamples.durationMs), cpuSeconds: median(reportedSamples.cpuSeconds) } })).sort((a, b) => a.proof.localeCompare(b.proof) || a.environment.localeCompare(b.environment) || a.runner.localeCompare(b.runner));
    // Reuse: avoided work is a grant no later live attempt replaced; false reuse is a grant a
    // later live attempt for the same proof contradicted with a failure.
    const decisions: ReuseDecision[] = (await this.store.pool.query('SELECT document FROM validation_reuse_decisions ORDER BY seq')).rows.map(r => r.document);
    const later = (d: ReuseDecision) => sequenced.filter(s => s.work_id === d.workId && s.proof === d.proof && Number(s.seq) > (d.of?.sequence ?? 0)).map(s => { const r = requests.get(s.request_id); const a = r?.attempts.find(a => a.id === s.attempt_id); return r && a ? outcomeOf(r, a) : null; });
    const refusalReasons: Record<string, number> = {};
    for (const d of decisions) if (d.outcome === 'refused') for (const reason of new Set(d.reasons.map(reason => reason.includes('relevant') ? 'relevant-change' : reason.includes('not covered') ? 'unknown-scope' : reason.includes('freshness') || reason.includes('expired') ? 'stale' : reason.includes('revision') || reason.includes('bundle') || reason.includes('scenario') || reason.includes('environment') ? 'binding-changed' : reason.includes('build') || reason.includes('artifacts') ? 'build-changed' : /queued|running|Newest attempt|No sequenced/.test(reason) ? 'newer-attempt' : 'other'))) refusalReasons[reason] = (refusalReasons[reason] ?? 0) + 1;
    const granted = decisions.filter(d => d.outcome === 'granted');
    const reuse = { decisions: decisions.length, granted: granted.length, refused: decisions.length - granted.length, refusalReasons,
      supersededByLiveRun: granted.filter(d => later(d).length > 0).length,
      contradictedByLaterFailure: granted.filter(d => later(d).includes('failed')).length,
      avoidedExecutions: granted.filter(d => later(d).length === 0).length };
    const replays: ReplayRecord[] = (await this.store.pool.query('SELECT document FROM validation_replays ORDER BY seq')).rows.map(r => r.document);
    const replaySummary = { total: replays.length, outcomes: { consistent: replays.filter(x => x.outcome === 'consistent').length, inconsistent: replays.filter(x => x.outcome === 'inconsistent').length, uncompared: replays.filter(x => x.outcome === 'uncompared').length, unmeasured: replays.filter(x => x.outcome === 'unmeasured').length },
      durationMs: median(replays.map(x => x.cost.durationMs)), bytesRead: replays.reduce((sum, x) => sum + x.cost.bytesRead, 0) };
    return { now: now.toISOString(), attempts: { sequenced: sequenced.length, groups: summarised.length }, groups: summarised, reuse, replays: replaySummary,
      caveat: 'Groups are keyed by proof, environment and runner registration because those decide the workload. Durations are Graphyard\'s own observations of the attempt timeline; reported durations, CPU and cost come from the runner and are labeled observed, estimated or unavailable. No group is ranked against another.' };
  }
}
