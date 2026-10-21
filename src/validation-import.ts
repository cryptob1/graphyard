// Concern: importing an external test run into the control plane (GY-1860) — bound by its sha to
// the release candidate cut there, kept in the event ledger with its provenance, idempotent by run
// id, and the hold the imported runs leave on that candidate.
import { isDeepStrictEqual } from 'node:util';
import type pg from 'pg';
import type { Principal } from './model.js';
import { Refusal, demand } from './model/refusal.js';
import type { Store } from './store.js';
import { importExternalRun, type ExternalRunResult } from './runner-report.js';
import { importedRunVerdict, type FlakyAcceptance, type ImportedBlockingCase } from './e2e/runner.js';
import { candidateAtHead, candidateTagPrefix, type PromotionImports, type ReleaseCandidate } from './release-candidate.js';
import { externalRunsImportGrant } from './server/principals.js';
import type { GitRunner } from './merge-writer/local-observation.js';

/**
 * GY-1842 gave the format and the verdict rule (`importExternalRun`, `importedRunVerdict`); this
 * module is the one way a run gets in from outside the process. A producer credential holding the
 * `external-runs:import` grant (GY-1879; the grant authorizes nothing else, and no proof evidence) posts one
 * run; the plane binds it to the release candidate whose head is exactly the run's `sha` — read
 * from the repository's `rc/` tags in the coordinator checkout (GY-2010: no GitHub read), the ledger `release cut` writes, never
 * from a candidate id the producer names — and refuses a run cut at no candidate. The record keeps
 * every verdict as given (`skipped` stays skipped) and the run's provenance: run and case ids,
 * the original result values, evidence links, the tool version and the catalog commit, which is
 * provenance only and never read into a case's version. Imports are rows of the append-only event
 * ledger under `importEventKind`; a run id names one run, so the same document replays its record
 * and a different document under a used id is refused. The first import at a candidate binds it to
 * the importing producer principal (not the free-text `producer` field): any other principal's
 * import there is refused, so only the bound producer's runs feed its hold.
 *
 * The hold the imports leave on the candidate is `importedRunVerdict`'s rule over each case's
 * newest report: a required failed, blocked, unrun or skipped case holds the candidate until a
 * later import reports that case passing at the same head, and an import whose every case passes
 * releases what earlier imports held. No flaky acceptance or pending outcome is applied here. The
 * hold is the candidate's own: runs bound to another candidate cut at the same commit never count,
 * and promotion (`assessPromotion`) reads it through `promotionImports`, so a held candidate is
 * refused production. A promotion workflow reads it in one job and promotes in another, so it reads
 * through `sealImports`, which closes a released candidate to imports, and the production job trusts
 * only a sealed released hold (`handedImports`).
 */
export const importEventKind = 'validation.import';

/** One imported run as the ledger keeps it: the normalised run, the candidate it bound to, and who imported it when. */
export interface ImportedRunRecord { run: ExternalRunResult; candidate: { id: string; sha: string }; importedBy: string; importedAt: string }
/** A case holding the candidate, and the imported run whose verdict holds it. */
export interface HeldCase extends ImportedBlockingCase { runId: string }
/** The candidate's hold as its imported runs leave it: held while any case's newest verdict blocks. */
export interface ImportedHold { held: boolean; cases: HeldCase[]; runs: number }

/**
 * Pure: the hold `records` (oldest first) leave on their candidate. Each case is judged by the
 * newest import that reports it, under `importedRunVerdict`'s rule for that run — so a case a
 * later run passes is released, a case a later run omits stays held by the run that last reported
 * it, and a run whose every case passes releases everything it covers. A case is required once any
 * import at the candidate reported it required, so a later report that drops the flag cannot release
 * a required failure without a pass.
 */
export function importedHold(records: readonly ImportedRunRecord[], acceptances: readonly FlakyAcceptance[] = [], pendingCases: readonly string[] = []): ImportedHold {
  // A case any import at this candidate reported required stays required: a later report leaving the flag out releases it only by passing.
  const required = new Set(records.flatMap(record => record.run.cases.filter(entry => entry.required).map(entry => entry.id)));
  const seen = new Set<string>(), cases: HeldCase[] = [];
  for (const record of [...records].reverse()) {
    const run = { ...record.run, cases: record.run.cases.map(entry => required.has(entry.id) ? { ...entry, required: true } : entry) };
    const blocking = new Map(importedRunVerdict(run, acceptances, pendingCases).blocking.map(entry => [entry.id, entry]));
    for (const entry of record.run.cases) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const block = blocking.get(entry.id);
      if (block) cases.push({ ...block, runId: record.run.runId });
    }
  }
  return { held: cases.length > 0, cases, runs: records.length };
}

/** The release ledger as the coordinator checkout holds it: its `rc/` tag refs, and one annotated tag object's target and message. */
export interface LedgerReader {
  tags(prefix: string): Promise<TagRef[]>;
  tag(objectSha: string): Promise<{ object: string; message: string } | null>;
}
interface TagRef { ref: string; object: { sha: string; type: string } }
const cachedTags = 5000;
/** Annotated tags never move, so a tag object's record is read once per process. */
const tagRecords = new Map<string, ReleaseCandidate | null>();

/** The ledger read through `git` in the checkout the plane serves from (GY-2010): the tags the loop's fetch brought in. */
export function gitLedger(run: GitRunner): LedgerReader {
  return {
    async tags(prefix) {
      const listed = await run(['for-each-ref', '--format=%(refname) %(objectname) %(objecttype)', `refs/tags/${prefix}`]);
      if (listed.status !== 0) throw new Refusal(`The release candidate tags could not be read from the coordinator checkout: ${listed.stderr || `git exited ${listed.status}`}`, 502);
      return listed.stdout.split('\n').filter(Boolean).map(line => { const [ref, sha, type] = line.split(' '); return { ref: ref!, object: { sha: sha!, type: type! } }; });
    },
    async tag(objectSha) {
      const read = await run(['cat-file', 'tag', objectSha]);
      if (read.status !== 0) return null;
      const split = read.stdout.indexOf('\n\n');
      const object = /^object ([0-9a-f]+)$/m.exec(split < 0 ? read.stdout : read.stdout.slice(0, split))?.[1];
      return object ? { object, message: split < 0 ? '' : read.stdout.slice(split + 2) } : null;
    },
  };
}

/** The candidate record one `rc/` tag carries, or null for a tag that is not a readable candidate record. */
async function candidateRecord(ledger: LedgerReader, ref: TagRef): Promise<ReleaseCandidate | null> {
  const cached = tagRecords.get(ref.object.sha);
  if (cached !== undefined) return cached;
  let record: ReleaseCandidate | null = null;
  if (ref.object.type === 'tag') {
    const tag = await ledger.tag(ref.object.sha);
    try {
      const parsed = JSON.parse(tag?.message ?? '');
      // The record is trusted only where it agrees with the tag: the head it names is the commit the tag marks.
      if (parsed && typeof parsed.id === 'string' && typeof parsed.sha === 'string' && typeof parsed.cutAt === 'string' && parsed.sha === tag?.object) record = parsed as ReleaseCandidate;
    } catch { record = null; }
  }
  if (tagRecords.size >= cachedTags) tagRecords.delete(tagRecords.keys().next().value!);
  tagRecords.set(ref.object.sha, record);
  return record;
}

/**
 * The newest release candidate whose head is `sha`, read from the repository's `rc/` tags newest
 * first (candidate ids are compact instants, so the tag name orders them): tags are dereferenced
 * only until the first match, which is the newest.
 */
export async function candidatesAtHead(ledger: LedgerReader, sha: string): Promise<ReleaseCandidate[]> {
  const refs = (await ledger.tags(candidateTagPrefix)).filter(entry => entry.ref.startsWith(`refs/tags/${candidateTagPrefix}`) && !!entry.object.sha);
  for (const ref of refs.sort((a, b) => b.ref.localeCompare(a.ref))) {
    const record = await candidateRecord(ledger, ref);
    if (record?.sha === sha) return [record];
  }
  return [];
}

type Db = Pick<pg.PoolClient, 'query'>;
/**
 * The runs bound to one candidate, oldest first: its id and head both, so another cut at the same
 * commit keeps its own history. Only the bound producer's count: the principal of the first import.
 */
const importedRuns = async (db: Db, candidate: { id: string; sha: string }): Promise<ImportedRunRecord[]> => {
  const records = (await db.query(`SELECT payload FROM events WHERE kind=$1 AND payload->'candidate'->>'sha'=$2 AND payload->'candidate'->>'id'=$3 ORDER BY seq`, [importEventKind, candidate.sha, candidate.id])).rows.map(row => row.payload as ImportedRunRecord);
  return records.filter(record => record.importedBy === records[0].importedBy);
};
/** The event that seals a candidate's released hold for promotion: no import binds to it afterwards. */
export const importSealEventKind = 'validation.import.seal';
export interface ImportSeal { candidate: { id: string; sha: string }; sealedBy: string; sealedAt: string; runs: number }
const importSeal = async (db: Db, candidate: { id: string; sha: string }): Promise<ImportSeal | undefined> =>
  (await db.query(`SELECT payload FROM events WHERE kind=$1 AND payload->'candidate'->>'sha'=$2 AND payload->'candidate'->>'id'=$3 ORDER BY seq LIMIT 1`, [importSealEventKind, candidate.sha, candidate.id])).rows[0]?.payload as ImportSeal | undefined;
/** The lock every import and seal at one candidate takes, so the binding, the seal and the hold read one history. */
const lockCandidate = (db: Db, candidate: { id: string; sha: string }) => db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${importEventKind}:candidate:${candidate.id}:${candidate.sha}`]);
/** Refuses `actor` at a candidate whose first import bound it to another producer principal (N4). */
const boundProducer = (records: readonly ImportedRunRecord[], actor: Principal, candidate: { id: string; sha: string }) => {
  const bound = records[0]?.importedBy;
  demand(!bound || bound === actor.id, `Candidate ${candidate.id} at ${candidate.sha} is bound to producer ${bound}, which made its first import; an import from ${actor.id} is refused`, 409);
};
/** The record a producer's run id already holds, if any. */
const committedRun = async (db: Db, run: ExternalRunResult): Promise<ImportedRunRecord | undefined> =>
  (await db.query(`SELECT payload FROM events WHERE kind=$1 AND payload->'run'->>'producer'=$2 AND payload->'run'->>'runId'=$3 ORDER BY seq LIMIT 1`, [importEventKind, run.producer, run.runId])).rows[0]?.payload as ImportedRunRecord | undefined;
const sameRun = (existing: ImportedRunRecord, run: ExternalRunResult) =>
  demand(isDeepStrictEqual(existing.run, run), `Run ${run.runId} from ${run.producer} was already imported with a different document; a run id names one run`, 409);

/** What the import needs of the control plane: its store and the release ledger it binds runs through. */
export interface ImportPlane { store: Store; ledger: LedgerReader }

/**
 * Import one run for `actor`. Refuses any credential but a producer's holding `external-runs:import` (403), a run naming no head
 * (400), a ledger the checkout cannot read (502), a head no candidate was
 * cut at (409), a candidate bound to another producer principal (409) and a sealed candidate (409). The record is written once per producer and run id: the same document again replays
 * it (`replayed`) with the candidate it bound to, read from the record before any ledger read, so a
 * replay succeeds while the ledger is unreadable; a different one under that id is refused (409). A
 * first import is rechecked under the run's lock, so concurrent first imports write once. The answer
 * carries the record, this run's own verdict and the candidate's hold after the import.
 */
export async function importRun(plane: ImportPlane, actor: Principal, input: unknown, now = new Date()) {
  demand(actor.role === 'producer', 'A producer credential is required to import an external run', 403);
  demand(actor.grants?.includes(externalRunsImportGrant), `Importing an external run requires the ${externalRunsImportGrant} grant; producer ${actor.id} holds ${actor.grants?.length ? actor.grants.join(', ') : 'no grant'}`, 403);
  const run = importExternalRun(input);
  demand(run.sha, 'An imported run binds to a release candidate by its head: give the candidate `sha` the run tested', 400);
  const committed = await committedRun(plane.store.pool, run);
  if (committed) {
    const records = await importedRuns(plane.store.pool, committed.candidate);
    boundProducer(records, actor, committed.candidate);
    sameRun(committed, run);
    return { imported: committed, replayed: true, verdict: importedRunVerdict(run), hold: importedHold(records) };
  }
  const candidate = candidateAtHead(await candidatesAtHead(plane.ledger, run.sha), run.sha);
  demand(candidate, `No release candidate was cut at ${run.sha}; an import binds only to a candidate's exact head`, 409);
  const record: ImportedRunRecord = { run, candidate: { id: candidate.id, sha: candidate.sha }, importedBy: actor.id, importedAt: now.toISOString() };
  return plane.store.transaction(async db => {
    await lockCandidate(db, record.candidate);
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${importEventKind}:${run.producer}:${run.runId}`]);
    const existing = await committedRun(db, run);
    const bound = existing?.candidate ?? record.candidate;
    if (existing) { boundProducer(await importedRuns(db, bound), actor, bound); sameRun(existing, run); }
    else {
      boundProducer(await importedRuns(db, bound), actor, bound);
      const seal = await importSeal(db, bound);
      demand(!seal, `Candidate ${bound.id} at ${bound.sha} was sealed for promotion at ${seal?.sealedAt} by ${seal?.sealedBy} with its hold released; import against the next candidate`, 409);
      await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, importEventKind, JSON.stringify(record)]);
    }
    return { imported: existing ?? record, replayed: !!existing, verdict: importedRunVerdict(run), hold: importedHold(await importedRuns(db, bound)) };
  }, { coordinationLock: false });
}

/**
 * The imports bound to one candidate at `sha`, oldest first, and the hold they leave; open to every
 * authenticated reader. `candidate` names it by id; left out, it is the newest candidate any import
 * at `sha` bound to.
 */
export async function readImports(plane: Pick<ImportPlane, 'store'>, sha: string, candidate?: string | null, importer?: string) {
  demand(/^[a-f0-9]{40}$/.test(sha), 'A candidate head is a 40-hex commit', 400);
  // `importer` (GY-1879) limits the read to the runs that principal imported: a lane-only producer reads only its own.
  const id = candidate || (await plane.store.pool.query(`SELECT max(payload->'candidate'->>'id') AS id FROM events WHERE kind=$1 AND payload->'candidate'->>'sha'=$2 AND ($3::text IS NULL OR payload->>'importedBy'=$3)`, [importEventKind, sha, importer ?? null])).rows[0]?.id as string | null;
  const runs = id ? (await importedRuns(plane.store.pool, { id, sha })).filter(record => !importer || record.importedBy === importer) : [];
  return { sha, candidate: id ? { id, sha } : null, runs, hold: importedHold(runs), sealed: id ? !!await importSeal(plane.store.pool, { id, sha }) : false };
}

/** The roles that may seal a candidate's imports for promotion: an admin, or an operator agent (the release-filing identity). */
export const sealRoles = ['admin', 'operator-agent'] as const;
export type SealAuthority = { mayseal: true; role: string } | { mayseal: false; role: string; needed: string[] };
/**
 * GY-1882: whether `actor` may seal, answered without sealing anything or writing an event, so a
 * promotion workflow checks its credential before soak and UAT results are spent on a seal it
 * cannot make (`GET /api/validation/import/seal-authority`, `graphyard release seal-check`).
 */
export const sealAuthority = (actor: Principal): SealAuthority =>
  (sealRoles as readonly string[]).includes(actor.role) ? { mayseal: true, role: actor.role } : { mayseal: false, role: actor.role, needed: [...sealRoles] };
/** Whether a seal-authority read failed only because the plane predates its route: 404, or the operator-agent guard's 403 for a route it did not yet allow. */
export const sealAuthorityUnserved = (error: { status?: number; message?: string } | null | undefined) =>
  error?.status === 404 || (error?.status === 403 && /Route is not available to operator agents/.test(error.message ?? ''));
/**
 * A valid operator-agent token scoped to another repository: auth refuses 403 before the route runs
 * (`Repository is outside operator-agent scope`). Seal-check records that as a denial — the uat secret
 * cannot seal here — without weakening the server's scope rule.
 */
export const sealAuthorityOutOfScope = (error: { status?: number; message?: string } | null | undefined) =>
  error?.status === 403 && /Repository is outside operator-agent scope/.test(error.message ?? '');
/** Where the workflows hold the credential `release imports` seals with: the uat environment's release-filing secret. */
export const sealCredential = { secret: 'GRAPHYARD_RELEASE_TOKEN', environment: 'uat' } as const;
/** The ledger records `release seal-check ID` writes, one per check, on the candidate's exact SHA (`rc-seal-check/ID.AT`). */
export const sealCheckTagPrefix = 'rc-seal-check/';
export interface SealCheckRecord { id: string; sha: string; at: string; mayseal: boolean; role: string; needed: string[]; secret: string; environment: string }
export function sealCheckRecord(candidate: Pick<ReleaseCandidate, 'id' | 'sha'>, answer: SealAuthority, now: Date): SealCheckRecord {
  return { id: candidate.id, sha: candidate.sha, at: now.toISOString(), mayseal: answer.mayseal, role: answer.role, needed: answer.mayseal ? [] : answer.needed, ...sealCredential };
}
export const sealCheckTag = (record: SealCheckRecord) => `${sealCheckTagPrefix}${record.id}.${record.at.replace(/[-:]/g, '')}`;

/**
 * Read candidate `id`'s hold at `sha` for promotion and, when it is released, seal it in the same
 * transaction under the candidate's lock: no import binds to the candidate afterwards, so the hold a
 * promotion workflow reads in one job is still the plane's hold when a later job promotes. A held
 * candidate is not sealed, so a passing import can still release it. Admins and operator agents (the
 * release-filing identity the workflows hold) seal; sealing twice answers the standing seal.
 */
export async function sealImports(plane: Pick<ImportPlane, 'store'>, actor: Principal, sha: string, input: unknown, now = new Date()) {
  demand(sealAuthority(actor).mayseal, 'Sealing a candidate\'s imports for promotion needs an admin or the release-filing identity', 403);
  demand(/^[a-f0-9]{40}$/.test(sha), 'A candidate head is a 40-hex commit', 400);
  const id = (input as { candidate?: unknown } | null)?.candidate;
  demand(typeof id === 'string' && /^[0-9A-Za-z._-]{1,100}$/.test(id), 'Name the candidate whose imports are sealed: {"candidate":"ID"}', 400);
  const candidate = { id: id as string, sha };
  return plane.store.transaction(async db => {
    await lockCandidate(db, candidate);
    const runs = await importedRuns(db, candidate), hold = importedHold(runs);
    let seal = await importSeal(db, candidate);
    if (!seal && !hold.held) {
      seal = { candidate, sealedBy: actor.id, sealedAt: now.toISOString(), runs: runs.length };
      await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, importSealEventKind, JSON.stringify(seal)]);
    }
    return { sha, candidate, runs, hold, sealed: !!seal };
  }, { coordinationLock: false });
}

/**
 * The hold promotion reads for `candidate`, through `read` (an authenticated `GET /api/PATH`). A
 * plane that serves no import route (404, a server older than GY-1860) holds nothing; any other
 * failure is `unread`, which refuses promotion rather than reading an unknown hold as released.
 */
export async function promotionImports(read: (path: string) => Promise<any>, candidate: Pick<ReleaseCandidate, 'id' | 'sha'>): Promise<PromotionImports> {
  try {
    const answer = await read(`validation/import/${candidate.sha}?candidate=${encodeURIComponent(candidate.id)}`);
    const hold = answer?.hold;
    if (!hold || typeof hold.held !== 'boolean' || !Array.isArray(hold.cases)) return { unread: 'the plane answered no hold' };
    return { held: hold.held, cases: hold.cases.map((entry: HeldCase) => ({ id: String(entry.id), verdict: String(entry.verdict), runId: String(entry.runId) })) };
  } catch (error: any) {
    if (error?.status === 404) return { held: false, cases: [] };
    return { unread: error?.message ?? String(error) };
  }
}

/** A promotion hold as `release imports` hands it on: released only once the plane sealed it. */
export type SealedImports = PromotionImports & { sealed?: boolean };
/**
 * The hold `release imports` reads and seals for `candidate` through `post` (an authenticated
 * `POST /api/PATH`): `sealed` when the plane closed the candidate to imports with its hold released.
 * A plane that serves no import route (404) records no imports at all; any other failure is `unread`.
 */
export async function sealedImports(post: (path: string, data: unknown) => Promise<any>, candidate: Pick<ReleaseCandidate, 'id' | 'sha'>): Promise<SealedImports> {
  try {
    const answer = await post(`validation/import/${candidate.sha}/seal`, { candidate: candidate.id });
    const hold = answer?.hold;
    if (!hold || typeof hold.held !== 'boolean' || !Array.isArray(hold.cases)) return { unread: 'the plane answered no hold' };
    return { held: hold.held, cases: hold.cases.map((entry: HeldCase) => ({ id: String(entry.id), verdict: String(entry.verdict), runId: String(entry.runId) })), sealed: answer.sealed === true };
  } catch (error: any) {
    if (error?.status === 404) return { held: false, cases: [], sealed: true };
    return { unread: error?.message ?? String(error) };
  }
}

/** The environment variable a promotion job is handed the hold in, as `release imports` printed it. */
export const handedImportsVariable = 'GRAPHYARD_PROMOTION_IMPORTS';
/**
 * The hold a promotion job was handed by `release imports` in an earlier job of its run — a
 * production job holds no plane credential, so the job before it, in the uat environment, reads the
 * hold. It counts only for the candidate it was read for, at that head, and a released hold counts
 * only when the plane sealed it, so no import can land between that read and this promotion;
 * anything else, or text that is no hold, is `unread` and refuses promotion.
 */
export function handedImports(text: string, candidate: Pick<ReleaseCandidate, 'id' | 'sha'>): PromotionImports {
  let handed: any;
  try { handed = JSON.parse(text); } catch { return { unread: `${handedImportsVariable} is not the JSON release imports prints` }; }
  if (handed?.candidate !== candidate.id || handed?.sha !== candidate.sha) return { unread: `${handedImportsVariable} was read for candidate ${handed?.candidate ?? 'none'}, not ${candidate.id} at ${candidate.sha}` };
  const imports = handed.imports;
  if (imports && typeof imports.unread === 'string') return { unread: imports.unread };
  if (!imports || typeof imports.held !== 'boolean' || !Array.isArray(imports.cases)) return { unread: `${handedImportsVariable} carries no hold` };
  if (!imports.held && imports.sealed !== true) return { unread: `${handedImportsVariable} carries a released hold the plane did not seal, so an import may have landed since it was read` };
  return { held: imports.held, cases: imports.cases.map((entry: any) => ({ id: String(entry.id), verdict: String(entry.verdict), runId: String(entry.runId) })) };
}
