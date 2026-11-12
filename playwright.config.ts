import { defineConfig } from '@playwright/test';
// `npm run test:browser` (tests/helpers/run-tests.ts --browser) reserves a free port for the server.
// The suite runs against the built bundle, not the dev server: a cold dev server transforms on first
// request, so a fresh checkout (every merge trial) timed tests out before the first page rendered.
const port = Number(process.env.GRAPHYARD_BROWSER_PORT ?? 4319);
const vite = (command: string) => `npx vite ${command} --configLoader runner --outDir ../.graphyard/browser-dist`;
export default defineConfig({
  testDir: './browser-tests', fullyParallel: true, timeout: 30000,
  // GY-3267: under an e2e command step the trial names E2E_SCREENSHOTS_DIR; each test's last page is captured
  // there, and the newest becomes the case's screenshot on the item page.
  ...(process.env.E2E_SCREENSHOTS_DIR ? { outputDir: process.env.E2E_SCREENSHOTS_DIR } : {}),
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, screenshot: process.env.E2E_SCREENSHOTS_DIR ? 'on' : 'off' },
  webServer: { command: `${vite('build')} && ${vite(`preview --host 127.0.0.1 --port ${port} --strictPort`)}`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
});
