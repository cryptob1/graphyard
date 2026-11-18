import { defineConfig } from '@playwright/test';
import base from '../../playwright.config';
// Regression specs owned by a tests/*.test.ts wrapper (GY-3364): the root browser suite's server and
// options, with this directory as the test root and the server started from the repository root.
export default defineConfig({ ...base, testDir: '.', webServer: { ...(base.webServer as object), cwd: '../..' } as any });
