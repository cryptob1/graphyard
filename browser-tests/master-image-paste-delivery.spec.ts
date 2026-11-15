import { test, expect, chromium, type Page } from '@playwright/test';
import { execFileSync, fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { signInDatabase } from '../tests/helpers/sign-in-database';
import { bridgeTerminals } from '../src/master/terminal-bridge';
import { masterSessionConfinement } from '../src/master/launch';
import { sessionMountNamespaceWorks } from '../src/master/confinement';
import { httpsFront } from './https-origin';
import { serveXterm } from './xterm';

const stub = resolve('fixtures/herdr-terminal-stub');
const settled = { timeout: 15_000 };
/** The origin the owner actually reaches: HTTPS on a name that is not localhost, as `tailscale serve` gives. */
const host = 'graphyard-master.test';

/**
 * A screenshot-sized PNG, drawn in the page: random noise barely compresses, so the upload message
 * (its base64) is far past the ~131 KB where a browser fragments one WebSocket message into
 * continuation frames — the size a real paste carries and a tiny fixture PNG never reaches.
 */
const screenshotPng = (page: Page) => page.evaluate(async () => {
  const width = 800, height = 600, canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(width, height);
  for (let i = 0; i < image.data.length; i += 4) { image.data[i] = Math.random() * 256; image.data[i + 1] = Math.random() * 256; image.data[i + 2] = Math.random() * 256; image.data[i + 3] = 255; }
  context.putImageData(image, 0, 0);
  const blob: Blob = await new Promise(done => canvas.toBlob(result => done(result!), 'image/png'));
  return await new Promise<string>(done => { const reader = new FileReader(); reader.onload = () => done(String(reader.result).split(',')[1]!); reader.readAsDataURL(blob); });
});
const pngBytes = (base64: string) => Uint8Array.from(atob(base64), char => char.charCodeAt(0));

/** Fires the browser paste event carrying the PNG as BASE64, as Ctrl/Cmd+V does. */
const pastePng = (page: Page, base64: string, name: string) => page.locator('.xterm-helper-textarea').evaluate((area, { base64, name }) => {
  const data = new DataTransfer();
  data.items.add(new File([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], name, { type: 'image/png' }));
  area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, { base64, name });

test('e2e:master-image-paste-delivery — a screenshot pasted on the Master page over HTTPS on a non-localhost origin is saved to the master inbox and its path typed, whatever way it is pasted; refusals say why', async () => {
  test.setTimeout(120_000);
  const site = await mkdtemp(join(tmpdir(), 'graphyard-master-image-'));
  const log = join(site, 'herdr.log');
  process.env.PATH = `${stub}${delimiter}${process.env.PATH}`; process.env.HERDR_STUB_LOG = log;
  process.env.GRAPHYARD_HERDR_CONFIG_HOME = ''; process.env.GRAPHYARD_HERDR_SESSION = '';
  const database = await signInDatabase();
  const child = fork(resolve('tests/helpers/terminal-server.ts'), [database.url, site], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, PATH: `${stub}${delimiter}${process.env.PATH}`, HERDR_STUB_LOG: log, GRAPHYARD_HERDR_CONFIG_HOME: '', GRAPHYARD_HERDR_SESSION: '' } });
  const [{ url }] = await once(child, 'message') as [{ url: string }];
  await symlink(resolve('.graphyard/browser-dist'), join(site, 'dist'));
  // TLS terminates in front of the control plane, as tailscale serve does on the host the master runs on.
  const front = await httpsFront(url, host);
  const origin = front.origin;
  // The loop's own bridge, with the stub master pane on the host side and the checkout as its root.
  const stopping = new AbortController();
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${host} 127.0.0.1`] });
  const typed = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.command?.type === 'terminal.input').map(entry => entry.command.text as string);
  /** One delivered paste: the page names the saved file's absolute path, the pane receives it, and the file holds SIZE bytes. */
  const delivered = async (page: Page, name: string, size: number) => {
    await expect(page.getByRole('status')).toContainText(name, settled);
    const path = (await page.getByRole('status').innerText()).match(/→ (\S+)/)![1]!;
    expect(path.endsWith(name)).toBe(true);
    const inbox = `${join('.graphyard', 'master-inbox')}/`;
    expect(path.startsWith(join(await realpath(site), inbox)) || path.startsWith(join(site, inbox))).toBe(true);
    expect((await stat(path)).size).toBe(size);
    await expect.poll(async () => (await typed()).join(''), settled).toContain(`\x1b[200~${path}\x1b[201~`);
    return path;
  };
  try {
    await new Promise<void>(done => bridgeTerminals(url, 'test-coordinator', stopping.signal, done, undefined, site));
    const { code } = await (await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string };
    const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['clipboard-read', 'clipboard-write'] });
    const operator = await context.newPage(); await serveXterm(operator);
    await operator.goto(`${origin}/#sign-in=${code}&master`);
    await expect(operator.getByRole('status')).toContainText('You can type here', settled);
    await operator.locator('.terminal-host').click();
    const png = await screenshotPng(operator);
    const size = pngBytes(png).byteLength;
    expect(size).toBeGreaterThan(500 * 1024);

    // By keyboard: a real paste event carrying a screenshot-sized PNG.
    await pastePng(operator, png, 'shot-keyboard.png');
    const keyboard = await delivered(operator, 'shot-keyboard.png', size);

    // By the context-menu paste path: the page reads the image off the clipboard itself. The
    // clipboard re-encodes a PNG on its round trip, so the saved bytes are the clipboard's own.
    await operator.evaluate(async base64 => {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], { type: 'image/png' }) })]);
    }, png);
    const onClipboard = await operator.evaluate(async () => (await (await navigator.clipboard.read())[0].getType('image/png')).size);
    await operator.locator('.terminal-host').dispatchEvent('contextmenu');
    const menu = await delivered(operator, 'image.png', onClipboard);

    // By drop.
    await operator.locator('.terminal-host').evaluate((element, base64) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], 'shot-drop.png', { type: 'image/png' }));
      element.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }, png);
    const drop = await delivered(operator, 'shot-drop.png', size);
    expect((await readdir(join(site, '.graphyard', 'master-inbox'))).length).toBe(3);

    // The saved paths are readable from inside the master session confinement: the wrapper the loop
    // would build for this checkout binds it read-only with its managed .graphyard — the inbox's
    // home — re-exposed; where bubblewrap works, the file is read through the real namespace.
    execFileSync('git', ['init', '-q', '-b', 'main', site]);
    const confinement = await masterSessionConfinement('claude', site, { bwrap: 'bwrap', platform: 'linux', mountNamespaceWorks: true });
    const words = confinement.wrapper, checkout = await realpath(site);
    const bound = (path: string, option: string) => { const at = words.indexOf(path); return at > 0 && words[at - 1] === option; };
    expect(bound(checkout, '--ro-bind')).toBe(true);
    expect(bound(join(checkout, '.graphyard'), '--bind')).toBe(true);
    if (await sessionMountNamespaceWorks().catch(() => false)) {
      for (const path of [keyboard, menu, drop]) {
        const read = spawnSync(words[0]!, [...words.slice(1), 'test', '-r', path], { cwd: site, encoding: 'utf8' });
        expect(read.status, read.stderr).toBe(0);
      }
    }

    // A paste the page cannot deliver says why: an image over the size limit, and an identity that may not type.
    const before = (await typed()).length;
    await operator.locator('.xterm-helper-textarea').evaluate(area => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(21 * 1024 * 1024)], 'huge.png', { type: 'image/png' }));
      area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(operator.getByRole('status')).toContainText('Not pasted: files are limited to 20 MB', settled);
    expect((await typed()).length).toBe(before);
    await context.close();
    const viewer = await browser.newContext({ ignoreHTTPSErrors: true });
    await viewer.addInitScript(() => sessionStorage.setItem('graphyard-token', 'test-reader'));
    const reader = await viewer.newPage(); await serveXterm(reader);
    await reader.goto(`${origin}/#master`);
    await expect(reader.getByRole('status')).toContainText('read-only', settled);
    await pastePng(reader, png, 'sneaky.png');
    await expect(reader.getByRole('status')).toContainText('Paste refused', settled);
    expect((await typed()).length).toBe(before);
    await viewer.close();
  } finally {
    stopping.abort(); await browser.close(); front.close();
    const ended = once(child, 'exit'); child.send('stop'); await ended;
    await database.close(); await rm(site, { recursive: true, force: true });
  }
});
