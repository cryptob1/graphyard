import { test, expect } from '@playwright/test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { signInDatabase } from '../tests/helpers/sign-in-database';
import { bridgeTerminals } from '../src/master/terminal-bridge';

const stub = resolve('fixtures/herdr-terminal-stub');
const settled = { timeout: 15_000 };

/** A control plane as a compose container runs it: no herdr on its PATH or in its home, and the stub herdr only on the "host" (this process). */
async function containerServer(site: string) {
  await symlink(resolve('.graphyard/browser-dist'), join(site, 'dist'));
  const database = await signInDatabase();
  const child = fork(resolve('tests/helpers/terminal-server.ts'), [database.url, site], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, PATH: join(site, 'empty'), HOME: site, GRAPHYARD_HERDR_CONFIG_HOME: '', GRAPHYARD_HERDR_SESSION: '' } });
  const [{ url }] = await once(child, 'message') as [{ url: string }];
  const signIn = async (browser: import('@playwright/test').Browser) => {
    const { code } = await (await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string };
    const page = await browser.newPage();
    await page.goto(`${url}/#sign-in=${code}&master`);
    return page;
  };
  const stop = async () => { const ended = once(child, 'exit'); child.send('stop'); await ended; await database.close(); await rm(site, { recursive: true, force: true }); };
  return { url, signIn, stop };
}

test('e2e:master-page-compose-install — a server with no herdr streams the master pane through the host supervisor, and typed input reaches it', async ({ browser }) => {
  const site = await mkdtemp(join(tmpdir(), 'graphyard-compose-terminal-'));
  process.env.PATH = `${stub}${delimiter}${process.env.PATH}`; process.env.HERDR_STUB_LOG = join(site, 'herdr.log');
  process.env.GRAPHYARD_HERDR_CONFIG_HOME = ''; process.env.GRAPHYARD_HERDR_SESSION = '';
  const server = await containerServer(site), stopping = new AbortController();
  try {
    await new Promise<void>(done => bridgeTerminals(server.url, 'test-coordinator', stopping.signal, done));
    const operator = await server.signIn(browser);
    await expect(operator.getByRole('heading', { name: 'Master', exact: true })).toBeVisible(settled);
    await expect(operator.locator('.xterm-rows')).toContainText('screen of w1:master', settled);
    await operator.locator('.terminal-host').click();
    await operator.keyboard.type('status please');
    await operator.keyboard.press('Enter');
    await expect(operator.locator('.xterm-rows')).toContainText('status please', settled);
  } finally { stopping.abort(); await server.stop(); }
});
