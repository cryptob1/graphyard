import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { handoff, loadConnection, managedInstructions, setupRepository } from '../src/repository-setup.js';
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const secret = 'fixture-worker-token-'.padEnd(40, 'x');
const connection = { url: 'https://example.com', token: secret, cliPath: launcher, hostId: 'machine-a' };
const fetcher = async () => new Response(JSON.stringify({ actor: { id: 'worker-a', role: 'worker' } }));
async function repo() { const root = await mkdtemp(join(tmpdir(), 'graphyard-init-')); execFileSync('git', ['init', '-q', root]); return root; }

test('managed instructions refresh one section and preserve all surrounding operator content', () => {
  const bootstrap = "The initial MVP is a single-agent bootstrap under the operator's supervision. Do not launch other agents for bootstrap work.";
  const original = `# Operator rules\n${bootstrap}\nNever delete customer data.\n`;
  const first = managedInstructions(original, 'https://one.example');
  assert.match(first, /dedicated master coordinator must keep cycling: status, dispatch ready work,\nshepherd review and proof collection, guarded merge, then deployment verification/);
  assert.match(first, /both conditions hold: \(1\) every in-scope item is Done or has a genuinely\nexternal blocker recorded in Graphyard; and \(2\) every merged change is deployed and\nlive-verified against the exact deployed release, or a genuinely external deployment\nblocker is recorded in Graphyard/);
  assert.match(first, /Delivered work is immutable, so a deployment\nblocker is recorded as a follow-up work item naming the delivered item, its merge\ncommit, and the external cause/);
  assert.match(first, /An observed merge alone does not end the loop/);
  for (const condition of ['Ordinary review findings', 'rework', 'idle workers', 'proof setup', 'Close finished agent\\s+sessions']) assert.match(first, new RegExp(condition));
  const surrounding = `${first}\n## Team review\nAsk the maintainer.\n`;
  const updated = managedInstructions(surrounding, 'https://two.example');
  assert.ok(updated.startsWith(original)); assert.ok(updated.endsWith('## Team review\nAsk the maintainer.\n'));
  assert.equal(updated.split('<!-- graphyard -->').length, 2); assert.doesNotMatch(updated, /one.example/);
  assert.equal(updated.split(bootstrap).length - 1, 1, 'setup preserves the protected bootstrap rule byte-for-byte');
  assert.equal(managedInstructions(updated, 'https://two.example'), updated);
  assert.match(updated, /Run `sync GY-N` before every push/); assert.match(updated, /never rebase/);
  assert.match(updated, /Files outside plannedFiles must match\norigin\/BASE byte-for-byte/); assert.match(updated, /Only an operator can widen plannedFiles/);
  assert.match(updated, /refused, naming the files and the shipped work/);
  for (const broken of ['<!-- graphyard -->', '<!-- /graphyard --><!-- graphyard -->', first + first]) assert.throws(() => managedInstructions(broken, 'https://example.com'), /markers/);
});

test('Herdr setup validates identity, privately saves configuration, updates instructions, and enables last', async () => {
  const root = await repo(); const config = join(root, 'herdr-private'); const calls: string[][] = [];
  const runHerdr = (args: string[]) => { calls.push(args); return args[1] === 'config-dir' ? config : ''; };
  try {
    await writeFile(join(root, 'AGENTS.md'), '# Original instructions\n', { mode: 0o600 });
    const result = await setupRepository(root, connection, { herdr: true, fetcher, runHerdr });
    const text = await readFile(join(root, 'AGENTS.md'), 'utf8');
    assert.ok(text.startsWith('# Original instructions\n')); assert.doesNotMatch(text, new RegExp(secret));
    assert.equal(JSON.stringify(result).includes(secret), false); assert.equal(result.pluginConfigured, true);
    assert.equal((await stat(join(root, '.graphyard/connection.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, 'AGENTS.md'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(config, 'config.json'))).mode & 0o777, 0o600);
    assert.deepEqual(calls.at(-1), ['plugin', 'enable', 'graphyard']);
    assert.equal((await loadConnection(root))?.principal, 'worker-a');
    await setupRepository(root, connection, { herdr: true, fetcher, runHerdr });
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), text);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('privileged or rejected credentials cause no instruction, plugin, or credential writes', async () => {
  for (const role of ['admin', 'coordinator', 'producer', 'reader', 'rejected']) {
    const root = await repo(); let invoked = false;
    try {
      await assert.rejects(setupRepository(root, connection, { herdr: true, fetcher: async () => new Response(JSON.stringify({ actor: { role } }), { status: role === 'rejected' ? 401 : 200 }), runHerdr: () => { invoked = true; return ''; } }));
      assert.equal(invoked, false); await assert.rejects(stat(join(root, 'AGENTS.md'))); await assert.rejects(stat(join(root, '.graphyard/connection.json')));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('setup does not follow an AGENTS.md symlink and refuses insecure credential file permissions', async () => {
  const root = await repo(); const target = join(root, 'operator-rules');
  try {
    await writeFile(target, 'Keep this intact'); await symlink(target, join(root, 'AGENTS.md'));
    await assert.rejects(setupRepository(root, connection, { fetcher }), /non-regular/);
    assert.equal(await readFile(target, 'utf8'), 'Keep this intact'); await rm(join(root, 'AGENTS.md'));
    await setupRepository(root, connection, { fetcher }); await chmod(join(root, '.graphyard/connection.json'), 0o644);
    await assert.rejects(loadConnection(root), /0600/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('linked worktrees inherit their primary checkout connection without copying credentials into Git', async () => {
  const root = await repo();
  try {
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--allow-empty', '-m', 'Initial'], { cwd: root, stdio: 'ignore' });
    await setupRepository(root, connection, { fetcher });
    const worktree = join(root, 'isolated'); execFileSync('git', ['worktree', 'add', '-b', 'assignment', worktree], { cwd: root, stdio: 'ignore' });
    assert.equal((await loadConnection(worktree))?.token, secret);
    await assert.rejects(stat(join(worktree, '.graphyard/connection.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('handoff fences stale ownership and hosts and returns safely quoted workspace commands', () => {
  const work = { key: 'GY-5', lease: { owner: 'worker-a', epoch: 2, expiresAt: '2030-01-01T00:02:00Z' }, workspaces: [{ epoch: 2, host: 'machine-a', path: "/tmp/worker's workspace" }] };
  const status = { actor: { id: 'worker-a', role: 'worker' }, now: '2030-01-01T00:00:00Z' };
  assert.match(handoff(work, status, 'machine-a', launcher).commands[0], /'\\''/);
  assert.throws(() => handoff(work, status, 'machine-b', launcher), /another host/);
  assert.throws(() => handoff(work, { ...status, actor: { id: 'other', role: 'worker' } }, 'machine-a', launcher), /lease/);
  assert.throws(() => handoff(work, { ...status, now: '2030-01-01T00:03:00Z' }, 'machine-a', launcher), /lease/);
  assert.match(handoff({ ...work, workspaces: [] }, status, 'machine-a', launcher).commands[0], /worktree/);
});

test('init accepts a token over stdin, and a server override never forwards a saved token elsewhere', async () => {
  const root = await repo(); let received = '';
  const http = createServer((req, res) => { received = String(req.headers.authorization ?? ''); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ actor: { role: 'worker', id: 'worker-a' } })); });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(http.address() as any).port}`;
  const env = { ...process.env }; delete env.GRAPHYARD_TOKEN; delete env.GRAPHYARD_URL;
  try {
    const child = execFile(process.execPath, [launcher, 'init', '--url', url, '--token-stdin'], { cwd: root, env });
    child.stdin!.end(secret);
    const output = await new Promise<string>((accept, reject) => { let text = ''; child.stdout!.on('data', d => text += d); child.on('exit', code => code === 0 ? accept(text) : reject(new Error('init failed'))); child.on('error', reject); });
    assert.equal(received, `Bearer ${secret}`); assert.equal(output.includes(secret), false);
    received = '';
    await promisify(execFile)(process.execPath, [launcher, 'doctor'], { cwd: root, env: { ...env, GRAPHYARD_URL: url.replace('127.0.0.1', 'localhost') } });
    assert.equal(received, '');
  } finally { await new Promise<void>(r => http.close(() => r())); await rm(root, { recursive: true, force: true }); }
});

 test('padded host IDs normalize before saving and match registered workspace handoffs', async () => {
  const root = await repo(); const config = join(root, 'herdr-private');
  try {
    await setupRepository(root, { ...connection, hostId: '  machine-a  ' }, { herdr: true, fetcher, runHerdr: args => args[1] === 'config-dir' ? config : '' });
    const saved = (await loadConnection(root))!;
    assert.equal(saved.hostId, 'machine-a');
    assert.equal(JSON.parse(await readFile(join(config, 'config.json'), 'utf8')).hostId, 'machine-a');
    const work = { key: 'GY-5', lease: { owner: 'worker-a', epoch: 2, expiresAt: '2030-01-01T00:02:00Z' }, workspaces: [{ epoch: 2, host: 'machine-a', path: root }] };
    assert.ok(handoff(work, { actor: { id: 'worker-a', role: 'worker' }, now: '2030-01-01T00:00:00Z' }, saved.hostId, launcher).commands.length);
    await assert.rejects(setupRepository(root, { ...connection, hostId: '   ' }, { fetcher }));
  } finally { await rm(root, { recursive: true, force: true }); }
 });

test('setup binds the checkout identity before saving credentials or changing Herdr', async () => {
  const root = await repo(); let calls = 0;
  const fetcher = async () => new Response(JSON.stringify({ actor: { id:'worker-a',role:'worker' },repository:'OWNER/Project' }));
  const runHerdr = () => { calls++; return ''; };
  try {
    await assert.rejects(setupRepository(root,connection,{fetcher,herdr:true,runHerdr}),/Cannot verify/);
    execFileSync('git',['remote','add','origin','git@github.com:other/project.git'],{cwd:root});
    await assert.rejects(setupRepository(root,connection,{fetcher,herdr:true,runHerdr}),/different repositories/);
    assert.equal(calls,0); await assert.rejects(stat(join(root,'.graphyard/connection.json'))); await assert.rejects(stat(join(root,'AGENTS.md')));
    for (const remote of ['https://github.com/owner/project.git','ssh://git@github.com/owner/project.git','ssh://git@ssh.github.com:443/owner/project.git']) {
      execFileSync('git',['remote','set-url','origin',remote],{cwd:root});
      assert.equal((await setupRepository(root,connection,{fetcher})).connected,true);
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});

 test('setup overrides later credential ignore negations before writing a token and remains idempotent', async () => {
  const root=await repo();
  try {
    await writeFile(join(root,'.gitignore'),'.graphyard/\n!.graphyard/\n.graphyard/*\n!.graphyard/connection.json\n');
    await setupRepository(root,connection,{fetcher});
    for(const path of ['.graphyard/connection.json','.graphyard/connection.json.pending.tmp']) {
      execFileSync('git',['check-ignore','--quiet','--',path],{cwd:root});
    }
    const ignored=await readFile(join(root,'.gitignore'),'utf8');
    assert.ok(ignored.endsWith('.graphyard/\n'));
    assert.doesNotMatch(execFileSync('git',['ls-files','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}),/connection/);
    await setupRepository(root,connection,{fetcher});
    assert.equal(await readFile(join(root,'.gitignore'),'utf8'),ignored);
  } finally { await rm(root,{recursive:true,force:true}); }
 });

function runCli(cwd: string, args: string[], input: string, env: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve,reject) => {
    const child=execFile(process.execPath,[launcher,...args],{cwd,env},(error,stdout,stderr)=>error?reject(new Error(stderr)):resolve(stdout));
    child.stdin!.end(input);
  });
}

test('CLI init from a linked worktree shares credentials with siblings and replaces legacy defaults', async () => {
  const root=await repo();let authorization='';
  const http=createServer((req,res)=>{authorization=String(req.headers.authorization??'');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({actor:{id:'worker-a',role:'worker'}}));});
  await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${(http.address() as any).port}`;
  const env={...process.env};delete env.GRAPHYARD_TOKEN;delete env.GRAPHYARD_URL;delete env.GRAPHYARD_HOST_ID;
  try {
    execFileSync('git',['-c','user.name=Test','-c','user.email=test@localhost','commit','--allow-empty','-m','Initial'],{cwd:root,stdio:'ignore'});
    const first=join(root,'first'),sibling=join(root,'sibling');
    for(const [branch,path] of [['first',first],['sibling',sibling]])execFileSync('git',['worktree','add','-b',branch,path],{cwd:root,stdio:'ignore'});
    await mkdir(join(first,'.graphyard'));
    await writeFile(join(first,'.graphyard/connection.json'),JSON.stringify({...connection,url,hostId:'legacy-host'}),{mode:0o600});
    const result=JSON.parse(await runCli(first,['init','--url',url,'--host-id','shared-host','--token-stdin'],secret,{...env,GRAPHYARD_TOKEN:''}));
    assert.equal(result.connected,true);
    assert.equal((await loadConnection(first))?.hostId,'shared-host');
    assert.equal((await loadConnection(sibling))?.token,secret);
    assert.equal((await stat(join(root,'.graphyard/connection.json'))).mode&0o777,0o600);
    execFileSync('git',['check-ignore','--quiet','.graphyard/connection.json'],{cwd:root});
    await assert.rejects(stat(join(sibling,'.graphyard/connection.json')));
    assert.match(await readFile(join(first,'AGENTS.md'),'utf8'),/Graphyard coordination/);
    assert.equal(JSON.parse(await runCli(sibling,['doctor'],'',env)).connected,true);
    assert.equal(authorization,`Bearer ${secret}`);
  } finally {await new Promise<void>(r=>http.close(()=>r()));await rm(root,{recursive:true,force:true});}
});

test('empty explicit stdin and environment credentials refuse without replacing saved configuration', async () => {
  const root=await repo();const env={...process.env};delete env.GRAPHYARD_TOKEN;delete env.GRAPHYARD_URL;
  try {
    await setupRepository(root,connection,{fetcher});
    const saved=await readFile(join(root,'.graphyard/connection.json'),'utf8'),instructions=await readFile(join(root,'AGENTS.md'),'utf8');
    for(const input of ['', '  \n\t']) {
      await assert.rejects(runCli(root,['init','--token-stdin'],input,env),/nonempty worker credential/);
      assert.equal(await readFile(join(root,'.graphyard/connection.json'),'utf8'),saved);
      assert.equal(await readFile(join(root,'AGENTS.md'),'utf8'),instructions);
    }
    for (const value of ['', '   ']) {
      await assert.rejects(runCli(root,['init'],'',{...env,GRAPHYARD_TOKEN:value}),/nonempty/);
      assert.equal(await readFile(join(root,'.graphyard/connection.json'),'utf8'),saved);
      assert.equal(await readFile(join(root,'AGENTS.md'),'utf8'),instructions);
    }
  } finally {await rm(root,{recursive:true,force:true});}
});
