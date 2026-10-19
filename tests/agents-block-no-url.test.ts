import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyProposal, managedInstructions, scanProposal } from '../src/repository-setup.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2240: the managed AGENTS.md block once embedded the install's control-plane URL, so every
// deploy's refresh step (`init --scan` then `init --scan --apply` with the install URL) rewrote the
// committed block with that machine's origin and left the coordinator checkout dirty on AGENTS.md —
// executors then refused every dispatch until a hand-run checkout restore. The URL already lives in
// ignored `.graphyard/connection.json`; the committed block names that file instead and carries no
// URL, so the same refresh on any install leaves a checkout at the committed block byte-identical.

test('unit:agents-block-refresh-is-url-independent — the managed AGENTS.md block names no control-plane URL, and the scan-and-apply refresh leaves a checkout holding it byte-identical under two different install URLs', async () => {
  const block = managedInstructions('# Rules\n');
  assert.doesNotMatch(block, /https?:\/\//, 'the block repository setup renders carries no URL');
  assert.match(block, /ignored\n`\.graphyard\/connection\.json` names the control plane/, 'the block points at the ignored connection file for machine-specific settings');

  const root = await temporaryDirectory('agents-block-no-url');
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/repo.git'], { cwd: root });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --version', typecheck: 'node --version' } }));
    await writeFile(join(root, 'AGENTS.md'), block);

    const refresh = async (url: string) => applyProposal(root, await scanProposal(root, { url, runtimes: [] }), { url });
    await refresh('https://one.example');
    const afterFirst = await readFile(join(root, 'AGENTS.md'));
    assert.ok(afterFirst.equals(Buffer.from(block, 'utf8')), 'the first install URL leaves the committed block byte-identical');
    await refresh('http://127.0.0.1:4311');
    const afterSecond = await readFile(join(root, 'AGENTS.md'));
    assert.ok(afterSecond.equals(afterFirst), 'a second refresh with a different install URL leaves the same bytes');
  } finally { await rm(root, { recursive: true, force: true }); }
});
