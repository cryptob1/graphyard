// Concern: the merge writer's fine-grained token (GY-3220), the alternative to the deploy key for organizations that disable deploy keys: its 0600 file and the GIT_ASKPASS helper beside it.
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeAskpassName } from '../merge-writer/executor.js';

export const MERGE_TOKEN_FILE = 'merge-writer.token';

/** Git asks for a username, then a password: the first is a fixed name, the second is the token read from the file the environment names. */
const askpass = `#!/bin/sh
case "$1" in
  Username*) echo x-access-token ;;
  *) cat "$GRAPHYARD_MERGE_TOKEN_FILE" ;;
esac
`;

/** Stores TOKEN at `<installDir>/merge-writer.token` (mode 0600) with the askpass helper (0700) beside it; returns the token file. */
export async function writeMergeToken(installDir: string, token: string): Promise<string> {
  await mkdir(installDir, { recursive: true, mode: 0o700 });
  const file = join(installDir, MERGE_TOKEN_FILE), helper = join(installDir, mergeAskpassName);
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  await writeFile(helper, askpass, { mode: 0o700 });
  await chmod(helper, 0o700);
  return file;
}
