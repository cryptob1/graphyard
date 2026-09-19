import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { Refusal, type EvidenceAttribution, type Principal, type Work } from './model.js';
import { appendAttribution, digestHash, targetIdentity, windowIdentity, type AttributionEntry, type TargetIdentity } from './attribution.js';
import type { Attempt, BuildAttestation, Environment, Registration, Validation, ValidationCandidate, ValidationRequest } from './validation.js';
import type { DeploymentObservation, Release } from './delivery.js';

/** The target identity a request or attempt was bound to at one instant. */
export interface TargetSnapshot { state: TargetIdentity['state']; observationIds: string[]; observedAt: string | null; digestHash: string | null }
/**
 * What a validation request is bound to for attribution. Written once when the request is
 * created; a target that moves afterwards supersedes the request and a fresh one is minted
 * with `reanchoredFrom` naming the record it replaces.
 */
export interface RequestAttribution {
  workKey: string; environmentId: string; environmentRevision: number; targetKind: 'immutable-preview' | 'shared-staging';
  manifestHash: string; digestHash: string; signature: string; buildId: string; target: TargetSnapshot;
  reanchoredFrom?: { requestId: string; attemptId: string | null; observationIds: string[]; trigger: string };
}
/** What caused a re-anchor decision: the principal that acted and, for an observation, the registration and lease epoch it held. */
type Trigger = { kind: 'dispatch' | 'observation' | 'delayed-observation' | 'retry'; actor: string; observationId?: string; registration?: { id: string; revision: number }; epoch?: number };
/**
 * A request refused because its target is known to run another manifest. The refusal rolls
 * the creating transaction back, so the ledger entries travel with it and the caller appends
 * them in a transaction of their own: an avoided paid run is history even when nothing else is.
 */
export class TargetMismatchRefusal extends Refusal {
  constructor(message: string, readonly entries: AttributionEntry[]) { super(message, 409); }
  async ledger(db: pg.PoolClient, now: Date) { for (const entry of this.entries) await appendAttribution(db, now, entry); }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const snapshotOf = (identity: TargetIdentity): TargetSnapshot => ({ state: identity.state, observationIds: identity.observationIds, observedAt: identity.observedAt, digestHash: identity.digestHash });
/** Bounded read of an environment's recent observations, newest first. */
const observationLimit = 200;

/**
 * Exact-target validation and safe automatic re-anchoring.
 *
 * Every decision here reads the independently observed target identity of the candidate's
 * environment — what registered, leased observers measured running — and compares it with
 * the manifest the candidate's trusted build attests. A mismatch known before a grant costs
 * nothing: the request is superseded, trusted release membership decides whether the moved
 * target still contains the intended change, and a fresh request is minted or the binding
 * is left visibly blocked. Nothing is edited, relabelled or retargeted; every step appends
 * to the attribution ledger, and no provider I/O happens inside these transactions.
 */
export class Reanchoring {
  constructor(readonly validation: Validation) {}
  private async build(db: pg.PoolClient, c: ValidationCandidate) {
    return (await db.query('SELECT document FROM validation_builds WHERE id=$1', [c.buildAttestationId])).rows[0].document as BuildAttestation;
  }
  private expected(build: BuildAttestation) { return Object.fromEntries(build.artifacts.map(a => [a.service, a.digest])); }
  async observations(db: pg.PoolClient, environmentId: string): Promise<DeploymentObservation[]> {
    return (await db.query('SELECT document FROM delivery_observations WHERE environment_id=$1 ORDER BY seq DESC LIMIT $2', [environmentId, observationLimit])).rows.map(r => r.document);
  }
  private async identity(db: pg.PoolClient, c: ValidationCandidate, build: BuildAttestation) {
    return targetIdentity(await this.observations(db, c.environment.id), this.expected(build));
  }
  private details(identity: TargetIdentity, c: ValidationCandidate, extra: Record<string, unknown> = {}) {
    return { state: identity.state, observationIds: identity.observationIds, observedAt: identity.observedAt, manifestHash: c.manifestHash ?? null, expectedDigestHash: c.digestHash ?? null, observedDigestHash: identity.digestHash,
      partialConvergence: identity.partialConvergence, matchedServices: identity.matchedServices, mismatchedServices: identity.mismatchedServices, ambiguous: identity.ambiguous, reasons: identity.reasons, ...extra };
  }
  /** Append a target check for a request; a mismatch is its own kind so the ledger reads plainly. */
  async checked(db: pg.PoolClient, r: ValidationRequest, c: ValidationCandidate, w: Work, phase: string, identity: TargetIdentity | TargetSnapshot, now: Date, attemptId: string | null = null) {
    const full: TargetIdentity = 'services' in identity ? identity : { ...identity, services: {}, ambiguous: false, partialConvergence: false, matchedServices: 0, mismatchedServices: 0, reasons: [] };
    const kind = full.state === 'mismatched' ? 'target-mismatch' : 'target-checked';
    return appendAttribution(db, now, { workId: w.id, workKey: w.key, proof: c.proof, environmentId: c.environment.id, candidateId: c.id, requestId: r.id, attemptId, kind,
      dedupe: `${kind}:${r.id}:${phase}:${attemptId ?? ''}:${full.observationIds.join(',')}:${full.state}`, details: this.details(full, c, { phase, reason: full.reasons[0] ?? `Target ${full.state} at ${phase}` }) });
  }
  /**
   * Bind a new request to its candidate manifest, signature and the target observers report
   * now. A target already measured running another manifest refuses the request outright —
   * there is nothing to execute against — and the avoided run is ledgered.
   */
  async bind(db: pg.PoolClient, c: ValidationCandidate, w: Work, environment: Environment, build: BuildAttestation, now: Date, reanchoredFrom?: RequestAttribution['reanchoredFrom']): Promise<RequestAttribution> {
    const identity = await this.identity(db, c, build);
    if (identity.state === 'mismatched') throw new TargetMismatchRefusal(`Target ${environment.id} is independently observed running another manifest (${identity.reasons.join('; ')}); no request is created until observers report the candidate manifest`, [
      { workId: w.id, workKey: w.key, proof: c.proof, environmentId: environment.id, candidateId: c.id, requestId: null, attemptId: null, kind: 'target-mismatch', dedupe: `target-mismatch:candidate:${c.id}:${identity.observationIds.join(',')}`, details: this.details(identity, c, { phase: 'request', reason: identity.reasons[0] }) },
      { workId: w.id, workKey: w.key, proof: c.proof, environmentId: environment.id, candidateId: c.id, requestId: null, attemptId: null, kind: 'paid-run-avoided', dedupe: `paid-run-avoided:candidate:${c.id}:${identity.digestHash ?? identity.observationIds.join(',')}`, details: this.details(identity, c, { phase: 'request', reason: 'Request refused: the target already runs another manifest' }) },
    ]);
    return { workKey: w.key, environmentId: environment.id, environmentRevision: environment.revision, targetKind: environment.immutable === false ? 'shared-staging' : 'immutable-preview',
      manifestHash: c.manifestHash!, digestHash: c.digestHash!, signature: c.signature!, buildId: build.id, target: snapshotOf(identity), ...(reanchoredFrom ? { reanchoredFrom } : {}) };
  }
  /**
   * The pre-grant gate. Returns the target snapshot to pin on the attempt, or null when no
   * paid execution may start: a known mismatch supersedes and re-anchors the request; shared
   * staging without a measured match simply waits, and the wait is visible.
   */
  async gate(db: pg.PoolClient, r: ValidationRequest, c: ValidationCandidate, w: Work, environment: Environment, actor: string, now: Date): Promise<Attempt['target'] | null> {
    const build = await this.build(db, c), identity = await this.identity(db, c, build);
    if (identity.state === 'mismatched') { await this.reanchor(db, r, c, w, environment, identity, { kind: 'dispatch', actor }, now); return null; }
    if (environment.immutable === false && identity.state !== 'matched') {
      await this.checked(db, r, c, w, 'dispatch-withheld', identity, now);
      return null;
    }
    await this.checked(db, r, c, w, 'dispatch', identity, now);
    return snapshotOf(identity);
  }
  /**
   * The result-time judgement: observers must have measured the candidate manifest for the
   * whole execution window, and never anything else. The collector's own attribution claim
   * cannot substitute for that; an unsupported claim of a match is ledgered as refused.
   */
  async settle(db: pg.PoolClient, r: ValidationRequest, a: Attempt, c: ValidationCandidate, w: Work, report: { target: { attribution: string; measurement: string } }, reasons: string[], now: Date): Promise<EvidenceAttribution> {
    const build = await this.build(db, c), expected = this.expected(build);
    const observations = await this.observations(db, c.environment.id);
    const window = windowIdentity(observations, expected, a.dispatchedAt, now.toISOString());
    const identity = targetIdentity(observations, expected);
    if (window.state === 'mismatched') {
      reasons.push('Independently observed target identity changed or mismatched during the execution window');
      await appendAttribution(db, now, { workId: w.id, workKey: w.key, proof: c.proof, environmentId: c.environment.id, candidateId: c.id, requestId: r.id, attemptId: a.id, kind: 'target-changed', dedupe: `target-changed:${r.id}:${a.id}:${window.observationIds.join(',')}`, details: this.details(identity, c, { phase: 'result', window: { from: a.dispatchedAt, to: now.toISOString() }, windowObservationIds: window.observationIds, reasons: window.reasons, reason: window.reasons[0] }) });
    }
    // Shared staging has no immutable-target declaration to lean on: observers must have
    // measured the candidate manifest for the whole run, not merely at the grant.
    if (r.attribution?.targetKind === 'shared-staging' && (window.state === 'unobserved' || window.state === 'unknown'))
      reasons.push(`Shared staging requires independently observed target identity across the entire execution window; the target was ${window.state} for part of it`);
    if (report.target.attribution === 'matched' && (report.target.measurement === 'unknown' || window.state === 'mismatched'))
      await appendAttribution(db, now, { workId: w.id, workKey: w.key, proof: c.proof, environmentId: c.environment.id, candidateId: c.id, requestId: r.id, attemptId: a.id, kind: 'unsupported-claim-refused', dedupe: `unsupported-claim-refused:${r.id}:${a.id}:collector-target`, details: { claim: 'collector-target', measurement: report.target.measurement, windowState: window.state, reason: window.state === 'mismatched' ? 'Collector claimed a matched target that observers measured running another manifest' : 'Collector claimed a matched target without a measured identity' } });
    await this.checked(db, r, c, w, 'result', { ...snapshotOf(identity), state: window.state, observationIds: window.observationIds }, now, a.id);
    return { manifestHash: c.manifestHash ?? '', digestHash: c.digestHash ?? '', signature: c.signature ?? '', environmentId: c.environment.id, environmentRevision: c.environment.revision, targetKind: r.attribution?.targetKind ?? 'immutable-preview', targetState: window.state, targetObservationIds: window.observationIds };
  }
  /** A SHA offered as target proof is refused before parsing, and ledgered when it names a real request. */
  async refuseClaimedTarget(actor: Principal, input: unknown) {
    if (!input || typeof input !== 'object') return;
    const body = input as Record<string, any>, target = body.target && typeof body.target === 'object' ? body.target as Record<string, unknown> : {};
    const claimed = ['sourceSha', 'sha', 'commit', 'commitSha', 'baseSha'].filter(field => field in body || field in target);
    if (!claimed.length) return;
    const requestId = typeof body.requestId === 'string' && z.uuid().safeParse(body.requestId).success ? body.requestId : null;
    if (requestId) await this.validation.store.transaction(async (db, now) => {
      const r = (await db.query('SELECT document FROM validation_requests WHERE id=$1', [requestId])).rows[0]?.document as ValidationRequest | undefined;
      const w = r ? (await db.query('SELECT document FROM work_items WHERE id=$1', [r.workId])).rows[0]?.document as Work | undefined : undefined;
      const c = r ? (await db.query('SELECT document FROM validation_candidates WHERE id=$1', [r.candidateId])).rows[0]?.document as ValidationCandidate | undefined : undefined;
      if (r && w && c) await appendAttribution(db, now, { workId: w.id, workKey: w.key, proof: r.proof, environmentId: c.environment.id, candidateId: c.id, requestId: r.id, attemptId: typeof body.attemptId === 'string' ? body.attemptId.slice(0, 36) : null, kind: 'unsupported-claim-refused', dedupe: `unsupported-claim-refused:${r.id}:${hash(input)}`, details: { claim: 'client-supplied-sha', actor: actor.id, fields: claimed, reason: 'A client-supplied SHA was offered as target proof' } });
    });
    throw new Refusal(`A client-supplied ${claimed.join('/')} is not target proof; target identity is measured by registered observers and bound by the trusted build attestation`, 400);
  }
  /**
   * An authoritative observation arrived. Unstarted requests whose target moved are
   * re-anchored; an accepted pass whose execution window the observation now contradicts is
   * undermined and re-anchored too; blocked bindings on the environment are retried.
   */
  async observed(db: pg.PoolClient, observation: DeploymentObservation, actor: string, now: Date) {
    const trigger: Trigger = { kind: 'observation', actor, observationId: observation.id, registration: observation.registration, epoch: observation.epoch };
    const requests: ValidationRequest[] = (await db.query(`SELECT document FROM validation_requests WHERE document->'attribution'->>'environmentId'=$1 AND document->>'state' IN ('queued','dispatched','running','collecting','completed') ORDER BY document->>'createdAt',id LIMIT 500`, [observation.environment.id])).rows.map(r => r.document);
    for (const r of requests) {
      const w = (await db.query('SELECT document FROM work_items WHERE id=$1', [r.workId])).rows[0]?.document as Work | undefined;
      if (!w || w.stage === 'done' || w.observation?.merged || w.validation?.[r.proof]?.requestId !== r.id) continue;
      const c = await this.validation.candidate(db, r.candidateId), build = await this.build(db, c), identity = await this.identity(db, c, build);
      const environment = await this.validation.definition(db, 'environment', c.environment, false) as Environment;
      const a = r.attempts.at(-1);
      if (r.state === 'queued' || r.state === 'dispatched') {
        if (identity.state === 'mismatched') await this.reanchor(db, r, c, w, environment, identity, trigger, now);
        else await this.checked(db, r, c, w, 'observed', identity, now);
      } else if (r.state === 'running' || r.state === 'collecting') {
        if (identity.state === 'mismatched') await appendAttribution(db, now, { workId: w.id, workKey: w.key, proof: c.proof, environmentId: c.environment.id, candidateId: c.id, requestId: r.id, attemptId: a?.id ?? null, kind: 'target-changed', dedupe: `target-changed:${r.id}:${a?.id ?? ''}:${observation.id}`, details: this.details(identity, c, { phase: 'execution', reason: identity.reasons[0] }) });
        else await this.checked(db, r, c, w, 'execution', identity, now, a?.id ?? null);
      } else if (a && r.result?.passed && w.validation[r.proof].attemptId === a.id) {
        // A delayed or late observation of the execution window: the pass stands only while nothing measured contradicts it.
        const window = windowIdentity([observation], this.expected(build), a.dispatchedAt, a.finishedAt ?? now.toISOString());
        if (window.state !== 'mismatched') continue;
        const evidence = w.evidence.find(e => e.validation?.attemptId === a.id);
        await appendAttribution(db, now, { workId: w.id, workKey: w.key, proof: c.proof, environmentId: c.environment.id, candidateId: c.id, requestId: r.id, attemptId: a.id, kind: 'attribution-undermined', dedupe: `attribution-undermined:${r.id}:${a.id}:${observation.id}`, details: this.details(identity, c, { phase: 'delayed-observation', evidenceId: evidence?.id ?? null, windowObservationIds: window.observationIds, reasons: window.reasons, reason: window.reasons[0] }) });
        await this.reanchor(db, r, c, w, environment, identity, { ...trigger, kind: 'delayed-observation' }, now);
      }
    }
    const blocked = (await db.query(`SELECT w.document FROM work_items w WHERE w.document->>'stage'<>'done' AND EXISTS (SELECT 1 FROM jsonb_each(COALESCE(w.document->'validation','{}'::jsonb)) v WHERE v.value->'reanchor'->>'state'='blocked' AND v.value->'reanchor'->>'environmentId'=$1) ORDER BY w.number LIMIT 200`, [observation.environment.id])).rows.map(r => r.document as Work);
    for (const stale of blocked) {
      const w = (await db.query('SELECT document FROM work_items WHERE id=$1', [stale.id])).rows[0].document as Work;
      for (const [proof, binding] of Object.entries(w.validation ?? {})) {
        if (binding.reanchor?.state !== 'blocked' || binding.reanchor.environmentId !== observation.environment.id) continue;
        const r = await this.validation.request(db, binding.reanchor.supersededRequestId), c = await this.validation.candidate(db, binding.candidateId);
        const environment = await this.validation.definition(db, 'environment', c.environment, false) as Environment;
        const current = (await db.query('SELECT document FROM work_items WHERE id=$1', [w.id])).rows[0].document as Work;
        await this.reanchor(db, r, c, current, environment, await this.identity(db, c, await this.build(db, c)), { ...trigger, kind: 'retry' }, now);
        void proof;
      }
    }
  }
  /**
   * Supersede a request whose target moved and decide what follows. Idempotent: one row in
   * attribution_reanchors per superseded request, written only when a fresh request exists,
   * so concurrent observations of the same movement mint exactly one replacement and a
   * blocked decision can be retried when a later observation changes it.
   */
  async reanchor(db: pg.PoolClient, r: ValidationRequest, c: ValidationCandidate, w: Work, environment: Environment, identity: TargetIdentity, trigger: Trigger, now: Date) {
    if ((await db.query('SELECT 1 FROM attribution_reanchors WHERE superseded_request_id=$1', [r.id])).rowCount) return;
    const a = r.attempts.at(-1);
    if (!['cancelled', 'expired', 'superseded'].includes(r.state)) {
      await this.validation.endActiveAttempt(db, r, 'superseded', now); r.state = 'superseded';
      await this.validation.persist(db, r); await this.validation.event(db, 'graphyard', 'superseded', { request: r, trigger }, r.workId);
    }
    await appendAttribution(db, now, { workId: w.id, workKey: w.key, proof: c.proof, environmentId: environment.id, candidateId: c.id, requestId: r.id, attemptId: a?.id ?? null, kind: 'target-mismatch', dedupe: `target-mismatch:${r.id}:${identity.digestHash ?? identity.observationIds.join(',')}`, details: this.details(identity, c, { phase: trigger.kind, reason: identity.reasons[0] ?? 'Target moved' }) });
    await appendAttribution(db, now, { workId: w.id, workKey: w.key, proof: c.proof, environmentId: environment.id, candidateId: c.id, requestId: r.id, attemptId: a?.id ?? null, kind: 'superseded', dedupe: `superseded:${r.id}`, details: this.details(identity, c, { trigger, reason: `Target moved while the request was ${a ? a.state : 'queued'}; the record is preserved and superseded` }) });
    // A request that never reached an acknowledged attempt was going to execute against the moved target; that paid run did not happen.
    if (!a?.acknowledgedAt) await appendAttribution(db, now, { workId: w.id, workKey: w.key, proof: c.proof, environmentId: environment.id, candidateId: c.id, requestId: r.id, attemptId: a?.id ?? null, kind: 'paid-run-avoided', dedupe: `paid-run-avoided:${r.id}`, details: this.details(identity, c, { phase: trigger.kind, reason: 'Execution withheld: the target runs another manifest' }) });
    if (w.validation?.[c.proof]?.requestId === r.id) delete w.validation[c.proof].attemptId;
    const decision = await this.decide(db, w, environment, identity, r, now);
    if (decision.contains && decision.buildId) {
      // The fresh candidate and request are minted together or not at all: a refusal half way
      // through leaves no orphan record behind, only the blocked decision below.
      await db.query('SAVEPOINT reanchor');
      try {
        const fresh = await this.validation.mintCandidate(db, 'graphyard', { workId: w.id, expectedWorkRevision: w.revision, proof: c.proof, environment: c.environment, bundle: c.bundle, buildAttestationId: decision.buildId, requiredArtifacts: c.requiredArtifacts, artifactStorage: c.artifactStorage }, w, now, { candidateId: c.id, requestId: r.id });
        const request = await this.validation.mintRequest(db, 'graphyard', { candidateId: fresh.id, expectedWorkRevision: w.revision, runner: r.runner, collector: r.collector, deadline: r.deadline, maxAttempts: r.maxAttempts }, fresh, w, now, { requestId: r.id, attemptId: a?.id ?? null, observationIds: identity.observationIds, trigger: trigger.kind });
        await db.query('INSERT INTO attribution_reanchors(superseded_request_id,fresh_request_id,fresh_candidate_id,recorded_at,document) VALUES($1,$2,$3,$4,$5)', [r.id, request.id, fresh.id, now, JSON.stringify({ trigger, decision, observationIds: identity.observationIds })]);
        await appendAttribution(db, now, { workId: w.id, workKey: w.key, proof: c.proof, environmentId: environment.id, candidateId: fresh.id, requestId: request.id, attemptId: null, kind: 'rescheduled', dedupe: `rescheduled:${r.id}`, details: this.details(identity, c, { supersededRequestId: r.id, freshCandidateId: fresh.id, buildId: decision.buildId, via: decision.via, release: decision.release ?? null, trigger, reason: `Fresh request minted: the moved target contains the intended change via ${decision.via}` }) });
        await this.validation.changed(db, w, 'graphyard', 'reanchored', now, { supersededRequestId: r.id, request, candidate: fresh, trigger });
        await db.query('RELEASE SAVEPOINT reanchor');
        return;
      } catch (error) {
        await db.query('ROLLBACK TO SAVEPOINT reanchor');
        // The in-memory work document must match the row the rollback restored.
        Object.assign(w, (await db.query('SELECT document FROM work_items WHERE id=$1', [w.id])).rows[0].document as Work);
        decision.contains = false; decision.reasons.push(`Fresh request could not be minted: ${(error as Error).message}`);
      }
    }
    w.validation![c.proof] = { candidateId: c.id, reanchor: { state: 'blocked', reasons: decision.reasons, supersededRequestId: r.id, environmentId: environment.id, at: now.toISOString() } };
    await appendAttribution(db, now, { workId: w.id, workKey: w.key, proof: c.proof, environmentId: environment.id, candidateId: c.id, requestId: r.id, attemptId: a?.id ?? null, kind: 'reanchor-blocked', dedupe: `reanchor-blocked:${r.id}:${identity.digestHash ?? 'unmeasured'}:${hash(decision.reasons)}`, details: this.details(identity, c, { contains: decision.contains, reasons: decision.reasons, release: decision.release ?? null, trigger, reason: decision.reasons[0] }) });
    await this.validation.changed(db, w, 'graphyard', 'reanchor-blocked', now, { supersededRequestId: r.id, reasons: decision.reasons, trigger });
  }
  /**
   * Does the observed target contain the intended change? Only trusted records answer: a
   * build attestation for this work item whose artifacts are the observed manifest and whose
   * source is the current candidate, or a release whose manifest is the observed one and
   * whose membership or source names the change. Anything else stays blocked.
   */
  async decide(db: pg.PoolClient, w: Work, environment: Environment, identity: TargetIdentity, r: ValidationRequest, now: Date): Promise<{ contains: boolean | null; buildId?: string; via?: string; release?: { id: string; revision: number }; reasons: string[] }> {
    const reasons: string[] = [];
    if (identity.ambiguous) reasons.push('Target history is ambiguous: overlapping authoritative observations disagree about what is running');
    if (!identity.digestHash) reasons.push('Observed target identity is not fully measured: a service is unobserved, incomplete or only self-reported');
    if (Date.parse(r.deadline) <= now.getTime()) reasons.push('The superseded request\'s deadline has passed; an operator must request validation again');
    if (reasons.length) return { contains: null, reasons };
    const builds: BuildAttestation[] = (await db.query("SELECT document FROM validation_builds WHERE document->>'workId'=$1 AND document->>'repository'=$2 ORDER BY document->>'at' DESC LIMIT 50", [w.id, this.validation.repository])).rows.map(row => row.document);
    // Only records of this environment speak for its target: the same digests attested or
    // released for another environment say nothing about what this one is running.
    const matching: BuildAttestation[] = [];
    for (const b of builds.filter(b => digestHash(b.artifacts) === identity.digestHash)) {
      const registration = await this.validation.definition(db, 'registration', b.registration, false).catch(() => null) as Registration | null;
      if (registration?.environment.id === environment.id) matching.push(b);
    }
    const containing: BuildAttestation[] = [];
    for (const b of matching) {
      if (b.sourceSha !== w.candidate?.sha || b.baseSha !== w.candidate.baseSha) continue;
      try { await this.validation.registration(db, b.registration, 'builder'); containing.push(b); } catch { /* revoked builder: not trusted */ }
    }
    const foreign = matching.filter(b => !containing.includes(b));
    const releases: Release[] = (await db.query("SELECT document FROM releases WHERE document->>'manifestHash'=$1 AND document->'environment'->>'id'=$2 ORDER BY id,revision LIMIT 50", [identity.digestHash, environment.id])).rows.map(row => row.document);
    const containsWork = (release: Release) => release.sourceSha === w.candidate?.sha || release.members.some(m => m.workId === w.id && m.included);
    const excluding = releases.filter(release => !containsWork(release)), including = releases.filter(containsWork);
    if ((containing.length || including.length) && !foreign.length && !excluding.length) {
      const release = including[0] ? { id: including[0].id, revision: including[0].revision } : undefined;
      const buildId = containing[0]?.id ?? (await this.releaseBuild(db, w, including[0]))?.id;
      // Membership alone cannot mint: a fresh candidate binds to a build attestation, so a
      // release that names the change without one stays blocked with the reason on record.
      if (!buildId) return { contains: null, release, reasons: ['A release names the change but no build attestation for this work item covers its manifest'] };
      return { contains: true, buildId, via: containing[0] ? 'build-attestation' : 'release-membership', release, reasons: [] };
    }
    if (!containing.length && !including.length && (foreign.length || excluding.length)) {
      return { contains: false, reasons: [`The observed target is a trusted manifest that does not contain the intended change (${foreign[0] ? `built from ${foreign[0].sourceSha}` : `release ${excluding[0].id} r${excluding[0].revision} does not include ${w.key}`})`] };
    }
    if (containing.length || including.length) return { contains: null, reasons: ['Trusted records disagree about whether the observed target contains the intended change'] };
    return { contains: null, reasons: ['The observed target matches no trusted build attestation or release manifest; membership is unknown'] };
  }
  /** A release that names the change must still be backed by a validation build attestation of this work item for the candidate to bind. */
  private async releaseBuild(db: pg.PoolClient, w: Work, release: Release | undefined) {
    if (!release) return undefined;
    const builds: BuildAttestation[] = (await db.query("SELECT document FROM validation_builds WHERE document->>'workId'=$1 ORDER BY document->>'at' DESC LIMIT 50", [w.id])).rows.map(row => row.document);
    return builds.find(b => digestHash(b.artifacts) === release.manifestHash && b.sourceSha === w.candidate?.sha && b.baseSha === w.candidate.baseSha);
  }
}
