import { fork } from 'node:child_process';
import { once } from 'node:events';

// GY-3267: a control plane for the item-before-after-screenshots browser spec — a real store and
// server with the git fixture its submitted heads live in, a human operator a person signs in as,
// the worker that submits the fixture items' heads and the coordinator that records their trials.
export async function trialShotServer(database: string, repo: string) {
  const child = fork(new URL('./trial-shot-server-main.ts', import.meta.url), [database, repo], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const [{ url }] = await once(child, 'message') as [{ url: string }];
  return { url, close: async () => { const ended = once(child, 'exit'); child.send('stop'); await ended; } };
}
