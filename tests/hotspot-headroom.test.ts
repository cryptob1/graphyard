import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFile(join(root, path), 'utf8');
const lines = (text: string) => text.split('\n').length;

test('unit:cycle-decisions-headroom — src/daemon/cycle-decisions.ts and every split module stay within 600 lines', async () => {
  const daemonFiles = [
    'src/daemon/cycle-decisions.ts',
    'src/daemon/cycle-approvers.ts',
  ];
  for (const file of daemonFiles) {
    const text = await read(file);
    const count = lines(text);
    assert.ok(count <= 600, `${file} has ${count} lines; budget is 600 lines (AC-1)`);
    const header = text.split('\n')[0];
    assert.match(header, /^\/\/ Concern: \S.{10,}$/, `${file} opens with a "// Concern: …" header naming what it owns`);
  }
});

test('unit:workspace-cli-headroom — src/cli/workspace.ts and every split module stay within 260 lines', async () => {
  const cliFiles = [
    'src/cli/workspace.ts',
    'src/cli/workspace-worktree.ts',
    'src/cli/workspace-generated.ts',
  ];
  for (const file of cliFiles) {
    const text = await read(file);
    const count = lines(text);
    assert.ok(count <= 260, `${file} has ${count} lines; budget is 260 lines (AC-2)`);
    if (file !== 'src/cli/workspace.ts') assert.match(text.split('\n')[0], /^\/\/ Concern: \S.{10,}$/, `${file} opens with a "// Concern: …" header naming what it owns`);
  }
});
