#!/usr/bin/env node
// The self-contained host's GitHub credential for workers (GY-717).
//
// Workers push their branch with git and open the pull request with gh, as the graphyard account.
// Nobody logs into the host to authenticate either: this helper mints a GitHub App installation
// token from the App key the installer wrote next to it (mode 0600), narrowed to the managed
// repository with Contents and Pull requests write only, and caches it (0600) until five minutes
// before it expires. git calls it as a credential helper (`get`; `store` and `erase` are no-ops),
// and the host's gh wrapper calls it with `token` to set GH_TOKEN.
//
// It reads, from its own directory: app.json ({ appId, installationId, repository, api? }) and
// app-private-key.pem. It uses Node's built-ins only, so it runs from any checkout or none.
import { createSign } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const cacheFile = join(directory, 'token.json');
const REFRESH_MS = 5 * 60_000;

function appJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url')}`;
}

function cached() {
  try {
    const entry = JSON.parse(readFileSync(cacheFile, 'utf8'));
    return typeof entry.token === 'string' && Date.parse(entry.expiresAt) - REFRESH_MS > Date.now() ? entry.token : null;
  } catch { return null; }
}

async function token() {
  const hit = cached();
  if (hit) return hit;
  const app = JSON.parse(readFileSync(join(directory, 'app.json'), 'utf8'));
  const key = readFileSync(join(directory, 'app-private-key.pem'), 'utf8');
  const api = app.api ?? 'https://api.github.com';
  const response = await fetch(`${api}/app/installations/${app.installationId}/access_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${appJwt(app.appId, key)}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ repositories: [String(app.repository).split('/')[1]], permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub refused an installation token for ${app.repository}: ${response.status}`);
  const body = await response.json();
  const temporary = `${cacheFile}.${process.pid}`;
  writeFileSync(temporary, JSON.stringify({ token: body.token, expiresAt: body.expires_at }), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, cacheFile);
  return body.token;
}

const operation = process.argv[2];
try {
  if (operation === 'token') process.stdout.write(`${await token()}\n`);
  else if (operation === 'get') {
    const request = Object.fromEntries(readFileSync(0, 'utf8').split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    // Answer for github.com only; any other host falls through to git's next helper.
    if ((request.host ?? 'github.com') === 'github.com') process.stdout.write(`username=x-access-token\npassword=${await token()}\n`);
  } else if (operation !== 'store' && operation !== 'erase') throw new Error('usage: graphyard-github-credential.mjs token|get|store|erase');
} catch (error) {
  process.stderr.write(`graphyard-github-credential: ${error.message}\n`);
  process.exit(1);
}
