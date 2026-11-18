import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchGateStep, fetchRefusalKey, noteBatchGateStopping } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3464: a loop restart kills the merge writer's in-flight `git fetch`; the loop reported that as
// the remote refusing access and sent the owner to re-authorise an SSH key that already worked.
// Only GitHub's SAML SSO refusal earns that advice; any other failure is reported in its own words.

const repository = 'cryptob1/graphyard';
const failure = (stderr: string, extra: object = {}) => Object.assign(new Error(`Command failed: git fetch --no-tags origin main\n${stderr}`), { stderr, ...extra });

async function fetchWith(fetch: (state: object) => Promise<string>) {
  const root = await temporaryDirectory('fetch-interrupted');
  const state = emptyDaemonState({ url: 'https://graphyard.example', repository } as any);
  const journal: string[] = [];
  const reads = { baseBranch: 'main', now: Date.now, fetch: () => fetch(state), git: async () => '', gate: { root, repository } } as unknown as MergeWriterReads;
  const thrown = await batchGateStep({ state, effects: { mergeWriter: reads } as any, snapshot: { work: [], now: new Date().toISOString() } as any, now: Date.now, log: line => journal.push(line) }).catch((error: unknown) => error);
  assert.ok(thrown instanceof Error, 'the failed fetch propagates to the gate step');
  return { state, journal };
}

test('e2e:fetch-interrupted-not-sso — a loop stopped while its fetch of main is in flight records no attention line and no SSO text', async () => {
  const { state, journal } = await fetchWith(async state => {
    noteBatchGateStopping(state); // the loop's SIGTERM handler, while git fetch runs
    throw failure('', { signal: 'SIGTERM', killed: true });
  });
  assert.equal(state.actions[fetchRefusalKey], undefined);
  assert.doesNotMatch(journal.join('\n'), /SSO|SAML|authori[sz]e/i);
});

test('e2e:fetch-interrupted-not-sso — a fetch refused by GitHub SAML SSO still produces the authorise message', async () => {
  const { state } = await fetchWith(async () => { throw failure("ERROR: The 'cryptob1' organization has enabled or enforced SAML SSO. To access this repository, you must re-authorize the OAuth Application.\nfatal: Could not read from remote repository.\n"); });
  const detail = state.actions[fetchRefusalKey]!.detail;
  assert.match(detail, /enabled or enforced SAML SSO/);
  assert.match(detail, /Configure SSO → Authorize/);
});

test('e2e:fetch-interrupted-not-sso — a fetch failing with any other stderr reports that stderr, not the SSO advice', async () => {
  const { state } = await fetchWith(async () => { throw failure("fatal: unable to access 'https://github.com/cryptob1/graphyard/': Could not resolve host: github.com\n"); });
  const detail = state.actions[fetchRefusalKey]!.detail;
  assert.match(detail, /Could not resolve host: github\.com/);
  assert.doesNotMatch(detail, /SSO|SAML|authori[sz]e/i);
});
