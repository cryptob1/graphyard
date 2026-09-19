import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeProtocolSkew } from '../src/master.js';
import { MERGE_PROTOCOL, buildIdentity, cliCommit } from '../src/protocol-version.js';

// GY-59 AC-3: a CLI/server protocol mismatch on master merge is reported as version skew.
const SERVER = '72b6326'.padEnd(40, '0'), CLI = 'abc1234'.padEnd(40, '0');

test('unit:merge-version-skew — a server behind the CLI is reported as "deploy main first" with both commits, not as an invalid gate verification', () => {
  // The production failure: main merged the new broker, the deployment never served it, and
  // the server still answered the old protocol.
  const behind = mergeProtocolSkew({ build: { commit: SERVER, protocol: 1 } }, { commit: CLI, protocol: 2 });
  assert.equal(behind, `server runs ${SERVER}, CLI expects ${CLI}: deploy main first (server merge protocol 1, CLI merge protocol 2; the deployment has not served the commit the CLI runs)`);
  // A server that reports no build at all predates the exchange: protocol 1, unknown commit.
  assert.match(mergeProtocolSkew({}, { commit: CLI })!, /^server runs an unknown commit, CLI expects abc1234.*: deploy main first \(server merge protocol 1, CLI merge protocol \d+;/);
  assert.match(mergeProtocolSkew(undefined, { commit: null })!, /^server runs an unknown commit, CLI expects an unknown commit: deploy main first/);
  // A CLI behind the server is skew in the other direction, with the other remedy.
  assert.match(mergeProtocolSkew({ build: { commit: SERVER, protocol: 3 } }, { commit: CLI, protocol: 2 })!, /update the CLI checkout to the deployed commit/);
  // Matching protocols never refuse, whatever the commits are: routine deploys move the commit without changing the exchange.
  assert.equal(mergeProtocolSkew({ build: { commit: SERVER, protocol: MERGE_PROTOCOL } }, { commit: CLI }), null);
  assert.equal(mergeProtocolSkew({ build: { commit: null, protocol: MERGE_PROTOCOL } }, { commit: null }), null);
  assert.equal(MERGE_PROTOCOL, 2, 'the merge-verify clock offset and merge-commit step are protocol 2');
});

test('unit:merge-version-skew — the build identity comes from the deployment environment and the CLI commit from its checkout', () => {
  assert.deepEqual(buildIdentity({}), { commit: null, protocol: MERGE_PROTOCOL, source: null });
  assert.deepEqual(buildIdentity({ RAILWAY_GIT_COMMIT_SHA: SERVER.toUpperCase() }), { commit: SERVER, protocol: MERGE_PROTOCOL, source: 'RAILWAY_GIT_COMMIT_SHA' });
  assert.equal(buildIdentity({ GRAPHYARD_BUILD_SHA: CLI, RAILWAY_GIT_COMMIT_SHA: SERVER }).source, 'GRAPHYARD_BUILD_SHA', 'an explicit build SHA wins over the provider variable');
  assert.equal(buildIdentity({ GRAPHYARD_BUILD_SHA: 'main' }).commit, null, 'a ref is not a commit');
  assert.equal(cliCommit('/repo', () => `${CLI}\n`), CLI);
  assert.equal(cliCommit('/repo', () => 'fatal: not a git repository'), null);
  assert.equal(cliCommit('/repo', () => { throw new Error('git missing'); }), null);
});
