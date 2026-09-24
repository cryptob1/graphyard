import { readFile } from 'node:fs/promises';
import { defineCommands, workMutation } from './registry.js';
import { verifyCommand } from './verify.js';
import { completeCommand } from './complete.js';

/**
 * Evidence names the candidate it was produced for. A file that leaves out `sha`, `baseSha` or
 * `policyRevision` is bound to the item's current candidate and policy revision as the CLI reads
 * them now, so a producer never has to look them up; a value the file carries is sent as written,
 * and the control plane still refuses evidence for anything but the current candidate.
 */
export function bindEvidence(input: unknown, work: { key: string; candidate?: { sha?: string | null; baseSha?: string | null } | null; policyRevision?: number }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Evidence must be a JSON object');
  const evidence = { ...input as Record<string, unknown> };
  const missing = (name: string) => evidence[name] === undefined || evidence[name] === null || evidence[name] === '';
  if (missing('sha') || missing('baseSha')) {
    if (!work.candidate?.sha || !work.candidate.baseSha) throw new Error(`${work.key} has no observed candidate yet, so the evidence file must name its sha and baseSha`);
    if (missing('sha')) evidence.sha = work.candidate.sha;
    if (missing('baseSha')) evidence.baseSha = work.candidate.baseSha;
  }
  if (missing('policyRevision')) {
    if (typeof work.policyRevision !== 'number') throw new Error(`${work.key} reports no policy revision, so the evidence file must name its policyRevision`);
    evidence.policyRevision = work.policyRevision;
  }
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
      '                                policyRevision default to the current candidate and policy'],
    run: async (context, work) => context.print(await workMutation(context, work)('evidence', bindEvidence(JSON.parse(await readFile(context.args[0], 'utf8')), work))),
  },
  {
    name: 'revoke',
    scope: 'work',
    help: ['  revoke GY-N file.json         Withdraw trusted evidence for a candidate (producer/operator)'],
    run: async (context, work) => context.print(await workMutation(context, work)('revoke', JSON.parse(await readFile(context.args[0], 'utf8')))),
  },
]);
