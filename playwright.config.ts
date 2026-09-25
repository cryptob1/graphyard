import { defineConfig } from '@playwright/test';
// `npm run test:browser` (tests/helpers/run-tests.ts --browser) reserves a free port for the dev server.
const port = Number(process.env.GRAPHYARD_BROWSER_PORT ?? 4319);
export default defineConfig({
  testDir: './browser-tests', fullyParallel: true, timeout: 30000,
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true },
  webServer: { command: `npm run dev:web -- --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
});
