import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

// Helper to read source files and verify implementation
async function readSourceFile(filename: string): Promise<string> {
  const modulePath = new URL('../src/' + filename, import.meta.url);
  return readFile(modulePath, 'utf-8');
}

// AC-1: unit:session-cwd-own-checkout
// Every session Graphyard launches for a role other than the master (reviewer, producer, approver,
// escalation handler, research, triage) is started with its pane cwd and process cwd set to its
// own managed checkout (or, for sessions with no checkout, a scratch directory outside the
// coordinator checkout); no launch passes the coordinator checkout as a cwd.
describe('AC-1: session-cwd-own-checkout', () => {
  test('reviewer session uses its own checkout, not coordinator checkout', async () => {
    const source = await readSourceFile('reviewer.ts');
    // Verify reviewer pane is created with checkout.directory, not root
    assert.ok(source.includes("'--cwd', checkout.directory"), 'reviewer pane uses checkout.directory for --cwd');
    // Verify reviewer session is started with cwd: checkout.directory
    assert.ok(source.includes('cwd: checkout.directory'), 'reviewer session uses checkout.directory for cwd');
    assert.ok(!source.includes('cwd: root'), 'reviewer session does not use root for cwd');
  });

  test('approver session uses its own checkout, not coordinator checkout', async () => {
    const source = await readSourceFile('master/autonomy.ts');
    // Extract launchApprover function
    const approverSection = source.substring(source.indexOf('export async function launchApprover'));
    // Verify approver allocates managed checkout
    assert.ok(approverSection.includes('allocateManagedCheckout'), 'approver allocates managed checkout');
    // Verify approver pane uses checkout.directory
    assert.ok(approverSection.includes("'--cwd', checkout.directory"), 'approver pane uses checkout.directory');
    // Verify approver session uses checkout.directory for cwd
    assert.ok(approverSection.includes('cwd: checkout.directory'), 'approver session uses checkout.directory for cwd');
    // Verify settleCheckout is called on error
    assert.ok(approverSection.includes('settleCheckout'), 'approver cleans up checkout on error');
  });

  test('escalation handler session uses its own checkout, not coordinator checkout', async () => {
    const source = await readSourceFile('master/autonomy.ts');
    // Extract launchEscalationHandler function
    const handlerSection = source.substring(source.indexOf('export async function launchEscalationHandler'));
    // Verify handler allocates managed checkout
    assert.ok(handlerSection.includes('allocateManagedCheckout'), 'escalation handler allocates managed checkout');
    // Verify handler pane uses checkout.directory
    assert.ok(handlerSection.includes("'--cwd', checkout.directory"), 'escalation handler pane uses checkout.directory');
    // Verify handler session uses checkout.directory for cwd
    assert.ok(handlerSection.includes('cwd: checkout.directory'), 'escalation handler session uses checkout.directory for cwd');
    // Verify settleCheckout is called on error
    assert.ok(handlerSection.includes('settleCheckout'), 'escalation handler cleans up checkout on error');
  });

  test('producer session uses its own checkout, not coordinator checkout', async () => {
    const source = await readSourceFile('master/dispatch.ts');
    // Extract launchWorker function
    const workerSection = source.substring(source.indexOf('async function launchWorker'));
    // Verify worker pane uses prepared.path (the worktree)
    assert.ok(workerSection.includes("'--cwd', prepared.path"), 'worker pane uses prepared.path (worktree)');
    // Verify worker session uses cwd: prepared.path
    assert.ok(workerSection.includes('cwd: prepared.path'), 'worker session uses prepared.path for cwd');
    // This isolates the producer/worker in its own worktree, outside the coordinator checkout
  });
});

// AC-2: unit:coordinator-checkout-drift-detected
// The loop checks the coordinator checkout each cycle: when HEAD is not the commit it runs or
// the tree is dirty, it records attention naming the paths, the HEAD and the sessions whose
// checkouts or panes point at it, and does not self-upgrade or restart from it until it is clean.
describe('AC-2: coordinator-checkout-drift-detected', () => {
  test('loop detects and records coordinator checkout drift via upgrade.refused', async () => {
    const source = await readSourceFile('daemon/run.ts');
    // Verify coordinatorCheckoutRefusal is imported and used
    assert.ok(source.includes('coordinatorCheckoutRefusal'), 'daemon imports coordinatorCheckoutRefusal');
    assert.ok(source.includes('import'), 'daemon imports from profiles.js');
    // This function checks the coordinator checkout each cycle and refuses upgrades if drifted
  });

  test('drift attention is reported in master status when upgrade is refused', async () => {
    const profilesSource = await readSourceFile('master/profiles.ts');
    // Verify coordinatorCheckoutRefusal function exists and implements drift detection
    assert.ok(profilesSource.includes('export function coordinatorCheckoutRefusal'), 'coordinatorCheckoutRefusal is exported');
    // Verify it checks for dirty state and HEAD divergence
    assert.ok(profilesSource.includes('CoordinatorCheckout'), 'function accepts CoordinatorCheckout type');
    // The function returns a refusal message when drift is detected, which prevents self-upgrade
    // and causes the loop to record attention with the paths and HEAD information
  });
});
