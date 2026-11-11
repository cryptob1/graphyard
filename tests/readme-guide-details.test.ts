import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// GY-3262: the README is a 250-word landing page; the full prerequisite checks and fixes,
// and the publishing account setup, moved into `graphyard guide setup` and
// `graphyard guide publishing`, which the README names.
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const cli = new URL('../src/cli.ts', import.meta.url);
const guide = (topic: string) => execFileSync(process.execPath, ['--import', 'tsx', cli.pathname, 'guide', topic], { encoding: 'utf8' });

test('unit:readme-guide-details — guide setup prints every prerequisite, check command and fix the landing page summarizes, and the README names it', () => {
  const setup = guide('setup');
  for (const detail of [
    'Linux 7.0+ with Landlock ABI 9+', 'uname -r', 'doctor checks the ABI',
    'Node.js 24+ and npm', 'node --version && npm --version',
    'durable checkout with an SSH origin', 'git --version && git rev-parse --show-toplevel && git remote -v',
    'Docker Engine usable by your user', 'merge trials need it even with `--local`', 'docker version',
    'Docker Compose plugin', 'docker compose version',
    'GitHub CLI signed in with repo scope and admin access', 'gh auth status && gh repo view OWNER/NAME --json viewerPermission',
    'Bubblewrap (worker confinement)', 'bwrap --version', 'sudo apt install bubblewrap', 'sudo pacman -S bubblewrap',
    'Python 3 (Landlock probe)', 'python3 --version',
    'Herdr', '`up` installs it if absent', 'herdr --version',
    'systemd user manager', 'systemctl --user status',
    'npx @cryptob1/graphyard doctor', 'checks credentials, agent logins, confinement, the kernel and services', 'failed check prints its fix',
    'gh auth login --scopes repo', 'No GitHub App is needed', 'merge writer\'s deploy key',
    'Contents read/write on the one repository', '--merge-token-stdin',
    'npx @cryptob1/graphyard install --repo OWNER/NAME --plan', '--provider local',
  ]) assert.ok(setup.includes(detail), `guide setup carries ${detail}`);
  assert.ok(readme.includes('graphyard guide setup'), 'README names graphyard guide setup');
});

test('unit:readme-guide-details — guide publishing prints the publishing account setup the landing page summarizes, and the README names it', () => {
  const publishing = guide('publishing');
  for (const detail of [
    'vYYYY.M.D-<sha12>', 'GitHub Actions', '@cryptob1/graphyard', 'npm OIDC provenance',
    'both GHCR images (`graphyard`, `graphyard-trial`)', 'GITHUB_TOKEN', 'the host holds no publish token',
    'Publishing runs apart from merge and deploy', "npm's latest version", 'graphyard master status',
    'placeholder `0.0.0`', 'npm publish --access public', 'Trusted Publisher', 'cryptob1/graphyard',
    'workflow **publish.yml**', 'grant **cryptob1/graphyard** Actions write access',
  ]) assert.ok(publishing.includes(detail), `guide publishing carries ${detail}`);
  assert.ok(readme.includes('graphyard guide publishing'), 'README names graphyard guide publishing');
});
