import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { stateSourceKinds, untrustedSourceKinds, defaultClosedQuestionThreshold, type ClosedQuestion, type StatePart, type StateSource, type StateSourceKind } from './model/closed-question.js';
import type { Work } from './model.js';

// ---------------------------------------------------------------------------
// The responder that answers closed questions (GY-109), and the state it is asked against.
//
// The responder is configuration, not a dependency: a local command on the control plane's own
// host (a small model served in-house, a rules engine, anything that reads one JSON request on
// stdin and writes one JSON answer on stdout), or an HTTP endpoint the operator runs or chooses.
// Nothing in the delivery path names a vendor, and with no responder configured every
// closed-question proof simply takes its ordinary path. The configuration also says which state
// the responder may never see: by default, everything an untrusted party can author on a pull
// request — its body and its conversation — together with any path the operator lists.
// ---------------------------------------------------------------------------

const identity = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
const exclusionSchema = z.object({
  /** Source kinds the responder is never given. Defaults to every untrusted kind. */
  sources: z.array(z.enum(stateSourceKinds)).max(stateSourceKinds.length).default([...untrustedSourceKinds]),
  /** Repository paths (exact, or a directory prefix ending in /) the responder is never given. */
  paths: z.array(z.string().min(1).max(500)).max(100).default([]),
}).strict();
const common = {
  id: identity, version: z.string().min(1).max(100),
  /** The floor every answer must reach to be a verdict; a question may raise it, never lower it. */
  threshold: z.number().min(0).max(1).default(defaultClosedQuestionThreshold),
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
  exclude: exclusionSchema.default({ sources: [...untrustedSourceKinds], paths: [] }),
};
export const responderConfigSchema = z.discriminatedUnion('kind', [
  /** A local program: argv[0] is executed without a shell, reads the request on stdin, writes the answer on stdout. */
  z.object({ kind: z.literal('command'), command: z.array(z.string().min(1).max(1000)).min(1).max(50), ...common }).strict(),
  /** An HTTP endpoint; the bearer token, if any, is read from the named environment variable, never stored here. */
  z.object({ kind: z.literal('http'), url: z.url().max(2000), tokenVariable: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(), ...common }).strict(),
]);
export type ResponderConfig = z.infer<typeof responderConfigSchema>;

/** What a responder is given: the question, the closed set of answers, and the bound state. */
export interface ResponderRequest {
  question: string; criteria: string[];
  state: { kind: StateSourceKind; path?: string; text: string }[];
  stateHash: string;
}
export interface ResponderAnswer { answer: string; probability: number }
/** Any responder: the configured ones below, or an embedder's own (tests pass one in-process). */
export interface Responder {
  id: string; version: string; threshold: number;
  exclude: { sources: StateSourceKind[]; paths: string[] };
  ask(request: ResponderRequest): Promise<ResponderAnswer>;
}
const answerSchema = z.object({ answer: z.string().min(1).max(200), probability: z.number().min(0).max(1) }).strip();

function runCommand(argv: string[], input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
    const out: Buffer[] = [], err: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`The responder did not answer within ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 64_000) child.kill('SIGKILL'); else out.push(chunk); });
    child.stderr.on('data', chunk => { if (err.length < 16) err.push(chunk); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(`The responder exited ${code}: ${Buffer.concat(err).toString('utf8').trim().slice(0, 300)}`));
    });
    child.stdin.end(input);
  });
}

/** Build the responder a configuration names. */
export function configuredResponder(config: ResponderConfig, env: NodeJS.ProcessEnv = process.env): Responder {
  const base = { id: config.id, version: config.version, threshold: config.threshold, exclude: { sources: [...config.exclude.sources], paths: [...config.exclude.paths] } };
  if (config.kind === 'command') return { ...base, ask: async request => answerSchema.parse(JSON.parse(await runCommand(config.command, JSON.stringify(request), config.timeoutMs))) };
  return {
    ...base,
    ask: async request => {
      const token = config.tokenVariable ? env[config.tokenVariable] : undefined;
      const response = await fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(request), signal: AbortSignal.timeout(config.timeoutMs) });
      if (!response.ok) throw new Error(`The responder answered HTTP ${response.status}`);
      return answerSchema.parse(await response.json());
    },
  };
}
/** The responder `GRAPHYARD_RESPONDER` configures, or null when none is: closed questions then take their ordinary path. */
export function responderFromEnv(env: NodeJS.ProcessEnv = process.env): Responder | null {
  const raw = env.GRAPHYARD_RESPONDER?.trim();
  return raw ? configuredResponder(responderConfigSchema.parse(JSON.parse(raw)), env) : null;
}

const excludedPath = (path: string, paths: readonly string[]) => paths.some(entry => entry.endsWith('/') ? path.startsWith(entry) : path === entry);
/** Why the responder may not be given this source, or null. */
export function excludedSource(source: StateSource, responder: Pick<Responder, 'exclude'>): string | null {
  if (responder.exclude.sources.includes(source.kind)) return `${source.kind} is excluded by the responder configuration${untrustedSourceKinds.includes(source.kind) ? ': an untrusted party may author it' : ''}`;
  if (source.kind === 'file' && excludedPath(source.path, responder.exclude.paths)) return `${source.path} is excluded by the responder configuration`;
  return null;
}

/** Reads one source of the candidate's state; the server supplies GitHub-backed readers. */
export interface StateReaders {
  file(path: string, sha: string): Promise<string>;
  pullRequestBody(pr: number): Promise<string>;
  comments(pr: number): Promise<string>;
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Assemble the state bound to the exact candidate, in the order declared, and hash it. The hash
 * covers the kind, path and text of every part, so a reader who assembles the same state gets the
 * same hash, and a changed file changes it.
 */
export async function boundState(work: Work, question: ClosedQuestion, responder: Pick<Responder, 'exclude'>, readers: StateReaders) {
  const candidate = work.candidate!;
  const excluded = question.state.map(source => excludedSource(source, responder)).filter((reason): reason is string => !!reason);
  if (excluded.length) return { excluded, state: [], parts: [], stateHash: '' };
  const state: ResponderRequest['state'] = [];
  for (const source of question.state) {
    const text = source.kind === 'file' ? await readers.file(source.path, candidate.sha)
      : source.kind === 'changed-files' ? [...(work.observation?.files ?? [])].sort().join('\n')
      : source.kind === 'criterion' ? work.criteria.find(criterion => criterion.id === question.criterion)?.text ?? ''
      : source.kind === 'pull-request-body' ? await readers.pullRequestBody(candidate.pr)
      : await readers.comments(candidate.pr);
    state.push({ kind: source.kind, ...(source.kind === 'file' ? { path: source.path } : {}), text });
  }
  const parts: StatePart[] = state.map(part => ({ kind: part.kind, ...(part.path ? { path: part.path } : {}), sha256: sha256(part.text), bytes: Buffer.byteLength(part.text) }));
  return { excluded, state, parts, stateHash: sha256(JSON.stringify(state.map(part => [part.kind, part.path ?? null, part.text]))) };
}
