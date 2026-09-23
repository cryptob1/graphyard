import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startGithubSetup } from '../github-setup.js';
import type { MasterConfig } from '../master.js';
import { bindReviewer, removeReviewerProfile, reviewerCredentialDirectory, saveReviewerProfile, verifyReviewerInstallation } from '../reviewer.js';
import { readSecretFromStdin } from './context.js';

/** `graphyard master reviewer …`: the reviewer App's registration and binding, and the reviewer launch profiles. */
export async function reviewerCommand(root: string, master: MasterConfig, args: string[], print: (value: unknown) => void) {
  if (args[0] === 'add' && args[1]) return print(await saveReviewerProfile(root, JSON.parse(await readFile(args[1], 'utf8'))));
  if (args[0] === 'remove' && args[1]) return print(await removeReviewerProfile(root, args[1]));
  if (args[0] === 'bind' && args[1]) {
    const { values, positionals } = parseArgs({ args: args.slice(1), options: { 'key-stdin': { type: 'boolean' } }, allowPositionals: true });
    if (!values['key-stdin']) throw new Error('Use master reviewer bind FILE --key-stdin so the reviewer private key is not stored in shell history');
    const input = await readSecretFromStdin(20_000, 'Reviewer key input is too large');
    const identity = JSON.parse(await readFile(positionals[0], 'utf8'));
    return print(await bindReviewer(root, { appId: Number(identity.appId), installationId: Number(identity.installationId), slug: String(identity.slug), privateKey: input }, verifyReviewerInstallation));
  }
  if (args[0] === 'setup') {
    const { values } = parseArgs({ args: args.slice(1), options: { deployment: { type: 'string' }, port: { type: 'string' }, name: { type: 'string' } }, allowPositionals: false });
    const deployment = values.deployment ?? master.url;
    if (!deployment.startsWith('https://')) throw new Error('Reviewer App registration needs the deployed HTTPS origin; pass --deployment https://YOUR-GRAPHYARD-HOST');
    const registrations = reviewerCredentialDirectory(master);
    await mkdir(registrations, { recursive: true, mode: 0o700 });
    const setup = await startGithubSetup(root, master.repository, deployment, Number(values.port ?? 4312), {
      file: resolve(registrations, `${master.repository.replace('/', '-')}-registration.json`),
      record: async app => { await bindReviewer(root, { appId: app.appId, installationId: app.installationId, slug: app.slug, privateKey: app.privateKey }, verifyReviewerInstallation); },
    }, values.name ?? 'reviewer');
    console.log(`Open ${setup.url} in your browser and register the reviewer App. It is a second App, separate from the Graphyard control-plane App, and it cannot write code. Credentials stay outside this repository with mode 0600. Press Ctrl+C when the page reports the installation is verified.`);
    const stop = () => setup.http.close(); process.once('SIGINT', stop); process.once('SIGTERM', stop); return;
  }
  throw new Error('Use master reviewer setup, master reviewer bind FILE --key-stdin, or master reviewer add FILE');
}
