import { defineConfig } from '@playwright/test';
// Parallel worktrees on one machine need distinct ports; CI keeps the default.
const port = Number(process.env.GRAPHYARD_BROWSER_TEST_PORT ?? 4319);
export default defineConfig({
  testDir: './browser-tests', fullyParallel: true, timeout: 30000,
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true },
  webServer: { command: `npm run dev:web -- --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
});
