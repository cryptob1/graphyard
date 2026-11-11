import type { BrowserContext, Page } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * The live terminal loads xterm.js from the CDN (web/components/live-terminal.tsx). The suite serves
 * the same pinned files from the @xterm/xterm devDependency instead, so a slow or failed CDN fetch
 * never fails a test (GY-3261); the page's integrity hashes still check the bytes.
 */
export const serveXterm = (target: Page | BrowserContext) =>
  target.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@xterm\/xterm@[^/]+\/(.+)$/, route => route.fulfill({
    path: resolve('node_modules/@xterm/xterm', new URL(route.request().url()).pathname.replace(/^\/npm\/@xterm\/xterm@[^/]+\//, '')),
    headers: { 'Access-Control-Allow-Origin': '*' },
  }));
