export const failureText = (error: unknown) => error instanceof Error ? error.message : String(error);
/**
 * A write that failed because there is no room left, said as exactly that. A full volume and an
 * exhausted user quota arrive as an errno on a direct write and as text in a child command's
 * output (`pwd: write error: Disk quota exceeded`); both are the same condition, and reporting
 * it as an unexplained command failure is what sends the next investigation to the wrong place.
 */
export function diskExhaustion(error: unknown): string | null {
  const record = error as { code?: unknown; stderr?: unknown; stdout?: unknown; message?: unknown } | null;
  const code = typeof record?.code === 'string' ? record.code : '';
  if (code === 'ENOSPC') return 'the volume is full (ENOSPC)';
  if (code === 'EDQUOT') return "the host's disk quota is exhausted (EDQUOT)";
  const text = [record?.message, record?.stderr, record?.stdout].filter(value => typeof value === 'string' || Buffer.isBuffer(value)).join('\n');
  if (/no space left on device/i.test(text)) return 'the volume is full (ENOSPC)';
  if (/disk quota exceeded/i.test(text)) return "the host's disk quota is exhausted (EDQUOT)";
  return null;
}
export const reclaimAdvice = 'free space on the volume, then retry; the master loop removes each assignment worktree once its attempt ends';
/** The path a failed write was aimed at: the one the caller names, or the one the system call reported. */
export function exhaustedPath(error: unknown, path?: string): string | null {
  const reported = (error as { path?: unknown; dest?: unknown } | null);
  return path ?? (typeof reported?.path === 'string' ? reported.path : typeof reported?.dest === 'string' ? reported.dest : null);
}
/** Disk exhaustion as one sentence: the condition, the path that could not be written, and the remedy. Null for any other failure. */
export function diskExhaustionMessage(error: unknown, path?: string): string | null {
  const cause = diskExhaustion(error);
  if (!cause) return null;
  const at = exhaustedPath(error, path);
  return `${cause}${at ? ` at ${at}` : ''}: ${reclaimAdvice}`;
}
/** The same failure, named by its cause when the cause is exhausted disk and left alone otherwise. */
export function writeFailure(error: unknown, action: string, path?: string): Error {
  const exhausted = diskExhaustionMessage(error, path);
  if (!exhausted) return error instanceof Error ? error : new Error(String(error));
  return Object.assign(new Error(`${action} failed because ${exhausted}`), { code: (error as { code?: string } | null)?.code ?? 'ENOSPC', cause: error });
}
