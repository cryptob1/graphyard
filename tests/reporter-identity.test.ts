import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { intentCommand } from '../src/cli/master/intent.js';
import type { MasterSession } from '../src/cli/master/session.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import type { Principal } from '../src/model.js';

// GY-3344: a reporter identity lets another install's Master file items and message this install's
// Master, and nothing else. The real control plane on a temporary Postgres, driven by the real CLI
// from a directory that is not a checkout, holding only a URL and a token file.
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const reporter: Principal = { id: 'huck-master', role: 'reporter' };
const token = (principal: Principal) => `${principal.id}-token-${'x'.repeat(32)}`;
const cli = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const exec = promisify(execFile);
const criteria = [{ id: 'AC-1', text: 'Huck reports a Graphyard fault', proofs: ['e2e:reporter-filed'] }];
let close = async () => {};
after(() => close());

test('e2e:reporter-identity — a reporter files an item and messages the Master with a URL and token file, and is refused everything else', async () => {
  const store = await withDatabase('reporter-identity'); await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  const http = server(engine, [coordinator, operator, reporter].map(principal => ({ ...principal, token: token(principal) })));
  close = async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await store.close(); };
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const api = async (path: string, body?: unknown, as = operator) => {
    const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token(as)}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };

  // This install's coordinator checkout, for master status.
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  const scratch = await temporaryDirectory('reporter-identity', join(process.cwd(), '.graphyard'));
  const root = await temporaryDirectory('coordinator', scratch);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'Fixture.\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  await setupMaster(root, { url, token: token(coordinator), cliPath: cli, credentialDirectory: await temporaryDirectory('credentials', scratch), run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
  const masterStatus = async () => (await masterStatusReport(root, await loadMasterConfig(root), path => api(path, undefined, coordinator), async () => { throw new Error('no git in the fixture'); })).attention;

  // The reporter's side: a plain directory, a URL and a token file, nothing else of this install.
  const home = await temporaryDirectory('reporter-home');
  const tokenFile = join(home, 'reporter.token');
  await writeFile(tokenFile, token(reporter), { mode: 0o600 });
  assert.throws(() => execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: home, stdio: 'ignore', env: { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: dirname(home) } }), 'the reporter directory is not a checkout');
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR ?? '/tmp', GIT_CEILING_DIRECTORIES: dirname(home), GRAPHYARD_URL: url, GRAPHYARD_TOKEN_FILE: tokenFile };
  const graphyard = async (...args: string[]) => JSON.parse((await exec(process.execPath, [cli, ...args], { cwd: home, env })).stdout);
  const refused = async (...args: string[]) => {
    const failure: any = await exec(process.execPath, [cli, ...args], { cwd: home, env }).then(() => null, error => error);
    assert.ok(failure, `graphyard ${args.join(' ')} was refused`);
    assert.match(failure.stderr, /Reporter huck-master may only file items, message this install's Master and read back its own items and the Master's replies/, `graphyard ${args.join(' ')}: ${failure.stderr}`);
  };

  // It files an item with the CLI and gets its key; the item is unreleased, in backlog and attributed to it.
  const itemFile = join(home, 'item.json');
  await writeFile(itemFile, JSON.stringify({ title: 'Huck: the trial image lacks Go 1.23', why: 'Huck ships Go changes again.', simplest: 'Add Go 1.23 to the trial image.', description: 'Filed by the Huck install master.', type: 'chore', criteria }));
  const created = await graphyard('create', itemFile);
  assert.match(created.key, /^GY-\d+$/);
  const filed = await api(`work/${created.key}`);
  assert.equal(filed.stage, 'backlog');
  assert.equal(filed.ready, false);
  assert.equal(filed.reportedBy, 'huck-master');
  assert.equal((await api(`events?work=${filed.id}`)).find((event: any) => event.kind === 'create').actor, 'huck-master');

  // It messages this install's Master: the message appears once in master status attention, naming the sender.
  const sent = await graphyard('message', `Please look at ${created.key} soon`);
  const named = (await masterStatus()).filter(line => line.subject.includes('huck-master'));
  assert.equal(named.length, 1, JSON.stringify(named));
  assert.equal(named[0].subject, `message ${sent.id} from huck-master`);
  assert.match(named[0].text, new RegExp(`huck-master wrote .* ago: Please look at ${created.key} soon`));
  assert.equal(named[0].next, `Act on it, then graphyard master reply ${sent.id} TEXT`);

  // The Master replies; the line clears, and the reporter reads back its item's stage and the reply.
  await intentCommand({ id: 'reply', args: [String(sent.id), 'Queued;', 'the loop releases it next'], print: () => {},
    masterMutation: (path: string, data: unknown) => api(path, data, coordinator) } as unknown as MasterSession);
  assert.deepEqual((await masterStatus()).filter(line => line.subject.includes('huck-master')), []);
  assert.equal((await graphyard('status', created.key)).stage, 'backlog');
  const [message] = (await graphyard('messages')).messages;
  assert.equal(message.text, `Please look at ${created.key} soon`);
  assert.equal(message.replies[0].by, 'graphyard-master');
  assert.equal(message.replies[0].text, 'Queued; the loop releases it next');

  // An unanswered message no exchange can push out of the window: one hundred answered messages
  // later, master status still raises it (it wakes the Master session once, so it may not leave
  // the list and come back), and the reporter still reads it back, first.
  const later = await graphyard('message', 'Anything new on the image?');
  await store.pool.query(`INSERT INTO events(work_id,actor,kind,payload) SELECT NULL,'huck-master','master.message', json_build_object('text','filled '||n,'thread','filled'||n) FROM generate_series(1,100) n`);
  await store.pool.query(`INSERT INTO events(work_id,actor,kind,payload) SELECT NULL,'graphyard-master','master.reply', json_build_object('message', m.seq, 'text','done') FROM events m WHERE m.kind='master.message' AND m.payload->>'thread' LIKE 'filled%'`);
  const stillRaised = (await masterStatus()).filter(line => line.subject.includes('huck-master'));
  assert.equal(stillRaised.length, 1, JSON.stringify(stillRaised));
  assert.equal(stillRaised[0].subject, `message ${later.id} from huck-master`);
  const mine = (await graphyard('messages')).messages;
  assert.equal(mine.length, 100);
  assert.equal(mine[0].id, later.id, 'the unanswered message leads the window');
  await intentCommand({ id: 'reply', args: [String(later.id), 'Still queued'], print: () => {},
    masterMutation: (path: string, data: unknown) => api(path, data, coordinator) } as unknown as MasterSession);
  assert.deepEqual((await masterStatus()).filter(line => line.subject.includes('huck-master')), []);

  // Nothing else: release, close, requirements, priority, claim, complete, evidence, registry and lesson.
  const requirementsFile = join(home, 'requirements.json'), evidenceFile = join(home, 'evidence.json');
  await writeFile(requirementsFile, JSON.stringify({ expectedPolicyRevision: 1, reason: 'Widen it', criteria, dependencies: [] }));
  await writeFile(evidenceFile, JSON.stringify({ proof: 'e2e:reporter-filed', status: 'passed', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1 }));
  await refused('ready', created.key, 'Release it');
  await refused('master', 'release', created.key, 'Release it');
  await refused('master', 'close', created.key, '--reason', 'Close it');
  await refused('requirements', created.key, requirementsFile);
  await refused('priority', created.key, '0', 'Raise it');
  await refused('claim', created.key);
  await refused('complete', created.key, '1', '--head', 'a'.repeat(40));
  await refused('complete', created.key, '1');
  await refused('evidence', created.key, evidenceFile);
  await refused('master', 'registry');
  await refused('master', 'lesson', 'add', 'Reporters write lessons');
  // It reads back only its own items.
  const other = await api('work', { why: 'w', simplest: 's', title: 'The operator\'s own item', type: 'chore', criteria });
  const unseen: any = await exec(process.execPath, [cli, 'status', other.key], { cwd: home, env }).then(() => null, error => error);
  assert.match(unseen?.stderr ?? '', new RegExp(`Unknown work item ${other.key}`));
  const after = await api(`work/${created.key}`);
  assert.equal(after.ready, false, 'nothing the reporter tried released, claimed or changed its item');
  assert.equal(after.priority, filed.priority);
  assert.equal(after.lease, null);
});
