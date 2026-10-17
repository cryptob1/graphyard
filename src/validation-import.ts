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
import { candidateAtHead, candidateTagPrefix, type ReleaseCandidate } from './release-candidate.js';

/**
 * GY-1842 gave the format and the verdict rule (`importExternalRun`, `importedRunVerdict`); this
 * module is the one way a run gets in from outside the process. A producer credential posts one
 * run; the plane binds it to the release candidate whose head is exactly the run's `sha` — read
 * from the repository's `rc/` tags through the GitHub App, the ledger `release cut` writes, never
 * from a candidate id the producer names — and refuses a run cut at no candidate. The record keeps
 * every verdict as given (`skipped` stays skipped) and the run's provenance: run and case ids,
 * the original result values, evidence links, the tool version and the catalog commit, which is
 * provenance only and never read into a case's version. Imports are rows of the append-only event
 * ledger under `importEventKind`; a run id names one run, so the same document replays its record
 * and a different document under a used id is refused.
 *
 * The hold the imports leave on the candidate is `importedRunVerdict`'s rule over each case's
 * newest report: a required failed, blocked, unrun or skipped case holds the candidate until a
 * later import reports that case passing at the same head, and an import whose every case passes
 * releases what earlier imports held. No flaky acceptance or pending outcome is applied here.
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
 * it, and a run whose every case passes releases everything it covers.
 */
export function importedHold(records: readonly ImportedRunRecord[], acceptances: readonly FlakyAcceptance[] = [], pendingCases: readonly string[] = []): ImportedHold {
  const seen = new Set<string>(), cases: HeldCase[] = [];
  for (const record of [...records].reverse()) {
    const blocking = new Map(importedRunVerdict(record.run, acceptances, pendingCases).blocking.map(entry => [entry.id, entry]));
    for (const entry of record.run.cases) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const block = blocking.get(entry.id);
      if (block) cases.push({ ...block, runId: record.run.runId });
    }
  }
  return { held: cases.length > 0, cases, runs: records.length };
}

/** What the ledger read needs of the GitHub adapter: repository-relative API reads. */
export interface LedgerReader { request(path: string, method?: string, body?: unknown): Promise<any> }
interface TagRef { ref: string; object: { sha: string; type: string } }
const refPage = 100, refPages = 50, cachedTags = 4000;
/** Annotated tags never move, so a tag object's record is read from GitHub once per process. */
const tagRecords = new Map<string, ReleaseCandidate | null>();

/** The candidate record one `rc/` tag carries, or null for a tag that is not a readable candidate record. */
async function candidateRecord(github: LedgerReader, ref: TagRef): Promise<ReleaseCandidate | null> {
  const cached = tagRecords.get(ref.object.sha);
  if (cached !== undefined) return cached;
  let record: ReleaseCandidate | null = null;
  if (ref.object.type === 'tag') {
    const tag = await github.request(`/git/tags/${ref.object.sha}`);
    try {
      const parsed = JSON.parse(String(tag?.message ?? ''));
      // The record is trusted only where it agrees with the tag: the head it names is the commit the tag marks.
      if (parsed && typeof parsed.id === 'string' && typeof parsed.sha === 'string' && typeof parsed.cutAt === 'string' && parsed.sha === tag?.object?.sha) record = parsed as ReleaseCandidate;
    } catch { record = null; }
  }
  if (tagRecords.size >= cachedTags) tagRecords.delete(tagRecords.keys().next().value!);
  tagRecords.set(ref.object.sha, record);
  return record;
}

/**
 * The release candidates whose head is `sha`, read from the repository's `rc/` tags newest first
 * (candidate ids are compact instants, so the tag name orders them). Every tag is read until a
 * match is found; a ledger with none at this head is read whole, once, and kept.
 */
export async function candidatesAtHead(github: LedgerReader, sha: string): Promise<ReleaseCandidate[]> {
  const refs: TagRef[] = [];
  for (let page = 1; page <= refPages; page++) {
    const batch = await github.request(`/git/matching-refs/tags/${candidateTagPrefix}?per_page=${refPage}&page=${page}`);
    if (!Array.isArray(batch)) throw new Refusal('GitHub did not return the release candidate tags', 502);
    refs.push(...batch.filter((entry: TagRef) => typeof entry?.ref === 'string' && entry.ref.startsWith(`refs/tags/${candidateTagPrefix}`) && typeof entry.object?.sha === 'string'));
    if (batch.length < refPage) break;
  }
  const matching: ReleaseCandidate[] = [];
  for (const ref of refs.sort((a, b) => b.ref.localeCompare(a.ref))) {
    const record = await candidateRecord(github, ref);
    if (record?.sha === sha) matching.push(record);
  }
  return matching;
}

const importedRuns = async (db: Pick<pg.PoolClient, 'query'>, sha: string): Promise<ImportedRunRecord[]> =>
  (await db.query(`SELECT payload FROM events WHERE kind=$1 AND payload->'candidate'->>'sha'=$2 ORDER BY seq`, [importEventKind, sha])).rows.map(row => row.payload as ImportedRunRecord);

/** What the import needs of the control plane: its store and the GitHub adapter the ledger is read through. */
export interface ImportPlane { store: Store; github: LedgerReader | null }

/**
 * Import one run for `actor`. Refuses any credential but a producer's (403), a run naming no head
 * (400), a plane with no GitHub adapter to read the ledger through (503) and a head no candidate was
 * cut at (409). The record is written once per producer and run id: the same document again replays
 * it (`replayed`), a different one under that id is refused (409). The answer carries the record,
 * this run's own verdict and the candidate's hold after the import.
 */
export async function importRun(plane: ImportPlane, actor: Principal, input: unknown, now = new Date()) {
  demand(actor.role === 'producer', 'A producer credential is required to import an external run', 403);
  const run = importExternalRun(input);
  demand(run.sha, 'An imported run binds to a release candidate by its head: give the candidate `sha` the run tested', 400);
  demand(plane.github, 'The control plane reads the release ledger through its GitHub App, and none is configured', 503);
  const candidate = candidateAtHead(await candidatesAtHead(plane.github, run.sha), run.sha);
  demand(candidate, `No release candidate was cut at ${run.sha}; an import binds only to a candidate's exact head`, 409);
  const record: ImportedRunRecord = { run, candidate: { id: candidate.id, sha: candidate.sha }, importedBy: actor.id, importedAt: now.toISOString() };
  return plane.store.transaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${importEventKind}:${run.producer}:${run.runId}`]);
    const existing = (await db.query(`SELECT payload FROM events WHERE kind=$1 AND payload->'run'->>'producer'=$2 AND payload->'run'->>'runId'=$3 ORDER BY seq LIMIT 1`, [importEventKind, run.producer, run.runId])).rows[0]?.payload as ImportedRunRecord | undefined;
    if (existing) demand(isDeepStrictEqual(existing.run, run), `Run ${run.runId} from ${run.producer} was already imported with a different document; a run id names one run`, 409);
    else await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, importEventKind, JSON.stringify(record)]);
    return { imported: existing ?? record, replayed: !!existing, verdict: importedRunVerdict(run), hold: importedHold(await importedRuns(db, candidate.sha)) };
  }, { coordinationLock: false });
}

/** The imports bound to the candidate at `sha`, oldest first, and the hold they leave; open to every authenticated reader. */
export async function readImports(plane: Pick<ImportPlane, 'store'>, sha: string) {
  demand(/^[a-f0-9]{40}$/.test(sha), 'A candidate head is a 40-hex commit', 400);
  const runs = await importedRuns(plane.store.pool, sha);
  return { sha, candidate: runs[0]?.candidate ?? null, runs, hold: importedHold(runs) };
}
