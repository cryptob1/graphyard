import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareDateVersions, datedVersionPattern, nextDateVersion } from '../src/release.js';

// GY-1959: every candidate production promotes becomes a dated release on the stable channel.
const day = new Date('2026-10-17T23:59:00Z');

test('unit:release-version — the first promotion of a day takes YYYY.M.D, later ones .1, .2', () => {
  assert.equal(nextDateVersion(day, []), '2026.10.17');
  assert.equal(nextDateVersion(day, ['rc/abc', 'stable', 'v0.1.0', '2026.10.16', '2026.10.16.3']), '2026.10.17');
  assert.equal(nextDateVersion(day, ['2026.10.17']), '2026.10.17.1');
  assert.equal(nextDateVersion(day, ['2026.10.17', '2026.10.17.1']), '2026.10.17.2');
  // Gaps and order do not matter: one past the highest suffix of the day.
  assert.equal(nextDateVersion(day, ['2026.10.17.4', '2026.10.17', '2026.10.17.2']), '2026.10.17.5');
  // Months and days carry no leading zero, and the UTC calendar day decides.
  assert.equal(nextDateVersion(new Date('2026-01-05T00:00:00Z'), ['2026.1.4']), '2026.1.5');
  assert.equal(nextDateVersion(new Date('2026-01-05T00:00:00Z'), ['2026.01.05']), '2026.1.5', 'a zero-padded tag is not a date version');
  for (const version of ['2026.10.17', '2026.10.17.1', '2026.1.5']) assert.match(version, datedVersionPattern);
  for (const other of ['0.1.0x', 'v2026.10.17', '2026.10.17.0', 'stable', 'unreleased abc']) assert.doesNotMatch(other, datedVersionPattern);
  assert.deepEqual(['2026.10.17.1', '2026.9.30', '2026.10.17', '2026.10.17.10', '2026.10.17.2'].sort(compareDateVersions),
    ['2026.9.30', '2026.10.17', '2026.10.17.1', '2026.10.17.2', '2026.10.17.10']);
});

test('unit:release-version — the promote job tags the promoted commit, publishes its image under the version and moves stable to it', () => {
  const workflow = readFileSync('.github/workflows/release-candidate.yml', 'utf8');
  const promote = workflow.slice(workflow.indexOf('\n  promote:\n'));
  assert.ok(promote.length > 1 && !/\n  [a-z-]+:\n/.test(promote.slice(1)), 'promote is the last job of the workflow');
  assert.match(promote, /permissions:\n      contents: write\n      packages: write\n/);
  assert.match(promote, /\n      CANDIDATE_SHA: \$\{\{ needs\.candidate\.outputs\.sha \}\}\n/);
  // Each step's text, from its `- ` line to the next.
  const steps = promote.split(/\n      - /).slice(1);
  const index = (pattern: RegExp) => { const at = steps.findIndex(step => pattern.test(step)); assert.ok(at >= 0, `the promote job has a step running ${pattern}`); return at; };
  const promoted = index(/release promote/), computed = index(/import { nextDateVersion }/), published = index(/docker push "\$REPOSITORY:\$VERSION"/), tagged = index(/git\/refs" -f "ref=refs\/tags\/\$VERSION" -f "sha=\$CANDIDATE_SHA"/);
  assert.ok(promoted < computed && computed < published && published < tagged, 'the version is computed after promotion, and the git tag follows the published image');
  assert.match(steps[computed], /git fetch --force --tags/);
  const build = steps[published];
  assert.match(build, /checkout --detach "\$CANDIDATE_SHA"/);
  assert.match(build, /GRAPHYARD_VERSION=\$VERSION/);
  const channel = steps[tagged];
  assert.match(channel, /docker tag "\$REPOSITORY:\$VERSION" "\$REPOSITORY:stable"/);
  assert.match(channel, /docker push "\$REPOSITORY:stable"/);
  assert.match(channel, /--method PATCH "repos\/\$GITHUB_REPOSITORY\/git\/refs\/tags\/stable" -f "sha=\$CANDIDATE_SHA" -F force=true/);
  assert.ok(channel.indexOf('refs/tags/$VERSION') < channel.indexOf('docker push "$REPOSITORY:stable"'), 'stable moves only once the dated tag exists');
  assert.doesNotMatch(promote, /git push/, 'tags are written through the refs API, never pushed from the checkout');
});
