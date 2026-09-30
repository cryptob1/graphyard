// Concern: connecting an account from the UI — this host's half of the operator's key paste or
// subscription login (GY-409): the login home's key pair, unsealing, the provider auth file, the
// smoke prompt and the registry report.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject } from 'node:crypto';
import { defaultChildRun, type ChildRun } from '../child-runner.js';
import { connectDefaultRoles, connectProvider, ensureResearchWrapper, appendResearchCommand, fleetRequest, redactKey, relaySubscriptionLogin, type ConnectProvider } from '../fleet.js';
import { type EnvironmentKind, type MasterConfig } from './profiles.js';
import { atomicPrivateText } from './config.js';
import { failureText } from './worktrees.js';
import { agentEnvironmentRoot, createAgentEnvironment, discoverAgentEnvironments } from './environments.js';

// Connect an account from the UI (GY-409).
//
// The operator pastes a key or starts a subscription login in Settings › Agents; the control plane
// stores and relays ciphertext only; this host's executor does everything else here: it holds the
// login home's key pair, unseals what the browser sealed to its public key, writes the provider's
// own auth file at mode 0600 inside a new login home under the agent environment root, relays a
// subscription login's URL and code, runs the one-line smoke prompt, and reports the card healthy
// or the provider's error. The plaintext key lives in this function's scope alone and is redacted
// from everything that is reported. A subscription login is started and relayed by fleet.ts's
// `relaySubscriptionLogin`, since the loop's modules run children only through the async runner.

/** The host's connect key: the private half stays beside the coordinator credential, never sent anywhere. */
const connectKeyPath = (credentialFile: string, file?: string) => file ?? resolve(dirname(credentialFile), `${basename(credentialFile).replace(/\.token$/, '')}.connect.key`);
/** Load this host's connect key pair, creating it on first use under an exclusive create; the public half is what the control plane holds. */
export async function hostKeyPair(credentialFile: string, file?: string): Promise<{ privateKey: KeyObject; publicKey: string }> {
  const path = connectKeyPath(credentialFile, file);
  const read = async () => {
    const stored = JSON.parse(await readFile(path, 'utf8')); // a corrupt file throws instead of silently rotating the key
    if (typeof stored?.privateKey !== 'string') throw new Error(`The connect key at ${path} is malformed; restore or remove it by hand.`);
    const privateKey = createPrivateKey(stored.privateKey), publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
    return { privateKey, publicKey };
  };
  try {
    return await read();
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  // Two slots starting together converge on one key: exactly one exclusive create wins; a loser waits out the winner's write and adopts its key.
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  try {
    await writeFile(path, `${JSON.stringify({ privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { privateKey: pair.privateKey, publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  for (let wait = 0; wait < 20; wait++) {
    await new Promise(resolve => setTimeout(resolve, 50)); try { return await read(); } catch (error: any) { if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') throw error; }
  }
  throw new Error(`The connect key at ${path} stayed unreadable after another writer created it.`);
}

/**
 * Open what the browser sealed to this host's public key: an ephemeral ECDH P-256 key, an HKDF over
 * the shared secret (salted with the host key itself, info naming the scheme), and AES-256-GCM with
 * the tag appended — the same construction `web/seal.ts` runs in the browser, so the control plane
 * in between holds nothing that can open the payload. P-256 (not the brief's X25519) is the recorded
 * departure: the portable WebCrypto choice, both implementations cross-tested.
 */
export function unsealToHost(privateKey: KeyObject, sealed: { ephemeral: string; iv: string; ciphertext: string }): string {
  const ephemeral = createPublicKey({ key: Buffer.from(sealed.ephemeral, 'base64'), format: 'der', type: 'spki' });
  const shared = diffieHellman({ privateKey, publicKey: ephemeral });
  const salt = createHash('sha256').update(createPublicKey(privateKey).export({ format: 'der', type: 'spki' })).digest();
  const key = Buffer.from(hkdfSync('sha256', shared, salt, 'graphyard connect-account v1', 32));
  const data = Buffer.from(sealed.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'), { authTagLength: 16 });
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8');
}

/** A JSON document inside the login home, laid over whatever was there, at mode 0600. */
async function mergeHomeDocument(file: string, document: (existing: Record<string, unknown>) => Record<string, unknown>) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch { /* a fresh home */ }
  await atomicPrivateText(file, `${JSON.stringify(document(existing), null, 2)}\n`);
}

/** The provider's own auth file inside a fresh login home (and its settings, when it names any), merged over whatever was there, at mode 0600. */
export async function writeProviderAuthFile(provider: ConnectProvider, home: string, key: string): Promise<string> {
  const file = resolve(home, provider.authFile!);
  await mergeHomeDocument(file, existing => provider.authDocument!(existing, key));
  if (provider.settings) await mergeHomeDocument(resolve(home, provider.settings.file), provider.settings.document);
  return file;
}

/**
 * A Pi account's login home: `pi-<letter>` under the agent environment root, the directory Pi reads
 * through PI_CODING_AGENT_DIR. Pi is no agent environment kind of the loop's own, so the letter is
 * chosen here: never one a `pi-<letter>` directory holds, nor one an `opencode-<letter>` account's
 * research wrapper points its Pi directory at. The exclusive mkdir is what claims it.
 */
export async function createPiHome(root: string, name?: string | null): Promise<{ name: string; home: string }> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (name && /^pi-[a-z]$/.test(name) && existsSync(resolve(root, name))) return { name, home: resolve(root, name) };
  const taken = new Set((await discoverAgentEnvironments(root)).filter(entry => entry.kind === 'opencode').map(entry => entry.name.slice('opencode-'.length)));
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    if (taken.has(letter)) continue;
    const home = resolve(root, `pi-${letter}`);
    try { await mkdir(home, { mode: 0o700 }); return { name: `pi-${letter}`, home }; }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error(`Every pi-<letter> login home is taken under ${root}`);
}

/** The one-line smoke prompt inside the login home: healthy when the runtime answers, the provider's error when it does not. */
export async function runSmokePrompt(provider: ConnectProvider, home: string, options: { runner?: ChildRun; timeoutMs?: number } = {}): Promise<{ healthy: boolean; error: string | null }> {
  const environment: NodeJS.ProcessEnv = { ...process.env, [provider.smoke.envVariable]: home };
  if (provider.smoke.envVariable === 'XDG_DATA_HOME') {
    // mise resolves installed runtimes under XDG_DATA_HOME; keep it on the operator's own install.
    const mise = process.env.MISE_DATA_DIR ?? resolve(process.env.XDG_DATA_HOME ?? resolve(homedir(), '.local/share'), 'mise');
    if (existsSync(mise)) environment.MISE_DATA_DIR = mise;
  }
  try {
    await (options.runner ?? defaultChildRun)(provider.smoke.command, provider.smoke.args, { env: environment, timeoutMs: options.timeoutMs ?? 120_000 });
    return { healthy: true, error: null };
  } catch (error) { return { healthy: false, error: failureText(error) }; }
}

/** One connect request as the worker reads it from the control plane. */
interface ConnectAssignment { id: string; state: string; provider: string; name?: string | null; url?: string | null; code?: string | null; sealed?: { ephemeral: string; iv: string; ciphertext: string }; answerSealed?: { ephemeral: string; iv: string; ciphertext: string } }
export interface ConnectWorkerReport { id: string; provider: string; state: 'healthy' | 'failed' | 'skipped'; detail: string }
export interface ConnectAccountOptions {
  fetch?: typeof fetch; now?: () => number;
  /** Test overrides: the smoke prompt's runner, where login homes, the host key and the master file live, and every bound. */
  runner?: ChildRun; root?: string; keyFile?: string; masterFile?: string; pollMs?: number; loginTimeoutMs?: number; smokeTimeoutMs?: number;
}
const connectOpen = (state: string) => state === 'pending' || state === 'claimed' || state === 'connecting' || state === 'waiting-login';
/**
 * The host's half of connecting an account: register this host's public key, take the connect
 * requests addressed to it, and carry each one from sealed payload or provider login to a
 * registered, smoke-tested account — or to the error its card shows. Sequential by design: these
 * are the operator's own rare, human-paced actions.
 */
export async function processConnectAccounts(config: Pick<MasterConfig, 'url' | 'hostId' | 'credentialFile'>, options: ConnectAccountOptions = {}): Promise<ConnectWorkerReport[]> {
  if (!config.url || !config.hostId) return [];
  const fetcher = options.fetch ?? fetch, reports: ConnectWorkerReport[] = [];
  const { privateKey, publicKey } = await hostKeyPair(config.credentialFile, options.keyFile);
  await fleetRequest(config, 'agent-registry/connect/host-key', { body: { host: config.hostId, publicKey }, fetch: fetcher });
  const { connects } = await fleetRequest(config, `agent-registry/connect/requests?host=${encodeURIComponent(config.hostId)}`, { fetch: fetcher }) as { connects: ConnectAssignment[] };
  for (const connect of connects) {
    if (!connectOpen(connect.state)) continue;
    const provider = connectProvider(connect.provider);
    if (!provider) { reports.push({ id: connect.id, provider: connect.provider, state: 'skipped', detail: 'no known provider' }); continue; }
    let claimed = false, held: string | null = null;
    try {
      await fleetRequest(config, `agent-registry/connect/${connect.id}/claim`, { body: {}, fetch: fetcher });
      claimed = true;
      const root = agentEnvironmentRoot(options.root);
      const discovered = await discoverAgentEnvironments(root);
      // A request this host already started keeps the login home it created.
      const environment = provider.runtime === 'pi' ? await createPiHome(root, connect.name)
        : (connect.name ? discovered.find(entry => entry.name === connect.name) : undefined)
          ?? await createAgentEnvironment(root, provider.runtime as EnvironmentKind, discovered);
      const name = environment.name, home = environment.home;
      const report = async (healthy: boolean, error: string | null, research = false) => {
        await fleetRequest(config, `agent-registry/connect/${connect.id}/result`, { body: healthy ? { state: 'healthy', name, home, ...(research ? { research: true } : {}) } : { state: 'failed', name, error: error!.slice(0, 2000) }, fetch: fetcher });
        const joined = connectDefaultRoles(provider.tier).filter(role => role !== 'research' || research);
        reports.push({ id: connect.id, provider: provider.id, state: healthy ? 'healthy' : 'failed', detail: healthy ? `${name} joined ${joined.join(', ')}` : error!.slice(0, 500) });
      };
      // Research is this host's own configuration (GY-409 AC-4): a cheap account joins it only
      // once this host has made the account's Pi wrapper its research command, and the result is
      // what reports it — the card never claims a placement the fleet cannot launch.
      // The wrapper reads an OpenCode account's key, so a Pi account (which holds its own) has none.
      const researchJoined = async () => provider.tier !== 'fast' || provider.runtime === 'pi' ? false
        : await ensureResearchWrapper(name, home, options).catch(() => null)
            .then(wrapper => wrapper ? appendResearchCommand(wrapper, options).catch(() => false) : false);
      if (provider.kind === 'api-key') {
        // The plaintext key exists only inside this block and is redacted from everything reported.
        const key = unsealToHost(privateKey, connect.sealed!);
        held = key;
        await writeProviderAuthFile(provider, home, key);
        await fleetRequest(config, `agent-registry/connect/${connect.id}/progress`, { body: { state: 'connecting', name }, fetch: fetcher });
        const smoke = await runSmokePrompt(provider, home, options);
        if (!smoke.healthy) { await report(false, redactKey(smoke.error!, key)); continue; }
        await report(true, null, await researchJoined());
      } else {
        await fleetRequest(config, `agent-registry/connect/${connect.id}/progress`, { body: { state: 'connecting', name }, fetch: fetcher });
        // The URL and code reach the card while the login is still waiting on the operator's sign-in.
        const awaitingCode = !!provider.login?.pasteCode;
        const waiting = (printed: { url: string | null; code: string | null }) => fleetRequest(config, `agent-registry/connect/${connect.id}/progress`, { body: { state: 'waiting-login', name, ...(printed.url ? { url: printed.url } : {}), ...(printed.code ? { code: printed.code } : {}), ...(awaitingCode ? { awaitingCode } : {}) }, fetch: fetcher });
        const announced: Promise<unknown>[] = [];
        // A login that asks for its sign-in page's code (Claude Code) gets the one the operator
        // pasted on the card: sealed to this host in the browser, opened here and nowhere else.
        const answer = async () => {
          const { connects: current } = await fleetRequest(config, `agent-registry/connect/requests?host=${encodeURIComponent(config.hostId!)}`, { fetch: fetcher }) as { connects: ConnectAssignment[] };
          const sealed = current.find(entry => entry.id === connect.id)?.answerSealed;
          return sealed ? unsealToHost(privateKey, sealed) : null;
        };
        const isCancelled = async () => { const { connects: current } = await fleetRequest(config, `agent-registry/connect/requests?host=${encodeURIComponent(config.hostId!)}`, { fetch: fetcher }) as { connects: ConnectAssignment[] }; return !current.some(entry => entry.id === connect.id && (entry.state === 'claimed' || entry.state === 'connecting' || entry.state === 'waiting-login')); };
        const relay = await relaySubscriptionLogin(provider, home, { ...options, onPrinted: printed => announced.push(waiting(printed)), ...(awaitingCode ? { answer } : {}), isCancelled });
        await Promise.allSettled(announced);
        if (!announced.length && (relay.url || relay.code)) await waiting(relay);
        if (!relay.loggedIn) { await report(false, relay.error ?? 'the login did not complete'); continue; }
        const smoke = await runSmokePrompt(provider, home, options);
        await report(smoke.healthy, smoke.healthy ? null : smoke.error, smoke.healthy ? await researchJoined() : false);
      }
    } catch (error) {
      const detail = redactKey(failureText(error), held ?? '').slice(0, 2000);
      if (claimed) await fleetRequest(config, `agent-registry/connect/${connect.id}/result`, { body: { state: 'failed', error: detail }, fetch: fetcher }).catch(() => {});
      reports.push({ id: connect.id, provider: connect.provider, state: 'failed', detail: detail.slice(0, 500) });
    }
  }
  return reports;
}