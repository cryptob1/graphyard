import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// GY-3379: the shared-server guide. The docs index (docs/README.md) and setup-from-zero.md were
// folded into README.md and docs/setup.md by GY-3109, so those two — the repository's landing page
// and the setup guide — are the pages the guide links from.
const root = new URL('..', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const section = (guide: string, name: string) => guide.split(`## ${name}\n`)[1]?.split('\n## ')[0] ?? '';

test('e2e:docs-shared-server-guide — docs/shared-server.md carries the shared server (swap, Landlock kernel), several installs, Tailscale machine sharing, the shared Herdr with only Master sessions, per-install ports, sign-in and invites, and moving an install by hand, linked from README.md and docs/setup.md', () => {
  const guide = read('docs/shared-server.md');
  assert.equal(guide.split('\n')[0], '# A shared Graphyard server on Tailscale', 'the guide carries its title');
  assert.deepEqual([...guide.matchAll(/^## (.+)$/gm)].map(match => match[1]), [
    'The server',
    'Several installs on one server',
    'Sharing the machine over Tailscale',
    'One Herdr, holding only the Master sessions',
    'One port per install',
    'Signing in and inviting people',
    'The missing desktop keyring',
    'Data kept outside Git',
    'Moving an install by hand',
  ], 'the guide carries exactly its sections');

  const server = section(guide, 'The server');
  for (const fact of ['swap', 'swapon', 'Landlock', 'Linux 7.0', 'uname -r']) assert.ok(server.includes(fact), `The server says: ${fact}`);

  const installs = section(guide, 'Several installs on one server');
  for (const fact of ['graphyard up --repo OWNER/NAME', 'graphyard-OWNER-NAME-server-1', 'graphyard-master-OWNER-NAME.service']) assert.ok(installs.includes(fact), `Several installs says: ${fact}`);

  const sharing = section(guide, 'Sharing the machine over Tailscale');
  for (const fact of ['tailscale serve --bg --http=PORT', 'Share', '30 days']) assert.ok(sharing.includes(fact), `Sharing says: ${fact}`);

  const herdr = section(guide, 'One Herdr, holding only the Master sessions');
  for (const fact of ['Herdr', 'Master', 'headless', '~/.config/herdr']) assert.ok(herdr.includes(fact), `Herdr says: ${fact}`);

  const ports = section(guide, 'One port per install');
  for (const fact of ['4310', 'http://SERVER:PORT']) assert.ok(ports.includes(fact), `Ports says: ${fact}`);

  const signin = section(guide, 'Signing in and inviting people');
  for (const fact of ['Invite someone', 'opens once', 'viewer', 'maintainer', 'graphyard login']) assert.ok(signin.includes(fact), `Sign-in says: ${fact}`);

  const move = section(guide, 'Moving an install by hand');
  for (const fact of ['~/.config/graphyard/<install>/', '~/.config/graphyard/masters/', '.git/worktrees']) assert.ok(move.includes(fact), `Moving says: ${fact}`);

  assert.match(read('README.md'), /\]\(docs\/shared-server\.md\)/, 'README links the guide');
  assert.match(read('docs/setup.md'), /\]\(shared-server\.md\)/, 'the setup guide links the guide');

  assert.doesNotMatch(guide, /\btoken\b/i, 'the guide names no token');
  assert.doesNotMatch(guide, /password/i, 'the guide names no password');
  assert.doesNotMatch(guide, /[\w.+-]+@[\w-]+\.[\w.-]+/, 'the guide carries no email address');
  assert.doesNotMatch(guide, /#[a-z-]+=[A-Za-z0-9_-]{16,}/, 'the guide carries no sign-in or claim code');
  assert.doesNotMatch(guide, /chief/i, 'the guide says Master, never Chief');
});
