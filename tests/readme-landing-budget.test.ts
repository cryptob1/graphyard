import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// GY-3360: the README stays at 290 words or fewer; every fact cut from it lives in docs/setup.md, which the README links.
const root = new URL('..', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const moved = [
  'on an AppArmor host up loads the `graphyard-trial` profile with sudo',
  'Workers and reviewers run headless, logged per item (`graphyard guide runtimes`)',
  'Where a SAML organization or org policy blocks deploy keys, `--push-auth gh` pushes with your gh login instead of a deploy key',
  'Setup invites or revokes viewers and maintainers',
  'Verified deploys publish `@cryptob1/graphyard` with npm OIDC provenance plus both GHCR images via Actions — no host publish token',
];

test('e2e:readme-landing-budget — README is at most 290 words, links the setup guide, and the guide carries every fact moved out of the README', () => {
  const readme = read('README.md');
  const words = readme.trim().split(/\s+/).length;
  assert.ok(words <= 290, `README is at most 290 words: ${words}`);
  assert.match(readme, /\]\(docs\/setup\.md\)/, 'README links docs/setup.md');
  const guide = read('docs/setup.md');
  for (const fact of moved) assert.ok(guide.includes(fact), `docs/setup.md carries: ${fact}`);
});
