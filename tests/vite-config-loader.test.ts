import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 2026-09-26: worker sandboxes make everything outside the worker's worktree read-only, and a
// worktree shares the coordinator checkout's node_modules. Vite's default config loader bundles
// vite.config.ts into node_modules/.vite-temp, so `npm run build` failed with EROFS for every
// sandboxed worker (GY-711, GY-714, GY-754, GY-761, GY-839). The runner loader writes nothing there.
test('unit:vite-config-loader-runner — every script that runs Vite loads its config without writing into node_modules', async () => {
  const scripts: Record<string, string> = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).scripts;
  const vite = Object.entries(scripts).filter(([, command]) => /(^|&&\s*|\s)vite(\s|$)/.test(command));
  assert.ok(vite.length, 'the build runs Vite');
  for (const [name, command] of vite) assert.match(command, /vite(\s+(build|preview))?\s+--configLoader runner/, `${name} loads vite.config.ts with the runner loader`);
});
