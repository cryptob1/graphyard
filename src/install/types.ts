export const providers = ['railway', 'hetzner', 'docker-host', 'compose'] as const;
export type Provider = (typeof providers)[number];
export type Role = 'admin' | 'coordinator' | 'worker' | 'reader' | 'producer';
/** The session kind a principal declares, as the server's principal schema accepts it. */
export type DeclaredSessionKind = 'human' | 'ai';

/** Every rendered secret becomes this exact string, in plan output, logs, and summaries. */
export const REDACTED = '[redacted]';
export const SERVER_PORT = 4310;

export interface PlannedPrincipal { id: string; role: Role; sessionKind?: DeclaredSessionKind; proofs?: string[] }
export interface EnvValue { name: string; value: string; secret: boolean }
export interface PlanValue { name: string; value: string; secret: boolean; fingerprint?: string; note?: string }
export interface PlanDrift { action: string; field: string; expected: string; observed: string }
export interface PreflightItem { name: string; ok: boolean; detail: string; fix?: string }

/**
 * `satisfied` is how a re-plan reports an existing installation: the action stays in the
 * ordered plan so the sequence is auditable, but apply performs no duplicate provisioning.
 */
export interface PlanAction {
  id: string;
  target: 'local' | 'provider' | 'github' | 'graphyard';
  title: string;
  state: 'create' | 'update' | 'satisfied';
  command?: string;
  values?: PlanValue[];
  drift?: PlanDrift[];
  human?: string;
}

export interface InstallPlan {
  version: 1;
  repository: string;
  provider: Provider;
  installId: string;
  installDirectory: string;
  baseBranch: string;
  reviewPolicy: 'github' | 'agent';
  domain: string | null;
  url: string | null;
  existing: boolean;
  secretsRedacted: true;
  preflight: PreflightItem[];
  principals: PlannedPrincipal[];
  actions: PlanAction[];
  drift: PlanDrift[];
  humanSteps: string[];
  /**
   * The repository's delivery model (GY-1102): its mode, the checks protection requires on pull
   * requests, the per-candidate checks, and the adapter deploying UAT and production.
   * `committed` is false while graphyard.json holds no reviewed policy yet: protection then keeps
   * the discovered checks until `graphyard init --scan --apply` records the split.
   */
  delivery: { mode: 'release-candidate' | 'per-pr'; committed: boolean; preMerge: string[]; perCandidate: string[]; adapter: 'railway' | 'command' };
}

export interface InstallInputs {
  repository: string;
  provider: Provider;
  baseBranch?: string;
  domain?: string;
  workers?: number;
  producerProofs?: string[];
  reviewer?: string;
  reviewPolicy?: 'github' | 'agent';
  requiredChecks?: string[];
  reviewCount?: number;
  /** docker-host and hetzner reach the machine over SSH as user@host. */
  sshHost?: string;
  sshUser?: string;
  /** Hetzner Cloud SSH key registered on the created server; required so key-only SSH can reach it. */
  sshKey?: string;
  /** Railway workspace (ID or exact name) that owns the project; required only when the account belongs to several. */
  workspace?: string;
  image?: string;
  /** Host port published by a local Compose install; the container always listens on 4310. */
  port?: number;
  serverName?: string;
  serverType?: string;
  location?: string;
  /** Create the cost-bearing UAT and production resources the plan marks as human decisions (GY-1102). */
  createEnvironments?: boolean;
}

export function installIdFor(repository: string) {
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(repository.trim());
  if (!match) throw new Error('Use --repo OWNER/NAME');
  return `${match[1]}-${match[2]}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}
