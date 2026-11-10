import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { defaultChildRun } from '../src/child-runner.js';
import { masterConfigSchema } from '../src/master.js';
import { writeMergeToken } from '../src/install/merge-token.js';

// GY-3220 AC-2: a scratch bare repository served over token-authenticated git smart HTTP on loopback
// (git http-backend behind a Basic-auth server). A token install fetches and pushes through it, a wrong
// token is refused, the token is in no log line, and a deploy-key install still uses origin.

const TOKEN = 'github_pat_fixture_token_value';
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** git http-backend as a CGI behind a server that answers 401 unless the Basic password is the token. */
async function serve(projectRoot: string, token: string, log: string[]) {
  const server = createServer((request, response) => {
    log.push(`${request.method} ${request.url}`);
    const password = Buffer.from((request.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString().split(':')[1];
    if (password !== token) { response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' }).end(); return; }
    const [path, query = ''] = request.url!.split('?');
    const cgi = spawn('git', ['http-backend'], { env: { PATH: process.env.PATH!, GIT_PROJECT_ROOT: projectRoot, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'x-access-token', REQUEST_METHOD: request.method!, PATH_INFO: path, QUERY_STRING: query, CONTENT_TYPE: request.headers['content-type'] ?? '', ...(request.headers['content-length'] ? { CONTENT_LENGTH: request.headers['content-length'] } : {}), ...(request.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: request.headers['content-encoding'] } : {}) } });
    request.pipe(cgi.stdin);
    const chunks: Buffer[] = [];
    cgi.stdout.on('data', chunk => chunks.push(chunk));
    cgi.on('close', () => {
      const output = Buffer.concat(chunks), split = output.indexOf('\r\n\r\n');
      const headers = Object.fromEntries(output.subarray(0, split).toString().split('\r\n').map(line => line.split(': ') as [string, string]));
      const { Status, ...rest } = headers;
      response.writeHead(Status ? Number(Status.split(' ')[0]) : 200, rest).end(output.subarray(split + 4));
    });
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/repo.git`, close: () => server.close() };
}

async function fixture(label: string) {
  const directory = await temporaryDirectory(label), origin = join(directory, 'repo.git'), checkout = join(directory, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(origin, 'config', 'http.receivepack', 'true');
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.name', 'Fixture'); git(checkout, 'config', 'user.email', 'fixture@example.com');
  await writeFile(join(checkout, 'a.txt'), 'base\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'base'); git(checkout, 'push', '-q', 'origin', 'main');
  const baseTip = git(checkout, 'rev-parse', 'HEAD');
  await writeFile(join(checkout, 'b.txt'), 'merge\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'merge');
  const mergeSha = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'reset', '-q', '--hard', baseTip);
  // The checkout's origin is unreachable, so only the explicit URL can work.
  git(checkout, 'remote', 'set-url', 'origin', 'git@127.0.0.1:0/unreachable.git');
  const readsFor = (run: Record<string, unknown>, environment: NodeJS.ProcessEnv) => mergeWriterReads(masterConfigSchema.parse({ version: 1, repository: 'owner/project', baseBranch: 'main', url: 'https://graphyard.example', credentialFile: '/unused', cliPath: '/unused', githubAppId: 1, hostId: 'fixture', masterAgentName: 'fixture', workers: [], run }),
    checkout, defaultChildRun, { base: join(directory, 'managed'), record: async () => {}, environment });
  return { directory, origin, checkout, baseTip, mergeSha, readsFor };
}

test('e2e:merge-writer-token — a token install fetches and pushes over token-authenticated smart HTTP; a wrong token is refused and no log holds it', { timeout: 120_000 }, async () => {
  const f = await fixture('merge-writer-token-http'), log: string[] = [], server = await serve(f.directory, TOKEN, log);
  try {
    const installDir = join(f.directory, 'config', 'owner-project');
    const tokenFile = await writeMergeToken(installDir, TOKEN);
    const env = { PATH: process.env.PATH!, GRAPHYARD_MERGE_WRITER_GIT_URL: server.url };
    const reads = f.readsFor({ mergeWriter: { tokenFile } }, env);
    assert.equal(await reads.fetch(), f.baseTip, 'the fetch reads the base tip over the token URL');
    assert.equal(await reads.push(f.mergeSha, f.baseTip), 'pushed');
    assert.equal(git(f.origin, 'rev-parse', 'main'), f.mergeSha, 'the merge landed on the served repository');

    const wrongFile = await writeMergeToken(join(f.directory, 'wrong'), 'github_pat_wrong');
    const wrong = f.readsFor({ mergeWriter: { tokenFile: wrongFile } }, env);
    const errors: string[] = [];
    await assert.rejects(wrong.fetch(), (error: Error) => { errors.push(error.message); return true; });
    await assert.rejects(wrong.push(f.mergeSha, f.baseTip), (error: Error) => { errors.push(error.message); return true; });
    for (const line of [...log, ...errors]) assert.ok(!line.includes(TOKEN) && !line.includes('github_pat_wrong'), `no log line holds a token: ${line}`);
  } finally { server.close(); }
});

test('integration:merge-writer-token — a deploy-key install still fetches and pushes through origin', { timeout: 60_000 }, async () => {
  const f = await fixture('merge-writer-deploy-key-origin');
  git(f.checkout, 'remote', 'set-url', 'origin', f.origin);
  const reads = f.readsFor({ mergeWriter: { deployKeyFile: join(f.directory, 'unused-key') } }, { PATH: process.env.PATH!, GRAPHYARD_MERGE_WRITER_GIT_URL: 'http://127.0.0.1:1/never.git' });
  assert.equal(await reads.fetch(), f.baseTip);
  assert.equal(await reads.push(f.mergeSha, f.baseTip), 'pushed');
  assert.equal(git(f.origin, 'rev-parse', 'main'), f.mergeSha);
});
