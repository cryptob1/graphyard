import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Transport } from './transport.js';
import { mergeQueueRulesetName } from '../protection.js';

export interface GitHubCli { (args: string[], options?: { input?: string; allowFailure?: boolean }): Promise<{ stdout: string; stderr: string; code: number }> }

export function githubCli(transport: Transport): GitHubCli {
  return (args, options = {}) => transport.exec('gh', args, { input: options.input, allowFailure: options.allowFailure, timeout: 180_000 });
}

export async function ghJson(gh: GitHubCli, args: string[], fallback: unknown = null) {
  const result = await gh(args, { allowFailure: true });
  if (result.code !== 0) return fallback;
  try { return JSON.parse(result.stdout); } catch { return fallback; }
}

export async function headSha(gh: GitHubCli, repository: string, branch: string) {
  const reference = await ghJson(gh, ['api', `repos/${repository}/commits/${branch}`], null) as any;
  const sha = String(reference?.sha ?? '');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Cannot read the head commit of ${repository}@${branch}`);
  return sha;
}

// ---------------------------------------------------------------------------
// The branch protection install found, and its restore (GY-1870)
// ---------------------------------------------------------------------------

/**
 * Immediately before its first github.protection write, install records the branch's protection
 * as GitHub answered it (null when the branch had none), whether the repository allowed auto-merge,
 * and Graphyard's merge-queue ruleset when one already stood. The record is a baseline, never a
 * rolling backup: a later apply keeps it, so `install --restore-protection` returns the branch to
 * what it was before Graphyard. It holds GitHub's protection document only, never a credential.
 */
export const protectionRecordFormat = 'graphyard-protection-record-v1';
export const PROTECTION_RECORD_FILE = 'protection-record.json';
const protectionRecordSchema = z.object({
  format: z.literal(protectionRecordFormat), repository: z.string().min(1), branch: z.string().min(1), recordedAt: z.string().min(1),
  protection: z.record(z.string(), z.unknown()).nullable(), allowAutoMerge: z.boolean(), mergeQueueRuleset: z.record(z.string(), z.unknown()).nullable(),
}).strict();
export type ProtectionRecord = z.infer<typeof protectionRecordSchema>;
export const protectionRecordFile = (directory: string) => resolve(directory, PROTECTION_RECORD_FILE);

/** The recorded protection, or null when none was recorded; a record this release cannot read refuses, naming its file. */
export async function readProtectionRecord(directory: string): Promise<ProtectionRecord | null> {
  const file = protectionRecordFile(directory);
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { throw new Error(`The protection record ${file} is not JSON; it was not written by graphyard install`); }
  if (typeof parsed?.format === 'string' && parsed.format !== protectionRecordFormat) throw new Error(`The protection record ${file} is in format ${parsed.format}, which this release does not read; restore it with the release that took it`);
  const result = protectionRecordSchema.safeParse(parsed);
  if (!result.success) throw new Error(`The protection record ${file} does not parse: ${result.error.issues.map(issue => `${issue.path.join('.') || 'record'} ${issue.message}`).join('; ')}`);
  return result.data;
}

/**
 * A GET the baseline and the restore rest on: its JSON document, null only when GitHub confirms
 * there is none (`absent`), and a refusal naming what was read otherwise. Unlike ghJson it never
 * turns a failed or malformed answer into a fallback, which would read as a confirmed absence.
 */
async function readConfirmed(gh: GitHubCli, args: string[], what: string, absent?: RegExp): Promise<any> {
  const result = await gh(args, { allowFailure: true });
  if (result.code !== 0 && absent?.test(`${result.stderr}\n${result.stdout}`)) return null;
  if (result.code !== 0) throw new Error(`GitHub did not answer ${what} (gh ${args.join(' ')} exited ${result.code}); run "gh auth status" and confirm the account administers the repository, then rerun`);
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object') throw new Error(`GitHub answered ${what} (gh ${args.join(' ')}) with no JSON document, so it cannot be compared; rerun`);
  return parsed;
}

/** Rulesets per page of the listing the record and the restore read: GitHub's maximum (its default is 30). */
const queueRulesetPageSize = 100;
/**
 * Graphyard's own merge-queue ruleset on the repository, by name, or null when the whole listing
 * confirms none: pages are read until a short one, so a queue ruleset past the first page is never
 * taken for absent. An operator's other rulesets are never read here.
 */
export async function readQueueRuleset(gh: GitHubCli, repository: string): Promise<Record<string, unknown> | null> {
  let found: any;
  for (let page = 1; !found; page++) {
    const listing = `repos/${repository}/rulesets?includes_parents=false&per_page=${queueRulesetPageSize}&page=${page}`;
    const rulesets = await readConfirmed(gh, ['api', listing], `page ${page} of the rulesets of ${repository}`);
    if (!Array.isArray(rulesets)) throw new Error(`GitHub answered page ${page} of the rulesets of ${repository} with no list, so whether ${mergeQueueRulesetName} stands is unknown; rerun`);
    found = rulesets.find(ruleset => ruleset?.name === mergeQueueRulesetName);
    if (!found && rulesets.length < queueRulesetPageSize) return null;
  }
  if (!found) return null;
  const document = await readConfirmed(gh, ['api', `repos/${repository}/rulesets/${found.id}`], `ruleset ${found.id} of ${repository}`);
  if (document.id !== found.id || document.name !== mergeQueueRulesetName) throw new Error(`GitHub answered ruleset ${found.id} of ${repository} with another document, so ${mergeQueueRulesetName} cannot be recorded or compared; rerun`);
  return document;
}



const actors = (list: any, key: 'login' | 'slug') => (Array.isArray(list) ? list : []).map((entry: any) => String(entry?.[key] ?? entry)).sort();
const enabled = (value: any) => value?.enabled === true;
/**
 * The PUT body that writes back a protection document GitHub answered: its {enabled} wrappers as
 * booleans, its actors as logins and slugs, and every subresource re-sent, because a PUT clears
 * whatever it omits (bypass allowances and dismissal restrictions included). Arrays are sorted, so
 * the same projection of a re-read compares equal to the record's.
 */
export function restorePayload(protection: any) {
  const checks = protection?.required_status_checks, reviews = protection?.required_pull_request_reviews, restrictions = protection?.restrictions;
  const dismissal = reviews?.dismissal_restrictions, bypass = reviews?.bypass_pull_request_allowances;
  return {
    required_status_checks: checks ? { strict: checks.strict === true, checks: (checks.checks ?? (checks.contexts ?? []).map((context: string) => ({ context, app_id: null })))
      .map((check: any) => ({ context: String(check.context), app_id: check.app_id ?? null })).sort((left: any, right: any) => `${left.context}:${left.app_id}`.localeCompare(`${right.context}:${right.app_id}`)) } : null,
    enforce_admins: enabled(protection?.enforce_admins),
    required_pull_request_reviews: reviews ? {
      required_approving_review_count: Number(reviews.required_approving_review_count ?? 0), dismiss_stale_reviews: reviews.dismiss_stale_reviews === true,
      require_code_owner_reviews: reviews.require_code_owner_reviews === true, require_last_push_approval: reviews.require_last_push_approval === true,
      ...(dismissal ? { dismissal_restrictions: { users: actors(dismissal.users, 'login'), teams: actors(dismissal.teams, 'slug'), apps: actors(dismissal.apps, 'slug') } } : {}),
      ...(bypass ? { bypass_pull_request_allowances: { users: actors(bypass.users, 'login'), teams: actors(bypass.teams, 'slug'), apps: actors(bypass.apps, 'slug') } } : {}),
    } : null,
    restrictions: restrictions ? { users: actors(restrictions.users, 'login'), teams: actors(restrictions.teams, 'slug'), apps: actors(restrictions.apps, 'slug') } : null,
    required_conversation_resolution: enabled(protection?.required_conversation_resolution),
    required_linear_history: enabled(protection?.required_linear_history),
    allow_force_pushes: enabled(protection?.allow_force_pushes),
    allow_deletions: enabled(protection?.allow_deletions),
    block_creations: enabled(protection?.block_creations),
    lock_branch: enabled(protection?.lock_branch),
    allow_fork_syncing: enabled(protection?.allow_fork_syncing),
  };
}
/** A ruleset's writable fields, the body a PUT or POST takes and the projection a re-read is compared by. */
function rulesetPayload(ruleset: any) {
  return { name: ruleset?.name, target: ruleset?.target, enforcement: ruleset?.enforcement, bypass_actors: ruleset?.bypass_actors ?? [], conditions: ruleset?.conditions ?? null, rules: ruleset?.rules ?? [] };
}

export interface RestoreObservation { protection: any | null; allowAutoMerge: boolean; mergeQueueRuleset: any | null }
export interface RestoreChange { write: string; field: string; recorded: string; observed: string }

/**
 * Protection, auto-merge and Graphyard's queue ruleset as GitHub answers them now. Absence counts
 * only when GitHub confirms it (protection: its "Branch not protected" 404); every other failed,
 * malformed or incomplete read refuses, so an unknown state never compares equal to a recorded one.
 */
export async function observeRestore(gh: GitHubCli, repository: string, branch: string): Promise<RestoreObservation> {
  const protection = await readConfirmed(gh, ['api', `repos/${repository}/branches/${branch}/protection`], `the protection of ${repository}@${branch}`, /Branch not protected/i);
  const settings = await readConfirmed(gh, ['api', `repos/${repository}`], `the repository ${repository}`);
  if (typeof settings.allow_auto_merge !== 'boolean') throw new Error(`GitHub answered the repository ${repository} without allow_auto_merge, so its auto-merge setting is unknown; confirm the account administers ${repository}`);
  return { protection, allowAutoMerge: settings.allow_auto_merge, mergeQueueRuleset: await readQueueRuleset(gh, repository) };
}

/**
 * The writes that return the branch to the record, diffed against what GitHub answers now; empty
 * when it already matches. An operator's own rulesets are never touched, only the one named
 * Graphyard's merge queue.
 */
export function restoreChanges(record: ProtectionRecord, current: RestoreObservation): RestoreChange[] {
  const { repository, branch } = record;
  const changes: RestoreChange[] = [];
  const protection = `repos/${repository}/branches/${branch}/protection`;
  const show = (value: unknown) => value === null ? 'none' : JSON.stringify(value);
  if (record.protection === null) {
    if (current.protection !== null) changes.push({ write: `DELETE ${protection}`, field: 'branch protection', recorded: 'none', observed: show(restorePayload(current.protection)) });
  } else {
    const recorded = restorePayload(record.protection), observed = current.protection === null ? null : restorePayload(current.protection);
    if (JSON.stringify(recorded) !== JSON.stringify(observed)) changes.push({ write: `PUT ${protection}`, field: 'branch protection', recorded: show(recorded), observed: show(observed) });
  }
  if (record.allowAutoMerge !== current.allowAutoMerge)
    changes.push({ write: `PATCH repos/${repository} allow_auto_merge=${record.allowAutoMerge}`, field: 'auto-merge', recorded: String(record.allowAutoMerge), observed: String(current.allowAutoMerge) });
  const recordedQueue = record.mergeQueueRuleset ? rulesetPayload(record.mergeQueueRuleset) : null, observedQueue = current.mergeQueueRuleset ? rulesetPayload(current.mergeQueueRuleset) : null;
  if (!recordedQueue && observedQueue) changes.push({ write: `DELETE repos/${repository}/rulesets/${current.mergeQueueRuleset.id}`, field: mergeQueueRulesetName, recorded: 'none', observed: show(observedQueue) });
  else if (recordedQueue && JSON.stringify(recordedQueue) !== JSON.stringify(observedQueue))
    changes.push({ write: observedQueue ? `PUT repos/${repository}/rulesets/${current.mergeQueueRuleset.id}` : `POST repos/${repository}/rulesets`, field: mergeQueueRulesetName, recorded: show(recordedQueue), observed: show(observedQueue) });
  return changes;
}

/**
 * Writes exactly the planned changes, then re-reads the branch and refuses, naming each field,
 * unless it now matches the record. Deleting protection that is already gone is not a failure.
 */
export async function applyRestore(gh: GitHubCli, record: ProtectionRecord, changes: RestoreChange[]) {
  for (const change of changes) {
    const [method, path] = change.write.split(' ');
    const body = change.field === 'branch protection' && method === 'PUT' ? restorePayload(record.protection)
      : change.field === mergeQueueRulesetName && method !== 'DELETE' ? rulesetPayload(record.mergeQueueRuleset) : undefined;
    const args = change.field === 'auto-merge' ? ['api', '--method', 'PATCH', `repos/${record.repository}`, '-F', `allow_auto_merge=${record.allowAutoMerge}`]
      : ['api', '--method', method, path, ...(body ? ['--input', '-'] : [])];
    const result = await gh(args, { ...(body ? { input: JSON.stringify(body) } : {}), allowFailure: true });
    const gone = method === 'DELETE' && /\b404\b|Not Found|not protected/i.test(`${result.stderr}\n${result.stdout}`);
    if (result.code !== 0 && !gone) throw new Error(`Restoring ${change.field} on ${record.repository}@${record.branch} failed at ${change.write}; run "gh auth status" and confirm the account administers ${record.repository}`);
  }
  // The re-read refuses rather than verifies when any part of it cannot be read.
  let reread: RestoreObservation;
  try { reread = await observeRestore(gh, record.repository, record.branch); }
  catch (error: any) { throw new Error(`The restore wrote its changes but could not verify ${record.repository}@${record.branch}: ${error.message}`); }
  const remaining = restoreChanges(record, reread);
  if (remaining.length) throw new Error(`The restore wrote its changes but ${record.repository}@${record.branch} still differs from the record in ${remaining.map(change => change.field).join(', ')}`);
  return { verified: true as const };
}
