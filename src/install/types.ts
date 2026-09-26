/**
 * `host` is the self-contained target (GY-717): one existing Linux machine, reached over SSH, that
 * runs the server, Postgres, the master loop, executors, Herdr and the agent runtimes.
 */
export const providers = ['railway', 'hetzner', 'docker-host', 'compose', 'host'] as const;
export type Provider = (typeof providers)[number];
export type Role = 'admin' | 'coordinator' | 'worker' | 'reader' | 'producer';

/** Every rendered secret becomes this exact string, in plan output, logs, and summaries. */
export const REDACTED = '[redacted]';
export const SERVER_PORT = 4310;

export interface PlannedPrincipal { id: string; role: Role; proofs?: string[] }
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
  target: 'local' | 'provider' | 'github' | 'graphyard' | 'host';
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
  /** The self-contained host (GY-717): units, runtimes, credential paths and dashboard connections; absent otherwise. */
  host?: import('./host.js').HostPlan;
  /** The provider's monthly price for the server this install would create (Hetzner, GY-717 AC-5). */
  price?: import('./pricing.js').PriceQuote | null;
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
  /**
   * Put the whole of Graphyard — server, Postgres, loop, executors, Herdr and agent runtimes — on the
   * machine this install provisions (`--target host`, `--target hetzner`). Implied by provider `host`.
   */
  selfContained?: boolean;
  /** `--target host` against the machine the installer runs on, instead of one reached over SSH. */
  local?: boolean;
  /** Move an existing installation onto the host (`--migrate`): the old database is read from GRAPHYARD_MIGRATE_DATABASE_URL. */
  migrate?: boolean;
  /** Spend consent for a created server: proceed when its monthly price is at most this (`--max-monthly`). */
  maxMonthly?: number;
  /** Spend consent for a created server: the exact monthly price the plan showed (`--confirm-price`). */
  confirmPrice?: number;
}

export function installIdFor(repository: string) {
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(repository.trim());
  if (!match) throw new Error('Use --repo OWNER/NAME');
  return `${match[1]}-${match[2]}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}
