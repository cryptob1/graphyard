import { test, expect, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { withDatabase } from '../tests/helpers/postgres';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { masterConfigSchema } from '../src/master/profiles';
import { assertDispatchable } from '../src/master/dispatch';
import { runCycle } from '../src/daemon/cycle';
import { emptyDaemonState } from '../src/daemon/state';
import type { DaemonEffects } from '../src/daemon/effects';
import { masterCauses } from '../src/daemon/master-stalled-delivery';
import { evaluate } from '../src/model-boundary/gates';
import { storedWorkSchema } from '../src/model-boundary/work';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy';
import type { Work } from '../src/model';

const waiting = 'Waiting on the master: writing the criteria';
const criteria = [{ id: 'AC-1', text: 'The requested change works through the dashboard', proofs: ['e2e:create-work-one-box'] }];

test('e2e:create-work-one-box — title-only filing waits for master requirements, then ordinary release and dispatch', async ({ page }) => {
  test.setTimeout(120_000);
  setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });
  const store = await withDatabase('create-work-one-box'); await store.init();
  const engine = new Engine(store, 300, 'owner/project'); engine.gitRunner = null;
  const http = server(engine, [
    { id: 'operator', role: 'admin', sessionKind: 'human', token: 'browser-operator' },
    { id: 'worker', role: 'worker', sessionKind: 'ai', token: 'browser-worker' },
  ]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const request = async (path: string, body: unknown, token = 'browser-operator') => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const post = async (path: string, body: unknown, token?: string) => {
    const response = await request(path, body, token); expect(response.status, JSON.stringify(response.body)).toBe(200); return response.body;
  };
  const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
  try {
    await post('operator-agents', { id: 'master', displayName: 'Master', capabilities: [], scope: { repositories: ['owner/project'], workItems: ['*'] }, token: 'browser-master-token-long-enough-123456789', reason: 'Write criteria and release eligible work' });
    const masterToken = 'browser-master-token-long-enough-123456789';
    await page.route('**/api/**', async route => {
      const { pathname, search } = new URL(route.request().url());
      await route.fulfill({ response: await route.fetch({ url: url + pathname + search }) });
    });
    await page.goto('/?sign-in');
    await page.getByLabel('Access token').fill('browser-operator');
    await page.getByRole('button', { name: 'Open control plane' }).click();
    await page.getByRole('button', { name: '＋ New work item' }).click();
    const form = page.getByRole('dialog', { name: 'New work item' });
    await expect(form.getByText('Advanced', { exact: true })).toBeVisible();
    await expect(form.getByLabel('Acceptance criterion')).not.toBeVisible();
    await form.getByLabel('Title', { exact: true }).fill('Make exports easier to find');
    const created = page.waitForResponse(response => response.url().endsWith('/api/work') && response.request().method() === 'POST');
    await form.getByRole('button', { name: 'Create work item', exact: true }).click();
    let draft = await (await created).json() as Work;
    await expect(page.locator('article.item-page')).toContainText(waiting);
    expect(draft.criteria).toEqual([]); expect(draft.ready).toBe(false);
    expect(draft.lease).toBeNull(); expect(draft.candidate).toBeNull();
    expect(draft.policy).toEqual({ review: true, checks: ['test', 'typecheck'] });
    expect(draft.scenarioRequirements).toEqual([]); expect(draft.evidence).toEqual([]);
    expect(storedWorkSchema.shape.criteria.safeParse(draft.criteria).success).toBe(true);
    const omitted = await post('work', { title: 'API title-only draft' });
    expect(omitted.criteria).toEqual([]); expect(omitted.ready).toBe(false); expect(omitted.lease).toBeNull(); expect(omitted.candidate).toBeNull();
    expect(omitted.policy).toEqual(draft.policy);
    const empty = await post('work', { title: 'Explicit empty draft', criteria: [] });
    expect(empty.criteria).toEqual([]); expect(empty.ready).toBe(false);
    for (const invalid of [[{ id: 'AC-1', text: 'Incomplete' }], [{ id: 'AC-1', text: 'No e2e', proofs: ['unit:only'] }]]) {
      expect((await request('work', { title: 'Invalid Advanced', criteria: invalid })).status).toBeGreaterThanOrEqual(400);
    }
    expect((await request('work', { title: 'Client ready', ready: true })).status).toBeGreaterThanOrEqual(400);
    expect((await request(`work/${draft.id}/ready`, { expectedRevision: draft.revision, reason: 'Try releasing draft' }, masterToken)).body.error).toContain(waiting);
    expect((await request(`work/${draft.id}/claim`, {}, 'browser-worker')).status).toBeGreaterThanOrEqual(400);
    const forged = { ...draft, ready: true };
    expect(evaluate(forged, [forged], new Date()).gates.find(gate => gate.name === 'ready')?.passed).toBe(false);
    expect(() => assertDispatchable(forged, [forged], new Date().toISOString())).toThrow(waiting);
    // Even a stored legacy/client-ready draft cannot be claimed.
    await store.pool.query("UPDATE work_items SET document = jsonb_set(document, '{ready}', 'true') WHERE id=$1", [draft.id]);
    expect((await request(`work/${draft.id}/claim`, {}, 'browser-worker')).body.error).toContain(waiting);
    await store.pool.query("UPDATE work_items SET document = jsonb_set(document, '{ready}', 'false') WHERE id=$1", [draft.id]);

    const config = masterConfigSchema.parse({ version: 1, url, credentialFile: '/outside/coordinator', cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), repository: 'owner/project', baseBranch: 'main', hostId: 'browser-host', masterAgentName: 'master-session', operatorAgent: { id: 'master', credentialFile: '/outside/master' }, workers: [{ name: 'worker', principal: 'worker', agentName: 'worker-session', mode: 'launch', kind: 'codex', credentialFile: '/outside/worker', agentArgs: [], approvals: 'auto', environment: {} }] });
    const state = emptyDaemonState(config);
    const released: string[] = [], dispatched: string[] = [], wakes: string[] = [];
    let masterVisible = true;
    const handovers: string[] = [];
    const effects: DaemonEffects = {
      agents: () => masterVisible ? [{ name: 'master-session', pane_id: 'master-pane', agent: 'codex', agent_status: 'working' }] : [],
      credentials: async () => ({ worker: { available: true, reason: null } }),
      snapshot: async () => ({ work: await store.list(), now: new Date().toISOString() }),
      release: async (item, reason) => { released.push(item.id); return post(`work/${item.id}/ready`, { expectedRevision: item.revision, reason }, masterToken); },
      dispatch: async item => { const claimed = await post(`work/${item.id}/claim`, {}, 'browser-worker'); dispatched.push(item.id); return { pane: 'worker-pane', epoch: claimed.epoch }; },
      masterSession: { launch: async handover => { handovers.push(handover); masterVisible = true; return { agentName: 'master-session', pane: 'master-pane', runtime: 'codex', account: null, session: null }; }, wake: async (_pane, prompt) => { wakes.push(prompt); } },
      closeSession: () => {}, persist: async () => {},
    };
    await runCycle(config, state, effects);
    await store.pool.query("UPDATE work_items SET document = jsonb_set(document, '{ready}', 'true') WHERE id=$1", [draft.id]);
    await runCycle(config, state, effects);
    await store.pool.query("UPDATE work_items SET document = jsonb_set(document, '{ready}', 'false') WHERE id=$1", [draft.id]);
    expect(released).toEqual([]); expect(dispatched).toEqual([]);
    expect(wakes).toHaveLength(1); expect(wakes[0]).toContain(`master requirements ${draft.key} FILE REASON`);
    expect(masterCauses([draft])[0].detail).toContain(waiting);
    masterVisible = false;
    await runCycle(config, state, effects);
    expect(handovers).toHaveLength(1); expect(handovers[0]).toContain(`master requirements ${draft.key} FILE REASON`);
    await runCycle(config, state, effects);
    expect(wakes).toHaveLength(1);
    const requirements = { expectedPolicyRevision: draft.policyRevision, reason: 'Define observable behavior and proof', criteria, dependencies: [], exclusiveResources: [] };
    expect((await request(`work/${draft.id}/requirements`, { ...requirements, criteria: [] }, masterToken)).status).toBeGreaterThanOrEqual(400);
    expect((await request(`work/${draft.id}/requirements`, { ...requirements, criteria: [{ ...criteria[0], proofs: ['unit:only'] }] }, masterToken)).status).toBeGreaterThanOrEqual(400);
    draft = await post(`work/${draft.id}/requirements`, requirements, masterToken);
    expect(draft.ready).toBe(false); expect(masterCauses([draft])).toEqual([]);
    // The release takes its response document, so the same cycle's dispatch offers the item.
    await runCycle(config, state, effects);
    expect(released).toEqual([draft.id]); expect(dispatched).toEqual([draft.id]);
    expect((await reload(draft.id)).lease?.owner).toBe('worker');
    // The page reads every 5 s, so the change can land just after a read: allow a full poll cycle.
    await expect(page.locator('article.item-page')).not.toContainText(waiting, { timeout: 15_000 });

    await page.getByRole('button', { name: '← Back' }).click();
    await page.getByRole('button', { name: '＋ New work item' }).click();
    await form.getByLabel('Title', { exact: true }).fill('Advanced export change');
    await form.getByText('Advanced', { exact: true }).click();
    await form.getByLabel('Acceptance criterion').fill(criteria[0].text);
    await form.getByLabel('Required proof').fill(criteria[0].proofs[0]);
    const advanced = page.waitForResponse(response => response.url().endsWith('/api/work') && response.request().method() === 'POST');
    await form.getByRole('button', { name: 'Create work item', exact: true }).click();
    const specified = await (await advanced).json();
    expect(specified.criteria).toEqual(criteria); expect(specified.ready).toBe(false);
    await expect(page.locator('article.item-page')).not.toContainText(waiting);

    // Advanced holds delivery rules too: opening it alone never requires criteria, and within a
    // row one filled field requires its pair. Rules-only changes file a draft.
    await page.getByRole('button', { name: '← Back' }).click();
    await page.getByRole('button', { name: '＋ New work item' }).click();
    await form.getByLabel('Title', { exact: true }).fill('Export checks change');
    await form.getByText('Advanced', { exact: true }).click();
    const criterion = form.getByLabel('Acceptance criterion');
    const proof = form.getByLabel('Required proof');
    const required = (input: Locator) => input.evaluate(el => (el as HTMLInputElement).required);
    expect(await required(criterion)).toBe(false);
    await criterion.fill('Typed a criterion first');
    expect(await required(proof)).toBe(true);
    await proof.fill('e2e:export-checks');
    expect(await required(criterion)).toBe(true);
    await criterion.fill('');
    await proof.fill('');
    expect(await required(proof)).toBe(false);
    await form.getByLabel(/CI checks/).fill('test');
    const rulesOnly = page.waitForResponse(response => response.url().endsWith('/api/work') && response.request().method() === 'POST');
    await form.getByRole('button', { name: 'Create work item', exact: true }).click();
    const rulesDraft = await (await rulesOnly).json() as Work;
    expect(rulesDraft.criteria).toEqual([]); expect(rulesDraft.ready).toBe(false);
    expect(rulesDraft.policy).toEqual({ review: true, checks: ['test'] });
    await expect(page.locator('article.item-page')).toContainText(waiting);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await store.close();
  }
});
