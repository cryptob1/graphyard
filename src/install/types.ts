export const providers = ['railway', 'hetzner', 'docker-host', 'compose'] as const;
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
  image?: string;
  /** Host port published by a local Compose install; the container always listens on 4310. */
  port?: number;
  serverName?: string;
  serverType?: string;
  location?: string;
}

export function installIdFor(repository: string) {
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(repository.trim());
  if (!match) throw new Error('Use --repo OWNER/NAME');
  return `${match[1]}-${match[2]}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}
