import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../playwright.config.js';

// GY-3158: every merge trial and batch gate is a fresh checkout. A cold vite dev server transforms
// each module on first request, so under parallel workers the first pages missed the test timeout.
test('unit:browser-suite-serves-built-bundle — the browser suite builds the bundle and serves it, never the on-demand dev server', () => {
  const server = config.webServer;
  assert.ok(server && !Array.isArray(server));
  assert.match(server.command, /vite build .*&& .*vite preview /);
  assert.doesNotMatch(server.command, /dev:web/);
});
