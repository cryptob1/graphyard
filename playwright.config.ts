import { defineConfig } from '@playwright/test';
// `npm run test:browser` (tests/helpers/run-tests.ts --browser) reserves a free port for the server.
// The suite runs against the built bundle, not the dev server: a cold dev server transforms on first
// request, so a fresh checkout (every merge trial) timed tests out before the first page rendered.
const port = Number(process.env.GRAPHYARD_BROWSER_PORT ?? 4319);
const vite = (command: string) => `npx vite ${command} --configLoader runner --outDir ../.graphyard/browser-dist`;
export default defineConfig({
  // The suite shares its host with the loop that runs it: a merge trial's parallel workers (browsers,
  // embedded Postgres boots) can throttle the CPU far past a quiet run's pace, and the failures move
  // test to test between runs. One budget for the whole suite — the 60/90/120 s per-spec bumps this
  // replaced each named the same loaded host, one flake at a time — so no test holds a tighter clock
  // than the trial host needs, and a quiet run never waits longer than its own assertions take.
  testDir: './browser-tests', fullyParallel: true, timeout: 120_000, expect: { timeout: 15_000 },
  // GY-3267: under an e2e command step the trial names E2E_SCREENSHOTS_DIR; each test's last page is captured
  // there, and the newest becomes the case's screenshot on the item page.
  ...(process.env.E2E_SCREENSHOTS_DIR ? { outputDir: process.env.E2E_SCREENSHOTS_DIR } : {}),
  // GY-3272: Night Yard's ambient motion (rain, streaks, the boot veil) would run on every page of
  // every test; the suite runs with reduced motion, and the specs that prove the motion ask for it.
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, reducedMotion: 'reduce', screenshot: process.env.E2E_SCREENSHOTS_DIR ? 'on' : 'off' },
  webServer: { command: `${vite('build')} && ${vite(`preview --host 127.0.0.1 --port ${port} --strictPort`)}`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
});
