// Concern: the fault kind of a recorded blocker — a stalled gate, or something the installation lacks.
import { userBusRefusal } from './user-bus.js';

/**
 * The kind of a recorded blocker. A blocker is a stalled gate only when it names nothing the
 * installation lacks: one quoting a sandbox refusal is the sandbox rule (`sandbox-blocker`), but not
 * one quoting the user bus the sandbox masks — a host check the loop probes and heals (GY-1428) —
 * and one quoting GitHub's refusal to let an App write `.github/workflows` without the `workflows`
 * permission is that permission (`workflow-permission`, GY-1097). Worker push tokens are narrowed
 * to contents and pull requests by design, so every worker whose push carries a workflow-file
 * change — its own, or main's brought in by a base sync — meets that refusal however long the gate
 * is held: on 2 October 2026 GY-793 and GY-1094 were both filed as stalled gates for it, within
 * three minutes of main taking GY-1093's workflow changes.
 */
export function blockerKind(blocker: string): 'sandbox-blocker' | 'workflow-permission' | 'setup' | 'blocker' {
  if (/sandbox|refused path|--add-dir|Operation not permitted/i.test(blocker) && !userBusRefusal.test(blocker)) return 'sandbox-blocker';
  if (/refusing to allow an? .{0,40}App to create or update workflow/i.test(blocker)) return 'workflow-permission';
  // The master-role refusal — the same shapes blocker-class.ts classes `master-role` (GY-1761): a step
  // needing the master role from a worker's token, which the installation lacks and retrying cannot
  // grant — is the installation's setup, so its standing blocker counts as configuration, never a
  // stalled gate. Restated here, not imported: fault-classes (browser-safe) reads this module, and the
  // import would close a module-init cycle through blocker-class → human-request → approval → work.
  // tests/fault-class-stalled-gate.test.ts holds the two patterns together.
  if (/\.graphyard\/master\.json does not exist|\bno master role\b|\bmaster-role session\b/i.test(blocker)) return 'setup';
  return 'blocker';
}
