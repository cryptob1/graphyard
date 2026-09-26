import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HELPER_TEXT, LoginView, REJECTED_NOTICE, VERIFY_TIMEOUT_MS, verifyToken, type LoginState, type LoginViewProps, type VerifyClock, type VerifyOutcome } from '../web/pages/login.js';

// GY-198: the sign-in page. One column with one left edge, a verifying state that shows progress and always
// resolves (accepted, rejected, or unreachable after VERIFY_TIMEOUT_MS), and "Use another token" as an escape
// link rather than the headline action. browser-tests/screenshots.spec.ts checks the same states in a browser.

const root = new URL('..', import.meta.url);
const noop = () => {};
const HOST = 'graphyard.example:4319';
const props = (state: LoginState, error = ''): LoginViewProps => ({ state, error, draftToken: '', setDraftToken: noop, submit: noop, retry: noop, useAnotherToken: noop });
const markup = (state: LoginState, error = '') => renderToStaticMarkup(createElement(LoginView, props(state, error)));

interface Host { type: string; props: Record<string, any>; parent: Host | null; children: Host[] }
/** The rendered tree of host elements (LoginView holds no hooks, so it can be called directly). */
function tree(state: LoginState, error = ''): Host {
  const build = (node: ReactNode, parent: Host | null, into: Host[]) => {
    if (Array.isArray(node)) { for (const child of node) build(child, parent, into); return; }
    if (!isValidElement(node)) return;
    const element = node as { type: any; props: Record<string, any> };
    if (typeof element.type === 'function') { build(element.type(element.props), parent, into); return; }
    if (typeof element.type !== 'string') { build(element.props.children, parent, into); return; }
    const host: Host = { type: element.type, props: element.props, parent, children: [] };
    into.push(host); build(element.props.children, host, host.children);
  };
  const top: Host[] = []; build(createElement(LoginView, props(state, error)), null, top);
  return top[0];
}
const all = (node: Host): Host[] => [node, ...node.children.flatMap(all)];
const text = (node: Host): string => { const own = node.props.children; const parts = (Array.isArray(own) ? own : [own]).filter(part => typeof part === 'string' || typeof part === 'number'); return [...parts, ...node.children.map(text)].join(''); };
const classes = (node: Host) => String(node.props.className ?? '').split(/\s+/).filter(Boolean);
const buttons = (node: Host) => all(node).filter(host => host.type === 'button');
const named = (node: Host, name: string) => buttons(node).find(button => text(button).includes(name));
const BLOCK = new Set(['p', 'div', 'form', 'section', 'main', 'h1', 'h2', 'h3']);

/** A fake clock: timers run only when the test advances time. */
function fakeClock() {
  let now = 0, next = 0; const timers = new Map<number, { at: number; run: () => void }>();
  const clock: VerifyClock & { advance(ms: number): Promise<void>; pending(): number } = {
    setTimeout(run, ms) { const id = ++next; timers.set(id, { at: now + ms, run }); return id; },
    clearTimeout(id) { timers.delete(id as number); },
    async advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); } await settle(); },
    pending: () => timers.size,
  };
  return clock;
}
const settle = () => new Promise(resolve => setImmediate(resolve));
/** A fake fetch whose single reply the test decides; it rejects when the request is aborted. */
function fakeFetch() {
  const calls: { url: string; init: RequestInit }[] = []; let answer: (response: Response) => void = noop;
  const fetcher = ((url: string, init: RequestInit) => { calls.push({ url, init }); return new Promise<Response>((resolve, reject) => { answer = resolve; init.signal?.addEventListener('abort', () => reject(new Error('aborted'))); }); }) as unknown as typeof fetch;
  return { fetcher, calls, reply: (response: Response) => answer(response) };
}
async function outcomeOf(result: Promise<VerifyOutcome>) { let seen: VerifyOutcome | null = null; void result.then(value => { seen = value; }); await settle(); return () => seen as VerifyOutcome | null; }

test('unit:login-single-column the brand, heading, tagline, status or form and helper share one column, with the helper its own block after the action', () => {
  for (const state of [{ kind: 'form' }, { kind: 'verifying' }] as LoginState[]) {
    const page = tree(state);
    assert.equal(page.type, 'main'); assert.deepEqual(classes(page), ['login'], 'one content column');
    const column = page.children;
    // The brand is a direct child of the same column as the heading, tagline and action: one left edge.
    assert.deepEqual(column.map(child => child.type), ['div', 'h1', 'p', state.kind === 'form' ? 'form' : 'div', 'p'], `${state.kind}: brand, heading, tagline, ${state.kind === 'form' ? 'form' : 'status'}, helper`);
    assert.ok(classes(column[0]).includes('brand') && column[0].parent === page, `${state.kind}: the brand sits inside the content column`);
    const action = column[3], helper = column[4];
    assert.ok(buttons(action).length > 0, `${state.kind}: the action is in the fourth block`);
    // The helper text is a block-level element after the action, never inline beside it.
    assert.ok(BLOCK.has(helper.type) && classes(helper).includes('login-help'), `${state.kind}: the helper is a block of its own`);
    assert.equal(text(helper), HELPER_TEXT);
    assert.ok(!all(action).some(host => text(host) === HELPER_TEXT), `${state.kind}: the helper is not inside the action block`);
    const html = markup(state);
    assert.ok(html.lastIndexOf('</button>') < html.indexOf(HELPER_TEXT), `${state.kind}: the helper follows every button`);
    assert.doesNotMatch(html, /<small/, `${state.kind}: no inline <small> helper`);
  }
  // web/style.css sets the layout: a single column with one max width; the brand drops the sidebar's inset; the helper is a block.
  const css = readFileSync(new URL('web/style.css', root), 'utf8');
  const rule = (selector: string) => { const matches = [...css.matchAll(new RegExp(`(?:^|})${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`, 'gm'))]; assert.ok(matches.length, `${selector} is styled`); return matches.at(-1)![1]; };
  const login = rule('.login');
  for (const declaration of ['display:flex', 'flex-direction:column', 'max-width:450px']) assert.ok(login.includes(declaration), `.login sets ${declaration}`);
  assert.ok(rule('.login>*').includes('margin-left:0') && rule('.login>*').includes('max-width:100%'), 'every child of .login shares its left edge and width');
  assert.ok(rule('.login .brand').includes('padding:0'), 'the brand has no inset of its own');
  assert.ok(rule('.login-help').includes('display:block'), 'the helper text is a block');
});

test('unit:login-verify-states verifying shows progress and resolves as pending, timeout, rejected or accepted', async () => {
  // Pending: the status read is in flight; the page shows a busy status and nothing has resolved.
  {
    const clock = fakeClock(), network = fakeFetch();
    const check = verifyToken('token-1', network.fetcher, clock); const seen = await outcomeOf(check.result);
    assert.equal(network.calls.length, 1); assert.equal(network.calls[0].url, '/api/status');
    assert.equal((network.calls[0].init.headers as Record<string, string>).Authorization, 'Bearer token-1');
    await clock.advance(VERIFY_TIMEOUT_MS - 1);
    assert.equal(seen(), null, 'still pending just before the timeout');
    const page = tree({ kind: 'verifying' });
    const status = all(page).find(host => host.props.role === 'status')!;
    assert.ok(status, 'a status region'); assert.equal(status.props['aria-busy'], 'true');
    assert.match(text(status), /Verifying connection…/);
    assert.ok(all(status).some(host => classes(host).includes('spinner')), 'a progress indicator');
    assert.deepEqual(buttons(page).map(text), ['Use another token']);
    check.cancel();
  }
  // Timeout: 10 seconds without a status reply → can't reach the control plane, with Retry and a secondary escape.
  {
    const clock = fakeClock(), network = fakeFetch();
    const seen = await outcomeOf(verifyToken('token-1', network.fetcher, clock).result);
    await clock.advance(VERIFY_TIMEOUT_MS);
    assert.deepEqual(seen(), { kind: 'unreachable' });
    assert.ok(network.calls[0].init.signal!.aborted, 'the unanswered read is abandoned');
    const page = tree({ kind: 'unreachable', host: HOST });
    const alert = all(page).find(host => host.props.role === 'alert')!;
    assert.equal(text(alert), `Can't reach the control plane at ${HOST}`);
    assert.deepEqual(buttons(page).map(text), ['Retry', 'Use another token']);
    assert.ok(!classes(named(page, 'Retry')!).includes('text-button'), 'Retry is the primary action');
    assert.ok(classes(named(page, 'Use another token')!).includes('text-button'), 'Use another token is a secondary link');
    assert.ok(!all(page).some(host => host.props['aria-busy'] === 'true'), 'no longer busy');
  }
  // An unreachable server that answers fast with an error resolves at once, not after the timeout.
  {
    const clock = fakeClock(), network = fakeFetch();
    const seen = await outcomeOf(verifyToken('token-1', network.fetcher, clock).result);
    network.reply(new Response('bad gateway', { status: 502 })); await settle();
    assert.deepEqual(seen(), { kind: 'unreachable' }); assert.equal(clock.pending(), 0, 'the timeout is cleared');
  }
  // Rejected (401 and 403): back to the token form with the notice and the input focused.
  for (const code of [401, 403]) {
    const clock = fakeClock(), network = fakeFetch();
    const seen = await outcomeOf(verifyToken('bad-token', network.fetcher, clock).result);
    network.reply(new Response(JSON.stringify({ error: 'no' }), { status: code })); await settle();
    assert.deepEqual(seen(), { kind: 'rejected' }, `${code} rejects the token`); assert.equal(clock.pending(), 0);
    const page = tree({ kind: 'form' }, REJECTED_NOTICE);
    const alert = all(page).find(host => host.props.role === 'alert')!;
    assert.equal(text(alert), 'That token was not accepted');
    const input = all(page).find(host => host.type === 'input')!;
    assert.equal(input.props.autoFocus, true, 'the token input takes focus');
    assert.deepEqual(buttons(page).map(text), ['Open control plane ↗']);
  }
  // Accepted: the status reply is handed on and the timer is cleared.
  {
    const clock = fakeClock(), network = fakeFetch();
    const seen = await outcomeOf(verifyToken('token-1', network.fetcher, clock).result);
    network.reply(new Response(JSON.stringify({ actor: { role: 'admin' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })); await settle(); await settle();
    assert.deepEqual(seen(), { kind: 'accepted', status: { actor: { role: 'admin' } } });
    assert.equal(clock.pending(), 0, 'no timeout left to fire');
    await clock.advance(VERIFY_TIMEOUT_MS);
    assert.deepEqual(seen(), { kind: 'accepted', status: { actor: { role: 'admin' } } }, 'the outcome does not change afterwards');
  }
  // Accepted waits for the dashboard's first read, under the same deadline; its failures resolve too.
  const ok = () => new Response(JSON.stringify({ actor: { role: 'admin' } }), { status: 200 });
  {
    const clock = fakeClock(), network = fakeFetch(); let loaded: unknown = null; let finish: () => void = noop;
    const seen = await outcomeOf(verifyToken('token-1', network.fetcher, clock, status => new Promise(resolve => { finish = () => { loaded = status; resolve(); }; })).result);
    network.reply(ok()); await settle(); await settle();
    assert.equal(seen(), null, 'still verifying while the first read loads');
    finish(); await settle();
    assert.deepEqual(loaded, { actor: { role: 'admin' } }); assert.deepEqual(seen(), { kind: 'accepted', status: { actor: { role: 'admin' } } });
  }
  {
    const clock = fakeClock(), network = fakeFetch(); let signal: AbortSignal | null = null;
    const seen = await outcomeOf(verifyToken('token-1', network.fetcher, clock, (_, abort) => { signal = abort; return new Promise(noop); }).result);
    network.reply(ok()); await settle(); await settle();
    await clock.advance(VERIFY_TIMEOUT_MS);
    assert.deepEqual(seen(), { kind: 'unreachable' }, 'a first read that never answers ends in unreachable'); assert.ok(signal!.aborted);
  }
  for (const [failure, expected] of [[new Error('Unable to load dashboard (502).'), 'unreachable'], [Object.assign(new Error(REJECTED_NOTICE), { unauthorized: true }), 'rejected']] as const) {
    const clock = fakeClock(), network = fakeFetch();
    const seen = await outcomeOf(verifyToken('token-1', network.fetcher, clock, async () => { throw failure; }).result);
    network.reply(ok()); await settle(); await settle();
    assert.deepEqual(seen(), { kind: expected }); assert.equal(clock.pending(), 0);
  }
});

test('unit:login-secondary-escape while verifying, Use another token is a link-styled secondary action and no primary button shows', () => {
  const page = tree({ kind: 'verifying' });
  const escape = named(page, 'Use another token')!;
  assert.ok(escape, 'the escape is offered');
  assert.deepEqual(classes(escape), ['text-button', 'login-escape']);
  assert.equal(escape.props.type, 'button');
  const primary = buttons(page).filter(button => !classes(button).includes('text-button'));
  assert.deepEqual(primary.map(text), [], 'no primary-styled button in the pending verifying state');
  const css = readFileSync(new URL('web/style.css', root), 'utf8');
  assert.match(css, /\.login \.login-escape\{[^}]*text-decoration:underline/, 'styled as a link');
  assert.match(css, /button\.text-button,\.text-button\{[^}]*background:none;border:0/, 'text-button has no button fill');
});

test('unit:login-screenshots-present the browser suite captures the sign-in page in each state at 1280 and 375 px and the images are committed', () => {
  const spec = readFileSync(new URL('browser-tests/screenshots.spec.ts', root), 'utf8');
  assert.match(spec, /loginWidths = \[1280, 375\] as const/);
  assert.match(spec, /loginStates = \['token-form', 'verifying', 'unreachable'\] as const/);
  assert.match(spec, /const loginOut = 'browser-tests\/screenshots\/login'/);
  // The browser checks: no sideways overflow, one left edge, and the helper text below every button.
  assert.match(spec, /scrollWidth[\s\S]*toBeLessThanOrEqual\(layout\.width\)/);
  assert.match(spec, /new Set\(layout\.lefts\)\.size[\s\S]*toBe\(1\)/);
  assert.match(spec, /layout\.helpTop[\s\S]*toBeGreaterThanOrEqual\(layout\.buttonBottom\)/);
  for (const state of ['token-form', 'verifying', 'unreachable']) for (const width of [1280, 375]) {
    const image = readFileSync(new URL(`browser-tests/screenshots/login/${state}-${width}.png`, root));
    assert.deepEqual([...image.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${state}-${width}.png is a PNG`);
    assert.equal(image.readUInt32BE(16), width, `${state}-${width}.png is ${width} px wide`);
  }
});
