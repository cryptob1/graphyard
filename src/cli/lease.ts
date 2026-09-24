import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { defineCommands, workMutation } from './registry.js';
import { verifyCommand } from './verify.js';
import { completeCommand } from './complete.js';

/** The candidate a run actually tested: the producer request the session was launched for, or else the checkout's own HEAD. */
export type TestedBinding = { source: string; sha: string; baseSha?: string; policyRevision?: number };

/**
 * What the evidence was produced against. A producer session carries its request's exact
 * key@sha@baseSha@policyRevision in GRAPHYARD_PRODUCER_BINDING (src/producer.ts); any other caller
 * tested the commit its checkout holds.
 */
export function testedBinding(key: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): TestedBinding | null {
  const request = /^([^@]+)@([0-9a-f]{40})@([0-9a-f]{40})@(\d+)$/.exec(env.GRAPHYARD_PRODUCER_BINDING ?? '');
  if (request && request[1] === key) return { source: `the producer request for ${key}`, sha: request[2], baseSha: request[3], policyRevision: Number(request[4]) };
  const head = spawnSync('git', ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return head.status === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim()) ? { source: `the checkout HEAD in ${cwd}`, sha: head.stdout.trim() } : null;
}

/**
 * Evidence names the candidate it was produced for. A file that leaves out `sha`, `baseSha` or
 * `policyRevision` gets them from the item's current candidate and policy revision, but only when
 * that candidate is the one the run tested: the producer request's exact tuple, or the checkout's
 * HEAD. A field is defaulted only when that binding records it: a checkout records its head alone,
 * so there the file must name its baseSha and policyRevision. A candidate that moved after the run
 * is refused rather than stamped onto an untested head.
 * A value the file carries is sent as written, and the control plane still refuses evidence for
 * anything but the current candidate.
 */
export function bindEvidence(input: unknown, work: { key: string; candidate?: { sha?: string | null; baseSha?: string | null } | null; policyRevision?: number }, tested: TestedBinding | null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Evidence must be a JSON object');
  const evidence = { ...input as Record<string, unknown> };
  const missing = (name: string) => evidence[name] === undefined || evidence[name] === null || evidence[name] === '';
  const omitted = ['sha', 'baseSha', 'policyRevision'].filter(missing);
  if (!omitted.length) return evidence;
  const name = `so the evidence file must name its ${omitted.join(', ')}`;
  if (!work.candidate?.sha || !work.candidate.baseSha) throw new Error(`${work.key} has no observed candidate yet, ${name}`);
  if (typeof work.policyRevision !== 'number') throw new Error(`${work.key} reports no policy revision, ${name}`);
  if (!tested) throw new Error(`Nothing records which head this evidence tested (no producer request and no git checkout here), ${name}`);
  const unrecorded = omitted.filter(field => tested[field as keyof TestedBinding] === undefined);
  if (unrecorded.length) throw new Error(`${tested.source} records only the head the run tested, not its ${unrecorded.join(' or ')}, so the evidence file must name its ${unrecorded.join(', ')} (a producer request binds all three)`);
  const current = { sha: work.candidate.sha, baseSha: work.candidate.baseSha, policyRevision: work.policyRevision };
  const expected: Record<string, unknown> = { sha: tested.sha, baseSha: tested.baseSha, policyRevision: tested.policyRevision, ...Object.fromEntries(['sha', 'baseSha', 'policyRevision'].filter(field => !missing(field)).map(field => [field, evidence[field]])) };
  for (const field of ['sha', 'baseSha', 'policyRevision'] as const)
    if (expected[field] !== undefined && expected[field] !== current[field])
      throw new Error(`${work.key}'s current ${field} is ${current[field]}, but the evidence was produced for ${expected[field]} (${missing(field) ? tested.source : 'the evidence file'}); the candidate moved after the run, ${name} or run the proof again on the current candidate`);
  for (const field of omitted) evidence[field] = current[field as keyof typeof current];
  return evidence;
}

/** The worker protocol on one claimed item: lease, blockers, submission and evidence. */
export const leaseCommands = defineCommands([
  {
    name: 'claim',
    scope: 'work',
    help: ['  claim GY-N                   Acquire a two-minute lease; returns epoch'],
    run: async (context, work) => context.print(await workMutation(context, work)('claim', {})),
  },
  {
    name: 'heartbeat',
    scope: 'work',
    help: ['  heartbeat GY-N EPOCH          Extend current lease (refused once the epoch is submitted)'],
    run: async (context, work) => context.print(await workMutation(context, work)('heartbeat', { epoch: Number(context.args[0]) })),
  },
  {
    name: 'release',
    scope: 'work',
    help: ['  release GY-N EPOCH            Release current lease'],
    run: async (context, work) => context.print(await workMutation(context, work)('release', { epoch: Number(context.args[0]) })),
  },
  {
    name: 'register',
    scope: 'work',
    help: ['  register GY-N file.json       Register a Herdr/external workspace'],
    run: async (context, work) => context.print(await workMutation(context, work)('workspace', JSON.parse(await readFile(context.args[0], 'utf8')))),
  },
  {
    name: 'blocked',
    scope: 'work',
    help: ["  blocked GY-N EPOCH REASON     Set blocker; use '-' to clear"],
    run: async (context, work) => context.print(await workMutation(context, work)('blocked', { epoch: Number(context.args[0]), reason: context.args[1] === '-' ? null : context.args.slice(1).join(' ') })),
  },
  verifyCommand,
  completeCommand,
  {
    name: 'evidence',
    scope: 'work',
    help: ['  evidence GY-N file.json       Submit evidence (trust follows credential); sha, baseSha and',
      '                                policyRevision default to the current candidate and policy',
      '                                when it is the head the run tested (a producer request binds all',
      '                                three; a checkout outside one binds only sha)'],
    run: async (context, work) => context.print(await workMutation(context, work)('evidence', bindEvidence(JSON.parse(await readFile(context.args[0], 'utf8')), work, testedBinding(work.key)))),
  },
  {
    name: 'revoke',
    scope: 'work',
    help: ['  revoke GY-N file.json         Withdraw trusted evidence for a candidate (producer/operator)'],
    run: async (context, work) => context.print(await workMutation(context, work)('revoke', JSON.parse(await readFile(context.args[0], 'utf8')))),
  },
]);
