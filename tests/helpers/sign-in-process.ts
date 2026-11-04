import { fork } from 'node:child_process';
import { once } from 'node:events';

export async function signInProcess(database: string) {
  const child = fork(new URL('./sign-in-server.ts', import.meta.url), [database], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const [{ url }] = await once(child, 'message') as [{ url: string }];
  return { url, close: async () => { const ended = once(child, 'exit'); child.send('stop'); await ended; } };
}
