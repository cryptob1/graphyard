// Concern: GY-1932 — the fixture origin whose SSH door serves git only to the merge writer's deploy key.
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deployKeySshCommand } from '../../src/merge-writer/executor.js';

/**
 * GY-1932. A git origin that behaves like GitHub for a private repository, over a local bare
 * repository: the only way in is `ssh` resolved to the wrapper this helper writes, and the wrapper
 * runs `git-upload-pack`/`git-receive-pack` against the bare repository only for a caller whose
 * GIT_SSH_COMMAND presents the merge writer's deploy key (`-i <deploy key>`). Any other caller —
 * a worker sandbox without the key, an impostor key — is refused with ssh's
 * `Host key verification failed.` on stderr and exit 255, exactly as the Snake install's sandboxes
 * observed, and every caller, presented key or not, is recorded.
 *
 * The wrapper is the command word of a GIT_SSH_COMMAND string, so production's own deploy-key
 * command (`deployKeySshCommand`, `ssh -i KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`)
 * reaches it unchanged when the returned `bin` directory leads the caller's PATH: `ssh` resolves to
 * the wrapper and the wrapper reads the `-i` argument off the command line git hands it. The
 * deploy key pair is generated with `ssh-keygen` when the host has one (the wrapper compares only
 * the `-i` argument, never the key material, so a placeholder stands in where it does not).
 */
export const keylessSshCommand = 'ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new';

/** One recorded call of the wrapper: the git service asked for, the repository path it named, whether the caller presented the deploy key, and what the door did. */
export interface SshOriginAccess { service: string; path: string; presented: boolean; outcome: 'served' | 'refused'; caller: string }

export interface SshOrigin {
  /** The local bare repository the door serves. */
  repository: string;
  /** The origin URL checkouts and workers configure; its host and path are recorded, never dialled. */
  url: string;
  /** The merge writer's deploy key file: the `-i` argument that opens the door. */
  deployKeyFile: string;
  /** Production's deploy-key GIT_SSH_COMMAND for this origin's key: `ssh` resolves to the wrapper when `bin` leads PATH. */
  deployKeySshCommand: string;
  /** The directory holding the `ssh` wrapper; first on a caller's PATH routes its SSH through the door. */
  bin: string;
  /** Every access the door recorded, oldest first. */
  accesses(): Promise<SshOriginAccess[]>;
}

const run = (command: string, args: string[]) => new Promise<string>((accept, reject) => {
  execFile(command, args, { encoding: 'utf8', timeout: 60_000 }, (error: any, stdout) => {
    if (!error) return accept(String(stdout ?? ''));
    if (error.code === 'ENOENT') { (error as { code?: unknown }).code = 'ENOENT'; }
    reject(error);
  });
});

/**
 * Stand up the origin under `fixture`: a bare repository, a deploy key pair, and the `ssh` wrapper
 * that guards it. `fixture` should be a directory of the caller's own (tests/helpers/temp-dirs.ts).
 */
export async function sshOrigin(fixture: string): Promise<SshOrigin> {
  if (fixture.includes("'")) throw new Error(`the fixture path must not hold a single quote: ${fixture}`);
  const bin = join(fixture, 'ssh-bin');
  const repository = join(fixture, 'origin.git');
  const log = join(fixture, 'access.log');
  const deployKeyFile = join(fixture, 'deploy-key');
  await mkdir(bin, { recursive: true });
  await run('git', ['init', '--quiet', '--bare', '--initial-branch=main', repository]);
  try {
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'graphyard-merge-writer-fixture', '-f', deployKeyFile]);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    // No ssh-keygen on the host: the wrapper never reads the key, so a placeholder keeps the file's shape.
    await writeFile(deployKeyFile, 'placeholder: the wrapper compares only the -i argument, never key material\n', { mode: 0o600 });
  }
  await chmod(deployKeyFile, 0o600);
  const wrapper = [
    '#!/bin/sh',
    '# GY-1932: the fixture origin\'s SSH door, written by tests/helpers/ssh-origin.ts.',
    '# It serves git-upload-pack/git-receive-pack on the local bare repository only for a caller',
    "# presenting the deploy key (-i <deploy key>); any other caller is refused with ssh's",
    "# 'Host key verification failed.' and exit 255, exactly as the sandboxes observed, and every",
    '# caller is recorded: <service> <path> <presented> <served|refused> <pid> per line.',
    `KEY='${deployKeyFile}'`,
    `REPO='${repository}'`,
    `LOG='${log}'`,
    'presented=no service= path= pending= want_path=0',
    'for arg in "$@"',
    'do',
    '  if [ "$pending" = "-i" ]; then',
    '    [ "$arg" = "$KEY" ] && presented=yes',
    '    pending=',
    '  elif [ "$arg" = "-i" ]; then',
    '    pending="-i"',
    '  elif [ "$want_path" = 1 ]; then',
    '    path=$arg',
    '    want_path=0',
    '  else',
    '    case "$arg" in',
    '      git-upload-pack | git-receive-pack | git-upload-archive) service=$arg want_path=1 ;;',
    '      "git-upload-pack "* | "git-receive-pack "* | "git-upload-archive "*)',
    '        service=${arg%% *}',
    '        path=${arg#* }',
    '        ;;',
    '    esac',
    '  fi',
    'done',
    'path=$(printf \'%s\' "$path" | tr -d "\'")',
    'if [ "$presented" = yes ] && [ -n "$service" ]; then',
    '  printf \'%s\\t%s\\tyes\\tserved\\t%s\\n\' "$service" "$path" "$$" >> "$LOG"',
    '  exec git "${service#git-}" "$REPO"',
    'fi',
    'printf \'%s\\t%s\\tno\\trefused\\t%s\\n\' "${service:-none}" "${path:-none}" "$$" >> "$LOG"',
    'echo "Host key verification failed." >&2',
    'exit 255',
  ].join('\n');
  const ssh = join(bin, 'ssh');
  await writeFile(ssh, wrapper, { mode: 0o755 });
  await chmod(ssh, 0o755);
  const accesses = async (): Promise<SshOriginAccess[]> => {
    let text = '';
    try { text = await readFile(log, 'utf8'); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    return text.split('\n').filter(Boolean).map(line => {
      const [service, path, presented, outcome, caller] = line.split('\t');
      return { service: service!, path: path!, presented: presented === 'yes', outcome: outcome as SshOriginAccess['outcome'], caller: caller! };
    });
  };
  return {
    repository,
    url: 'git@graphyard.test:owner/project.git',
    deployKeyFile,
    deployKeySshCommand: deployKeySshCommand(deployKeyFile),
    bin,
    accesses: () => accesses(),
  };
}
