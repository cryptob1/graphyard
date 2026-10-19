/**
 * The reason→remedy registry (GY-949): what clears each unchanged reason a stalled action row
 * keeps failing for, or which bounded decision owns it.
 *
 * A row that fails three times for one reason is stalled (`actionStall`), and until this registry
 * a stall was only reported: `master status` raised one attention whose whole instruction was
 * "Clear what that reason names", the row re-ran the impossibility on a widening backoff, and after
 * `livenessRetryLimit` failures it became an escalation addressed to whoever read it. On 29
 * September 2026 GY-864 and GY-515 sat that way on the App permission hold — a condition `master
 * browser installation-accept` exists to clear — and GY-947, GY-73 and GY-806 on a full worker role,
 * a condition only a capacity decision moves (GY-948).
 *
 * Each entry recognises one family of reasons and binds it to its remedy:
 *
 * - `installation-accept` — the control-plane App lacks a permission its installation has a
 *   pending request for. The master runs the master browser installation-accept flow,
 *   app-permissions first when the App does not yet request the permission. The loop no longer
 *   applies it itself (GY-1984): the action-row remedy record went with the executor fleet.
 * - `capacity` — a role at its concurrency limit. Nothing the loop can run clears it: it is a
 *   capacity decision, owned by the master, and the lever is named — the role's concurrency in the
 *   agent registry, or a live session of the role ending.
 * - `installation-suspended` — the App's installation is suspended, which only the account that
 *   owns it can reinstate: a human decision.
 * - `installation-setup` — the configured deployment endpoint answers 4xx (a standing condition of
 *   `run.deploymentUrl`). The installation's setup owns it; `stalledActionAttention` raises the
 *   installation-level setup line rather than a per-item stalled-action (GY-2014).
 * - `credential-401` — a dispatched worker's claim was refused with the control plane's own 401
 *   ("A valid Graphyard bearer token is required"). The same lever the step-stall registry names
 *   for 401s (GY-2014).
 * - `reviewer-identity` — the control plane refused a reviewer launch with a 4xx. The master owns
 *   the reviewer-identity remedy (the condition GY-2008 clears); attention raises that line rather
 *   than a per-item stalled-action (GY-2014).
 *
 * A reason no entry recognises keeps the generic instruction. Pure: nothing here runs a remedy.
 */

export const stallRemedyKinds = ['installation-accept', 'capacity', 'installation-suspended', 'installation-setup', 'credential-401', 'reviewer-identity'] as const;
export type StallRemedyKind = typeof stallRemedyKinds[number];
export interface BoundRemedy {
  kind: StallRemedyKind;
  /** Who makes the bounded decision the remedy is. */
  owner: 'master' | 'human';
  /** The remedy named in one line, for an escalation's detail. */
  remedy: string;
  /** What the attention names as the next step. */
  next: string;
}

/** The credential-401 lever shared by the action-row registry and the step-stall registry (GY-1854, GY-2014). */
export const credential401Remedy = 'renew the refused host-owned credential — a worker or producer profile\'s from the credential the install issued for its principal, or the merge writer\'s deploy key — then verify it authenticates; the coordinator\'s own credential is the operator\'s to rotate';

const installationAccept = (app: string, permission: string, url: string): BoundRemedy => ({
  kind: 'installation-accept', owner: 'master',
  remedy: `graphyard master browser installation-accept (app-permissions first when the App does not yet request it), accepting App ${app}'s pending request for ${permission} at ${url}`,
  next: `Run graphyard master browser installation-accept — graphyard master browser app-permissions first when the App does not yet request ${permission} — to accept App ${app}'s pending request at ${url}; the row's own recheck picks the granted permission up`,
});

/** Each family of stall reasons and the remedy it binds to; the first entry that recognises a reason binds it. */
export const stallRemedyRegistry: readonly { kind: StallRemedyKind; bind: (reason: string) => BoundRemedy | null }[] = [
  {
    kind: 'installation-suspended',
    bind: reason => /\binstallation(?:\s+\S+)?\s+is suspended\b/i.test(reason) ? { kind: 'installation-suspended', owner: 'human',
      remedy: 'reinstate the suspended GitHub App installation from the account that owns it',
      next: 'Reinstate the suspended GitHub App installation from the account that owns it; nothing the loop runs can, and the row\'s recheck picks the reinstated installation up' } : null,
  },
  {
    kind: 'installation-accept',
    // describeShortfall (src/github-permissions.ts) and pushShortfall (src/worker-credential.ts) word every permission hold this way.
    bind: reason => {
      const hold = /\bApp (\S+)(?:\s+installation)?\s+lacks ([A-Za-z ]+: (?:read|write|admin))\b.*?\baccept the pending permission request at (\S+?)[;,]?(?:\s|$)/.exec(reason);
      return hold ? installationAccept(hold[1], hold[2], hold[3]) : null;
    },
  },
  {
    kind: 'capacity',
    // The registry (src/fleet.ts, src/model/registry-sessions.ts) words a full role this way.
    bind: reason => {
      const full = /\brole (\S+) is at its concurrency limit \((\d+) of (\d+) live/.exec(reason);
      if (!full) return null;
      const [, role, live, limit] = full;
      const lever = `raise role ${role}'s concurrency in the agent registry (graphyard master registry role set ${role} ACCOUNT[,ACCOUNT…] --concurrency N --reason REASON, N above ${limit}) or let a live ${role} session end`;
      return { kind: 'capacity', owner: 'master', remedy: `a capacity decision: ${lever}`,
        next: `Role ${role} is full (${live} of ${limit} live), and retrying moves nothing: it is a capacity decision the master owns — ${lever}. The row is escalated to that decision with this lever named if it keeps failing, and is claimed within one recheck of a slot freeing` };
    },
  },
  {
    // observeDeployment (src/daemon/deployment.ts) words a 4xx from the configured deploymentUrl this way.
    kind: 'installation-setup',
    bind: reason => /Deployment endpoint answered 4\d\d\b/.test(reason) ? { kind: 'installation-setup', owner: 'master',
      remedy: 'fix the installation\'s configured deploymentUrl (graphyard master init --deployment-url) so the endpoint answers 2xx with the build SHA at deploymentShaField, or clear the misconfigured URL',
      next: 'Fix the installation\'s configured deploymentUrl so the endpoint answers 2xx with the build SHA (graphyard master init --deployment-url), or clear the misconfigured URL; the setup path already raises this, and each verify-deployment row\'s recheck picks the repaired endpoint up' } : null,
  },
  {
    // demand (src/server/auth.ts) refuses every claim whose bearer resolves to no principal this way; GY-1998 owns the condition.
    kind: 'credential-401',
    bind: reason => /A valid Graphyard bearer token is required/.test(reason) ? { kind: 'credential-401', owner: 'master',
      remedy: credential401Remedy,
      next: `Renew the refused host-owned credential (the credential-401 remedy the step-stall registry names for 401s) — ${credential401Remedy}; the row's recheck picks a working credential up` } : null,
  },
  {
    // launchReview (src/reviewer.ts) surfaces a control-plane 4xx this way; GY-2008 owns the reviewer-identity condition.
    kind: 'reviewer-identity',
    bind: reason => /The control plane refused the reviewer launch of \S+ \(4\d\d\):/.test(reason) ? { kind: 'reviewer-identity', owner: 'master',
      remedy: 'repair the reviewer identity the control plane registers for launches (graphyard master reviewer setup or graphyard master reviewer bind); the condition GY-2008 clears',
      next: 'Repair the reviewer identity the control plane registers for launches (graphyard master reviewer setup or graphyard master reviewer bind) — the condition GY-2008 clears; each request-review row\'s recheck picks the repaired identity up' } : null,
  },
];
/** The remedy a stall reason binds to, or null when no entry recognises it. */
export function stallRemedy(reason: string): BoundRemedy | null {
  for (const entry of stallRemedyRegistry) { const bound = entry.bind(reason); if (bound) return bound; }
  return null;
}

// ---- Step-stall remedies (GY-1854) ---------------------------------------------------------------

/**
 * The remedies a failing loop step's or dispatcher call's normalised signature binds to (GY-1854).
 * Where the action-row registry above binds a stalled row's unchanged reason, this one binds a
 * stalled call's signature, and the loop's stall step (src/daemon/step-stalls.ts) applies each
 * bound remedy once per run and records the attempt on the stall. Pure here: nothing runs until a
 * caller hands the port in.
 */
export const stepStallRemedyKinds = ['profile-unknown', 'credential-401', 'merge-record-idempotency'] as const;
export type StepStallRemedyKind = typeof stepStallRemedyKinds[number];
/** What one bound step-stall remedy is: the lever, named in one line. */
export interface BoundStepStallRemedy { kind: StepStallRemedyKind; remedy: string }
/** What applying one remedy reported: its outcome, whether the verification after it held, and why. */
export interface StepStallRemedyOutcome { outcome: 'applied' | 'unchanged' | 'refused'; verified: boolean; detail: string }

/** Each family of stall signatures and the remedy it binds to; the first entry that recognises a signature binds it. */
export const stepStallRemedyRegistry: readonly { kind: StepStallRemedyKind; bind: (signature: string) => BoundStepStallRemedy | null }[] = [
  {
    // A launch profile no configured agent environment backs refuses this way (src/master/environments.ts
    // inspectProfileAccounts, src/master/dispatch.ts prepareWorkerLaunch), and a review launch naming
    // a reviewer profile no configured one carries throws "Unknown reviewer profile NAME"
    // (src/reviewer.ts launchReview, GY-1850), which the loop signs as its review-launch step.
    kind: 'profile-unknown',
    bind: signature => /is not a configured agent environment|A complete launch profile is required|Unknown reviewer profile \S/.test(signature)
      ? { kind: 'profile-unknown', remedy: 'write the agent profiles as master environments --apply does (setupAgentEnvironments with apply), from the logged-in environments, and let the loop redispatch' }
      : null,
  },
  {
    // A control plane or provider answering 401 names the status or the word (src/supervisor.ts GY-392,
    // src/master/dispatch.ts readMergeWriter); stallSignature keeps 401 as its own <unauthorized> token.
    kind: 'credential-401',
    bind: signature => /<unauthorized>|unauthorized/i.test(signature)
      ? { kind: 'credential-401', remedy: credential401Remedy }
      : null,
  },
  {
    // recordMergeEvent (src/server/merge-record.ts) refuses a reused idempotency key with different
    // input this way, and the record that met the refusal is one the merge writer wrote (GY-1524);
    // the writer's own settle and replay records name the same refusal as "a record key reused".
    // The same refusal is every module's (delegation, agent-registry, proof grants, delivery), so
    // the bind names the merge step: only a stall signed `merge: …` runs the merge-writer remedy;
    // the same refusal on any other step stays unbound and wakes the master.
    kind: 'merge-record-idempotency',
    bind: signature => /^merge: .*key reused with different input/i.test(signature)
      ? { kind: 'merge-record-idempotency', remedy: 'adopt the server\'s merge ledger for the refused record (read the item\'s folded ledger back and take its event count into the attempt key) and start a new attempt' }
      : null,
  },
];

/** The remedy a step-stall signature binds to, or null when no entry recognises it. */
export function stepStallRemedy(signature: string): BoundStepStallRemedy | null {
  for (const entry of stepStallRemedyRegistry) { const bound = entry.bind(signature); if (bound) return bound; }
  return null;
}

/**
 * Apply one bound step-stall remedy through `run` — the caller's port for that kind — and answer
 * what it did. A port that throws is a refusal carrying its message, never a crash of the step.
 */
export async function applyStepStallRemedy(kind: StepStallRemedyKind, run: (kind: StepStallRemedyKind) => Promise<StepStallRemedyOutcome>): Promise<StepStallRemedyOutcome> {
  try { return await run(kind); }
  catch (error) { return { outcome: 'refused', verified: false, detail: `${kind} remedy was refused: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000) }; }
}
