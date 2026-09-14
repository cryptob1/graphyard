import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './browser-tests', fullyParallel: true, timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:4319', headless: true },
  webServer: { command: 'npm run dev:web -- --port 4319 --strictPort', url: 'http://127.0.0.1:4319', reuseExistingServer: false },
});
