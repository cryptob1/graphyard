import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, pruneDaemonState, type DaemonState } from '../src/master-daemon.js';
import { diagnosticianGate, probeSubject } from '../src/daemon/diagnosis.js';
import { providerLimit } from '../src/model/capacity.js';
import { retainedDiagnoses } from '../src/runner/payloads.js';

// GY-1245: follow-ups from the approved review of GY-1092. A provider hold survives retention, the
// probe after a reset runs the subject refused longest ago, and a 429 is a limit only as the
// provider's status. The retention and 429 cases fail on the base.

const minute = 60_000, hour = 60 * minute;
const iso = (at: number) => new Date(at).toISOString();
const refusedAt = Date.parse('2026-10-01T22:22:33.900Z');
const limitError = '429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-03 08:27:35"}';
function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [], run: { proofWorkflow: 'acceptance.yml' } });
}
const diagnosisRecord = (subject: string, state: 'waiting' | 'answered', at: number, refused: number | null = null) => ({
  subject, kind: 'recurring', faultClass: 'loop', work: subject, state, startedAt: iso(at), updatedAt: iso(at), runs: [], diagnosis: null, fix: null,
  decision: null, answeredBy: null, retryAt: refused === null ? null : iso(refused + hour), refusedAt: refused === null ? null : iso(refused), detail: '' }) as DaemonState['diagnoses'][string];

test('GY-1245 — retention past the bound never prunes a waiting diagnosis, so the provider hold survives the overflow', () => {
  const state = emptyDaemonState(config());
  // The waiting entry is the oldest record, the first a settled-only prune would take.
  state.diagnoses['GY-1083'] = diagnosisRecord('GY-1083', 'waiting', refusedAt - hour, refusedAt);
  for (let index = 0; index < retainedDiagnoses + 5; index++) state.diagnoses[`GY-${2000 + index}`] = diagnosisRecord(`GY-${2000 + index}`, 'answered', refusedAt + index * 1000);
  pruneDaemonState(state);
  assert.equal(state.diagnoses['GY-1083']?.state, 'waiting');
  assert.equal(Object.keys(state.diagnoses).length, retainedDiagnoses);
  assert.equal(diagnosticianGate(state, refusedAt + 30 * minute), 'held');
});

test('GY-1245 — a probe runs the waiting subject refused longest ago, not whichever subject is listed first', () => {
  const state = emptyDaemonState(config());
  state.diagnoses['GY-1084'] = diagnosisRecord('GY-1084', 'waiting', refusedAt + 3 * hour, refusedAt);
  state.diagnoses['GY-1083'] = diagnosisRecord('GY-1083', 'waiting', refusedAt, refusedAt - 10 * minute);
  const subjects = [{ id: 'GY-1200' }, { id: 'GY-1084' }, { id: 'GY-1083' }];
  assert.deepEqual(probeSubject(state, subjects), [{ id: 'GY-1083' }]);
  assert.deepEqual(probeSubject(emptyDaemonState(config()), subjects), [{ id: 'GY-1200' }]);
  assert.deepEqual(probeSubject(state, []), []);
});

test('GY-1245 — a 429 is a limit only as the provider\'s status, never inside an id or an echoed body', () => {
  for (const text of ['429 Too Many Requests', 'Error: 429 rate limited', 'HTTP 429: slow down', 'HTTP/1.1 429', 'request failed with status code 429', '{"status": 429, "error": "quota"}', '{"code":429}', limitError])
    assert.ok(providerLimit(text, refusedAt), text);
  for (const text of ['request 429 failed: model not found', 'invalid tool call in message 429 of the transcript', 'ENOENT /tmp/run-429/models.json', 'id req_429 failed: internal error'])
    assert.equal(providerLimit(text, refusedAt), null, text);
});
