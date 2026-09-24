import { readFile } from 'node:fs/promises';

/** The master-agent guide: the operating loop, then its sessions and reference pages. */
export const masterGuidePages = ['docs/master-agent.md', 'docs/master-agent-sessions.md', 'docs/master-agent-reference.md'] as const;

/** Every page of the master-agent guide as one text, in page order, for tests that check what the guide states. */
export async function readMasterGuide() {
  const pages = await Promise.all(masterGuidePages.map(page => readFile(new URL(`../../${page}`, import.meta.url), 'utf8')));
  return pages.join('\n');
}
