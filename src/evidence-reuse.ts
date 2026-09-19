import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type pg from 'pg';
import { admin, demand, proofSchema, type Evidence, type Principal, type Work } from './model.js';
import { producerIndependenceRefusal } from './delegation.js';
import type { Attempt, BuildAttestation, Environment, ReusePolicy, Validation, ValidationCandidate, ValidationRequest } from './validation.js';

/**
 * D6 evidence reuse: the newest sequenced attempt for a proof may stand for a new head of
 * the same work item when an operator-defined applicability policy says nothing relevant
 * changed between the two. Every decision, granted or refused, is a durable record; a
 * grant selects a derived candidate bound to the executed attempt, so the gate evaluator,
 * reconciliation and every later live attempt treat it exactly like the original binding.
 * Nothing here relaxes the exact requirement, scenario, policy, bundle, environment and
 * freshness binding; a path the policy does not name is unknown, and unknown refuses.
 */
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/).max(150);
const pattern = z.string().min(1).max(300).regex(/^[^\s\\]+$/, 'Patterns are repository-relative paths without whitespace or backslashes').refine(p => !p.startsWith('/') && !p.split('/').includes('..'), 'Patterns are repository-relative');
const patterns = z.array(pattern).max(100).refine(a => new Set(a).size === a.length, 'Patterns must be unique');
export const reuseCategories = ['dependencies', 'lockfiles', 'buildInputs', 'configuration', 'migrations'] as const;
export type ReuseCategory = (typeof reuseCategories)[number];
/** The applicability definition an operator publishes as a `reuse` definition. */
export const reuseScopeSchema = z.object({
  dependencies: patterns, lockfiles: patterns, buildInputs: patterns, configuration: patterns, migrations: patterns,
  /** One pattern list per service of the environment; every service must be named. */
  services: z.record(name, patterns),
}).strict();
export const reuseDecisionSchema = z.object({ workId: z.uuid(), expectedWorkRevision: z.number().int().positive(), proof: proofSchema, policy: z.object({ id: name, revision: z.number().int().positive() }).strict(), buildAttestationId: z.uuid() }).strict();
export type ReuseClassification = 'relevant' | 'ignorable' | 'unknown';
export interface ChangedPath { path: string; change: 'added' | 'removed' | 'modified' | 'reverted'; classification: ReuseClassification; category: string | null }
export interface ReuseDecision {
  id: string; at: string; actor: string; workId: string; key: string; proof: string; policy: { id: string; revision: number };
  outcome: 'granted' | 'refused'; reasons: string[];
  /** The executed attempt the decision considered, when one exists. */
  of: { candidateId: string; requestId: string; attemptId: string; epoch: number; sequence: number | null; sourceSha: string; state: Attempt['state']; evidenceId: string | null; observedAt: string | null } | null;
  target: { sourceSha: string; baseSha: string; buildAttestationId: string };
  applicability: { changed: ChangedPath[]; buildInputsIdentical: boolean | null; artifactsIdentical: boolean | null; scopeKnown: boolean };
  /** Set on a grant: the derived candidate and the evidence entry it selected. */
  candidateId: string | null; evidenceId: string | null;
}

/**
 * A small glob: `**` matches any number of path segments, `*` matches within one segment,
 * `?` matches one character, everything else is literal. Anchored to the whole path.
 */
export function globRegExp(glob: string) {
  const segments = glob.split('/');
  let out = '^';
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if (segment === '**') { out += last ? '.*' : '(?:[^/]+/)*'; return; }
    out += segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    if (!last) out += '/';
  });
  return new RegExp(out + '$');
}
export const matchesGlob = (glob: string, path: string) => globRegExp(glob).test(path);

/** Relevant categories win over ignorable patterns; a path neither names is unknown. */
export function classifyPath(policy: Pick<ReusePolicy, 'relevant' | 'ignorable'>, path: string): { classification: ReuseClassification; category: string | null } {
  for (const category of reuseCategories) if (policy.relevant[category].some(glob => matchesGlob(glob, path))) return { classification: 'relevant', category };
  for (const [service, globs] of Object.entries(policy.relevant.services)) if (globs.some(glob => matchesGlob(glob, path))) return { classification: 'relevant', category: `services.${service}` };
  if (policy.ignorable.some(glob => matchesGlob(glob, path))) return { classification: 'ignorable', category: null };
  return { classification: 'unknown', category: null };
}
/**
 * The paths whose blob differs between two candidate file snapshots. A snapshot holds every
 * file the head changes against the base with the blob it holds there (null when the head
 * removes it), so a path present in one snapshot only was changed back to, or away from,
 * the base between the two heads.
 */
export function changedPaths(before: { path: string; sha: string | null }[], after: { path: string; sha: string | null }[]) {
  const was = new Map(before.map(f => [f.path, f.sha])), is = new Map(after.map(f => [f.path, f.sha]));
  const changed: { path: string; change: ChangedPath['change'] }[] = [];
  for (const [path, sha] of was) {
    if (!is.has(path)) changed.push({ path, change: 'reverted' });
    else if (is.get(path) !== sha) changed.push({ path, change: is.get(path) === null ? 'removed' : sha === null ? 'added' : 'modified' });
  }
  for (const [path, sha] of is) if (!was.has(path)) changed.push({ path, change: sha === null ? 'removed' : 'added' });
  return changed.sort((a, b) => a.path.localeCompare(b.path));
}

export class EvidenceReuse {
  constructor(readonly validation: Validation) {}
  get store() { return this.validation.store; }
  /** Definition-time checks for a `reuse` policy: its environment exists and every service of that environment has a scope. */
  async checkPolicy(db: pg.PoolClient, data: ReusePolicy & { enabled: boolean }) {
    const environment = await this.validation.definition(db, 'environment', data.environment, data.enabled) as Environment;
    const named = Object.keys(data.relevant.services).sort();
    demand(isDeepStrictEqual(named, [...environment.services].sort()), `A reuse policy must scope every service of its environment (${environment.services.join(', ')}) and no other`);
  }
  async decisions(cursor?: string) {
    const before = cursor ? z.coerce.number().int().positive().parse(cursor) : null;
    const rows = (await this.store.pool.query('SELECT seq,document FROM validation_reuse_decisions WHERE $1::bigint IS NULL OR seq<$1 ORDER BY seq DESC LIMIT 51', [before])).rows;
    const decisions: ReuseDecision[] = rows.slice(0, 50).map(r => r.document);
    return { decisions, nextCursor: rows.length > 50 ? String(rows[49].seq) : null };
  }
  /**
   * Decide whether the newest attempt's pass may stand for the work item's current head.
   * Authority faults (wrong revision, unknown policy, missing build provenance) refuse the
   * command; applicability findings are committed as a refused decision so that false and
   * avoided reuse can be measured. A grant is the only path that creates evidence.
   */
  async decide(actor: Principal, input: unknown, key: string) {
    admin(actor); const data = reuseDecisionSchema.parse(input);
    const v = this.validation;
    return v.withReceipt(actor, 'reuse', data, key, async (db, now) => {
      const w = await v.work(db, data.workId, now, data.expectedWorkRevision);
      demand(w.candidate && w.observation && w.observation.candidate.sha === w.candidate.sha && w.observation.candidate.baseSha === w.candidate.baseSha, 'Independently observed source required');
      const s = w.scenarioRequirements.find(s => s.proof === data.proof);
      demand(s && w.criteria.some(ac => ac.proofs.includes(data.proof)), 'Proof must be required by current work and pin a registered scenario');
      const policy = await v.definition(db, 'reuse', data.policy) as ReusePolicy;
      demand(policy.enabled, 'Reuse policy is disabled');
      const environment = await v.definition(db, 'environment', policy.environment) as Environment;
      demand(environment.repository === v.repository && environment.id === s!.environment, 'Reuse policy environment differs from the required scenario environment', 403);
      const build = (await db.query('SELECT document FROM validation_builds WHERE id=$1', [data.buildAttestationId])).rows[0]?.document as BuildAttestation | undefined;
      demand(build && build.workId === w.id && build.repository === v.repository && build.sourceSha === w.candidate!.sha && build.baseSha === w.candidate!.baseSha, 'Missing or mismatched trusted build provenance for the current head');
      const builder = await v.registration(db, build!.registration, 'builder'); demand(isDeepStrictEqual(builder.environment, policy.environment), 'Build environment differs');
      const decision: ReuseDecision = { id: randomUUID(), at: now.toISOString(), actor: actor.id, workId: w.id, key: w.key, proof: data.proof, policy: data.policy, outcome: 'refused', reasons: [],
        of: null, target: { sourceSha: w.candidate!.sha, baseSha: w.candidate!.baseSha, buildAttestationId: build!.id }, applicability: { changed: [], buildInputsIdentical: null, artifactsIdentical: null, scopeKnown: false }, candidateId: null, evidenceId: null };
      const refuse = (reason: string) => { decision.reasons.push(reason); };
      // The newest authority for this proof, by durable sequence. Anything still in flight,
      // and any newest attempt that is not a settled, accepted pass, forbids falling back.
      const live: ValidationRequest[] = (await db.query("SELECT document FROM validation_requests WHERE document->>'workId'=$1 AND document->>'proof'=$2 AND document->>'state' IN ('queued','dispatched','running','collecting')", [w.id, data.proof])).rows.map(r => r.document);
      for (const r of live) refuse(`Request ${r.id} is ${r.state}; a newer queued or running attempt prevents fallback to an older pass`);
      const newest = (await db.query('SELECT seq,request_id,attempt_id FROM validation_attempts WHERE work_id=$1 AND proof=$2 ORDER BY seq DESC LIMIT 1', [w.id, data.proof])).rows[0];
      let previous: ValidationCandidate | null = null, evidence: Evidence | undefined, attempt: Attempt | undefined, request: ValidationRequest | undefined;
      if (!newest) refuse('No sequenced attempt exists for this proof; live verification is required');
      else {
        request = await v.request(db, newest.request_id); attempt = request.attempts.find(a => a.id === newest.attempt_id);
        previous = await v.candidate(db, request.candidateId);
        evidence = w.evidence.find(e => e.trusted && !e.revocation && !e.reuse && !!e.validation && e.validation.attemptId === attempt?.id && e.validation.requestId === request!.id && e.validation.candidateId === previous!.id);
        decision.of = { candidateId: previous.id, requestId: request.id, attemptId: attempt?.id ?? newest.attempt_id, epoch: attempt?.epoch ?? 0, sequence: Number(newest.seq), sourceSha: previous.sourceSha, state: attempt?.state ?? 'superseded', evidenceId: evidence?.id ?? null, observedAt: evidence?.at ?? null };
        if (!attempt || attempt.state !== 'completed' || !request.result?.accepted || !request.result.passed || !evidence || evidence.result !== 'pass')
          refuse(`Newest attempt ${attempt?.epoch ?? '?'} of request ${request.id} is ${attempt?.state ?? 'unknown'}${request.result ? ` (${request.result.passed ? 'passed' : `not passed: ${request.result.reasons.join('; ')}`})` : ''}; only a settled, accepted pass can be reused and a blocked, timed-out, unmeasured or incomplete attempt prevents fallback`);
        else {
          if (!attempt.settled) refuse('The newest attempt was never verified settled');
          if (evidence.expiresAt && Date.parse(evidence.expiresAt) <= now.getTime()) refuse('The reused evidence has expired (artifact retention)');
          if (Date.parse(evidence.at) + policy.freshnessSeconds * 1000 <= now.getTime()) refuse(`The newest pass was observed at ${evidence.at}, older than the policy freshness of ${policy.freshnessSeconds}s`);
          const dependent = producerIndependenceRefusal(v.principals.find(p => p.id === evidence!.producer) ?? { id: evidence.producer, role: 'producer' }, w, v.principals);
          if (dependent) refuse(dependent);
        }
        // Exact binding: requirement/proof policy revision, scenario revision and hash, the
        // approved bundle and environment revisions, and the base the head was compared to.
        if (previous.proof !== data.proof) refuse('The newest attempt proved a different proof');
        if (previous.policyRevision !== w.policyRevision) refuse(`Requirement or proof policy revision changed (attempt at v${previous.policyRevision}, work at v${w.policyRevision}); reuse is bound to the exact revision`);
        if (!isDeepStrictEqual(previous.scenario, s)) refuse('Scenario revision, hash or environment changed since the attempt; reuse is bound to the exact scenario pin');
        if (previous.baseSha !== w.candidate!.baseSha) refuse('The base the attempt was compared to differs from the current base; changes on the base branch are outside the applicability scope');
        if (!isDeepStrictEqual(previous.environment, policy.environment)) refuse('Target environment scope differs from the reuse policy environment');
        try { await v.definition(db, 'environment', previous.environment); } catch { refuse('The environment revision the attempt ran against is no longer current'); }
        try { await v.definition(db, 'bundle', previous.bundle); } catch { refuse('The approved oracle bundle revision the attempt executed is no longer current'); }
        const previousBuild = (await db.query('SELECT document FROM validation_builds WHERE id=$1', [previous.buildAttestationId])).rows[0]?.document as BuildAttestation | undefined;
        decision.applicability.buildInputsIdentical = !!previousBuild && previousBuild.buildInputsDigest === build!.buildInputsDigest;
        decision.applicability.artifactsIdentical = !!previousBuild && isDeepStrictEqual([...previousBuild.artifacts].sort((a, b) => a.service.localeCompare(b.service)), [...build!.artifacts].sort((a, b) => a.service.localeCompare(b.service)));
        if (!decision.applicability.buildInputsIdentical) refuse('Declared build inputs differ between the attempt\'s build and the current build');
        if (!decision.applicability.artifactsIdentical && policy.artifacts === 'identical') refuse('Built artifacts differ and the reuse policy requires identical artifacts');
        // Applicability over the two independently observed file snapshots. No snapshot on
        // either side means the scope is unknown, and unknown never widens applicability.
        const files = w.observation!.scopeFiles?.map(f => ({ path: f.path, sha: f.sha }));
        if (!previous.files || !files) { decision.applicability.scopeKnown = false; refuse('The changed files of the attempt\'s head or the current head were not independently observed; missing scope falls back to exact source binding'); }
        else {
          decision.applicability.scopeKnown = true;
          decision.applicability.changed = changedPaths(previous.files, files).map(c => ({ ...c, ...classifyPath(policy, c.path) }));
          for (const c of decision.applicability.changed) {
            if (c.classification === 'relevant') refuse(`${c.path} (${c.change}) is a relevant ${c.category} change`);
            else if (c.classification === 'unknown') refuse(`${c.path} (${c.change}) is not covered by the reuse policy; unknown scope never widens applicability`);
          }
        }
      }
      if (!decision.reasons.length && previous && request && attempt && evidence) {
        decision.outcome = 'granted';
        const candidate: ValidationCandidate = { workId: w.id, expectedWorkRevision: data.expectedWorkRevision, proof: data.proof, environment: previous.environment, bundle: previous.bundle, buildAttestationId: build!.id, requiredArtifacts: previous.requiredArtifacts, artifactStorage: previous.artifactStorage,
          id: randomUUID(), sourceSha: w.candidate!.sha, baseSha: w.candidate!.baseSha, policyRevision: w.policyRevision, scenario: s!, files: w.observation!.scopeFiles!.map(f => ({ path: f.path, sha: f.sha })), createdAt: now.toISOString(), createdBy: actor.id,
          reuse: { decisionId: decision.id, of: { candidateId: previous.id, requestId: request.id, attemptId: attempt.id, sequence: Number(newest.seq) } } };
        await db.query('INSERT INTO validation_candidates(id,document) VALUES($1,$2)', [candidate.id, JSON.stringify(candidate)]);
        const freshUntil = Date.parse(evidence.at) + policy.freshnessSeconds * 1000;
        const expiresAt = new Date(evidence.expiresAt ? Math.min(Date.parse(evidence.expiresAt), freshUntil) : freshUntil).toISOString();
        const { id: _id, validation: _binding, ...inherited } = evidence; void _id; void _binding;
        const derived: Evidence = { ...inherited, id: randomUUID(), sha: w.candidate!.sha, baseSha: w.candidate!.baseSha, policyRevision: w.policyRevision, at: now.toISOString(), expiresAt,
          validation: { candidateId: candidate.id, requestId: request.id, attemptId: attempt.id },
          reuse: { decisionId: decision.id, evidenceId: evidence.id, candidateId: previous.id, requestId: request.id, attemptId: attempt.id, sequence: Number(newest.seq), sourceSha: previous.sourceSha, observedAt: evidence.at, policy: data.policy } };
        (w.validation ??= {})[data.proof] = { candidateId: candidate.id, requestId: request.id, attemptId: attempt.id };
        w.evidence.push(derived);
        decision.candidateId = candidate.id; decision.evidenceId = derived.id;
      }
      await db.query('INSERT INTO validation_reuse_decisions(id,work_id,proof,document) VALUES($1,$2,$3,$4)', [decision.id, w.id, data.proof, JSON.stringify(decision)]);
      if (decision.outcome === 'granted') await v.changed(db, w, actor.id, 'reuse-granted', now, { decision });
      else await v.event(db, actor.id, 'reuse-refused', { decision }, w.id);
      return decision;
    }) as Promise<ReuseDecision>;
  }
}
